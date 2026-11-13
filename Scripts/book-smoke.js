// The book reader, driven the way a phone drives it: real taps on the real file
// list, against the real server. Run through Scripts/pdf-smoke.mjs --suite
// book-smoke in Blink and in WebKit. A single expression, like pdf-smoke.js.
(async () => {
  const out = window.__pdfSmokeOut = [];
  const ok = (what, cond, detail) =>
    out.push({ what, pass: !!cond, detail: detail == null ? "" : String(detail) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(50);
    }
    return null;
  };

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
    blocked.push(e.violatedDirective + " " + e.blockedURI + " at " + e.lineNumber + ":" + e.columnNumber + " " + (e.sample || ""));
  });
  const opened = [];
  window.open = (url) => { opened.push(url); return null; };
  const startedAt = location.href;

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
  const q = (s) => document.querySelector(s);
  const text = () => q(".glyph-book-text");
  const bar = (label) => [...document.querySelectorAll(".glyph-book .glyph-book-button")]
    .find((b) => b.textContent === label);
  const has = (phrase) => text() && text().innerText.includes(phrase);
  const span = (phrase) => [...text().querySelectorAll("span, p")].find((n) => n.textContent.trim() === phrase);
  const style = (node) => getComputedStyle(node);
  const pick = (value) => [...document.querySelectorAll(".glyph-book-panel button")]
    .find((b) => b.textContent === value);

  await until(() => rowIn("novel.epub"));
  ok("a book is in the folder, marked as a book", /Book/.test(rowIn("novel.epub").textContent), rowIn("novel.epub").textContent);
  await open("novel.epub");
  await until(() => text() && text().querySelector("img"));
  ok("it opens on a page of its own, titled after the book", !lib() && /^The Test Book/.test(document.title), document.title);
  ok("the status shows the place in it", status() === "1 of 4", status());
  ok("the tools are out of the way", dock() === "none", dock());
  const cover = text().querySelector("img");
  ok("a cover drawn as <svg><image> comes through as a picture from the zip",
    cover && await until(() => cover.naturalWidth === 1 && cover.src.startsWith("data:image/png")));

  bar("Next").click();
  await until(() => has("Plain words"));
  ok("Next turns to the next chapter", status() === "2 of 4", status());
  ok("the bar names the chapter", q(".glyph-book-where").textContent === "Chapter One", q(".glyph-book-where").textContent);
  ok("italics that exist only in the stylesheet survive", style(span("leaning words")).fontStyle === "italic");
  ok("centering too", style(span("A centered line")).textAlign === "center");
  ok("bold too", parseInt(style(span("A heavy line")).fontWeight, 10) >= 600);
  ok("a larger size too", parseFloat(style(span("A big line")).fontSize) > parseFloat(style(text()).fontSize) * 1.2);
  ok("a rule inside a comment does not count", style(span("Not slanted")).fontStyle === "normal");
  ok("a rule inside @media does", style(span("in media")).fontStyle === "italic");
  ok("an inline style's italic survives", style(span("inline slanted")).fontStyle === "italic");
  ok("the style attribute itself is gone", !text().querySelector("[style]"));
  ok("the publisher's stylesheet is not applied", style(body).display !== "none");
  ok("nothing scrolls sideways", document.documentElement.scrollWidth <= innerWidth + 1,
    document.documentElement.scrollWidth + " of " + innerWidth);

  const note = [...text().querySelectorAll("a")].find((a) => a.textContent === "1");
  note.click();
  await until(() => !bar("Back").hidden);
  await sleep(200);
  const footnote = span("The footnote itself.");
  ok("a footnote link jumps to the footnote",
    footnote.getBoundingClientRect().top < innerHeight && footnote.getBoundingClientRect().top > 0,
    footnote.getBoundingClientRect().top);
  bar("Back").click();
  await until(() => bar("Back").hidden);
  await sleep(200);
  ok("Back returns from it", window.scrollY < 400 && bar("Back").hidden, window.scrollY);

  [...text().querySelectorAll("a")].find((a) => a.textContent === "a link onward").click();
  await until(() => has("The far paragraph"));
  await sleep(200);
  ok("a link to another chapter lands on the right paragraph",
    Math.abs(span("The far paragraph.").getBoundingClientRect().top) < innerHeight,
    span("The far paragraph.").getBoundingClientRect().top);
  bar("Back").click();
  await until(() => has("Plain words"));
  [...text().querySelectorAll("a")].find((a) => a.textContent === "the web").click();
  ok("a web link leaves the book", opened[0] === "https://example.com/out", opened[0]);

  bar("Contents").click();
  await until(() => style(q(".glyph-book-sheet")).display !== "none");
  const entries = [...document.querySelectorAll(".glyph-book-entry")];
  ok("Contents lists the book's own table", entries.map((e) => e.textContent).join("|") ===
    "Cover|Part One|Chapter One|Chapter Two|Chapter Three", entries.map((e) => e.textContent).join("|"));
  ok("a heading with no page of its own can't be tapped", entries[1].disabled);
  ok("nested entries are indented", parseFloat(style(entries[2]).paddingLeft) > parseFloat(style(entries[0]).paddingLeft));
  ok("the current chapter is marked", entries[2].getAttribute("aria-current") === "true");
  ok("the book and author are at the top", /The Test Book/.test(q(".glyph-book-title").textContent) &&
    q(".glyph-book-author").textContent === "A. Writer");
  entries[4].click();
  await until(() => has("Hostile chapter end"));
  ok("an entry takes you there, and the sheet closes",
    status() === "4 of 4" && style(q(".glyph-book-sheet")).display === "none", status());

  // The chapter built to attack the reader.
  await sleep(300);
  ok("no script in a book ran", window.__booked === undefined, window.__booked);
  ok("nothing dangerous reached the page",
    !text().querySelector("script, style, iframe, object, embed, form, input, meta, base, link, svg"));
  ok("no element kept a handler or an id",
    ![...text().querySelectorAll("*")].some((n) => n.id || n.hasAttribute("name") ||
      [...n.attributes].some((a) => a.name.startsWith("on"))));
  ok("a javascript: link lost its address", !text().querySelector('a[href^="javascript"]'));
  ok("a remote picture is not fetched, and its description stays",
    !text().querySelector('img[src^="http"]') && has("held picture"));
  ok("a path out of the book finds nothing", !text().querySelector("img"));
  ok("words inside stripped tags stay", has("covering div") && has("forged flags"));
  ok("a book cannot forge the reader's own flags",
    style(span("forged flags")).fontStyle === "normal" && !span("forged flags").dataset.bookId);
  ok("a book cannot clobber the page", q("#glyph-nav").tagName === "NAV" && document.body.tagName === "BODY");
  ok("a fixed element cannot cover the screen",
    ![...text().querySelectorAll("*")].some((n) => style(n).position === "fixed"));
  ok("no refresh or base took effect", location.href === startedAt && !q("head base"));
  bar("Previous").click();
  await until(() => status() === "3 of 4");

  // The settings.
  bar("Aa").click();
  await until(() => style(q(".glyph-book-panel")).display !== "none");
  const sized = parseFloat(style(text()).fontSize);
  document.querySelector('.glyph-book-panel [aria-label="Larger text"]').click();
  ok("A+ makes the text larger", parseFloat(style(text()).fontSize) === sized + 1, style(text()).fontSize);
  ok("and the panel shows the size", q(".glyph-book-size").textContent === String(sized + 1), q(".glyph-book-size").textContent);
  pick("Charter").click();
  ok("a font can be chosen", /Charter/.test(style(text()).fontFamily), style(text()).fontFamily);
  const leading = parseFloat(style(text()).lineHeight);
  pick("Open").click();
  ok("spacing opens up", parseFloat(style(text()).lineHeight) > leading, style(text()).lineHeight);
  const left = parseFloat(style(text()).paddingLeft);
  pick("Large").click();
  ok("margins grow", parseFloat(style(text()).paddingLeft) > left, style(text()).paddingLeft);
  pick("Justified").click();
  ok("text can be justified", style(text()).textAlign === "justify");
  pick("Sepia").click();
  ok("the page takes its color", style(q(".glyph-book")).backgroundColor === "rgb(239, 226, 201)", style(q(".glyph-book")).backgroundColor);
  ok("the chosen ones read as chosen", pick("Sepia").getAttribute("aria-pressed") === "true" &&
    pick("Auto").getAttribute("aria-pressed") === "false");
  ok("the panel fits the screen", q(".glyph-book-panel").getBoundingClientRect().right <= innerWidth &&
    q(".glyph-book-panel").getBoundingClientRect().left >= 0);
  q(".glyph-book-scrim").click();
  await until(() => style(q(".glyph-book-panel")).display === "none");
  ok("tapping outside closes the panel", style(q(".glyph-book-panel")).display === "none");

  // Pages: one screen at a time, turned by a tap, a swipe or an arrow key.
  const placeNow = () => q(".glyph-book-place").textContent;
  const pageNow = () => Number((/^Page (\d+) of (\d+)$/.exec(placeNow()) || [])[1]);
  const pagesNow = () => Number((/^Page (\d+) of (\d+)$/.exec(placeNow()) || [])[2]);
  bar("Aa").click();
  await until(() => style(q(".glyph-book-panel")).display !== "none");
  pick("Pages").click();
  await until(() => q(".glyph-book").classList.contains("glyph-book-paged") && pagesNow() > 1);
  q(".glyph-book-scrim").click();
  await sleep(300);
  ok("Pages lays the chapter out a screen at a time", pagesNow() > 3, placeNow());
  ok("and the window itself no longer scrolls", document.documentElement.scrollHeight <= innerHeight + 2,
    document.documentElement.scrollHeight + " vs " + innerHeight);
  const first = pageNow();
  text().dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: innerWidth * 0.92, clientY: innerHeight / 2 }));
  ok("a tap near the right edge turns the page", await until(() => pageNow() === first + 1), placeNow());
  // One screen is the text's own width plus the gap to the next column.
  const screenWide = () => text().clientWidth - parseFloat(getComputedStyle(text()).paddingLeft) * 2 +
    parseFloat(getComputedStyle(text()).columnGap);
  ok("by exactly one screen", await until(() => Math.abs(text().scrollLeft - (pageNow() - 1) * screenWide()) < 2),
    text().scrollLeft + " vs " + (pageNow() - 1) * screenWide());
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  ok("the left arrow turns back", await until(() => pageNow() === first), placeNow());
  const chapterHere = status();
  for (let i = 0; i < 80 && pageNow() < pagesNow(); i++) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await sleep(30);
  }
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  ok("past the last page is the next chapter", await until(() => status() !== chapterHere && pageNow() === 1),
    chapterHere + " -> " + status() + " " + placeNow());
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  ok("and back from its first page is the last page before",
    await until(() => status() === chapterHere && pageNow() === pagesNow()), status() + " " + placeNow());
  bar("Aa").click();
  await until(() => style(q(".glyph-book-panel")).display !== "none");
  pick("Two").click();
  await until(() => getComputedStyle(text()).columnCount === "2");
  ok("Two shows two pages side by side", getComputedStyle(text()).columnCount === "2" &&
    q(".glyph-book").classList.contains("glyph-book-two"));
  pick("One").click();
  pick("Scroll").click();
  await until(() => !q(".glyph-book").classList.contains("glyph-book-paged"));
  ok("and Scroll puts it back", !q(".glyph-book").classList.contains("glyph-book-paged") && /of 4$/.test(placeNow()), placeNow());
  q(".glyph-book-scrim").click();
  await until(() => style(q(".glyph-book-panel")).display === "none");
  if (status() !== "3 of 4") {
    bar("Previous").click();
    await until(() => status() === "3 of 4");
  }

  // A note beside it: the book stands aside, and the note still works.
  window.scrollTo(0, 2000);
  await sleep(700);
  const where = window.scrollY;
  await open("note");
  await until(() => !body.classList.contains("glyph-reading") && q("#md") && q("#md").innerText.includes("A note beside"));
  ok("a note opens beside the book", q("#md").innerText.includes("A note beside"));
  ok("the tools come back for it", dock() !== "none", dock());
  const md = q("#md");
  md.focus();
  getSelection().selectAllChildren(md);
  getSelection().collapseToEnd();
  document.execCommand("insertText", false, " BESIDE");
  await open("novel.epub");
  await until(() => body.classList.contains("glyph-reading"));
  await sleep(1200);
  ok("the book comes back where it was", Math.abs(window.scrollY - where) < 5, window.scrollY + " vs " + where);
  ok("and an edit in flight lands on the note, nowhere else",
    writes.length >= 1 && writes.every((w) => w.path === "note.md"), JSON.stringify(writes.map((w) => w.path)));
  ok("nothing is left waiting to save", !/unsaved|Offline/.test(status()), status());

  // Reading is remembered. Opening another book lets this one go from memory,
  // so opening it again has to find its place from what was saved.
  await sleep(700);
  await open("fonts.epub");
  ok("scrambled fonts alone do not count as locked", await until(() => has("Only the fonts are scrambled")));
  ok("a newer book lets the older one go", !q("#glyph-book .glyph-book-text") || !has("The far paragraph"));
  await open("novel.epub");
  await until(() => has("The far paragraph"));
  await sleep(300);
  ok("it reopens at the same chapter", status() === "3 of 4", status());
  ok("near the same place", Math.abs(window.scrollY - where) < 80, window.scrollY + " vs " + where);
  ok("with the same settings", /Charter/.test(style(text()).fontFamily) &&
    style(q(".glyph-book")).backgroundColor === "rgb(239, 226, 201)");

  await open("scan.epub");
  await until(() => has("The first page"));
  const held = () => [...text().querySelectorAll("img")].filter((i) => i.getAttribute("src")).length;
  const shots = () => [...text().querySelectorAll("img")];
  ok("a scanned chapter's first page draws", await until(() => shots()[0].naturalWidth === 1));
  ok("only the pictures near the screen are held", held() > 0 && held() < 40, held() + " of " + shots().length);
  ok("the rest keep their space", document.documentElement.scrollHeight > innerHeight * 20,
    document.documentElement.scrollHeight);
  shots()[199].scrollIntoView();
  ok("the last picture draws when you reach it", await until(() => shots()[199].naturalWidth === 1));
  ok("pictures far behind let go", await until(() => !shots()[0].getAttribute("src")));
  ok("and the count stays small", held() < 40, held() + " of " + shots().length);

  // The older form, which is most real books.
  await open("old.epub");
  await until(() => has("After an anchor"));
  bar("Contents").click();
  await until(() => style(document.querySelectorAll(".glyph-book-sheet")[0]).display !== "none");
  ok("an older book's table is read", [...document.querySelectorAll(".glyph-book-entry")]
    .map((e) => e.textContent).join("|") === "First|Inside First|Second");
  q(".glyph-book-scrim").click();
  ok("a self-closed anchor does not swallow the page",
    has("After an anchor") && [...text().querySelectorAll("a")].every((a) => !a.textContent));
  ok("a page an XML parser rejects still opens", has("Spaced") && has("out."));
  bar("Next").click();
  await until(() => has("au lait"));
  ok("a page in an older encoding reads correctly", has("café au lait"), text().innerText);

  await open("locked.epub");
  ok("a copy-protected book says so", await until(() => /copy-protected/.test(status())), status());
  rowIn("notabook.epub").click();
  ok("a file that isn't a book says so", await until(() => /isn.t a readable book/.test(status())), status());
  ok("and both leave you on the folder page", lib());
  rowIn("bomb.epub").click();
  ok("a chapter built to fill memory is refused, and the page says so",
    await until(() => has("too large to open")), text() && text().innerText);
  ok("the way past it stays", q(".glyph-book-foot") && status() === "1 of 1", status());

  // Blink reports everything a book attempts as the chapter is parsed, in a document
  // nothing shows, so a refusal there says nothing. In WebKit, the engine an iPhone
  // and the Mac app run, silence means nothing got as far as being refused.
  if (!/Chrome/.test(navigator.userAgent)) {
    ok("the security policy had nothing to refuse", blocked.length === 0, blocked.slice(0, 3).join(" | "));
  }
  ok("nothing was reported as going wrong", reports.length === 0, reports.join(" | "));
  return JSON.stringify(out);
})()
