// The Glyph server's security boundary and file loop.
//
//   node Scripts/server-smoke.mjs
//
// Starts server/glyph-server.mjs against a temp folder and asserts, over real
// HTTP, that: the token is required; a path can never read or write outside the
// served folder (traversal, absolute, symlink-out); only text files and read-only
// PDFs are served;
// a legitimate read/write round-trips; a .txt comes back byte for byte; and a
// stale write is refused. This is the
// suite that stands between a phone on the wifi and the rest of the disk, so
// every "blocked" case here is a file that must stay untouched.
//
// It also covers the list's titles and previews, creating and renaming notes,
// the HTTPS address (/api/info), and voice transcription. Voice runs against
// Scripts/fake-whisper.mjs through GLYPH_WHISPER_CMD, so this needs no Python,
// no mlx and no model, and runs the same on a Linux CI runner.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, lstat, utimes } from "node:fs/promises";
import { rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server", "glyph-server.mjs");
const FAKE_WHISPER = path.join(HERE, "fake-whisper.mjs");

let fails = 0;
const ok = (what, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${what}`);
  if (!cond) fails++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = await mkdtemp(path.join(tmpdir(), "glyph-srv-"));
const drafts = path.join(root, "drafts");
await mkdir(path.join(drafts, "reports"), { recursive: true });
await writeFile(path.join(drafts, "a.md"), "# A\n\nbody\n");
await writeFile(path.join(drafts, "reports", "b.md"), "# B\n");
await writeFile(path.join(drafts, "notes.txt"), "plain text, served literally\n");
await writeFile(path.join(drafts, "photo.png"), "not a text file at all\n");
await writeFile(path.join(drafts, "reports", "c.pdf"), "%PDF-1.4 pretend bytes\n");
await writeFile(path.join(root, "secret.pdf"), "%PDF-1.4 SECRET OUTSIDE THE ROOT\n");
await symlink(path.join(root, "secret.pdf"), path.join(drafts, "escape.pdf")).catch(() => {});
await writeFile(path.join(drafts, "reports", "d.epub"), "PK pretend book bytes\n");
await writeFile(path.join(root, "secret.epub"), "PK SECRET OUTSIDE THE ROOT\n");
await symlink(path.join(root, "secret.epub"), path.join(drafts, "escape.epub")).catch(() => {});
await writeFile(path.join(root, "secret.md"), "SECRET OUTSIDE THE ROOT\n");
// A symlink inside the root that points OUT of it — the classic escape.
await symlink(path.join(root, "secret.md"), path.join(drafts, "escape.md")).catch(() => {});

// Titles and previews in the list.
const T = (name, text) => writeFile(path.join(drafts, "titles", name), text);
await mkdir(path.join(drafts, "titles"));
await T("front.md", "---\ntitle: not this\ntags: [a, b]\n---\n\n# Real **Title** here\n\n" +
  "First para with [a link](http://x.test/) and [[Target|alias]] and `code`.\n");
await T("first-line.md", "\n\nJust a *first* line\nsecond line\n- item one\n- [ ] task two\n> quoted _text_\n");
await T("heading-late.md", "intro line\n\n# Heading later\n");
await T("tagged.md", "#project/idea some text\n");
await T("hidden.md", "<!-- a comment\nover two lines -->\n![[banner.png]]\n![alt](pic.png)\n" +
  "## Second-level **bold** ##\n```js\nconst zz = 1;\n```\n| a | b |\n|---|---|\n| [[x\\|y]] | 2 |\n");
await T("long.md", "# " + "word ".repeat(60) + "\n\n" + "body ".repeat(80));
await T("empty.md", "");
await T("only-front.md", "---\na: b\n---\n");
await T("snake.md", "file_name_here and 2 * 3 * 4\n");
await T("big.md", "# Big title\n" + "x".repeat(4 * 1024 * 1024));
await T("edit-me.md", "# Before\n\nold body\n");
// Renaming.
await mkdir(path.join(drafts, "ren"));
await writeFile(path.join(drafts, "ren", "one.md"), "# One\n");
await writeFile(path.join(drafts, "ren", "three.md"), "# Three\n");
await writeFile(path.join(drafts, "ren", "case.md"), "# Case\n");
await mkdir(path.join(drafts, "ren", "folder.md"));

// The settings folder the server is pointed at instead of ~/.config/glyph. The
// token does NOT move with it (rule 44), which is why it is still read below
// from the home folder.
const config = await mkdtemp(path.join(tmpdir(), "glyph-cfg-"));
const fakeLog = path.join(config, "fake-whisper.log");

const PORT = 40000 + Math.floor((process.pid % 20000));
const children = [];
function startServer(port, env) {
  const child = spawn(process.execPath, [SERVER, drafts, `--port=${port}`], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env },
  });
  children.push(child);
  return child;
}
const srv = startServer(PORT, {
  GLYPH_CONFIG_DIR: config,
  GLYPH_WHISPER_CMD: JSON.stringify([process.execPath, FAKE_WHISPER]),
  GLYPH_VOICE_TIMEOUT_MS: "1500",
  FAKE_WHISPER_LOG: fakeLog,
});
// The finally block at the bottom covers a thrown assertion, but a signal never
// reaches it — Ctrl-C would leave the server running and its temp root on disk.
// Same lesson as Scripts/engine-smoke.mjs: a spawned child outlives an
// interrupted harness unless something is listening for one.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
    try { rmSync(root, { recursive: true, force: true }); } catch {}
    try { rmSync(config, { recursive: true, force: true }); } catch {}
    process.exit(130);
  });
}
let out = "";
srv.stdout.on("data", (d) => { out += d.toString(); });
srv.stderr.on("data", (d) => { out += d.toString(); });

// Wait for the banner, then read the token from its file. The banner prints the
// token ONLY to an interactive terminal — stdout here is a pipe, and a log file
// is world-readable far more often than anyone expects — so the file (mode 0600)
// is the supported way to obtain it.
let token = null;
for (let i = 0; i < 100 && !token; i++) {
  await sleep(100);
  if (!/Glyph server is running/.test(out)) continue;
  try {
    token = (await readFile(path.join(homedir(), ".config", "glyph", "server-token"), "utf8")).trim();
  } catch { /* not written yet */ }
}
// The token must NOT appear in non-interactive output.
const tokenLeaked = !!token && out.includes(token);

const base = `http://127.0.0.1:${PORT}`;
const auth = (extra = {}) => ({ Authorization: "Bearer " + token, ...extra });

async function main() {
  ok("server started and the token is readable from its file", !!token);
  ok("the token is NOT printed to non-interactive output (a log would leak it)", !tokenLeaked);
  if (!token) return;

  // Auth.
  let r = await fetch(`${base}/api/files`);
  ok("no token is rejected (401)", r.status === 401);
  r = await fetch(`${base}/api/files`, { headers: { Authorization: "Bearer wrong" } });
  ok("a wrong token is rejected (401)", r.status === 401);

  // Listing.
  r = await fetch(`${base}/api/files`, { headers: auth() });
  const list = await r.json();
  const names = (list.files || []).map((f) => f.path).sort();
  ok("lists the .md files under the root", names.includes("a.md") && names.includes("reports/b.md"));
  // .txt is served (shown literally by the page, saved byte for byte); a
  // non-text file is not served at all.
  ok("lists plain text files too", names.includes("notes.txt"));
  ok("does not list non-text files", !names.includes("photo.png"));
  // escape.md is a symlink to outside; listing it is harmless (reading is what
  // matters) but ideally it is skipped. Not asserted either way here.

  // Read.
  r = await fetch(`${base}/api/file?path=a.md`, { headers: auth() });
  const a = await r.json();
  ok("reads a file's content", r.status === 200 && a.text.includes("body"));

  // Traversal / escape — every one of these must be blocked, and the outside
  // file must stay exactly as written.
  for (const bad of ["../secret.md", "reports/../../secret.md", "/etc/hosts", "..%2Fsecret.md"]) {
    const rr = await fetch(`${base}/api/file?path=${encodeURIComponent(bad)}`, { headers: auth() });
    ok(`read blocked: ${bad}`, rr.status === 400 || rr.status === 404);
  }
  r = await fetch(`${base}/api/file?path=notes.txt`, { headers: auth() });
  ok("reads a plain text file", r.status === 200 && (await r.json()).text.includes("served literally"));
  r = await fetch(`${base}/api/file?path=photo.png`, { headers: auth() });
  ok("read of a non-text file is blocked", r.status === 400);
  r = await fetch(`${base}/api/file`, {
    method: "PUT", headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify({ path: "photo.png", text: "nope" }),
  });
  ok("write of a non-text file is blocked", r.status === 400);

  // A plain text file must come back BYTE FOR BYTE — the markdown renderer must
  // never touch it. Trailing spaces and lone asterisks are exactly what a
  // markdown round-trip would rewrite.
  const plainBody = "* not a bullet\n#hashtag not a heading\n   indented   \ntrailing spaces   \n";
  r = await fetch(`${base}/api/file`, {
    method: "PUT", headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify({ path: "notes.txt", text: plainBody }),
  });
  ok("writes a plain text file", r.status === 200);
  ok("a plain text file is stored byte for byte",
     (await readFile(path.join(drafts, "notes.txt"), "utf8")) === plainBody);

  // A symlink inside the root pointing out must not be readable.
  r = await fetch(`${base}/api/file?path=escape.md`, { headers: auth() });
  const escBody = r.ok ? (await r.json()).text : "";
  ok("a symlink pointing outside the root is not read", !escBody.includes("SECRET OUTSIDE"));

  // Write round-trip.
  r = await fetch(`${base}/api/file`, {
    method: "PUT", headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify({ path: "a.md", text: "# A edited\n\nfrom the test\n" }),
  });
  ok("writes a file", r.status === 200);
  const onDisk = await readFile(path.join(drafts, "a.md"), "utf8");
  ok("the write is on disk", onDisk.includes("from the test"));

  // Write escape attempts — the outside file must be untouched.
  for (const bad of ["../secret.md", "a/../../secret.md", "/tmp/glyph-pwned.md"]) {
    const rr = await fetch(`${base}/api/file`, {
      method: "PUT", headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ path: bad, text: "PWNED" }),
    });
    ok(`write blocked: ${bad}`, rr.status === 400);
  }
  const secret = await readFile(path.join(root, "secret.md"), "utf8");
  ok("the file outside the root is untouched", secret === "SECRET OUTSIDE THE ROOT\n");

  // A symlink planted at the atomic-write TEMP path must not be followed out of
  // the folder when the note is written. This is the escape the review found:
  // <note>.glyph-tmp -> an outside file, and editing the note wrote through it.
  const tempTarget = path.join(root, "temp-target.md");
  await writeFile(tempTarget, "UNTOUCHED BY TEMP WRITE\n");
  await symlink(tempTarget, path.join(drafts, "a.md.glyph-tmp")).catch(() => {});
  r = await fetch(`${base}/api/file`, {
    method: "PUT", headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify({ path: "a.md", text: "# A written past the temp symlink\n" }),
  });
  ok("writing a note past a planted temp symlink succeeds", r.status === 200);
  ok("the temp-symlink target outside root is untouched",
     (await readFile(tempTarget, "utf8")) === "UNTOUCHED BY TEMP WRITE\n");
  ok("the note itself got the new content",
     (await readFile(path.join(drafts, "a.md"), "utf8")).includes("past the temp symlink"));

  // A NEW .md created inside a symlinked-out subdirectory must be blocked (the
  // new-file branch that skips the existing-file realpath check).
  const outDir = path.join(root, "outdir");
  await mkdir(outDir, { recursive: true });
  await symlink(outDir, path.join(drafts, "linkdir")).catch(() => {});
  r = await fetch(`${base}/api/file`, {
    method: "PUT", headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify({ path: "linkdir/new.md", text: "ESCAPED VIA SYMLINK DIR" }),
  });
  ok("a new file inside a symlinked-out subdir is blocked", r.status === 400);
  let leaked = false;
  try { await stat(path.join(outDir, "new.md")); leaked = true; } catch { /* good */ }
  ok("nothing leaked into the symlinked-out directory", !leaked);

  // A token whose bytes differ from its code-unit count must 401, not 500. An
  // HTTP header value is Latin-1, so a byte >= 0x80 (here U+00FF) is one code
  // unit but two UTF-8 bytes — the old string-length pre-check passed it through
  // to timingSafeEqual, which throws on unequal buffers and crashed to a 500.
  r = await fetch(`${base}/api/files`, { headers: { Authorization: "Bearer " + "ÿ".repeat(token.length) } });
  ok("a high-byte wrong token is a clean 401, not a 500", r.status === 401);

  // PDFs: readable, listed, sandboxed exactly like a note, and never writable.
  const pdfBytes = await readFile(path.join(drafts, "reports", "c.pdf"));
  r = await fetch(`${base}/api/files`, { headers: auth() });
  const listed = (await r.json()).files.map((f) => f.path);
  ok("a PDF is listed", listed.includes("reports/c.pdf"));
  r = await fetch(`${base}/api/pdf?path=reports/c.pdf`);
  ok("reading a PDF needs the token", r.status === 401);
  r = await fetch(`${base}/api/pdf?path=reports/c.pdf`, { headers: auth() });
  ok("a PDF comes back byte for byte", r.status === 200 &&
     r.headers.get("content-type") === "application/pdf" &&
     Buffer.from(await r.arrayBuffer()).equals(pdfBytes));
  r = await fetch(`${base}/api/pdf?path=${encodeURIComponent("../secret.pdf")}`, { headers: auth() });
  ok("a PDF outside the folder is refused", r.status === 400);
  r = await fetch(`${base}/api/pdf?path=escape.pdf`, { headers: auth() });
  ok("a PDF symlink pointing out is refused", r.status === 400);
  r = await fetch(`${base}/api/pdf?path=a.md`, { headers: auth() });
  ok("the PDF route only serves PDFs", r.status === 400);
  r = await fetch(`${base}/api/file?path=reports/c.pdf`, { headers: auth() });
  ok("a PDF is not read as text", r.status === 400);
  r = await fetch(`${base}/api/file`, {
    method: "PUT", headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify({ path: "reports/c.pdf", text: "overwritten" }),
  });
  ok("a PDF cannot be written", r.status === 400);
  ok("and it is untouched on disk",
     (await readFile(path.join(drafts, "reports", "c.pdf"))).equals(pdfBytes));

  // Books: the same rules, and the same reason.
  const bookBytes = await readFile(path.join(drafts, "reports", "d.epub"));
  r = await fetch(`${base}/api/files`, { headers: auth() });
  ok("a book is listed", (await r.json()).files.some((f) => f.path === "reports/d.epub"));
  r = await fetch(`${base}/api/epub?path=reports/d.epub`);
  ok("reading a book needs the token", r.status === 401);
  r = await fetch(`${base}/api/epub?path=reports/d.epub`, { headers: auth() });
  ok("a book comes back byte for byte", r.status === 200 &&
     r.headers.get("content-type") === "application/epub+zip" &&
     Buffer.from(await r.arrayBuffer()).equals(bookBytes));
  r = await fetch(`${base}/api/epub?path=${encodeURIComponent("../secret.epub")}`, { headers: auth() });
  ok("a book outside the folder is refused", r.status === 400);
  r = await fetch(`${base}/api/epub?path=escape.epub`, { headers: auth() });
  ok("a book symlink pointing out is refused", r.status === 400);
  r = await fetch(`${base}/api/epub?path=a.md`, { headers: auth() });
  ok("the book route only serves books", r.status === 400);
  r = await fetch(`${base}/api/file?path=reports/d.epub`, { headers: auth() });
  ok("a book is not read as text", r.status === 400);
  r = await fetch(`${base}/api/file`, { method: "PUT", headers: { ...auth(), "Content-Type": "application/json" },
    body: JSON.stringify({ path: "reports/d.epub", text: "overwritten" }) });
  ok("a book cannot be written", r.status === 400 &&
     (await readFile(path.join(drafts, "reports", "d.epub"))).equals(bookBytes));

  r = await fetch(`${base}/vendor/pdfjs/pdf.min.mjs`);
  ok("the PDF reader loads without a token, as a script", r.status === 200 &&
     /javascript/.test(r.headers.get("content-type")) &&
     r.headers.get("x-content-type-options") === "nosniff");
  r = await fetch(`${base}/vendor/pdfjs/pdf.worker.min.mjs`);
  ok("its worker has no network of its own, and may only compile the decoders",
     r.headers.get("content-security-policy") === "default-src 'none'; script-src 'wasm-unsafe-eval'");
  r = await fetch(`${base}/vendor/pdfjs/LICENSE`);
  ok("nothing else in that folder is served", r.status === 404);
  r = await fetch(`${base}/`);
  const page = await r.text();
  const decoders = /__glyphPdfWasm = "([^"]+)"/.exec(page)[1];
  for (const f of ["jbig2.wasm", "openjpeg.wasm"]) {
    r = await fetch(`${base}${decoders}${f}`);
    ok(`the ${f} decoder is served as WebAssembly`, r.status === 200 &&
       r.headers.get("content-type") === "application/wasm" &&
       Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString("latin1") === "\0asm");
  }
  r = await fetch(`${base}/vendor/pdfjs/wasm/jbig2.wasm`);
  ok("a decoder is only served under its hashed address", r.status === 404);
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(page)[1];
  ok("the page may load the reader and its worker from here",
     /script-src 'self' /.test(csp) && /worker-src 'self'/.test(csp));
  ok("and still runs no inline or evaluated code outside its pinned hashes",
     !/unsafe-inline|unsafe-eval/.test(csp));

  // The phone's error reports. They land in a log, so the rule about tokens in
  // logs applies to them: a stack trace can carry the page's address.
  r = await fetch(`${base}/api/log`, { method: "POST", body: "{}" });
  ok("reporting to the log needs the token", r.status === 401);
  r = await fetch(`${base}/api/log`, { method: "POST", headers: auth(),
    body: `first\nsecond \u001b[31m http://x/#token=${token} end` });
  ok("a report is accepted", r.status === 200);
  await sleep(50);
  const reported = out.split("\n").filter((l) => l.startsWith("glyph-phone:"));
  ok("a report lands on one line of plain text",
     reported.length === 1 && /first second .*end$/.test(reported[0]) && !out.includes("\u001b"));
  ok("a report never writes the token to the log", !out.includes(token));
  // The server hangs up on it, the same way it does on an oversized note.
  r = await fetch(`${base}/api/log`, { method: "POST", headers: auth(), body: "x".repeat(20000) })
    .catch(() => null);
  ok("a report cannot fill the log", !r && !out.includes("x".repeat(9000)));

  // Stale write (changed on disk since load) is refused rather than clobbering.
  r = await fetch(`${base}/api/file?path=reports/b.md`, { headers: auth() });
  const b = await r.json();
  await sleep(20);
  await writeFile(path.join(drafts, "reports", "b.md"), "# B changed on the computer\n");
  await sleep(20);
  r = await fetch(`${base}/api/file`, {
    method: "PUT", headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify({ path: "reports/b.md", text: "# B from stale phone\n", baseMtime: b.mtime }),
  });
  ok("a stale write is refused (409)", r.status === 409);
  const bNow = await readFile(path.join(drafts, "reports", "b.md"), "utf8");
  ok("the newer on-disk version is not clobbered", bNow.includes("changed on the computer"));

  // ------------------------------------------------ titles and previews
  const listing = async () => {
    const rr = await fetch(`${base}/api/files`, { headers: auth() });
    return new Map((await rr.json()).files.map((f) => [f.path, f]));
  };
  let files = await listing();
  const meta = (p) => files.get(p) || {};
  ok("every entry has a title and a preview string",
     [...files.values()].every((f) => typeof f.title === "string" && f.title && typeof f.preview === "string"));
  ok("frontmatter is skipped and the heading is the title",
     meta("titles/front.md").title === "Real Title here");
  ok("the preview is the body, links and wikilinks reduced to their text",
     meta("titles/front.md").preview === "First para with a link and alias and code.");
  ok("no heading: the first non-empty line is the title",
     meta("titles/first-line.md").title === "Just a first line");
  ok("list, task and quote markers are stripped from the preview",
     meta("titles/first-line.md").preview === "second line item one task two quoted text");
  ok("a heading after other text is not the title",
     meta("titles/heading-late.md").title === "intro line" &&
     meta("titles/heading-late.md").preview === "Heading later");
  ok("a #tag keeps its text", meta("titles/tagged.md").title === "#project/idea some text");
  ok("comments, embeds and images are skipped; closing #s go",
     meta("titles/hidden.md").title === "Second-level bold");
  ok("fence markers go, code and table text stay, an escaped wikilink pipe resolves",
     meta("titles/hidden.md").preview === "const zz = 1; a b y 2");
  ok("snake_case and a lone * are not emphasis",
     meta("titles/snake.md").title === "file_name_here and 2 * 3 * 4");
  ok("a long title is clipped to 120 characters",
     [...meta("titles/long.md").title].length <= 120 && meta("titles/long.md").title.endsWith("…"));
  ok("a long preview is clipped to about 160 characters",
     [...meta("titles/long.md").preview].length <= 160 && meta("titles/long.md").preview.startsWith("body body"));
  ok("an empty note is titled by its file name",
     meta("titles/empty.md").title === "empty" && meta("titles/empty.md").preview === "");
  ok("a note that is only frontmatter is titled by its file name",
     meta("titles/only-front.md").title === "only-front");
  ok("a note over 4MB is not read: file name, no preview",
     meta("titles/big.md").title === "big" && meta("titles/big.md").preview === "");
  ok("a PDF is titled by its file name", meta("reports/c.pdf").title === "c" && meta("reports/c.pdf").preview === "");
  ok("a book is titled by its file name", meta("reports/d.epub").title === "d");
  ok("the existing fields are unchanged",
     typeof meta("a.md").size === "number" && typeof meta("a.md").mtime === "number" && meta("a.md").name === "a.md");
  ok("an outside file's first line never shows up in the list",
     ![...files.values()].some((f) => /SECRET OUTSIDE/.test(f.title + f.preview)));

  // The cache must notice an edit — through the server, and on disk behind it.
  const editMe = path.join(drafts, "titles", "edit-me.md");
  ok("a title before an edit", meta("titles/edit-me.md").title === "Before");
  r = await fetch(`${base}/api/file`, {
    method: "PUT", headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify({ path: "titles/edit-me.md", text: "# After the edit\n\nnew body\n" }),
  });
  files = await listing();
  ok("an edit through the server shows its new title",
     meta("titles/edit-me.md").title === "After the edit" && meta("titles/edit-me.md").preview === "new body");
  const later = new Date(Date.now() + 5000);
  await writeFile(editMe, "# Aftxr the edit\n\nnew body\n");  // same size
  await utimes(editMe, later, later);
  files = await listing();
  ok("a same-size edit is caught by its mtime", meta("titles/edit-me.md").title === "Aftxr the edit");
  await writeFile(editMe, "# Third\n\nnew body, longer now\n");
  await utimes(editMe, later, later);  // same mtime as the cached one
  files = await listing();
  ok("an edit that keeps the mtime is caught by its size", meta("titles/edit-me.md").title === "Third");

  // A thousand notes, listed twice: the second listing reads nothing.
  await mkdir(path.join(drafts, "many"));
  await Promise.all(Array.from({ length: 1000 }, (_, i) =>
    writeFile(path.join(drafts, "many", `n${i}.md`), `# Note ${i}\n\n${"some words ".repeat(50)}\n`)));
  let t0 = Date.now();
  files = await listing();
  const cold = Date.now() - t0;
  t0 = Date.now();
  files = await listing();
  const warm = Date.now() - t0;
  console.log(`        (1,000 more notes listed in ${cold} ms cold, ${warm} ms warm)`);
  ok("a thousand notes list with their titles", meta("many/n999.md").title === "Note 999");
  ok("a thousand notes list quickly once remembered", warm < 2000);
  await rm(path.join(drafts, "many"), { recursive: true, force: true });

  // -------------------------------------------------------- create: true
  const put = (body) => fetch(`${base}/api/file`, {
    method: "PUT", headers: auth({ "Content-Type": "application/json" }), body: JSON.stringify(body),
  });
  r = await put({ path: "titles/new-note.md", text: "# New note\n", create: true });
  const created = await r.json();
  ok("create: a new note is written", r.status === 200 && created.path === "titles/new-note.md" &&
     typeof created.mtime === "number" &&
     (await readFile(path.join(drafts, "titles", "new-note.md"), "utf8")) === "# New note\n");
  r = await put({ path: "titles/new-note.md", text: "# Replaced\n", create: true });
  ok("create: an existing note is refused (409 exists)", r.status === 409 && (await r.json()).error === "exists");
  ok("create: and left exactly as it was",
     (await readFile(path.join(drafts, "titles", "new-note.md"), "utf8")) === "# New note\n");
  r = await put({ path: "linkdir/fresh.md", text: "ESCAPED", create: true });
  ok("create: a new note inside a symlinked-out folder is refused", r.status === 400 &&
     !existsSync(path.join(outDir, "fresh.md")));
  await symlink(path.join(root, "nowhere.md"), path.join(drafts, "dangling.md")).catch(() => {});
  r = await put({ path: "dangling.md", text: "THROUGH A DANGLING LINK", create: true });
  ok("create: a dangling symlink counts as existing, and is not written through",
     r.status === 409 && !existsSync(path.join(root, "nowhere.md")));
  r = await put({ path: "reports/new.pdf", text: "x", create: true });
  ok("create: never a PDF", r.status === 400);

  // ---------------------------------------------------------------- rename
  const rn = (from, to, headers = auth({ "Content-Type": "application/json" })) =>
    fetch(`${base}/api/rename`, { method: "POST", headers, body: JSON.stringify({ from, to }) });
  r = await rn("ren/one.md", "ren/two.md", { "Content-Type": "application/json" });
  ok("rename needs the token", r.status === 401 && existsSync(path.join(drafts, "ren", "one.md")));
  r = await rn("ren/one.md", "ren/two.md");
  const renamed = await r.json();
  ok("rename within a folder works", r.status === 200 && renamed.path === "ren/two.md" &&
     typeof renamed.mtime === "number" && !existsSync(path.join(drafts, "ren", "one.md")) &&
     (await readFile(path.join(drafts, "ren", "two.md"), "utf8")) === "# One\n");
  files = await listing();
  ok("the list shows the new name, not the old", files.has("ren/two.md") && !files.has("ren/one.md") &&
     meta("ren/two.md").title === "One");
  r = await rn("ren/two.md", "ren/three.md");
  ok("rename onto an existing note is refused (409 exists)", r.status === 409 &&
     (await r.json()).error === "exists" &&
     (await readFile(path.join(drafts, "ren", "three.md"), "utf8")) === "# Three\n" &&
     existsSync(path.join(drafts, "ren", "two.md")));
  for (const [to, why] of [
    ["two.md", "to another folder"], ["reports/two.md", "into a sibling folder"],
    ["ren/../two.md", "with .. in it"], ["../two.md", "out of the root"],
    ["ren/a\\b.md", "with a backslash in the name"], ["ren/.hidden.md", "to a hidden name"],
    ["ren/" + "x".repeat(118) + ".md", "to a name over 120 characters"],
    ["ren/a\u0001b.md", "to a name with a control character"],
    ["ren/two.pdf", "to a PDF"], ["ren/two.epub", "to a book"], ["ren/two.png", "to a non-text file"],
    ["/tmp/two.md", "to an absolute path"],
  ]) {
    r = await rn("ren/two.md", to);
    ok(`rename refused ${why} (400)`, r.status === 400);
  }
  ok("and the note is still where it was", existsSync(path.join(drafts, "ren", "two.md")));
  r = await rn("reports/c.pdf", "reports/c2.pdf");
  ok("a PDF cannot be renamed", r.status === 400 && existsSync(path.join(drafts, "reports", "c.pdf")));
  r = await rn("reports/d.epub", "reports/e.epub");
  ok("a book cannot be renamed", r.status === 400 && existsSync(path.join(drafts, "reports", "d.epub")));
  r = await rn("photo.png", "photo2.png");
  ok("a non-text file cannot be renamed", r.status === 400);
  r = await rn("escape.md", "escape2.md");
  ok("a symlink pointing out cannot be renamed", r.status === 400 &&
     (await lstat(path.join(drafts, "escape.md"))).isSymbolicLink() &&
     (await readFile(path.join(root, "secret.md"), "utf8")) === "SECRET OUTSIDE THE ROOT\n");
  await writeFile(path.join(outDir, "x.md"), "OUTSIDE\n");
  r = await rn("linkdir/x.md", "linkdir/y.md");
  ok("a note inside a symlinked-out folder cannot be renamed", r.status === 400 &&
     existsSync(path.join(outDir, "x.md")) && !existsSync(path.join(outDir, "y.md")));
  // The note resolves INSIDE the root here, but renaming it would still change
  // a folder outside it: the folder is checked, not just the note.
  await symlink(path.join(drafts, "a.md"), path.join(outDir, "back.md")).catch(() => {});
  r = await rn("linkdir/back.md", "linkdir/back2.md");
  ok("nor can a link back in, sitting in a folder outside", r.status === 400 &&
     existsSync(path.join(outDir, "back.md")) && !existsSync(path.join(outDir, "back2.md")));
  r = await rn("ren/nope.md", "ren/nope2.md");
  ok("renaming a missing note is a 404", r.status === 404);
  r = await rn("ren/folder.md", "ren/folder2.md");
  ok("a folder is not a note", r.status === 400 && existsSync(path.join(drafts, "ren", "folder.md")));
  r = await rn("ren/case.md", "ren/Case.md");
  files = await listing();
  ok("a rename that only changes case works", r.status === 200 && files.has("ren/Case.md") && !files.has("ren/case.md"));
  r = await fetch(`${base}/api/rename`, { method: "POST", headers: auth(), body: "not json" });
  ok("a rename with a bad body is a 400", r.status === 400);

  // ------------------------------------------------------------- /api/info
  const info = async () => (await (await fetch(`${base}/api/info`, { headers: auth() })).json()).secureOrigin;
  r = await fetch(`${base}/api/info`);
  ok("info needs the token", r.status === 401);
  ok("no secure-origin file: null", (await info()) === null);
  const originFile = path.join(config, "secure-origin");
  await writeFile(originFile, "https://glyph-test.example.ts.net:4322\nsecond line\n");
  ok("a valid https origin is handed out (first line, trimmed)",
     (await info()) === "https://glyph-test.example.ts.net:4322");
  await writeFile(originFile, "  https://glyph-test.example  \n");
  ok("without a port too", (await info()) === "https://glyph-test.example");
  for (const bad of ["http://glyph-test.example", "https://glyph-test.example/path", "https://glyph-test.example:99999",
                     "javascript:alert(1)", "https://user@glyph-test.example", ""]) {
    await writeFile(originFile, bad + "\n");
    ok(`an invalid origin is null: ${JSON.stringify(bad)}`, (await info()) === null);
  }

  // ------------------------------------------------------------------ voice
  const say = (body, type = "audio/mp4", query = "", headers = auth({ "Content-Type": type })) =>
    fetch(`${base}/api/transcribe${query}`, { method: "POST", headers, body });
  r = await fetch(`${base}/api/voice`);
  ok("voice status needs the token", r.status === 401);
  r = await fetch(`${base}/api/voice`, { headers: auth() });
  ok("voice is available with a worker", r.status === 200 && (await r.json()).available === true);
  r = await say("CASE:pause", "audio/mp4", "", { "Content-Type": "audio/mp4" });
  ok("transcribing needs the token", r.status === 401);
  r = await say("CASE:pause", "text/plain");
  ok("a non-audio type is refused (415)", r.status === 415);
  r = await fetch(`${base}/api/transcribe`, { method: "POST", headers: auth(), body: "CASE:pause" });
  ok("no type at all is refused (415)", r.status === 415);
  r = await say("CASE:pause", "audio/mp4", "?lang=fr");
  ok("an unknown language is refused (400)", r.status === 400);

  r = await say("CASE:pause");
  let v = await r.json();
  ok("a pause of 1.5 s or more starts a paragraph; 1.49 s does not",
     r.status === 200 && v.text === "Zebra one two three.\n\nFour.");
  ok("the language and the length come back", v.language === "en" && v.seconds === 6.5);
  r = await say("CASE:romanian", "audio/mp4", "?lang=ro");
  v = await r.json();
  ok("Romanian capitals: ă becomes Ă and ș becomes Ș",
     r.status === 200 && v.text === "Ăsta e începutul zebra.\n\nȘtefan trimite propunerea mâine." && v.language === "ro");
  r = await say("CASE:punct");
  v = await r.json();
  ok("an ending ? . or … is kept, a letter gets a full stop, a quote is skipped to capitalize",
     r.status === 200 && v.text === "Is it zebra?\n\nYes.\n\nWell…\n\n\"Quoted start.");
  const langOf = async (q) => (await (await say("CASE:lang", "audio/mp4", q)).json()).language;
  ok("lang=ro and lang=en reach the worker", (await langOf("?lang=ro")) === "ro" && (await langOf("?lang=en")) === "en");
  ok("lang=auto and no lang both ask the worker to detect",
     (await langOf("?lang=auto")) === null && (await langOf("")) === null);
  r = await say("CASE:pause", "audio/webm;codecs=opus");
  ok("a type with parameters is accepted", r.status === 200);
  r = await say("CASE:silence");
  ok("silence is 422 no speech", r.status === 422 && (await r.json()).error === "no speech");
  r = await say("CASE:blank");
  ok("only empty segments is 422", r.status === 422);
  r = await say("");
  ok("an empty recording is 422", r.status === 422);
  r = await say("CASE:error");
  ok("a worker error is a 500", r.status === 500);
  r = await say("CASE:crash");
  ok("a worker that dies mid-job is a 500", r.status === 500);
  r = await say("CASE:pause");
  ok("and the next job starts a fresh worker", r.status === 200);
  r = await say("CASE:hang");
  ok("a job that never finishes is a 504", r.status === 504);
  r = await say("CASE:pause");
  ok("and the next job works again", r.status === 200);
  const both = await Promise.all([say("CASE:pause"), say("CASE:romanian")]);
  ok("two at once are queued, and both answered",
     both[0].status === 200 && both[1].status === 200 &&
     (await both[1].json()).text.startsWith("Ăsta"));
  const logged = () => existsSync(fakeLog) ? readFile(fakeLog, "utf8").then((t) => t.trim().split("\n")) : [];
  const before = (await logged()).length;
  r = await say(Buffer.alloc(40 * 1024 * 1024 + 1, 0x41)).catch(() => null);
  ok("a recording over 40MB is hung up on", !r || r.status >= 400);
  await sleep(100);
  ok("and never reaches the worker", (await logged()).length === before);

  const jobs = (await logged()).map((l) => JSON.parse(l));
  ok("every job's audio was a temp file of its own, 0600, named by its type",
     jobs.length >= 15 && jobs.every((j) => j.mode === 0o600 &&
       path.dirname(j.path) === tmpdir() && /^glyph-voice-[0-9a-f]{24}\.(m4a|webm)$/.test(path.basename(j.path))) &&
     jobs.some((j) => j.path.endsWith(".webm")) && new Set(jobs.map((j) => j.path)).size === jobs.length);
  ok("and every one was deleted afterwards, crash and timeout included",
     jobs.every((j) => !existsSync(j.path)));
  ok("nothing that was said reaches the log", !/zebra/i.test(out));
  ok("the log says what happened in sizes and seconds", /glyph-voice: 6\.5s of audio, 0 KB, transcribed/.test(out));

  // No worker: voice reports itself off and refuses, rather than hanging.
  const srv2 = startServer(PORT + 1, { GLYPH_CONFIG_DIR: config, GLYPH_WHISPER_CMD: "[]" });
  let out2 = "";
  srv2.stdout.on("data", (d) => { out2 += d.toString(); });
  for (let i = 0; i < 100 && !/Glyph server is running/.test(out2); i++) await sleep(50);
  const base2 = `http://127.0.0.1:${PORT + 1}`;
  r = await fetch(`${base2}/api/voice`, { headers: auth() });
  ok("with no worker, voice is reported unavailable", r.status === 200 && (await r.json()).available === false);
  r = await fetch(`${base2}/api/transcribe`, { method: "POST", headers: auth({ "Content-Type": "audio/mp4" }), body: "CASE:pause" });
  ok("and a recording is refused with 503", r.status === 503 && (await r.json()).error === "voice unavailable");
  ok("and the reason is in its log", /GLYPH_WHISPER_CMD is not a JSON array/.test(out2));
  srv2.kill("SIGKILL");

  ok("the token never reached the log, voice included", !out.includes(token) && !out2.includes(token));
}

try {
  await main();
} finally {
  for (const c of children) c.kill("SIGKILL");
  await rm(root, { recursive: true, force: true }).catch(() => {});
  await rm(config, { recursive: true, force: true }).catch(() => {});
}

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall pass");
process.exit(fails ? 1 : 0);
