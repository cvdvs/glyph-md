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
  // The phone moves like Notes: a folder page, a file page, and Back between them.
  const lib = () => body.classList.contains("glyph-library");
  const back = () => document.querySelector("#glyph-nav .glyph-round").click();
  const rowIn = (label) => [...document.querySelectorAll(".glyph-lib-note")].find((r) => {
    const base = r.dataset.path.split("/").pop();
    return base === label || base === label + ".md";
  });
  const open = async (label) => {
    if (!lib()) { back(); await until(lib); }
    (await until(() => rowIn(label))).click();
  };
  const dock = () => getComputedStyle(document.getElementById("glyph-dock")).display;
  const status = () => document.getElementById("glyph-status").textContent;
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

  ok("a device with a saved text size starts up whole, on its folder page",
    !window.__startupErrors.length && lib() && document.querySelector(".glyph-lib-heading"),
    window.__startupErrors.join(" | "));
  ok("and the saved size is applied", body.style.getPropertyValue("--reader-size") === "19px",
    body.style.getPropertyValue("--reader-size"));

  await until(() => rowIn("book.pdf"));
  ok("the PDF is in the folder, marked as a PDF", /PDF/.test(rowIn("book.pdf").textContent), rowIn("book.pdf").textContent);

  await open("book.pdf");
  await until(() => inked(1), 30000);
  ok("the first page has ink on it", inked(1));
  ok("it opened on a page of its own", !lib() && body.classList.contains("glyph-pdf"));
  ok("the status counts pages, not words", status() === "40 pages", status());
  ok("the second page is in the document too", await until(() => inked(2)));
  ok("the parser runs in a real worker, not on the page", !window.pdfjsWorker);
  ok("the tools are out of the way", dock() === "none", dock());
  const barH = () => Math.round(document.getElementById("glyph-nav").getBoundingClientRect().height);
  ok("the page moved up into that space",
    await until(() => parseFloat(getComputedStyle(body).paddingTop) === barH()), barH());
  ok("a landscape page keeps its own shape",
    Math.abs(box(2).clientWidth / box(2).clientHeight - 842 / 595) < 0.02,
    box(2).clientWidth + "x" + box(2).clientHeight);
  ok("a page fits the screen", box(1).getBoundingClientRect().width <= innerWidth);
  ok("nothing scrolls sideways", document.documentElement.scrollWidth <= innerWidth + 1,
    document.documentElement.scrollWidth + " of " + innerWidth);

  // One page or two, from the menu.
  const more = () => document.querySelector('#glyph-nav [aria-label="More"]');
  const spread = (label) => [...document.querySelectorAll("#glyph-more button")].find((b) => b.textContent === label);
  ok("a PDF has the menu, and no Share", more().getBoundingClientRect().width > 0 &&
    document.querySelector('#glyph-nav [aria-label="Share"]').hidden);
  more().click();
  await until(() => spread("Two"));
  spread("Two").click();
  await sleep(300);
  ok("Two puts pages side by side",
    Math.abs(box(1).getBoundingClientRect().top - box(2).getBoundingClientRect().top) < 2 &&
    box(1).getBoundingClientRect().right <= box(2).getBoundingClientRect().left,
    JSON.stringify([box(1).getBoundingClientRect().left, box(2).getBoundingClientRect().left]));
  ok("and draws them again at their new size", await until(() => inked(1) && inked(2), 20000));
  spread("One").click();
  await sleep(300);
  ok("One stacks them again", box(2).getBoundingClientRect().top > box(1).getBoundingClientRect().bottom);
  document.getElementById("glyph-scrim").click();
  await until(() => inked(1));
  window.scrollTo(0, 0);

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
  await open("note");
  await until(() => !body.classList.contains("glyph-pdf") && mdEl().innerText.includes("A note beside"));
  ok("a note opens beside it", mdEl().innerText.includes("A note beside"));
  ok("the tools come back for a note", dock() !== "none", dock());
  ok("the PDF behind it lets go of its pictures", await until(() => !document.querySelector("canvas")));

  // The awkward case: typing, then switching within the 600ms before the edit
  // reaches the document. It has to land on the note and nowhere else.
  typeAtEnd(" EDITED");
  await open("book.pdf");
  await until(() => inked(40));
  ok("the PDF comes back where you left it", Math.abs(window.scrollY - y) < 3, window.scrollY + " vs " + y);
  await sleep(1500);
  ok("an edit in flight lands on its own note, only there",
    writes.length >= 1 && writes.every((w) => w.path === "note.md" && w.text.includes("EDITED")),
    JSON.stringify(writes.map((w) => w.path)));
  ok("nothing is left waiting to save", !/unsaved|Offline/.test(status()), status());

  await open("note");
  await until(() => mdEl().innerText.includes("EDITED"));
  ok("the note still reads as itself", mdEl().innerText.includes("EDITED") && !body.classList.contains("glyph-pdf"));

  // The same race against the tabs that CAN be written. A .txt never re-renders
  // #md, so the leftover edit used to be taken for the .txt's own text and saved
  // over the file.
  await open("notes.txt");
  await until(() => body.classList.contains("glyph-raw"));
  await open("other");
  await until(() => !body.classList.contains("glyph-raw") && mdEl().innerText.includes("star bullet"));
  await open("note");
  await until(() => mdEl().innerText.includes("EDITED"));
  typeAtEnd(" AGAIN");
  await open("notes.txt");
  await sleep(1500);
  ok("an edit in flight never lands on a .txt",
    document.getElementById("glyph-raw").value === "plain text\n" &&
    writes.every((w) => w.path === "note.md"), JSON.stringify([...new Set(writes.map((w) => w.path))]));
  await open("note");
  await until(() => mdEl().innerText.includes("AGAIN"));
  typeAtEnd(" THIRD");
  await open("other");
  await sleep(1500);
  ok("nor rewrites the next note", writes.every((w) => w.path === "note.md"),
    JSON.stringify([...new Set(writes.map((w) => w.path))]));

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
  ok("a note only read is never written", writes.every((w) => w.path === "note.md"),
    JSON.stringify([...new Set(writes.map((w) => w.path))]));

  await open("edited");
  await until(() => mdEl().innerText.includes("Edited"));
  typeAtEnd(" TYPED");
  await until(() => writes.some((w) => w.path === "edited.md"), 5000);
  ok("an edit to an untidy note still counts as one", writes.some((w) => w.path === "edited.md"));
  writes.length = 0;

  await open("notes.txt");
  await until(() => body.classList.contains("glyph-raw"));
  await open("book.pdf");
  await until(() => inked(40));
  ok("coming from a plain text file leaves no raw view over the PDF",
    !body.classList.contains("glyph-raw") && body.classList.contains("glyph-pdf"));

  back();
  ok("Back goes to the folder", await until(lib));

  // A newer PDF lets the older one go, so this one opens fresh. Tapped twice.
  rowIn("scan.pdf").click();
  rowIn("scan.pdf").click();
  ok("a scanned page draws, through its decoder", await until(() => inked(1) && status() === "1 page", 30000));
  ok("a double tap opens it once", document.querySelectorAll("#glyph-pdf > div").length === 1);

  await open("broken.pdf");
  ok("a damaged PDF says so", await until(() => /Could not read/.test(status())), status());
  ok("and stays on the folder page", lib());

  ok("the security policy refused nothing", blocked.length === 0, blocked.slice(0, 3).join(" | "));
  const problems = reports.filter((w) => !w.startsWith("pdf trace"));
  ok("the only problem reported to the Mac was the damaged PDF",
    problems.length === 1 && problems[0] === "pdf open", problems.join(" | "));
  return JSON.stringify(out);
})()
