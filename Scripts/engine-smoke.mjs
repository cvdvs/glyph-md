// Runs Scripts/smoke.js against real headless Chrome — the Blink engine that
// Windows WebView2 uses — and captures light + dark screenshots.
//
// Deliberately has NO dependencies: it drives the Chrome DevTools Protocol over
// Node's built-in WebSocket (Node 22+). Nothing enters the repo, nothing to install.
//
//   node Scripts/engine-smoke.mjs [--shots <dir>] [--chrome <path>]
//
// Exits nonzero if any assertion fails or the serialization drifts from
// Scripts/fixtures/golden-sample.md (regenerate that with --update-golden).

import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const CHROME_CANDIDATES = [
  flag("--chrome"),
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error("engine-smoke: no Chrome/Chromium found. Looked at:\n  " + CHROME_CANDIDATES.join("\n  "));
  console.error("Pass one with --chrome <path> or set CHROME_PATH.");
  process.exit(2);
}

// ---------- compose the page exactly the way the app does ----------
const viewer = readFileSync(path.join(ROOT, "Resources", "viewer.html"), "utf8");
const marked = readFileSync(path.join(ROOT, "Resources", "marked.min.js"), "utf8");
const fixtureDir = path.join(ROOT, "Scripts", "fixtures");
const docPath = existsSync(path.join(fixtureDir, "selftest.md"))
  ? path.join(fixtureDir, "selftest.md")
  : path.join(ROOT, "sample.md");
const doc = readFileSync(docPath, "utf8");

const page = viewer
  .replace("/*__MARKED_JS__*/", () => marked)
  .replace("/*__INITIAL__*/", () => "window.__initial = " + JSON.stringify(doc) + ";");

// Written into the fixtures dir so relative image paths (pic.png) resolve,
// which is what the imageResolves assertion depends on.
const pagePath = path.join(fixtureDir, ".engine-smoke.html");
await mkdir(fixtureDir, { recursive: true });
await writeFile(pagePath, page, "utf8");

// ---------- launch chrome ----------
const profile = await mkdtemp(path.join(tmpdir(), "glyph-chrome-"));
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--no-first-run",
  "--disable-extensions",
  "--allow-file-access-from-files",
  "--remote-debugging-port=0",
  "--user-data-dir=" + profile,
  "--window-size=1000,1400",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });

let chromeErr = "";
chrome.stderr.on("data", (d) => { chromeErr += d.toString(); });

const cleanup = async () => {
  try { chrome.kill("SIGKILL"); } catch {}
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await rm(pagePath, { force: true }).catch(() => {});
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The port lands in DevToolsActivePort once the browser is listening.
let wsUrl = null;
for (let i = 0; i < 100 && !wsUrl; i++) {
  await sleep(100);
  try {
    const portFile = await readFile(path.join(profile, "DevToolsActivePort"), "utf8");
    const [port, tail] = portFile.split("\n");
    if (port && tail) wsUrl = `ws://127.0.0.1:${port.trim()}${tail.trim()}`;
  } catch {}
}
if (!wsUrl) {
  console.error("engine-smoke: Chrome never became ready.\n" + chromeErr.slice(0, 2000));
  await cleanup();
  process.exit(2);
}

// ---------- minimal CDP client ----------
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", () => rej(new Error("CDP connect failed")), { once: true });
});

let msgId = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.method + ": " + JSON.stringify(m.error))) : resolve(m.result);
  }
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const S = (method, params) => send(method, params, sessionId);

await S("Page.enable");
await S("Runtime.enable");

const loaded = new Promise((resolve) => {
  const onMsg = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Page.loadEventFired" && m.sessionId === sessionId) {
      ws.removeEventListener("message", onMsg);
      resolve();
    }
  };
  ws.addEventListener("message", onMsg);
});
await S("Page.navigate", { url: "file://" + pagePath });
await loaded;
await sleep(400); // let the initial render settle

// ---------- screenshots (both themes) before the suite mutates the doc ----------
const shotDir = flag("--shots");
if (shotDir) {
  await mkdir(shotDir, { recursive: true });
  for (const scheme of ["light", "dark"]) {
    await S("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    });
    await sleep(200);
    const { data } = await S("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await writeFile(path.join(shotDir, `chrome-${scheme}.png`), Buffer.from(data, "base64"));
  }
  await S("Emulation.setEmulatedMedia", { features: [] });
  console.log("engine-smoke: screenshots -> " + shotDir);
}

// ---------- run the shared assertion suite ----------
const smoke = readFileSync(path.join(ROOT, "Scripts", "smoke.js"), "utf8");
const { result, exceptionDetails } = await S("Runtime.evaluate", {
  expression: smoke,
  returnByValue: true,
  awaitPromise: false,
});
if (exceptionDetails) {
  console.error("engine-smoke: smoke.js threw:\n" + JSON.stringify(exceptionDetails, null, 2));
  await cleanup();
  process.exit(1);
}

const out = JSON.parse(result.value);
const serialized = out.serialized;
delete out.serialized;

// ---------- golden comparison ----------
const goldenPath = path.join(fixtureDir, "golden-sample.md");
let goldenVerdict = "skipped (no golden on disk)";
if (has("--update-golden")) {
  await writeFile(goldenPath, serialized, "utf8");
  goldenVerdict = "WROTE golden-sample.md (" + serialized.length + " bytes)";
} else if (existsSync(goldenPath)) {
  const golden = readFileSync(goldenPath, "utf8");
  if (golden === serialized) {
    goldenVerdict = "matches golden-sample.md exactly";
  } else {
    goldenVerdict = "DRIFTED from golden-sample.md";
    out.goldenMatch = false;
    const g = golden.split("\n");
    const s = serialized.split("\n");
    console.error("\n--- serialization drift (golden vs this engine) ---");
    for (let i = 0; i < Math.max(g.length, s.length); i++) {
      if (g[i] !== s[i]) {
        console.error(`line ${i + 1}:\n  golden: ${JSON.stringify(g[i])}\n  actual: ${JSON.stringify(s[i])}`);
      }
    }
    console.error("---\n");
  }
}

const failed = Object.entries(out).filter(([k, v]) => {
  if (/Error$/.test(k) || k === "ok") return false;
  return typeof v === "boolean" ? !v : typeof v === "number" ? v <= 0 : false;
});

console.log("engine-smoke (Blink " + path.basename(chromePath) + "):");
console.log("  " + JSON.stringify(out));
console.log("  golden: " + goldenVerdict);

await cleanup();

if (failed.length) {
  console.error("\nFAILED assertions: " + failed.map(([k, v]) => `${k}=${v}`).join(", "));
  process.exit(1);
}
console.log("  ALL PASS");
