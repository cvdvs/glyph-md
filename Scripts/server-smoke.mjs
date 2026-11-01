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
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server", "glyph-server.mjs");

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

const PORT = 40000 + Math.floor((process.pid % 20000));
const srv = spawn(process.execPath, [SERVER, drafts, `--port=${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
// The finally block at the bottom covers a thrown assertion, but a signal never
// reaches it — Ctrl-C would leave the server running and its temp root on disk.
// Same lesson as Scripts/engine-smoke.mjs: a spawned child outlives an
// interrupted harness unless something is listening for one.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    try { srv.kill("SIGKILL"); } catch {}
    try { rmSync(root, { recursive: true, force: true }); } catch {}
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
}

try {
  await main();
} finally {
  srv.kill("SIGKILL");
  await rm(root, { recursive: true, force: true }).catch(() => {});
}

console.log(fails ? `\n${fails} FAILURE(S)` : "\nall pass");
process.exit(fails ? 1 : 0);
