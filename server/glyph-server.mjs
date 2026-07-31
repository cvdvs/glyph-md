// Glyph server — read and edit a folder of .md files from your phone.
//
//   node server/glyph-server.mjs ~/Documents/drafts
//
// It runs on the always-on machine (a Mac mini) and serves the SAME Glyph
// interface the desktop app uses, plus a list of the .md files in one folder.
// A phone on the same wifi opens it in a browser and edits the files directly —
// there is ONE copy of every file, on this machine, so it is genuinely
// real-time and there is nothing to sync and no conflict to resolve. Close the
// phone and the edit is already on disk here.
//
// Node standard library only — no npm, nothing to install (same rule as the
// rest of the project). Node 18+.
//
// SECURITY, because this writes files over the network:
//   - Every /api call needs a token. The token is printed once at startup and
//     lives in ~/.config/glyph/server-token, stable across restarts, so a phone
//     pairs once. Without it, the API answers 401.
//   - Every path is sandboxed to the served folder: a request can never read or
//     write a file outside it (the GlyphVault discipline — a name, resolved and
//     re-checked against the root, symlinks defeated).
//   - Only .md/.markdown files are listed, read and written.
//   - Bind is LAN-wide so the phone can reach it, but it is meant for a home
//     network behind a router. Do NOT port-forward it to the open internet; for
//     access away from home use a private tunnel (Tailscale), which is
//     encrypted and stays off the public net.
import { createServer } from "node:http";
import { readFile, writeFile, readdir, stat, rename, mkdir } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { networkInterfaces, homedir, hostname } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

const MD_EXT = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const SKIP_DIRS = new Set([".git", ".obsidian", "node_modules", ".trash", ".DS_Store"]);
const MAX_FILES = 5000;
const MAX_WRITE_BYTES = 25 * 1024 * 1024;  // a .md note far past anything real

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const port = Number(
  (process.argv.find((a) => a.startsWith("--port=")) || "").split("=")[1] || 4321);
if (args.length !== 1) {
  console.error("usage: node server/glyph-server.mjs <folder-of-md-files> [--port=4321]");
  process.exit(2);
}
let ROOT;
try {
  ROOT = realpathSync(path.resolve(args[0]));  // canonical, symlinks resolved
} catch {
  console.error(`glyph-server: no such folder: ${args[0]}`);
  process.exit(1);
}

// ---------------------------------------------------------------- the token
// Stable across restarts so a phone pairs once, and 0600 so other users on the
// machine cannot read it.
async function loadOrCreateToken() {
  const dir = path.join(homedir(), ".config", "glyph");
  const file = path.join(dir, "server-token");
  try {
    const t = (await readFile(file, "utf8")).trim();
    if (t.length >= 32) return t;
  } catch { /* fall through and create one */ }
  const t = randomBytes(24).toString("hex");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(file, t + "\n", { mode: 0o600 });
  return t;
}
const TOKEN = await loadOrCreateToken();

function tokenOk(req) {
  const header = req.headers["authorization"] || "";
  const got = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (got.length !== TOKEN.length) return false;
  // Constant-time compare so a wrong token cannot be guessed byte by byte.
  return timingSafeEqual(Buffer.from(got), Buffer.from(TOKEN));
}

// ------------------------------------------------------------ path sandbox
// A client path is a NAME under the root, never a way out of it. Reject
// absolute paths, parent traversal, and null bytes before touching the disk,
// then resolve and require the result to stay inside the root. For an existing
// file, realpath defeats a symlink that points out; for a new file, the parent
// must resolve inside the root.
function resolveInRoot(rel) {
  if (typeof rel !== "string" || rel === "" || rel.includes("\0")) return null;
  if (path.isAbsolute(rel)) return null;
  // Reject a parent-traversal segment outright. Sanitizing "../x" into "x"
  // would silently write a DIFFERENT file than the client named and report
  // success — surprising, and a foothold for confusion. A "name" has no "..".
  const parts = rel.split(/[/\\]+/);
  if (parts.some((seg) => seg === ".." || seg === ".")) return null;
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

function isMarkdown(p) {
  return MD_EXT.has(path.extname(p).toLowerCase());
}

// ------------------------------------------------------------- file listing
async function listFiles() {
  const out = [];
  async function walk(dir, relBase) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = relBase ? relBase + "/" + e.name : e.name;
      if (e.isDirectory()) {
        await walk(abs, rel);
      } else if (e.isFile() && isMarkdown(e.name)) {
        try {
          const s = await stat(abs);
          out.push({ path: rel, name: e.name, size: s.size, mtime: Math.floor(s.mtimeMs) });
        } catch { /* skip unreadable */ }
      }
    }
  }
  await walk(ROOT, "");
  out.sort((a, b) => b.mtime - a.mtime);  // most-recently-edited first
  return out;
}

// ------------------------------------------------------------- atomic write
async function writeAtomic(abs, text) {
  const tmp = abs + ".glyph-tmp";
  await writeFile(tmp, text, { encoding: "utf8", mode: 0o644 });
  await rename(tmp, abs);
}

// --------------------------------------------------------- the served page
// The same viewer.html the desktop app uses, composed with the chrome layer on
// and a `server` flag. The Content-Security-Policy is pinned by hash (a static
// page has no per-load nonce step) and relaxed ONLY to connect-src 'self', so
// the page's own scripts may call this server's API. A note still cannot: its
// scripts are blocked by the script-src hash allowlist, so connect-src 'self'
// grants the trusted chrome layer a channel to the API and grants a document
// nothing.
function sha(text) {
  return "sha256-" + createHash("sha256").update(text, "utf8").digest("base64");
}

async function composePage() {
  const viewer = await readFile(path.join(REPO, "Resources", "viewer.html"), "utf8");
  const marked = await readFile(path.join(REPO, "Resources", "marked.min.js"), "utf8");

  const initial =
    "window.__glyphChrome = true;\n" +
    "window.__glyphServer = true;\n" +
    'window.__glyphPlatform = "web";\n' +
    'window.__initialName = "";\n' +
    "window.__initial = \"\";";

  let page = viewer
    .replace("/*__MARKED_JS__*/", () => marked)
    .replace("/*__INITIAL__*/", () => initial)
    .replace("connect-src 'none'", "connect-src 'self'")
    .replaceAll(' nonce="/*__CSP_NONCE__*/"', "");

  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const styles = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  page = page.replace("'/*__CSP_SCRIPT__*/'", scripts.map((b) => "'" + sha(b) + "'").join(" "));
  page = page.replace("'/*__CSP_STYLE__*/'", styles.map((b) => "'" + sha(b) + "'").join(" "));
  return page;
}
let PAGE = await composePage();

// ------------------------------------------------------------------ routing
function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" });
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    // The interface. Public to serve, useless without a token, so serving it
    // discloses nothing.
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      return send(res, 200, PAGE, { "Content-Type": "text/html; charset=utf-8" });
    }

    // Everything under /api needs the token.
    if (p.startsWith("/api/")) {
      if (!tokenOk(req)) return json(res, 401, { error: "unauthorized" });

      if (req.method === "GET" && p === "/api/files") {
        return json(res, 200, { root: path.basename(ROOT), files: await listFiles() });
      }

      if (req.method === "GET" && p === "/api/file") {
        const abs = resolveInRoot(url.searchParams.get("path") || "");
        if (!abs || !isMarkdown(abs)) return json(res, 400, { error: "bad path" });
        try {
          const real = realpathSync(abs);
          if (real !== ROOT && !real.startsWith(ROOT + path.sep)) {
            return json(res, 400, { error: "bad path" });  // symlink out
          }
          const [text, s] = await Promise.all([readFile(real, "utf8"), stat(real)]);
          return json(res, 200, { path: url.searchParams.get("path"), text, mtime: Math.floor(s.mtimeMs) });
        } catch {
          return json(res, 404, { error: "not found" });
        }
      }

      if (req.method === "PUT" && p === "/api/file") {
        let body;
        try {
          body = JSON.parse((await readBody(req, MAX_WRITE_BYTES)).toString("utf8"));
        } catch {
          return json(res, 400, { error: "bad body" });
        }
        const abs = resolveInRoot(body && body.path);
        if (!abs || !isMarkdown(abs) || typeof body.text !== "string") {
          return json(res, 400, { error: "bad path" });
        }
        // If the file changed on disk since the phone loaded it (edited on the
        // Mac at the same time), refuse rather than clobber the newer version.
        // The one true "conflict" case even with a single source of truth.
        try {
          const s = await stat(abs);
          if (typeof body.baseMtime === "number" && Math.floor(s.mtimeMs) > body.baseMtime + 1) {
            return json(res, 409, { error: "changed on disk", mtime: Math.floor(s.mtimeMs) });
          }
          // Do not follow a symlink that points out of the root.
          const real = realpathSync(abs);
          if (real !== ROOT && !real.startsWith(ROOT + path.sep)) {
            return json(res, 400, { error: "bad path" });
          }
        } catch { /* new file: fine, the parent is already inside the root */ }
        await writeAtomic(abs, body.text);
        const s2 = await stat(abs);
        return json(res, 200, { path: body.path, mtime: Math.floor(s2.mtimeMs) });
      }

      return json(res, 404, { error: "no such endpoint" });
    }

    return send(res, 404, "not found", { "Content-Type": "text/plain" });
  } catch (e) {
    return json(res, 500, { error: "server error" });
  }
});

// ------------------------------------------------------------------- startup
function lanAddresses() {
  const out = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(port, "0.0.0.0", () => {
  const host = hostname().replace(/\.local$/, "");
  const addrs = lanAddresses();
  const primary = addrs[0] || "127.0.0.1";
  const link = `http://${primary}:${port}/#token=${TOKEN}`;
  console.log("");
  console.log("  Glyph server is running.");
  console.log(`  Serving:  ${ROOT}`);
  console.log("");
  console.log("  On your phone (same wifi), open this ONCE — it remembers the token:");
  console.log("");
  console.log(`      ${link}`);
  console.log("");
  console.log(`  Or by name:  http://${host}.local:${port}/#token=${TOKEN}`);
  if (addrs.length > 1) {
    console.log(`  Other addresses: ${addrs.slice(1).join(", ")}`);
  }
  console.log("");
  console.log("  Keep this on the home wifi. Do not port-forward it to the internet;");
  console.log("  for access away from home, use Tailscale.  Ctrl-C to stop.");
  console.log("");
});
