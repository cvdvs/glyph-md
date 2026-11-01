// The PDF and book readers end to end: the real server, a temp folder of files,
// and a real browser at iPhone size running a page-side suite.
//
//   node Scripts/pdf-smoke.mjs                      Blink (headless Chrome)
//   node Scripts/pdf-smoke.mjs --webkit <harness>   WebKit (see Scripts/pdf-webkit.m)
//   add --suite book-smoke to run Scripts/book-smoke.js instead of pdf-smoke.js
//
// The page-side suite can only see the page, so this side checks what actually
// matters afterwards, on disk: no PDF or book changed by a single byte, and the one
// edit made during the run reached the note it was typed into.
//
// The browser starts as a device that has been used: a clean profile hid a startup
// crash that only happened with a saved text size, and only on a real phone.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};
const webkit = flag("--webkit");
const suiteName = flag("--suite") || "pdf-smoke";
const SEED = `try { localStorage.setItem("glyphReaderSize", "19"); } catch (e) {}
  window.__startupErrors = [];
  window.addEventListener("error", (e) => window.__startupErrors.push(e.message));`;
const chromePath = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser", "/usr/bin/chromium",
].find((p) => p && existsSync(p));
if (!webkit && !chromePath) { console.error("pdf-smoke: no Chrome found"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash("sha256").update(b).digest("hex");

// A real PDF, written by hand so the test owns no binary and no one's document.
// Every page carries a heavy black bar, which is what the ink check looks for.
function makePdf(sizes) {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${sizes.length} /Kids [${sizes.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  sizes.forEach(([w, h], i) => {
    const text = `BT /F1 28 Tf 60 ${h - 90} Td (Page ${i + 1}) Tj ET 0 0 0 rg 60 60 ${w - 120} ${h - 200} re f`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
              `/Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  });
  return assemblePdf(objs);
}

// A scanned page, which is the part PDF.js cannot do without its JBIG2 decoder:
// without it this page is blank white. One segment of page information and one
// region, coded by hand in Group 4: the first row is "white for 0, black for 64",
// and every row after it is "same as the row above" (two 1 bits).
function makeScanPdf() {
  const SIZE = 64;
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const segment = (number, type, data) => Buffer.concat([
    u32(number), Buffer.from([type, 0, 1]), u32(data.length), data,
  ]);
  const bits = "001" + "00110101" + "0000001111" + "0000110111" + "11".repeat(SIZE - 1);
  const coded = Buffer.from(bits.padEnd(Math.ceil(bits.length / 8) * 8, "0").match(/.{8}/g)
    .map((byte) => parseInt(byte, 2)));
  const page = Buffer.concat([u32(SIZE), u32(SIZE), u32(0), u32(0), Buffer.from([0, 0, 0])]);
  const region = Buffer.concat([u32(SIZE), u32(SIZE), u32(0), u32(0), Buffer.from([0, 1]), coded]);
  const jbig2 = Buffer.concat([segment(0, 48, page), segment(1, 38, region)]).toString("latin1");
  const draw = "q 400 0 0 400 100 200 cm /Im0 Do Q";
  return assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
      "/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    `<< /Type /XObject /Subtype /Image /Width ${SIZE} /Height ${SIZE} /BitsPerComponent 1 ` +
      `/ColorSpace /DeviceGray /Filter /JBIG2Decode /Length ${jbig2.length} >>\nstream\n${jbig2}\nendstream`,
    `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
  ]);
}

function assemblePdf(objs) {
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((n) => String(n).padStart(10, "0") + " 00000 n \n").join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// A zip, written by hand for the same reason. A file marked stored is kept as is.
function makeZip(files) {
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const locals = [];
  const central = [];
  let at = 0;
  files.forEach(([name, data, stored]) => {
    const raw = Buffer.from(data);
    const packed = stored ? raw : deflateRawSync(raw);
    const method = u16(stored ? 0 : 8);
    const nameBytes = Buffer.from(name);
    const sizes = Buffer.concat([u32(0), u32(packed.length), u32(raw.length), u16(nameBytes.length), u16(0)]);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), method, u32(0), sizes, nameBytes, packed]);
    locals.push(local);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), method, u32(0), sizes,
                                u16(0), u16(0), u16(0), u32(0), u32(at), nameBytes]));
    at += local.length;
  });
  const directory = Buffer.concat(central);
  return Buffer.concat([...locals, directory, u32(0x06054b50), u16(0), u16(0), u16(files.length),
                        u16(files.length), u32(directory.length), u32(at), u16(0)]);
}

const CONTAINER = `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
const XHTML = (body, head = "") => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink"><head><title>t</title>${head}</head><body>${body}</body></html>`;
const opf = (title, items, spine, extra = "") => `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>A. Writer</dc:creator><dc:language>en</dc:language></metadata>
<manifest>${items}</manifest><spine ${extra}>${spine.map((id) => `<itemref idref="${id}"/>`).join("")}</spine></package>`;
const item = (id, href, type = "application/xhtml+xml", props = "") =>
  `<item id="${id}" href="${href}" media-type="${type}"${props ? ` properties="${props}"` : ""}/>`;
// One black pixel, as a PNG: enough to prove an image came out of the zip.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const FILLER = "<p>Filler so the chapter is long enough to scroll through on a phone screen, and then some more.</p>".repeat(60);

function makeNovel() {
  const css = `.slanted { font-style: italic } p.heavy { font-weight: 700 } .middle { text-align: center }
    .big { font-size: 150% } /* .commented { font-style: italic } */ @media screen { .inmedia { font-style: oblique } }
    body { display: none } .evil { background: url(https://example.invalid/leak) }`;
  const ch1 = XHTML(`<h1>Chapter One</h1><p>Plain words and <span class="slanted">leaning words</span>.</p>
    <p class="middle">A centered line</p><p class="heavy">A heavy line</p><p class="big">A big line</p>
    <p><span class="commented">Not slanted</span> and <span class="inmedia">in media</span>
    and <span style="font-style:italic">inline slanted</span>.</p>
    <p>A claim<a href="#fn1" id="ref1">1</a> and <a href="ch2.xhtml#far">a link onward</a>
    and <a href="https://example.com/out">the web</a>.</p>${FILLER}<aside id="fn1"><p>The footnote itself.</p></aside>`);
  // This exact opening kills Chrome's page process if a parser ever sees it.
  const ch2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><h1>Chapter Two</h1>${FILLER}<p id="far">The far paragraph.</p>${FILLER}</body></html>`;
  // Everything a book must not be able to do.
  const ch3 = XHTML(`<h1>Chapter Three</h1><script>window.__booked = 1</script>
    <img src="x.png" onerror="window.__booked = 2"/><img src="https://example.invalid/pixel.png" alt="held picture"/>
    <a href="javascript:window.__booked = 3">bad link</a><iframe src="https://example.invalid/"></iframe>
    <style>body { display: none }</style><form action="/api/file" method="post"><input name="x" value="y"/></form>
    <p data-book-id="forged" data-book-style="i b">forged flags</p>
    <div style="position: fixed; inset: 0; background: red">covering div</div><object data="x.bin">fallback</object>
    <a id="glyph-menu" name="getElementById">clobber</a><form name="body"></form>
    <svg xmlns="http://www.w3.org/2000/svg" onload="window.__booked = 4"><circle r="1"/></svg>
    <img src="../../../../etc/passwd"/><p>Hostile chapter end.</p>`,
    `<meta http-equiv="refresh" content="0;url=https://example.invalid/"/><base href="https://example.invalid/"/>
     <link rel="stylesheet" href="https://example.invalid/x.css"/><script>window.__booked = 5</script>`);
  const cover = XHTML(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><image width="10" height="10" xlink:href="../images/dot.png"/></svg>`);
  const nav = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>n</title></head><body>
    <nav epub:type="toc"><ol><li><a href="text/cover.xhtml">Cover</a></li>
    <li><span>Part One</span><ol><li><a href="text/ch1.xhtml">Chapter One</a></li><li><a href="text/ch2.xhtml">Chapter Two</a></li></ol></li>
    <li><a href="text/ch3.xhtml">Chapter Three</a></li></ol></nav></body></html>`;
  return makeZip([
    ["mimetype", "application/epub+zip", true],
    ["META-INF/container.xml", CONTAINER],
    ["OEBPS/content.opf", opf("The Test Book",
      item("nav", "nav.xhtml", undefined, "nav") + item("cover", "text/cover.xhtml") + item("c1", "text/ch1.xhtml") +
      item("c2", "text/ch2.xhtml") + item("c3", "text/ch3.xhtml") + item("css", "styles/book.css", "text/css") +
      item("img", "images/dot.png", "image/png"), ["cover", "c1", "c2", "c3"])],
    ["OEBPS/nav.xhtml", nav], ["OEBPS/text/cover.xhtml", cover], ["OEBPS/text/ch1.xhtml", ch1],
    ["OEBPS/text/ch2.xhtml", ch2], ["OEBPS/text/ch3.xhtml", ch3], ["OEBPS/styles/book.css", css],
    ["OEBPS/images/dot.png", PNG],
  ]);
}

// The older form most real books use: a toc.ncx, and pages an XML parser rejects.
function makeOldBook() {
  const ncx = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
    <navPoint id="a"><navLabel><text>First</text></navLabel><content src="one.html"/>
      <navPoint id="b"><navLabel><text>Inside First</text></navLabel><content src="one.html#in"/></navPoint></navPoint>
    <navPoint id="c"><navLabel><text>Second</text></navLabel><content src="two.html"/></navPoint></navMap></ncx>`;
  const one = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p><a id="top"/>After an anchor.</p>
    <p>Spaced&nbsp;out.</p><p id="in">Inside.</p></body></html>`;
  const two = Buffer.concat([
    Buffer.from(`<?xml version="1.0" encoding="iso-8859-1"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>caf`, "latin1"),
    Buffer.from([0xe9]), Buffer.from(` au lait</p></body></html>`, "latin1"),
  ]);
  return makeZip([
    ["mimetype", "application/epub+zip", true], ["META-INF/container.xml", CONTAINER],
    ["OEBPS/content.opf", opf("The Old Book", item("ncx", "toc.ncx", "application/x-dtbncx+xml") +
      item("one", "one.html") + item("two", "two.html"), ["one", "two"], 'toc="ncx"')],
    ["OEBPS/toc.ncx", ncx], ["OEBPS/one.html", one], ["OEBPS/two.html", two],
  ]);
}

function makeSmallBook(chapter, extra = []) {
  return makeZip([
    ["mimetype", "application/epub+zip", true], ["META-INF/container.xml", CONTAINER],
    ["OEBPS/content.opf", opf("A Small Book", item("one", "one.xhtml"), ["one"])],
    ["OEBPS/one.xhtml", chapter], ...extra,
  ]);
}
const encryption = (uri) => ["META-INF/encryption.xml",
  `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
   <EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><CipherData><CipherReference URI="${uri}"/></CipherData></EncryptedData></encryption>`];

const root = await mkdtemp(path.join(tmpdir(), "glyph-pdf-"));
const profile = await mkdtemp(path.join(tmpdir(), "glyph-pdf-chrome-"));
const sizes = Array.from({ length: 40 }, (_, i) => (i === 1 ? [842, 595] : [595, 842]));
const book = makePdf(sizes);
const broken = Buffer.from("%PDF-1.4\nthis is not really a pdf at all\n", "latin1");
await writeFile(path.join(root, "book.pdf"), book);
await writeFile(path.join(root, "scan.pdf"), makeScanPdf());
await writeFile(path.join(root, "broken.pdf"), broken);
await writeFile(path.join(root, "note.md"), "# Note\n\nA note beside the PDF.\n");
await writeFile(path.join(root, "notes.txt"), "plain text\n");
// Untidy on purpose: the serializer would turn this * into a -, so any path that
// writes a note nobody edited shows up on disk.
const other = "# Other\n\n* star bullet\n";
await writeFile(path.join(root, "other.md"), other);
await writeFile(path.join(root, "edited.md"), "# Edited\n\n* star bullet\n");
const books = {
  "novel.epub": makeNovel(),
  "old.epub": makeOldBook(),
  "locked.epub": makeSmallBook(XHTML("<p>Scrambled.</p>"), [encryption("OEBPS/one.xhtml")]),
  "fonts.epub": makeSmallBook(XHTML("<p>Only the fonts are scrambled.</p>"), [encryption("OEBPS/fonts/a.otf")]),
  "notabook.epub": Buffer.from("this is not a zip at all"),
  // A scan: far too many pictures to hold at once.
  "scan.epub": makeZip([
    ["mimetype", "application/epub+zip", true], ["META-INF/container.xml", CONTAINER],
    ["OEBPS/content.opf", opf("A Scanned Book", item("one", "one.xhtml"), ["one"])],
    ["OEBPS/one.xhtml", XHTML("<p>The first page.</p>" + '<div><img src="p.png"/></div>'.repeat(200))],
    ["OEBPS/p.png", PNG],
  ]),
  // Under a kilobyte on disk, and far more than a chapter can be.
  "bomb.epub": makeSmallBook(Buffer.alloc(70 * 1024 * 1024, 32)),
};
for (const [name, bytes] of Object.entries(books)) await writeFile(path.join(root, name), bytes);

const PORT = 30000 + (process.pid % 9000);
const srv = spawn(process.execPath, [path.join(HERE, "..", "server", "glyph-server.mjs"), root, `--port=${PORT}`],
                  { stdio: ["ignore", "pipe", "pipe"] });
let browser = null;
const cleanup = () => {
  try { srv.kill("SIGKILL"); } catch {}
  try { browser && browser.kill("SIGKILL"); } catch {}
  try { rmSync(root, { recursive: true, force: true }); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => { cleanup(); process.exit(130); });
}

let banner = "";
srv.stdout.on("data", (d) => { banner += d; });
srv.stderr.on("data", (d) => { banner += d; });
for (let i = 0; i < 100 && !/Glyph server is running/.test(banner); i++) await sleep(100);
const token = (await readFile(path.join(homedir(), ".config", "glyph", "server-token"), "utf8")).trim();
const pageUrl = `http://127.0.0.1:${PORT}/#token=${token}`;
const suite = await readFile(path.join(HERE, suiteName + ".js"), "utf8");

async function runInChrome() {
  browser = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--remote-debugging-port=0", "--user-data-dir=" + profile, "about:blank"], { stdio: "ignore" });
  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    await sleep(100);
    try {
      const [p, t] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n");
      if (p && t) wsUrl = `ws://127.0.0.1:${p.trim()}${t.trim()}`;
    } catch { /* not up yet */ }
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const waiting = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      const { res, rej } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    waiting.set(++id, { res, rej });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S("Page.enable");
  await S("Runtime.enable");
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Page.javascriptDialogOpening") {
      // Nothing answers a dialog here, so an unexpected one would stall the page.
      console.log("  FAIL  unexpected dialog: " + m.params.message);
      process.exitCode = 1;
      S("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    }
  });
  await S("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await S("Page.addScriptToEvaluateOnNewDocument", { source: SEED });
  await S("Page.navigate", { url: pageUrl });
  await sleep(1500);
  // A suite that hangs must fail with what it had got through, not sit forever.
  const finished = S("Runtime.evaluate", { expression: suite, awaitPromise: true, returnByValue: true });
  const verdict = await Promise.race([finished, sleep(150000).then(() => null)]);
  if (!verdict) {
    const { result } = await S("Runtime.evaluate",
      { expression: "JSON.stringify(window.__pdfSmokeOut || [])", returnByValue: true });
    const got = JSON.parse(result.value);
    got.push({ what: "the suite finished", pass: false, detail: "stuck after the checks above" });
    return JSON.stringify(got);
  }
  if (verdict.exceptionDetails) throw new Error(JSON.stringify(verdict.exceptionDetails).slice(0, 500));
  return verdict.result.value;
}

function runInWebKit() {
  return new Promise((resolve, reject) => {
    browser = spawn(webkit, [path.join(HERE, suiteName + ".js")], { stdio: ["ignore", "pipe", "inherit"],
                    env: { ...process.env, GLYPH_URL: pageUrl, GLYPH_SEED: SEED } });
    let text = "";
    browser.stdout.on("data", (d) => { text += d; });
    browser.on("exit", (code) => (code === 0 ? resolve(text) : reject(new Error("harness exit " + code))));
  });
}

let fails = 0;
try {
  console.log(`${suiteName} (${webkit ? "WebKit" : "Blink"}):`);
  const results = JSON.parse(await (webkit ? runInWebKit() : runInChrome()));
  for (const [name, bytes] of Object.entries(books)) {
    results.push({ what: name + " is byte for byte what it was",
                   pass: (await readFile(path.join(root, name))).equals(bytes), detail: "" });
  }
  results.push({ what: "book.pdf is byte for byte what it was",
                 pass: sha(await readFile(path.join(root, "book.pdf"))) === sha(book), detail: "" });
  results.push({ what: "broken.pdf too",
                 pass: sha(await readFile(path.join(root, "broken.pdf"))) === sha(broken), detail: "" });
  const note = await readFile(path.join(root, "note.md"), "utf8");
  results.push(suiteName === "book-smoke"
    ? { what: "the note beside the book took the edit made to it", pass: /BESIDE/.test(note), detail: "" }
    : { what: "every edit reached the note on disk",
        pass: /EDITED/.test(note) && /AGAIN/.test(note) && /THIRD/.test(note), detail: "" });
  if (suiteName === "pdf-smoke") {
    results.push({ what: "an edit to an untidy note is still saved",
                   pass: /TYPED/.test(await readFile(path.join(root, "edited.md"), "utf8")), detail: "" });
  }
  results.push({ what: "notes.txt is byte for byte what it was",
                 pass: (await readFile(path.join(root, "notes.txt"), "utf8")) === "plain text\n", detail: "" });
  results.push({ what: "other.md is byte for byte what it was",
                 pass: (await readFile(path.join(root, "other.md"), "utf8")) === other, detail: "" });
  for (const r of results) {
    console.log(`  ${r.pass ? "ok  " : "FAIL"}  ${r.what}${r.detail ? "   " + r.detail : ""}`);
    if (!r.pass) fails++;
  }
} catch (e) {
  console.log("  FAIL  " + String(e.message || e).split(token).join("[token]"));
  fails++;
} finally {
  cleanup();
}
console.log(fails ? `\n${fails} FAILURE(S)` : "\nall pass");
process.exit(fails || process.exitCode ? 1 : 0);
