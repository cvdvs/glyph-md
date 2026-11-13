// Glyph server — read and edit a folder of notes from your phone.
//
//   node server/glyph-server.mjs ~/Documents/drafts
//
// It runs on the always-on machine (a Mac mini) and serves the SAME Glyph
// interface the desktop app uses, plus a list of the text files in one folder.
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
//   - Only markdown and plain-text files are listed, read and written. A .txt
//     is served literally and saved byte for byte — the page pins it to its
//     literal view, so the markdown renderer never reformats a plain file.
//   - A PDF is listed and read, never written, and the phone's browser does the
//     parsing, so this machine never interprets one.
//   - Voice notes are transcribed HERE, by a separate Python process
//     (server/whisper-worker.py), started with an argument list and never a
//     shell. The audio goes to a random 0600 temp file that is deleted after
//     every job, and neither the audio nor what was said is ever logged.
//   - Bind is LAN-wide so the phone can reach it, but it is meant for a home
//     network behind a router. Do NOT port-forward it to the open internet; for
//     access away from home use a private tunnel (Tailscale), which is
//     encrypted and stays off the public net.
import { createServer } from "node:http";
import { readFile, writeFile, readdir, stat, lstat, rename, mkdir, unlink, link, open } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync, existsSync, readFileSync, accessSync, statSync, lstatSync, constants as FS } from "node:fs";
import { execFileSync, execFile, spawn } from "node:child_process";
import { networkInterfaces, homedir, hostname, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

// Markdown is rendered; plain text is served literally and saved byte for byte
// (the page pins a .txt to its literal view). Both are text files the owner
// wants to read on her phone, so both are served.
const MD_EXT = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const PLAIN_EXT = new Set([".txt", ".text", ".log"]);
const SKIP_DIRS = new Set([".git", ".obsidian", "node_modules", ".trash", ".DS_Store"]);
const MAX_FILES = 5000;
const MAX_WRITE_BYTES = 25 * 1024 * 1024;  // a .md note far past anything real
const MAX_LOG_BYTES = 8 * 1024;

// Optional settings: the HTTPS address (secure-origin) and which Python to use
// (python). The pairing token is deliberately NOT read from here — it stays at
// ~/.config/glyph/server-token whatever this says (rule 44), so pointing this
// somewhere else, as the tests do, can never mint or move a token.
const CONFIG_DIR = process.env.GLYPH_CONFIG_DIR || path.join(homedir(), ".config", "glyph");

// ---------------------------------------------------------------- arguments
const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const port = Number(
  (process.argv.find((a) => a.startsWith("--port=")) || "").split("=")[1] || 4321);
if (args.length !== 1) {
  console.error("usage: node server/glyph-server.mjs <folder-of-notes> [--port=4321]");
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

const TOKEN_BYTES = Buffer.from(TOKEN, "utf8");
function tokenOk(req) {
  const header = req.headers["authorization"] || "";
  const got = header.startsWith("Bearer ") ? header.slice(7) : "";
  const g = Buffer.from(got, "utf8");
  // Compare BYTE length, not string length: timingSafeEqual throws on unequal
  // buffers, so a same-code-unit-length multibyte token would have crashed the
  // request into a 500 instead of a clean 401.
  if (g.length !== TOKEN_BYTES.length) return false;
  return timingSafeEqual(g, TOKEN_BYTES);
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

function isServable(p) {
  const e = path.extname(p).toLowerCase();
  return MD_EXT.has(e) || PLAIN_EXT.has(e);
}

// Kept out of isServable on purpose: that check also guards the write route, and
// a PDF or a book must never be writable.
function isPdf(p) {
  return path.extname(p).toLowerCase() === ".pdf";
}
function isBook(p) {
  return path.extname(p).toLowerCase() === ".epub";
}

// ------------------------------------------------------- titles and previews
// The list shows each note the way Apple Notes does: a title (the first heading,
// or else the first line) and one line of what follows. Only the first 8KB of a
// note is read, only for notes up to 4MB, and the result is remembered until
// the file's mtime or size changes, so a list of a thousand notes reads almost
// nothing after the first time. It is display text: markdown is stripped, and
// nothing here ever writes.
const HEAD_BYTES = 8 * 1024;
const HEAD_MAX_FILE = 4 * 1024 * 1024;
const TITLE_MAX = 120;
const PREVIEW_MAX = 160;
const metaCache = new Map();  // absolute path -> { mtimeMs, size, title, preview }

function stem(name) {
  return path.basename(name, path.extname(name));
}

function clip(s, max) {
  const chars = [...s];
  if (chars.length <= max) return s;
  let cut = chars.slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  if (space > max * 0.6) cut = cut.slice(0, space);
  return cut.replace(/[\s.,;:]+$/u, "") + "…";
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

// Every quantifier is bounded: a note is untrusted, and an unbounded one next
// to a backreference is how the parsers froze before (rule 16).
function stripInline(s) {
  s = s
    .replace(/`+/g, "")                                                    // code ticks
    .replace(/!\[\[[^\]\n]{0,500}\]\]/g, "")                               // ![[embed]]
    .replace(/!\[[^\]\n]{0,500}\]\([^)\n]{0,2000}\)/g, "")                 // ![alt](src)
    .replace(/\[\[[^\]|\n]{0,500}?\\?\|([^\]\n]{0,500})\]\]/g, "$1")       // [[a|b]] -> b
    .replace(/\[\[([^\]\n]{0,500})\]\]/g, "$1")                            // [[a]] -> a
    .replace(/\[\^[^\]\n]{0,100}\]/g, "")                                  // footnote mark
    .replace(/\[([^\]\n]{0,500})\]\([^)\n]{0,2000}\)/g, "$1")              // [text](url)
    .replace(/\[([^\]\n]{0,500})\]\[[^\]\n]{0,200}\]/g, "$1")              // [text][ref]
    .replace(/<((?:https?|mailto):[^>\s]{1,2000})>/g, "$1")                // <autolink>
    .replace(/<\/?[A-Za-z][^>\n]{0,500}>/g, "")                            // html tags
    .replace(/(\*\*|__|~~|==)(?=\S)([^\n]{0,300}?\S)\1/g, "$2")            // **b** ~~s~~ ==h==
    .replace(/(^|[^\w*\\])\*(?=\S)([^*\n]{0,300}?\S)\*(?![\w*])/g, "$1$2") // *i*
    .replace(/(^|[^\w\\])_(?=\S)([^_\n]{0,300}?\S)_(?!\w)/g, "$1$2")       // _i_, not snake_case
    .replace(/\s\^[A-Za-z0-9-]{1,64}\s*$/, "");                            // block id
  return s;
}

function stripLine(raw) {
  let s = raw.length > 2000 ? raw.slice(0, 2000) : raw;
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(s)) return "";                 // rule
  if (/^\s{0,3}=+\s*$/.test(s)) return "";                                  // setext underline
  if (s.includes("|") && /^[\s|:-]*-[\s|:-]*$/.test(s)) return "";          // table divider
  if (/^\s{0,3}\[[^\]^\n][^\]\n]{0,200}\]:\s/.test(s)) return "";           // link definition
  s = s
    .replace(/^(\s{0,3}>\s?)+/, "")                                         // quote
    .replace(/^\[![^\]\n]{0,64}\][+-]?\s*/, "")                             // callout
    .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+/, "")                            // list marker
    .replace(/^\[[ xX/-]\]\s+/, "")                                         // task box
    .replace(/^\s{0,3}#{1,6}(?:\s+|$)/, "")                                 // ATX heading
    .replace(/\s+#+\s*$/, "")
    .replace(/^\[\^[^\]\n]{1,100}\]:\s*/, "");                              // footnote text
  const tableRow = /^\s*\|/.test(s);
  s = stripInline(s);
  if (tableRow) s = s.replace(/(^|[^\\])\|/g, "$1 ");
  return s
    .replace(/\\([\\`*_{}[\]()#+\-.!|~=<>])/g, "$1")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (m, e) => ENTITIES[e])
    .replace(/[\u0000-\u001f\u007f�]/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

// truncated: the text is only the head of a longer file.
function titleAndPreview(text, name, truncated) {
  let t = text.replace(/^﻿/, "");
  if (/^---[ \t]*\r?\n/.test(t)) {
    const end = /\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(t.slice(3));
    if (end) t = t.slice(3 + end.index + end[0].length);
    else if (truncated) return { title: stem(name), preview: "" };  // all frontmatter so far
  }
  // Comments are invisible on the page, so they are invisible here.
  t = t.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/%%[\s\S]*?(?:%%|$)/g, "");

  let title = "";
  const rest = [];
  let restLen = 0;
  let fence = null;
  for (const raw of t.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    let line;
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length &&
          /^\s{0,3}[`~]+\s*$/.test(raw)) {
        fence = null;
        continue;
      }
      line = raw.replace(/[\u0000-\u001f\u007f�]/g, " ").replace(/\s+/gu, " ").trim();
    } else if (marker) {
      fence = marker[1];  // the marker is skipped, the code inside is text
      continue;
    } else {
      line = stripLine(raw);
    }
    if (!line) continue;
    if (!title) { title = line; continue; }
    rest.push(line);
    restLen += line.length + 1;
    if (restLen > PREVIEW_MAX + 40) break;
  }
  if (!title) return { title: stem(name), preview: "" };
  return { title: clip(title, TITLE_MAX), preview: clip(rest.join(" "), PREVIEW_MAX) };
}

async function readHead(abs) {
  // O_NOFOLLOW: the walk only lists regular files, and this keeps it that way
  // if a file is swapped for a link between the listing and the read.
  const fh = await open(abs, FS.O_RDONLY | (FS.O_NOFOLLOW || 0));
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function fileMeta(abs, name, s) {
  const hit = metaCache.get(abs);
  if (hit && hit.mtimeMs === s.mtimeMs && hit.size === s.size) return hit;
  let meta = { title: stem(name), preview: "" };
  if (isServable(name) && s.size > 0 && s.size <= HEAD_MAX_FILE) {
    try {
      const head = await readHead(abs);
      meta = titleAndPreview(head.toString("utf8"), name, s.size > head.length);
    } catch {
      return meta;  // not remembered: it may read fine next time
    }
  }
  const entry = { mtimeMs: s.mtimeMs, size: s.size, ...meta };
  metaCache.set(abs, entry);
  return entry;
}

async function eachLimited(items, limit, fn) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

// ------------------------------------------------------------- file listing
async function listFiles() {
  const found = [];
  const folders = [];
  async function walk(dir, relBase) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= MAX_FILES) return;
      if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const rel = relBase ? relBase + "/" + e.name : e.name;
      if (e.isDirectory()) {
        if (folders.length < MAX_FILES) folders.push(rel);
        await walk(abs, rel);
      } else if (e.isFile() && (isServable(e.name) || isPdf(e.name) || isBook(e.name))) {
        try {
          found.push({ abs, rel, name: e.name, s: await stat(abs) });
        } catch { /* skip unreadable */ }
      }
    }
  }
  await walk(ROOT, "");
  const out = new Array(found.length);
  const pinned = await loadPins();
  await eachLimited(found, 16, async ({ abs, rel, name, s }, i) => {
    const { title, preview } = await fileMeta(abs, name, s);
    out[i] = { path: rel, name, size: s.size, mtime: Math.floor(s.mtimeMs), title, preview };
    if (pinned.has(rel)) out[i].pinned = true;
  });
  // Forget files that are gone (renamed, deleted), so the cache cannot grow forever.
  const seen = new Set(found.map((f) => f.abs));
  for (const k of metaCache.keys()) if (!seen.has(k)) metaCache.delete(k);
  out.sort((a, b) => b.mtime - a.mtime);  // most-recently-edited first
  return { files: out, folders };
}

// ------------------------------------------------------- folder management
// The Mac's own Trash, so nothing sent there from the phone is gone for good.
const TRASH_DIR = process.env.GLYPH_TRASH_DIR || path.join(homedir(), ".Trash");

// A path the library shows: no hidden or skipped folder anywhere along it, so a
// request can never reach .git, .obsidian or anything else the list leaves out.
function listedPath(rel) {
  return rel.split("/").every((seg) => seg && !seg.startsWith(".") && !SKIP_DIRS.has(seg));
}
function relOf(abs) {
  return path.relative(ROOT, abs).split(path.sep).join("/");
}
// Something that can be moved or sent to the Trash: a note, a PDF, a book or a
// folder, really inside the root. Never the root itself and never a symlink:
// moving a link moves only the link, and a link can point anywhere.
async function movable(rel) {
  const abs = resolveInRoot(rel);
  if (!abs || abs === ROOT || !listedPath(rel)) return { error: 400 };
  let st;
  try {
    st = await lstat(abs);
  } catch {
    return { error: 404 };
  }
  if (st.isSymbolicLink()) return { error: 400 };
  try {
    if (!inRoot(realpathSync(path.dirname(abs))) || !inRoot(realpathSync(abs))) return { error: 400 };
  } catch {
    return { error: 400 };
  }
  if (st.isDirectory()) return { abs, st, dir: true };
  if (st.isFile() && (isServable(abs) || isPdf(abs) || isBook(abs))) return { abs, st, dir: false };
  return { error: 400 };
}
// A folder something can be put in: an existing, real folder in the root, not a
// link to one. Returns its real path.
function intoFolder(abs) {
  try {
    if (abs !== ROOT && lstatSync(abs).isSymbolicLink()) return null;
    const real = realpathSync(abs);
    return inRoot(real) && statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- pins
// Pinned notes are kept on the Mac, so the phone and the Mac window show the
// same ones. One small file per served folder, in Glyph's own settings folder:
// never in the notes themselves, which Obsidian and git also read.
const PINS_FILE = path.join(CONFIG_DIR,
  "pins-" + createHash("sha256").update(ROOT).digest("hex").slice(0, 12) + ".json");
const MAX_PINS = 500;
let pins = null;
let pinsSaving = Promise.resolve();
async function loadPins() {
  if (pins) return pins;
  try {
    const list = JSON.parse(await readFile(PINS_FILE, "utf8"));
    pins = new Set(Array.isArray(list) ? list.filter((x) => typeof x === "string").slice(0, MAX_PINS) : []);
  } catch {
    pins = new Set();
  }
  return pins;
}
// One write at a time, through a fresh temp file renamed into place, so a link
// planted at the pins file's name is replaced rather than written through.
function savePins() {
  const text = JSON.stringify([...pins]);
  pinsSaving = pinsSaving.then(async () => {
    try {
      await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
      const tmp = PINS_FILE + "." + randomBytes(6).toString("hex") + ".tmp";
      await writeFile(tmp, text, { mode: 0o600, flag: "wx" });
      await rename(tmp, PINS_FILE);
    } catch {
      console.log("glyph-pins: could not save the pinned notes");
    }
  });
  return pinsSaving;
}
// After a move, a pin follows its note; after the Trash, it goes, and comes
// back with Undo. Returns the pins it took away.
async function movePins(from, to, dir) {
  await loadPins();
  const gone = [];
  for (const p of [...pins]) {
    const hit = p === from || (dir && p.startsWith(from + "/"));
    if (!hit) continue;
    pins.delete(p);
    gone.push(p);
    if (to !== null) pins.add(to + p.slice(from.length));
  }
  if (gone.length) await savePins();
  return gone;
}

// Undo for the Trash: only what this server put there itself, for a quarter of
// an hour, and only back to where it came from. Anything else in the Trash is
// the Mac's business; letting a request pull an arbitrary file out of it into
// the served folder would make it readable from the phone.
const UNDO_MS = 15 * 60 * 1000;
const trashPrint = (st) => [st.dev, st.ino, st.size, st.mtimeMs, st.birthtimeMs].join(":");
const trashed = new Map();
function rememberTrashed(item) {
  const now = Date.now();
  for (const [k, v] of trashed) if (now - v.at > UNDO_MS) trashed.delete(k);
  while (trashed.size >= 50) trashed.delete(trashed.keys().next().value);
  const id = randomBytes(16).toString("hex");
  trashed.set(id, { ...item, at: now });
  return id;
}

// ------------------------------------------------------------- atomic write
// exclusive: never replace anything at abs, not even a dangling symlink. The
// temp file is hard-linked into place, and link() refuses an existing name, so
// a file that appears after the caller looked is still not overwritten.
async function writeAtomic(abs, text, { exclusive = false } = {}) {
  // A RANDOM temp name created with O_EXCL ("wx"). If the served folder holds
  // untrusted content (cloned repos, downloads, shared vaults — the project's
  // standing threat model, and git preserves symlinks), an attacker can plant a
  // symlink at the OLD predictable temp path "<note>.glyph-tmp" pointing at, say,
  // ~/.zshrc; the plain write followed it and overwrote the outside file on the
  // next edit. O_EXCL refuses to open ANY existing entry, symlink included, and
  // the random suffix also stops two concurrent writers sharing a temp file.
  const tmp = abs + "." + randomBytes(6).toString("hex") + ".glyph-tmp";
  try {
    await writeFile(tmp, text, { encoding: "utf8", mode: 0o644, flag: "wx" });
    if (!exclusive) {
      await rename(tmp, abs);
      return;
    }
    try {
      await link(tmp, abs);
    } catch (e) {
      // A volume with no hard links (exFAT): check, then rename.
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(e.code)) throw e;
      if (await lstat(abs).then(() => true, () => false)) {
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }
      await rename(tmp, abs);
      return;
    }
    await unlink(tmp).catch(() => {});
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

function inRoot(real) {
  return real === ROOT || real.startsWith(ROOT + path.sep);
}

// A new note name typed on a phone: one plain name, never a path or a hidden
// file, short enough for any filesystem.
function plainName(n) {
  if (!n || n.startsWith(".") || /[/\\]/.test(n) || /[\u0000-\u001f\u007f-\u009f]/.test(n)) return false;
  if ([...n].length > 120 || Buffer.byteLength(n, "utf8") > 255) return false;
  return stem(n).trim() !== "";
}

// --------------------------------------------------------- the served page
// PDF.js reads PDFs inside the phone's browser. These are Mozilla's own files,
// unmodified. They are named by a hash of their contents so a phone caches them
// once and an upgrade can never leave it holding a mismatched pair.
const PDFJS = new Map(["pdf.min.mjs", "pdf.worker.min.mjs"].map((f) => [
  "/vendor/pdfjs/" + f, readFileSync(path.join(HERE, "vendor", "pdfjs", f)),
]));
// The decoders for scanned pages. Named by the same hash through their folder,
// because PDF.js builds their addresses itself and leaves no room for a ?v=.
const DECODERS = ["jbig2.wasm", "openjpeg.wasm"].map((f) => [
  f, readFileSync(path.join(HERE, "vendor", "pdfjs", "wasm", f)),
]);
const PDFJS_V = createHash("sha256")
  .update(Buffer.concat([...PDFJS.values(), ...DECODERS.map(([, bytes]) => bytes)]))
  .digest("hex").slice(0, 10);
const PDFJS_WASM = new Map(DECODERS.map(([f, bytes]) => [`/vendor/pdfjs/${PDFJS_V}/${f}`, bytes]));

// The same viewer.html the desktop app uses, composed with the chrome layer on
// and a `server` flag. The Content-Security-Policy is pinned by hash (a static
// page has no per-load nonce step) and relaxed ONLY to connect-src 'self', so
// the page's own scripts may call this server's API, and to 'self' for scripts
// and workers, so the page can load PDF.js. A note still cannot run anything:
// the sanitizer removes its script tags, and everything this server answers
// without a token is either HTML (refused as a script by nosniff), an icon, or
// PDF.js itself. So these grant the trusted chrome layer what it needs and grant
// a document nothing.
function sha(text) {
  return "sha256-" + createHash("sha256").update(text, "utf8").digest("base64");
}

function iconVersion() {
  try {
    const bytes = readFileSync(path.join(REPO, "assets", "apple-touch-icon.png"));
    return createHash("sha256").update(bytes).digest("hex").slice(0, 10);
  } catch {
    return "0";
  }
}

async function composePage() {
  const viewer = await readFile(path.join(REPO, "Resources", "viewer.html"), "utf8");
  const marked = await readFile(path.join(REPO, "Resources", "marked.min.js"), "utf8");

  const initial =
    "window.__glyphChrome = true;\n" +
    "window.__glyphServer = true;\n" +
    'window.__glyphPlatform = "web";\n' +
    `window.__glyphPdfJs = "/vendor/pdfjs/pdf.min.mjs?v=${PDFJS_V}";\n` +
    `window.__glyphPdfWorker = "/vendor/pdfjs/pdf.worker.min.mjs?v=${PDFJS_V}";\n` +
    `window.__glyphPdfWasm = "/vendor/pdfjs/${PDFJS_V}/";\n` +
    'window.__initialName = "";\n' +
    "window.__initial = \"\";";

  // Added to the SERVED page only: an app added to the iOS home screen needs an
  // icon and a display mode, and neither means anything to the desktop builds.
  // The icon is a separate request rather than a data: URI so it does not add
  // 47KB of base64 to every build of the app on three platforms.
  const ICON_V = iconVersion();
  const iosTags = [
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=${ICON_V}">`,
    `<link rel="icon" href="/apple-touch-icon.png?v=${ICON_V}">`,
    // Opens without Safari's chrome, so it feels like an app rather than a page.
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-title" content="Glyph">',
    // black-translucent lets the page run under the status bar; the viewport
    // already carries viewport-fit=cover and the CSS pads for the safe area.
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
    '<meta name="theme-color" content="#1e1e26">',
  ].join("\n");

  let page = viewer
    .replace("/*__MARKED_JS__*/", () => marked)
    .replace("/*__INITIAL__*/", () => initial)
    .replace("connect-src 'none'", "connect-src 'self'; worker-src 'self'")
    .replace("<meta charset=\"utf-8\">", '<meta charset="utf-8">\n' + iosTags)
    .replaceAll(' nonce="/*__CSP_NONCE__*/"', "");

  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const styles = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  page = page.replace("'/*__CSP_SCRIPT__*/'", ["'self'", ...scripts.map((b) => "'" + sha(b) + "'")].join(" "));
  page = page.replace("'/*__CSP_STYLE__*/'", styles.map((b) => "'" + sha(b) + "'").join(" "));
  return page;
}
let PAGE = await composePage();

// ------------------------------------------------------------ secure origin
// The HTTPS address of this same server (a `tailscale serve` front door), if
// there is one. A phone's microphone only works on an https page, so the page
// asks for this and offers to move there. One line in CONFIG_DIR/secure-origin,
// and only a bare https origin is ever handed out.
async function secureOrigin() {
  try {
    const line = (await readFile(path.join(CONFIG_DIR, "secure-origin"), "utf8")).split(/\r?\n/)[0].trim();
    const m = /^https:\/\/[a-z0-9.-]+(?::(\d{1,5}))?$/i.exec(line);
    if (!m || (m[1] && Number(m[1]) > 65535)) return null;
    return line;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------- voice
// A voice note is recorded on the phone and transcribed here by mlx_whisper, in
// server/whisper-worker.py: a separate, persistent Python process that holds the
// model in memory, started on the first transcription and stopped after 15 idle
// minutes. One job at a time. Audio and transcripts are never logged — only
// sizes and durations.
const AUDIO_TYPES = new Map([
  ["audio/mp4", ".m4a"], ["audio/x-m4a", ".m4a"], ["audio/aac", ".aac"],
  ["audio/webm", ".webm"], ["audio/ogg", ".ogg"], ["audio/wav", ".wav"],
  ["audio/x-wav", ".wav"], ["audio/mpeg", ".mp3"],
]);
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;
// Recordings are kept only while this folder exists, which is how its owner says
// yes: they are her voice and what she said, so it is opt-in and stays in Glyph's
// own settings folder, never in the notes. They are there to compare models on
// her real speech (Scripts/voice-compare.py); delete the folder and it stops.
const SAMPLES_DIR = path.join(CONFIG_DIR, "voice-samples");
async function keepSample(audio, ext, info) {
  try {
    const st = await lstat(SAMPLES_DIR);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  const name = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(3).toString("hex");
  try {
    await writeFile(path.join(SAMPLES_DIR, name + ext), audio, { mode: 0o600, flag: "wx" });
    await writeFile(path.join(SAMPLES_DIR, name + ".json"), JSON.stringify(info, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
const VOICE_TIMEOUT_MS = Number(process.env.GLYPH_VOICE_TIMEOUT_MS) || 120_000;  // the env is for tests
const VOICE_IDLE_MS = 15 * 60_000;
const VOICE_RECHECK_MS = 60_000;
const VOICE_QUEUE_MAX = 4;
const PARAGRAPH_GAP = 1.5;  // seconds of silence that start a new paragraph
// A LaunchAgent has almost no PATH, and mlx_whisper runs `ffmpeg` by name.
const WORKER_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

// GLYPH_WHISPER_CMD replaces Python and the worker with any program that speaks
// the same JSON lines (Scripts/fake-whisper.mjs, for the tests). Set but not a
// JSON array of strings means voice is off — never a silent fall back to Python.
const WHISPER_CMD = (() => {
  const raw = process.env.GLYPH_WHISPER_CMD;
  if (!raw) return undefined;
  try {
    const a = JSON.parse(raw);
    if (Array.isArray(a) && a.length && a.every((x) => typeof x === "string" && x)) return a;
  } catch { /* reported below */ }
  console.log("glyph-voice: GLYPH_WHISPER_CMD is not a JSON array of strings; voice is off");
  return null;
})();

function workerEnv() {
  const dirs = (process.env.PATH || "").split(":").filter(Boolean);
  return {
    ...process.env,
    PATH: [...new Set([...dirs, ...WORKER_PATH])].join(":"),
    HF_HUB_OFFLINE: "1",           // never download a model from here
    HF_HUB_DISABLE_TELEMETRY: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONSAFEPATH: "1",           // no module is ever imported from the working folder
  };
}

function isExecutable(p) {
  try {
    accessSync(p, FS.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function pythonCandidates() {
  const out = [];
  if (process.env.GLYPH_PYTHON) out.push(process.env.GLYPH_PYTHON);
  try {
    const line = readFileSync(path.join(CONFIG_DIR, "python"), "utf8").split(/\r?\n/)[0].trim();
    if (path.isAbsolute(line) && !/[\u0000-\u001f]/.test(line)) out.push(line);
  } catch { /* no such file */ }
  const onPath = (process.env.PATH || "").split(":")
    .filter((d) => path.isAbsolute(d)).map((d) => path.join(d, "python3")).find(isExecutable);
  if (onPath) out.push(onPath);
  out.push("/opt/homebrew/bin/python3", "/usr/local/bin/python3");
  return [...new Set(out)];
}

// cwd is this folder, which holds no Python modules, so `-c` cannot pick up a
// planted numpy.py from wherever the server was started.
function importsWhisper(python) {
  return new Promise((resolve) => {
    execFile(python, ["-c", "import mlx_whisper"],
      { cwd: HERE, env: workerEnv(), timeout: 20_000, killSignal: "SIGKILL", windowsHide: true },
      (err) => resolve(!err));
  });
}

const voice = { available: false, python: null, checkedAt: 0, checking: null };

function checkVoice() {
  if (!voice.checking) {
    voice.checking = (async () => {
      for (const py of pythonCandidates()) {
        if (await importsWhisper(py)) {
          voice.python = py;
          voice.available = true;
          break;
        }
      }
      voice.checkedAt = Date.now();
      voice.checking = null;
      console.log(voice.available
        ? `glyph-voice: ready, using ${voice.python}`
        : "glyph-voice: off, no Python with mlx_whisper was found");
      return voice.available;
    })();
  }
  return voice.checking;
}

async function voiceAvailable() {
  if (WHISPER_CMD !== undefined) return !!WHISPER_CMD;
  if (voice.available) return true;
  if (!voice.checking && Date.now() - voice.checkedAt > VOICE_RECHECK_MS) checkVoice();
  if (voice.checking) {
    await Promise.race([voice.checking, new Promise((r) => setTimeout(r, 25_000).unref())]);
  }
  return voice.available;
}

const worker = { proc: null, buf: "", job: null, idle: null, nextId: 1, startedAt: 0 };

function armIdle() {
  clearTimeout(worker.idle);
  worker.idle = setTimeout(() => {
    if (worker.job || !worker.proc) return;
    const proc = worker.proc;
    worker.proc = null;
    proc.kill("SIGTERM");
  }, VOICE_IDLE_MS);
  worker.idle.unref();
}

function startWorker() {
  if (worker.proc) return worker.proc;
  const [cmd, ...argv] = WHISPER_CMD || [voice.python, path.join(HERE, "whisper-worker.py")];
  const proc = spawn(cmd, argv, {
    cwd: WHISPER_CMD ? REPO : HERE,
    env: workerEnv(),
    stdio: ["pipe", "pipe", "ignore"],  // stderr is a library's chatter, and is never logged
    windowsHide: true,
  });
  worker.proc = proc;
  worker.buf = "";
  worker.startedAt = Date.now();
  proc.stdin.on("error", () => { /* it died; "close" reports it */ });
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    if (worker.proc !== proc) return;
    worker.buf += chunk;
    if (worker.buf.length > 8 * 1024 * 1024) { proc.kill("SIGKILL"); return; }
    let nl;
    while ((nl = worker.buf.indexOf("\n")) >= 0) {
      const line = worker.buf.slice(0, nl);
      worker.buf = worker.buf.slice(nl + 1);
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (!msg || typeof msg !== "object") continue;
      if ("ready" in msg || "fatal" in msg) {
        const secs = ((Date.now() - worker.startedAt) / 1000).toFixed(1);
        const why = String(msg.fatal || msg.error || "").replace(/[^\w.]/g, "").slice(0, 60);
        if (msg.ready) console.log(`glyph-voice: model loaded in ${secs}s`);
        else if (msg.fatal) console.log(`glyph-voice: worker could not start (${why})`);
        else console.log(`glyph-voice: the model did not load (${why})`);
        // It passed the import check and now fails it: off until the next look.
        if (msg.fatal && !WHISPER_CMD) { voice.available = false; voice.checkedAt = Date.now(); }
      } else if (worker.job && msg.id === worker.job.id) {
        worker.job.done(null, msg);
      }
    }
  });
  // "close", not "exit": a reply written just before exiting is still read.
  const gone = (err) => {
    if (worker.proc !== proc) return;
    worker.proc = null;
    clearTimeout(worker.idle);
    if (worker.job) worker.job.done(Object.assign(new Error("worker exited"), { code: "crash" }));
    if (err && err.code === "ENOENT" && !WHISPER_CMD) {
      voice.available = false;  // that Python has gone; look again on the next request
      voice.checkedAt = 0;
    }
  };
  proc.on("close", () => gone());
  proc.on("error", (e) => gone(e));
  armIdle();
  return proc;
}

function runJob(file, language) {
  return new Promise((resolve, reject) => {
    const proc = startWorker();
    const job = {
      id: worker.nextId++,
      done(err, msg) {
        if (worker.job !== job) return;
        worker.job = null;
        clearTimeout(timer);
        armIdle();
        if (err) reject(err); else resolve(msg);
      },
    };
    // A stuck job cannot be interrupted, so the whole worker goes and the next
    // job starts a fresh one. Detached first, so nothing new is sent to it.
    const timer = setTimeout(() => {
      if (worker.proc === proc) worker.proc = null;
      job.done(Object.assign(new Error("timeout"), { code: "timeout" }));
      proc.kill("SIGKILL");
    }, VOICE_TIMEOUT_MS);
    worker.job = job;
    clearTimeout(worker.idle);
    proc.stdin.write(JSON.stringify({ id: job.id, path: file, language }) + "\n");
  });
}

let voiceChain = Promise.resolve();
let voiceQueued = 0;
function transcribeQueued(file, language) {
  voiceQueued++;
  const run = voiceChain.then(() => runJob(file, language));
  voiceChain = run.then(() => {}, () => {});
  return run.finally(() => { voiceQueued--; });
}

// Whisper's segments become paragraphs: a pause of PARAGRAPH_GAP or more starts
// a new one, each starts with a capital and ends with a full stop if it ended on
// a letter or a digit. Unicode-aware, so a Romanian ă or ș capitalizes too.
function formatTranscript(segments) {
  if (!Array.isArray(segments)) return "";
  const paras = [];
  let cur = [];
  let prevEnd = null;
  for (const seg of segments) {
    if (!seg || typeof seg.text !== "string") continue;
    const text = seg.text.replace(/\s+/gu, " ").trim();
    if (!text) continue;
    const start = Number(seg.start);
    if (cur.length && prevEnd !== null && start - prevEnd >= PARAGRAPH_GAP - 1e-6) {
      paras.push(cur.join(" "));
      cur = [];
    }
    cur.push(text);
    if (Number.isFinite(Number(seg.end))) prevEnd = Number(seg.end);
  }
  if (cur.length) paras.push(cur.join(" "));
  return paras.map((p) => {
    let s = p.replace(/\s+/gu, " ").trim();
    s = s.replace(/^([\p{Ps}\p{Pi}"'¿¡]*)(\p{Ll})/u, (m, pre, ch) => pre + ch.toUpperCase());
    if (/[\p{L}\p{N}]$/u.test(s)) s += ".";
    return s;
  }).filter(Boolean).join("\n\n").trim();
}

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

    if (req.method === "GET" && (p === "/apple-touch-icon.png" || p === "/favicon.ico")) {
      try {
        const icon = await readFile(path.join(REPO, "assets", "apple-touch-icon.png"));
        return send(res, 200, icon, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        });
      } catch {
        return send(res, 404, "", { "Content-Type": "text/plain" });
      }
    }

    // Public like the interface itself: a module import cannot carry a token,
    // and this is a published library, not anything of hers. The header is what
    // a worker takes its policy from, so the thread that parses an untrusted PDF
    // has no network of its own. It may compile the scanned-page decoders, which
    // the page fetches and hands it, and only it may: the page's own policy still
    // refuses WebAssembly.
    if (req.method === "GET" && PDFJS.has(p)) {
      return send(res, 200, PDFJS.get(p), {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Security-Policy": "default-src 'none'; script-src 'wasm-unsafe-eval'",
      });
    }
    if (req.method === "GET" && PDFJS_WASM.has(p)) {
      return send(res, 200, PDFJS_WASM.get(p), {
        "Content-Type": "application/wasm",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
    }

    // Everything under /api needs the token.
    if (p.startsWith("/api/")) {
      if (!tokenOk(req)) return json(res, 401, { error: "unauthorized" });

      // A phone has no console, so this log is the only place anything that goes
      // wrong on one can be seen. One line, printable text, and never the token:
      // a stack trace can carry the page's address, and the address holds it.
      if (req.method === "POST" && p === "/api/log") {
        const line = (await readBody(req, MAX_LOG_BYTES)).toString("utf8")
          .replaceAll(TOKEN, "(token)").replace(/[^\x20-\x7e]+/g, " ");
        console.log(`glyph-phone: ${new Date().toISOString()} ${line}`);
        return json(res, 200, { ok: true });
      }

      if (req.method === "GET" && p === "/api/files") {
        const { files, folders } = await listFiles();
        return json(res, 200, { root: path.basename(ROOT), files, folders });
      }

      if (req.method === "GET" && p === "/api/info") {
        return json(res, 200, { secureOrigin: await secureOrigin() });
      }

      if (req.method === "GET" && p === "/api/voice") {
        return json(res, 200, { available: await voiceAvailable() });
      }

      if (req.method === "POST" && p === "/api/transcribe") {
        const lang = url.searchParams.get("lang") || "auto";
        if (!["auto", "en", "ro"].includes(lang)) return json(res, 400, { error: "bad lang" });
        const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        const ext = AUDIO_TYPES.get(type);
        if (!ext) return json(res, 415, { error: "unsupported audio type" });
        if (!(await voiceAvailable())) return json(res, 503, { error: "voice unavailable" });
        if (voiceQueued >= VOICE_QUEUE_MAX) return json(res, 503, { error: "busy" });
        // Start loading the model while the audio is still arriving.
        if (!worker.proc && !worker.job) startWorker();
        // Over the limit, readBody hangs up, as it does for an oversized note.
        const audio = await readBody(req, MAX_AUDIO_BYTES);
        if (audio.length === 0) return json(res, 422, { error: "no speech" });
        const kb = Math.round(audio.length / 1024);
        const tmp = path.join(tmpdir(), `glyph-voice-${randomBytes(12).toString("hex")}${ext}`);
        const t0 = Date.now();
        let msg;
        try {
          await writeFile(tmp, audio, { mode: 0o600, flag: "wx" });
          msg = await transcribeQueued(tmp, lang === "auto" ? null : lang);
        } catch (e) {
          const why = e && e.code === "timeout" ? "timed out" : e && e.code === "crash" ? "worker exited" : "error";
          console.log(`glyph-voice: ${kb} KB ${why} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
          return e && e.code === "timeout"
            ? json(res, 504, { error: "timeout" })
            : json(res, 500, { error: "transcription failed" });
        } finally {
          await unlink(tmp).catch(() => {});
        }
        if (typeof msg.error === "string") {
          console.log(`glyph-voice: ${kb} KB failed in the worker (${msg.error.replace(/[^\w.]/g, "").slice(0, 60)})`);
          return json(res, 500, { error: "transcription failed" });
        }
        const text = formatTranscript(msg.segments);
        const segs = Array.isArray(msg.segments) ? msg.segments : [];
        const last = segs.length ? Number(segs[segs.length - 1].end) : 0;
        const dur = Number.isFinite(msg.duration) ? msg.duration : Number.isFinite(last) ? last : 0;
        const seconds = Math.round(dur * 10) / 10;
        const language = typeof msg.language === "string" && /^[a-z]{2,3}$/i.test(msg.language)
          ? msg.language.toLowerCase() : null;
        const kept = await keepSample(audio, ext, { asked: lang, language, seconds, text,
          model: process.env.GLYPH_WHISPER_MODEL || "mlx-community/whisper-large-v3-turbo" });
        console.log(`glyph-voice: ${seconds}s of audio, ${kb} KB, ` +
          `${text ? "transcribed" : "no speech"} in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
          (kept ? ", kept for comparison" : ""));
        if (!text) return json(res, 422, { error: "no speech" });
        return json(res, 200, { text, language, seconds });
      }

      // Rename a note within its own folder. Text notes only: a PDF or a book is
      // never written, and a rename is a write.
      if (req.method === "POST" && p === "/api/rename") {
        let body;
        try {
          body = JSON.parse((await readBody(req, MAX_LOG_BYTES)).toString("utf8"));
        } catch {
          return json(res, 400, { error: "bad body" });
        }
        const fromAbs = resolveInRoot(body && body.from);
        const toAbs = resolveInRoot(body && body.to);
        if (!fromAbs || !toAbs || !isServable(fromAbs) || !isServable(toAbs)) {
          return json(res, 400, { error: "bad path" });
        }
        if (path.dirname(fromAbs) !== path.dirname(toAbs)) return json(res, 400, { error: "different folder" });
        if (!plainName(path.basename(toAbs))) return json(res, 400, { error: "bad name" });
        let fromStat;
        try {
          fromStat = await lstat(fromAbs);
        } catch {
          return json(res, 404, { error: "not found" });
        }
        // The note and its folder must both really be inside the root: a symlink
        // out, or a folder that is a link to elsewhere, is refused.
        try {
          if (!inRoot(realpathSync(fromAbs)) || !inRoot(realpathSync(path.dirname(fromAbs))) ||
              !(await stat(fromAbs)).isFile()) {
            return json(res, 400, { error: "bad path" });
          }
        } catch {
          return json(res, 400, { error: "bad path" });
        }
        try {
          const there = await lstat(toAbs);
          // The same file under another case ("note.md" -> "Note.md") on a
          // case-insensitive disk is a rename, not a clash.
          if (there.ino !== fromStat.ino || there.dev !== fromStat.dev) {
            return json(res, 409, { error: "exists" });
          }
        } catch { /* free: good */ }
        await rename(fromAbs, toAbs);
        const s = await stat(toAbs);
        // The same spelling the list uses, whatever the request looked like.
        const rel = path.relative(ROOT, toAbs).split(path.sep).join("/");
        return json(res, 200, { path: rel, mtime: Math.floor(s.mtimeMs) });
      }

      // Folder management: make a folder, move or rename a note or a folder, and
      // send either to the Mac's Trash. Nothing is ever deleted outright.
      if (req.method === "POST" && ["/api/folder", "/api/move", "/api/trash", "/api/untrash", "/api/pin"].includes(p)) {
        let body;
        try {
          body = JSON.parse((await readBody(req, MAX_LOG_BYTES)).toString("utf8"));
        } catch {
          return json(res, 400, { error: "bad body" });
        }
        if (!body || typeof body !== "object") return json(res, 400, { error: "bad body" });

        if (p === "/api/folder") {
          const rel = body.path;
          const abs = resolveInRoot(rel);
          if (!abs || abs === ROOT || !listedPath(rel) || !plainName(path.basename(abs))) {
            return json(res, 400, { error: "bad name" });
          }
          if (!intoFolder(path.dirname(abs))) return json(res, 400, { error: "bad path" });
          try {
            await mkdir(abs);  // one level, and never over anything already there
          } catch (e) {
            if (e && e.code === "EEXIST") return json(res, 409, { error: "exists" });
            return json(res, 500, { error: "could not make the folder" });
          }
          return json(res, 200, { path: relOf(abs) });
        }

        // Put back what this server sent to the Trash a moment ago.
        if (p === "/api/untrash") {
          const item = typeof body.undo === "string" ? trashed.get(body.undo) : null;
          if (!item || Date.now() - item.at > UNDO_MS) return json(res, 404, { error: "nothing to undo" });
          trashed.delete(body.undo);
          let st;
          try {
            st = await lstat(item.dest);
          } catch {
            return json(res, 404, { error: "no longer in the trash" });
          }
          // The very same item, not something put in its place since. The inode
          // alone is not enough: Linux hands a freed one straight to the next
          // file, so size and times have to match too.
          if (st.isSymbolicLink() || trashPrint(st) !== item.print) {
            return json(res, 404, { error: "no longer in the trash" });
          }
          if (!intoFolder(path.dirname(item.abs))) return json(res, 409, { error: "its folder is gone" });
          try {
            await lstat(item.abs);
            return json(res, 409, { error: "exists" });
          } catch { /* free: good */ }
          try {
            await rename(item.dest, item.abs);
          } catch {
            return json(res, 500, { error: "could not put it back" });
          }
          if (item.pins.length) {
            await loadPins();
            item.pins.forEach((x) => pins.add(x));
            await savePins();
          }
          return json(res, 200, { path: relOf(item.abs) });
        }

        const from = await movable(body.path !== undefined ? body.path : body.from);
        if (from.error) return json(res, from.error, { error: from.error === 404 ? "not found" : "bad path" });

        if (p === "/api/move") {
          const toAbs = resolveInRoot(body.to);
          if (!toAbs || toAbs === ROOT || !listedPath(body.to) || !plainName(path.basename(toAbs))) {
            return json(res, 400, { error: "bad name" });
          }
          // A file keeps its kind: a note stays a note and a PDF stays a PDF.
          if (!from.dir && path.extname(toAbs).toLowerCase() !== path.extname(from.abs).toLowerCase()) {
            return json(res, 400, { error: "different kind" });
          }
          const parent = intoFolder(path.dirname(toAbs));
          if (!parent) return json(res, 400, { error: "bad path" });
          // A folder cannot go inside itself (compared without case too, as the
          // Mac's disk ignores it; the system refuses this as well, with EINVAL).
          if (from.dir) {
            const self = realpathSync(from.abs).toLowerCase();
            const into = parent.toLowerCase();
            if (into === self || into.startsWith(self + path.sep)) return json(res, 400, { error: "inside itself" });
          }
          try {
            const there = await lstat(toAbs);
            // The same item under another case ("note.md" -> "Note.md") on a
            // case-insensitive disk is a rename, not a clash.
            if (there.ino !== from.st.ino || there.dev !== from.st.dev) return json(res, 409, { error: "exists" });
          } catch { /* free: good */ }
          try {
            await rename(from.abs, toAbs);
          } catch (e) {
            if (e && e.code === "EINVAL") return json(res, 400, { error: "inside itself" });
            if (e && (e.code === "EEXIST" || e.code === "ENOTEMPTY")) return json(res, 409, { error: "exists" });
            return json(res, 500, { error: "could not move" });
          }
          const out = { path: relOf(toAbs) };
          if (!from.dir) out.mtime = Math.floor((await stat(toAbs)).mtimeMs);
          await movePins(relOf(from.abs), out.path, from.dir);
          return json(res, 200, out);
        }

        if (p === "/api/pin") {
          if (from.dir) return json(res, 400, { error: "only notes are pinned" });
          await loadPins();
          const rel = relOf(from.abs);
          if (body.pinned === false) pins.delete(rel);
          else if (pins.size >= MAX_PINS && !pins.has(rel)) return json(res, 400, { error: "too many pins" });
          else pins.add(rel);
          await savePins();
          return json(res, 200, { path: rel, pinned: pins.has(rel) });
        }

        // /api/trash: into the Trash under a name not already taken there.
        const base = path.basename(from.abs);
        const ext = from.dir ? "" : path.extname(base);
        const bare = ext ? base.slice(0, -ext.length) : base;
        let dest = null;
        for (let n = 1; n < 1000 && !dest; n++) {
          const name = n === 1 ? base : `${bare} ${n}${ext}`;
          try {
            await lstat(path.join(TRASH_DIR, name));
          } catch (e) {
            if (e && e.code === "ENOENT") dest = path.join(TRASH_DIR, name);
            else return json(res, 500, { error: "no trash" });
          }
        }
        if (!dest) return json(res, 500, { error: "no free name" });
        try {
          await rename(from.abs, dest);
        } catch {
          return json(res, 500, { error: "could not move to the trash" });
        }
        console.log(`glyph-trash: moved a ${from.dir ? "folder" : "file"} to the Trash`);
        const gone = await movePins(relOf(from.abs), null, from.dir);
        let undo = null;
        try {
          const st = await lstat(dest);
          undo = rememberTrashed({ dest, abs: from.abs, print: trashPrint(st), pins: gone });
        } catch { /* it is in the Trash; only Undo is lost */ }
        return json(res, 200, { trashed: true, undo });
      }

      if (req.method === "GET" && p === "/api/file") {
        const abs = resolveInRoot(url.searchParams.get("path") || "");
        if (!abs || !isServable(abs)) return json(res, 400, { error: "bad path" });
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

      if (req.method === "GET" && p === "/api/epub") {
        const abs = resolveInRoot(url.searchParams.get("path") || "");
        if (!abs || !isBook(abs)) return json(res, 400, { error: "bad path" });
        try {
          const real = realpathSync(abs);
          if (real !== ROOT && !real.startsWith(ROOT + path.sep)) {
            return json(res, 400, { error: "bad path" });  // symlink out
          }
          return send(res, 200, await readFile(real), { "Content-Type": "application/epub+zip" });
        } catch {
          return json(res, 404, { error: "not found" });
        }
      }

      if (req.method === "GET" && p === "/api/pdf") {
        const abs = resolveInRoot(url.searchParams.get("path") || "");
        if (!abs || !isPdf(abs)) return json(res, 400, { error: "bad path" });
        try {
          const real = realpathSync(abs);
          if (real !== ROOT && !real.startsWith(ROOT + path.sep)) {
            return json(res, 400, { error: "bad path" });  // symlink out
          }
          return send(res, 200, await readFile(real), { "Content-Type": "application/pdf" });
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
        if (!abs || !isServable(abs) || typeof body.text !== "string") {
          return json(res, 400, { error: "bad path" });
        }
        // The PARENT folder must resolve inside the root, for a NEW file too —
        // otherwise a new .md created inside a symlinked subdirectory would land
        // outside. resolveInRoot is lexical; this follows the real links.
        let parentReal;
        try {
          parentReal = realpathSync(path.dirname(abs));
        } catch {
          return json(res, 400, { error: "bad path" });
        }
        if (parentReal !== ROOT && !parentReal.startsWith(ROOT + path.sep)) {
          return json(res, 400, { error: "bad path" });
        }
        // A new note: refuse rather than replace anything already there.
        if (body.create === true) {
          try {
            await writeAtomic(abs, body.text, { exclusive: true });
          } catch (e) {
            if (e.code === "EEXIST") return json(res, 409, { error: "exists" });
            throw e;
          }
          const s2 = await stat(abs);
          return json(res, 200, { path: body.path, mtime: Math.floor(s2.mtimeMs) });
        }
        // If the file changed on disk since the phone loaded it (edited on the
        // Mac at the same time), refuse rather than clobber the newer version.
        // The one true "conflict" case even with a single source of truth.
        try {
          const s = await stat(abs);
          if (typeof body.baseMtime === "number" && Math.floor(s.mtimeMs) > body.baseMtime + 1) {
            return json(res, 409, { error: "changed on disk", mtime: Math.floor(s.mtimeMs) });
          }
          // An existing file must not itself be a symlink pointing out of root.
          const real = realpathSync(abs);
          if (real !== ROOT && !real.startsWith(ROOT + path.sep)) {
            return json(res, 400, { error: "bad path" });
          }
        } catch { /* new file: the parent was checked above */ }
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
      // 100.64.0.0/10 is the carrier-grade NAT range Tailscale uses for tailnet
      // addresses. It is not a LAN address and is reported separately below.
      if (ni.family === "IPv4" && !ni.internal && !isTailscaleIPv4(ni.address)) {
        out.push(ni.address);
      }
    }
  }
  return out;
}

function isTailscaleIPv4(addr) {
  const p = addr.split(".").map(Number);
  return p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}

// The tailnet name, when Tailscale is running. This is the address that works
// away from home — on cellular, on a walk — because the tunnel reaches the
// machine wherever it is. The server needs no configuration for it: it already
// binds 0.0.0.0, which includes the Tailscale interface.
function tailscaleHost() {
  const cli = [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
  ].find((p) => existsSync(p));
  if (!cli) return null;
  try {
    const raw = execFileSync(cli, ["status", "--json"], {
      timeout: 4000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const self = JSON.parse(raw).Self || {};
    if (!self.Online) return null;
    const dns = (self.DNSName || "").replace(/\.$/, "");
    return dns || (self.TailscaleIPs || []).find(isTailscaleIPv4) || null;
  } catch {
    return null;   // Tailscale present but not running, or not signed in
  }
}

server.listen(port, "0.0.0.0", () => {
  const host = hostname().replace(/\.local$/, "");
  const addrs = lanAddresses();
  const primary = addrs[0] || "127.0.0.1";
  const ts = tailscaleHost();

  // The token is a password. It is printed ONLY to an interactive terminal —
  // when stdout is redirected to a log file the URLs are printed without it,
  // because a log is world-readable far more often than anyone expects (the
  // first one this wrote lived in /tmp at mode 0644, with the token in it three
  // times over). The token is always available from the file below, which is
  // 0600, so nothing is lost by leaving it out of the log.
  const tty = process.stdout.isTTY;
  const tokenFile = path.join(homedir(), ".config", "glyph", "server-token");
  const withToken = (base) => tty ? `${base}/#token=${TOKEN}` : `${base}/`;

  console.log("");
  console.log("  Glyph server is running.");
  console.log(`  Serving:  ${ROOT}`);
  console.log("");
  if (tty) {
    console.log("  On your phone (same wifi), open this ONCE — it remembers the token:");
  } else {
    console.log("  On your phone (same wifi):");
  }
  console.log("");
  console.log(`      ${withToken(`http://${primary}:${port}`)}`);
  console.log("");
  console.log(`  Or by name:  ${withToken(`http://${host}.local:${port}`)}`);
  if (addrs.length > 1) {
    console.log(`  Other addresses: ${addrs.slice(1).join(", ")}`);
  }
  if (ts) {
    console.log("");
    console.log("  ANYWHERE (on a walk, on cellular) — via your private Tailscale network:");
    console.log("");
    console.log(`      ${withToken(`http://${ts}:${port}`)}`);
    console.log("");
    console.log("  That address only works from your own signed-in devices, and the");
    console.log("  traffic is encrypted between them by Tailscale.");
    console.log("");
    console.log("  NOTE: the phone remembers the token per ADDRESS. Pairing on the wifi");
    console.log("  link does not pair this one — open this link once too.");
  } else {
    console.log("");
    console.log("  For access away from home, install Tailscale on this Mac and your");
    console.log("  phone and sign in to the same account — the link appears here.");
  }
  if (!tty) {
    console.log("");
    console.log("  The pairing token is NOT printed to a log file. Add it to a link as");
    console.log(`  #token=…  — read it from ${tokenFile}`);
  }
  console.log("");
  console.log("  Do NOT port-forward this to the internet, and do not enable Tailscale");
  console.log("  Funnel on it: both would put your notes on the public web.  Ctrl-C to stop.");
  console.log("");
  // Looked for after the banner, in the background: importing mlx takes a
  // second or two, and the notes should not wait for it.
  if (WHISPER_CMD === undefined) checkVoice();
});
