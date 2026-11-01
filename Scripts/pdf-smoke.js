// The PDF reader, driven the way a phone drives it: real taps on the real file
// list, against the real server. Run by Scripts/pdf-smoke.mjs in Blink and, through
// Scripts/pdf-webkit.m, in WebKit, which is the engine an iPhone actually uses.
// It has to stay a single expression: the WebKit harness wraps it in `return await`.
(async () => {
  const out = window.__pdfSmokeOut = [];
  const ok = (what, cond, detail) =>
    out.push({ what, pass: !!cond, detail: detail == null ? "" : String(detail) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(60);
    }
    return null;
  };

  // Every write the page attempts, and everything the security policy refuses.
  const writes = [];
  const reports = [];
  const realFetch = window.fetch;
  window.fetch = function (url, opts) {
    if (String(url).includes("/api/log")) reports.push(JSON.parse(opts.body).what);
    else if (opts && opts.method && opts.method !== "GET") writes.push(JSON.parse(opts.body));
    return realFetch.apply(this, arguments);
  };
  const blocked = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    blocked.push(e.violatedDirective + " " + e.blockedURI);
  });

  const body = document.body;
  const row = (label) =>
    [...document.querySelectorAll(".glyph-tree-row.file")]
      .find((r) => r.querySelector(".tn").textContent === label);
  const tab = (label) =>
    [...document.querySelectorAll(".glyph-tab")].find((t) => t.textContent.includes(label));
  const tabCount = (label) =>
    [...document.querySelectorAll(".glyph-tab")].filter((t) => t.textContent.includes(label)).length;
  const status = () => document.getElementById("glyph-status").textContent;
  const tools = () => getComputedStyle(document.getElementById("glyph-tools")).display;
  const box = (n) => document.querySelector('.glyph-pdf-page[data-page="' + n + '"]');
  // Ink, not merely a canvas: a blank white sheet would pass any weaker check,
  // and a blank page is exactly how a render failure looks.
  const inked = (n) => {
    const c = box(n) && box(n).querySelector("canvas");
    if (!c || !c.width) return false;
    const px = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < px.length; i += 4 * 53) if (px[i] < 80 && px[i + 3] > 200) return true;
    return false;
  };
  // renderMarkdown replaces #md, so it has to be looked up every time.
  const mdEl = () => document.getElementById("md");
  const typeAtEnd = (text) => {
    mdEl().focus();
    const sel = getSelection();
    sel.selectAllChildren(mdEl());
    sel.collapseToEnd();
    document.execCommand("insertText", false, text);
  };
  const key = (k) => document.dispatchEvent(new KeyboardEvent("keydown",
    { key: k, ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
  const pageIs = (state) => {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  };

  ok("a device with a saved text size starts up whole",
    !window.__startupErrors.length && document.getElementById("glyph-menu"),
    window.__startupErrors.join(" | "));
  ok("and the saved size is applied", body.style.getPropertyValue("--reader-size") === "19px",
    body.style.getPropertyValue("--reader-size"));

  await until(() => row("book.pdf"));
  ok("the PDF is in the file list, extension showing", row("book.pdf") && /book\.pdf/.test(row("book.pdf").textContent));

  row("book.pdf").click();
  await until(() => inked(1), 30000);
  ok("the first page has ink on it", inked(1));
  ok("it opened in its own tab", tabCount("book.pdf") === 1);
  ok("the status counts pages, not words", status() === "40 pages", status());
  ok("the second page is in the document too", await until(() => inked(2)));
  ok("the parser runs in a real worker, not on the page", !window.pdfjsWorker);
  ok("the toolbar is out of the way", tools() === "none", tools());
  const barH = () => Math.round(document.getElementById("glyph-bar").getBoundingClientRect().height);
  ok("the page moved up into that space",
    await until(() => parseFloat(getComputedStyle(body).paddingTop) === barH()), barH());
  ok("a landscape page keeps its own shape",
    Math.abs(box(2).clientWidth / box(2).clientHeight - 842 / 595) < 0.02,
    box(2).clientWidth + "x" + box(2).clientHeight);
  ok("a page fits the screen", box(1).getBoundingClientRect().width <= innerWidth);
  ok("nothing scrolls sideways", document.documentElement.scrollWidth <= innerWidth + 1,
    document.documentElement.scrollWidth + " of " + innerWidth);

  box(40).scrollIntoView();
  ok("the last page draws when you reach it", await until(() => inked(40)));
  ok("pages far behind let go of their picture", await until(() => !box(1).firstChild));
  const held = document.querySelectorAll(".glyph-pdf-page canvas").length;
  ok("only pages near the screen are held", held > 0 && held <= 8, held + " of 40");

  // Reachable on an iPad with a keyboard. All of these act on the hidden #md.
  ["b", "e", "s", "1"].forEach(key);
  await sleep(1000);
  ok("formatting, raw view and save do nothing here",
    !body.classList.contains("glyph-raw") && body.classList.contains("glyph-pdf") && writes.length === 0,
    writes.length + " writes");

  const y = window.scrollY;
  row("note").click();
  await until(() => !body.classList.contains("glyph-pdf") && mdEl().innerText.includes("A note beside"));
  ok("a note opens beside it", mdEl().innerText.includes("A note beside"));
  ok("the toolbar comes back for a note", tools() !== "none", tools());
  ok("the PDF behind it lets go of its pictures", await until(() => !document.querySelector("canvas")));

  // The awkward case: typing, then switching within the 600ms before the edit
  // reaches the document. It has to land on the note and nowhere else.
  typeAtEnd(" EDITED");
  tab("book.pdf").click();
  await until(() => inked(40));
  ok("the PDF comes back where you left it", Math.abs(window.scrollY - y) < 3, window.scrollY + " vs " + y);
  await sleep(1500);
  ok("an edit in flight lands on its own note, only there",
    writes.length >= 1 && writes.every((w) => w.path === "note.md" && w.text.includes("EDITED")),
    JSON.stringify(writes.map((w) => w.path)));
  ok("no tab is left marked unsaved", !document.querySelector(".glyph-tab.dirty"));

  tab("note.md").click();
  await until(() => mdEl().innerText.includes("EDITED"));
  ok("the note still reads as itself", mdEl().innerText.includes("EDITED") && !body.classList.contains("glyph-pdf"));

  // The same race against the tabs that CAN be written. A .txt never re-renders
  // #md, so the leftover edit used to be taken for the .txt's own text and saved
  // over the file.
  row("notes.txt").click();
  await until(() => body.classList.contains("glyph-raw"));
  row("other").click();
  await until(() => !body.classList.contains("glyph-raw") && mdEl().innerText.includes("star bullet"));
  tab("note.md").click();
  await until(() => mdEl().innerText.includes("EDITED"));
  typeAtEnd(" AGAIN");
  tab("notes.txt").click();
  await sleep(1500);
  ok("an edit in flight never lands on a .txt",
    document.getElementById("glyph-raw").value === "plain text\n" &&
    writes.every((w) => w.path === "note.md"), JSON.stringify([...new Set(writes.map((w) => w.path))]));
  tab("note.md").click();
  await until(() => mdEl().innerText.includes("AGAIN"));
  typeAtEnd(" THIRD");
  tab("other.md").click();
  await sleep(1500);
  ok("nor rewrites the next note", writes.every((w) => w.path === "note.md") &&
    !document.querySelector(".glyph-tab.dirty"), JSON.stringify([...new Set(writes.map((w) => w.path))]));

  // A note that was only read is never written, whichever way it is left. It
  // reads as * here and the serializer would write -, so the file shows any slip.
  pageIs("hidden");                                 // the phone being locked
  await sleep(1200);
  pageIs("visible");
  delete document.visibilityState;
  key("e");                                         // raw view and back
  await sleep(100);
  ok("the raw view shows the file as it is",
    document.getElementById("glyph-raw").value === "# Other\n\n* star bullet\n",
    JSON.stringify(document.getElementById("glyph-raw").value));
  key("e");
  await sleep(1200);
  ok("a note only read is never written", writes.every((w) => w.path === "note.md") &&
    !document.querySelector(".glyph-tab.dirty"), JSON.stringify([...new Set(writes.map((w) => w.path))]));

  row("edited").click();
  await until(() => mdEl().innerText.includes("Edited"));
  typeAtEnd(" TYPED");
  await until(() => writes.some((w) => w.path === "edited.md"), 5000);
  ok("an edit to an untidy note still counts as one", writes.some((w) => w.path === "edited.md"));
  writes.length = 0;

  tab("notes.txt").click();
  await until(() => body.classList.contains("glyph-raw"));
  tab("book.pdf").click();
  await until(() => inked(40));
  ok("coming from a plain text file leaves no raw view over the PDF",
    !body.classList.contains("glyph-raw") && body.classList.contains("glyph-pdf"));

  tab("book.pdf").querySelector(".x").click();
  await until(() => !tab("book.pdf"));
  ok("closing the tab clears the PDF", !tab("book.pdf") && !document.querySelector(".glyph-pdf-page"));

  row("book.pdf").click();
  row("book.pdf").click();
  await until(() => inked(1), 30000);
  ok("a double tap opens one tab", tabCount("book.pdf") === 1, tabCount("book.pdf"));

  row("scan.pdf").click();
  ok("a scanned page draws, through its decoder", await until(() => inked(1) && status() === "1 page", 30000));
  tab("book.pdf").click();

  const before = document.querySelectorAll(".glyph-tab").length;
  row("broken.pdf").click();
  ok("a damaged PDF says so", await until(() => /Could not read/.test(status())), status());
  ok("and adds no tab", document.querySelectorAll(".glyph-tab").length === before);

  ok("the security policy refused nothing", blocked.length === 0, blocked.slice(0, 3).join(" | "));
  const problems = reports.filter((w) => !w.startsWith("pdf trace"));
  ok("the only problem reported to the Mac was the damaged PDF",
    problems.length === 1 && problems[0] === "pdf open", problems.join(" | "));
  return JSON.stringify(out);
})()
