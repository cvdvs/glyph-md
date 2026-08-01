// Runs Scripts/smoke.js against real headless Chrome — the Blink engine that
// Windows WebView2 uses — and captures light + dark screenshots.
//
// Deliberately has NO dependencies: it drives the Chrome DevTools Protocol over
// Node's built-in WebSocket (Node 22+). Nothing enters the repo, nothing to install.
//
//   node Scripts/engine-smoke.mjs [--shots <dir>] [--chrome <path>] [--with-chrome]
//
// Exits nonzero if any assertion fails or the serialization drifts from
// Scripts/fixtures/golden-sample.md (regenerate that with --update-golden).

import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

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

// --with-chrome builds the standalone app; --security renders the hostile
// fixture and runs the security assertions instead of the feature suite.
const chromeMode = has("--with-chrome");
const securityMode = has("--security");
// --fidelity checks that a document survives being written back unchanged.
const fidelityMode = has("--fidelity");

// ---------- compose the page exactly the way the app does ----------
const viewer = readFileSync(path.join(ROOT, "Resources", "viewer.html"), "utf8");
const marked = readFileSync(path.join(ROOT, "Resources", "marked.min.js"), "utf8");
const fixtureDir = path.join(ROOT, "Scripts", "fixtures");
const docPath = fidelityMode
  ? path.join(fixtureDir, "fidelity.md")
  : securityMode
  ? path.join(fixtureDir, "hostile.md")
  : existsSync(path.join(fixtureDir, "selftest.md"))
    ? path.join(fixtureDir, "selftest.md")
    : path.join(ROOT, "sample.md");
const doc = readFileSync(docPath, "utf8");

// --chrome is the browser path; --with-chrome selects the standalone-app build.

// JSON.stringify does not escape "<", so a document containing "</script>"
// would close the script block early and run as HTML — bypassing the sanitizer
// entirely. Same escaping as Scripts/make-preview.py.
const embed = (v) => JSON.stringify(v)
  .replace(/</g, "\\u003c")
  .replace(/\u2028/g, "\\u2028")
  .replace(/\u2029/g, "\\u2029");
let initial = "window.__initial = " + embed(doc) + ";";
if (chromeMode) {
  initial = 'window.__glyphChrome = true;\nwindow.__initialName = "selftest.md";\n' + initial;
}
let page = viewer
  .replace("/*__MARKED_JS__*/", () => marked)
  .replace("/*__INITIAL__*/", () => initial);

// Pin the inline blocks by hash exactly as Scripts/make-preview.py does, so the
// harness exercises the real shipping Content-Security-Policy rather than a
// weakened one. Computed after substitution, over the bytes between the tags.
const sha = (t) => "sha256-" + createHash("sha256").update(t, "utf8").digest("base64");
page = page.replaceAll(' nonce="/*__CSP_NONCE__*/"', "");
const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const styles = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
page = page.replace("'/*__CSP_SCRIPT__*/'", scripts.map((b) => "'" + sha(b) + "'").join(" "));
page = page.replace("'/*__CSP_STYLE__*/'", styles.map((b) => "'" + sha(b) + "'").join(" "));

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

// ---------- run the assertion suite ----------
const smoke = readFileSync(
  path.join(ROOT, "Scripts",
    fidelityMode ? "fidelity-smoke.js" : securityMode ? "security-smoke.js" : "smoke.js"), "utf8");
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

// Security mode has its own pass/fail shape and no golden document.
if (securityMode || fidelityMode) {
  const bad = Object.entries(out).filter(([k, v]) => k !== "ok" && v !== true);
  console.log("engine-smoke (" + (fidelityMode ? "fidelity" : "security") + ", Blink):");
  console.log("  " + JSON.stringify(out));
  await cleanup();
  if (bad.length) {
    console.error("\nFAILED: " + bad.map(([k, v]) => `${k}=${v}`).join(", "));
    process.exit(1);
  }
  console.log("  ALL PASS");
  process.exit(0);
}

// The standalone page must also carry the chrome: tabs, toolbar, status, and a
// working raw view. Without this the release artifact could quietly lose them.
if (chromeMode) {
  const { result: cr } = await S("Runtime.evaluate", {
    expression: `(function(){
      const r = {};
      r.chromeBar = !!document.getElementById("glyph-bar");
      r.tabs = document.querySelectorAll(".glyph-tab").length;
      r.toolButtons = document.querySelectorAll(".glyph-btn").length;
      r.status = !!document.getElementById("glyph-status");
      r.rawArea = !!document.getElementById("glyph-raw");
      r.getText = typeof window.glyphGetText === "function"
        && window.glyphGetText().length > 0;
      const rawBtn = document.querySelector('[title^="Raw markdown"]');
      if (rawBtn) {
        rawBtn.click();
        r.rawOpens = getComputedStyle(document.getElementById("glyph-raw")).display !== "none";
        r.rawHasSource = document.getElementById("glyph-raw").value.indexOf("#") >= 0;
        rawBtn.click();
        r.rawCloses = !document.body.classList.contains("glyph-raw");
      }
      document.getElementById("glyph-newtab").click();
      r.newTabOpens = document.querySelectorAll(".glyph-tab").length === 2;

      // Mobile. The viewport meta is the single most important line for a phone:
      // without it the page lays out at ~980px and is scaled down, so every
      // media query below 640px never matches and the interface arrives as a
      // shrunken desktop. It is one line and easy to drop, so it is asserted.
      const vp = document.querySelector('meta[name="viewport"]');
      r.viewportMeta = !!vp && /width=device-width/.test(vp.getAttribute("content") || "");
      r.viewportFitCover = !!vp && /viewport-fit=cover/.test(vp.getAttribute("content") || "");

      // The fixed bar's height is measured, not guessed: it is 86px on a desktop
      // and 99px on a phone, and a hardcoded value hides the first lines of the
      // document under the toolbar on one of them.
      const barEl = document.getElementById("glyph-bar");
      const barVar = getComputedStyle(document.documentElement).getPropertyValue("--glyph-bar-h").trim();
      r.barHeightMeasured = parseFloat(barVar) > 0 &&
        Math.abs(parseFloat(barVar) - barEl.getBoundingClientRect().height) < 2;
      r.barIsFixed = getComputedStyle(barEl).position === "fixed";
      r.bodyPaddingMatchesBar =
        Math.abs(parseFloat(getComputedStyle(document.body).paddingTop) -
                 barEl.getBoundingClientRect().height) < 2;

      // The reader text size control scales the DOCUMENT and leaves the chrome
      // alone, and it clamps so the page cannot be made unusable.
      const bigger = [...document.querySelectorAll(".glyph-btn")].find((b) => b.title === "Larger text");
      const smaller = [...document.querySelectorAll(".glyph-btn")].find((b) => b.title === "Smaller text");
      r.textSizeControls = !!bigger && !!smaller;
      if (bigger && smaller) {
        const chromeBefore = getComputedStyle(document.querySelector(".glyph-tab")).fontSize;
        const before = parseFloat(getComputedStyle(document.body).fontSize);
        bigger.click(); bigger.click();
        const after = parseFloat(getComputedStyle(document.body).fontSize);
        r.textSizeGrows = after > before;
        r.textSizeLeavesChromeAlone =
          getComputedStyle(document.querySelector(".glyph-tab")).fontSize === chromeBefore;
        for (let i = 0; i < 40; i++) bigger.click();
        r.textSizeClampsHigh = parseFloat(getComputedStyle(document.body).fontSize) <= 26;
        for (let i = 0; i < 80; i++) smaller.click();
        r.textSizeClampsLow = parseFloat(getComputedStyle(document.body).fontSize) >= 13;
        try { localStorage.removeItem("glyphReaderSize"); } catch (e) { /* ignore */ }
        document.body.style.removeProperty("--reader-size");
      }

      // A .txt is PLAIN TEXT: it opens in the literal view and never reaches the
      // markdown renderer, so it is saved exactly as typed.
      // Newlines come from fromCharCode because a backslash-n ANYWHERE in this
      // template literal — including in a comment — becomes a REAL newline in
      // the injected JS, which ends the comment early and breaks the syntax.
      const NL = String.fromCharCode(10);
      const plainSrc = ["* not a bullet", "#hashtag not a heading",
                        "trailing spaces   ", ""].join(NL);
      window.__glyphChromeReady("notes.txt", plainSrc);
      const plainDoc = document.querySelectorAll(".glyph-tab").length;
      r.txtOpensRaw = document.body.classList.contains("glyph-raw");
      r.txtShowsLiteralText = document.getElementById("glyph-raw").value === plainSrc;
      // Toggling the formatted view must be refused for plain text.
      const rawBtn2 = document.querySelector('[title^="Raw markdown"]');
      if (rawBtn2) rawBtn2.click();
      r.txtStaysRaw = document.body.classList.contains("glyph-raw");
      r.txtTabOpened = plainDoc >= 2;

      // A document too large to render live must fall back to the raw view
      // instead of freezing the window parsing it (the portable shell has no
      // native editor to fall back to, as the macOS app does).
      const huge = "word ".repeat(70000);  // 350000 chars, over the render limit
      document.body.classList.remove("glyph-raw");
      window.renderMarkdown(huge);
      r.bigFileGoesRaw = document.body.classList.contains("glyph-raw");
      r.bigFileTextIntact = document.getElementById("glyph-raw").value.length > 300000;
      return JSON.stringify(r);
    })()`,
    returnByValue: true,
  });
  Object.assign(out, JSON.parse(cr.value));
}
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
