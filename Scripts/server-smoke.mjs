// The Glyph server's security boundary and file loop.
//
//   node Scripts/server-smoke.mjs
//
// Starts server/glyph-server.mjs against a temp folder and asserts, over real
// HTTP, that: the token is required; a path can never read or write outside the
// served folder (traversal, absolute, symlink-out); only .md is served; a
// legitimate read/write round-trips; and a stale write is refused. This is the
// suite that stands between a phone on the wifi and the rest of the disk, so
// every "blocked" case here is a file that must stay untouched.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
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
await writeFile(path.join(drafts, "notes.txt"), "not markdown\n");
await writeFile(path.join(root, "secret.md"), "SECRET OUTSIDE THE ROOT\n");
// A symlink inside the root that points OUT of it — the classic escape.
await symlink(path.join(root, "secret.md"), path.join(drafts, "escape.md")).catch(() => {});

const PORT = 40000 + Math.floor((process.pid % 20000));
const srv = spawn(process.execPath, [SERVER, drafts, `--port=${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
let out = "";
srv.stdout.on("data", (d) => { out += d.toString(); });
srv.stderr.on("data", (d) => { out += d.toString(); });

// Wait for the banner, which carries the token.
let token = null;
for (let i = 0; i < 100 && !token; i++) {
  await sleep(100);
  const m = out.match(/token=([a-f0-9]+)/);
  if (m) token = m[1];
}

const base = `http://127.0.0.1:${PORT}`;
const auth = (extra = {}) => ({ Authorization: "Bearer " + token, ...extra });

async function main() {
  ok("server started and printed a token", !!token);
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
  ok("does not list non-markdown", !names.includes("notes.txt"));
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
  ok("read of a non-.md is blocked", r.status === 400);

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
