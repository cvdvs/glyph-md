// The phone's own screens, laid out like Apple Notes: folders, search, a note on
// a page of its own, the Aa sheet, the menu, new notes and dictation. Run through
// Scripts/pdf-smoke.mjs --suite notes-smoke in Blink and in WebKit. Whisper is the
// stand-in in Scripts/fake-whisper.mjs, and the microphone is replaced below by a
// recorder whose "audio" names the stand-in's case.
(async () => {
  const out = window.__pdfSmokeOut = [];
  const ok = (what, cond, detail) =>
    out.push({ what, pass: !!cond, detail: detail == null ? "" : String(detail) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000) => {
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
    else if (opts && opts.method === "PUT") writes.push(JSON.parse(opts.body));
    return realFetch.apply(this, arguments);
  };
  const blocked = [];
  document.addEventListener("securitypolicyviolation", (e) => blocked.push(e.violatedDirective + " " + e.blockedURI));
  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.message));

  // The microphone. What it "hears" is the stand-in's case name.
  let heard = "CASE:pause";
  window.MediaRecorder = class {
    constructor() { this.mimeType = "audio/mp4"; this.state = "inactive"; this.on = {}; }
    static isTypeSupported(t) { return t === "audio/mp4"; }
    addEventListener(type, fn) { (this.on[type] = this.on[type] || []).push(fn); }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      (this.on.dataavailable || []).forEach((f) => f({ data: new Blob([heard], { type: "audio/mp4" }) }));
      setTimeout(() => (this.on.stop || []).forEach((f) => f({})), 10);
    }
  };
  // A stream with nothing in it. A real one from an AudioContext sometimes stalled
  // waiting for this Mac's audio hardware, which is not what is being tested.
  const fakeStream = async () => ({ getTracks: () => [] });
  // On the prototype, not on navigator.mediaDevices itself: WebKit can drop that
  // object's wrapper and make a new one, and a property added to the old one goes
  // with it, which sent the third recording to the real microphone.
  if (window.MediaDevices) MediaDevices.prototype.getUserMedia = fakeStream;
  else Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: fakeStream } });

  const body = document.body;
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const lib = () => body.classList.contains("glyph-library");
  const shown = (el) => !!el && !el.hidden && getComputedStyle(el).display !== "none" &&
    el.getBoundingClientRect().width > 0;
  const back = () => q("#glyph-nav .glyph-round").click();
  const heading = () => q(".glyph-lib-heading").textContent;
  const rowIn = (label) => qa(".glyph-lib-note").find((r) => {
    const base = r.dataset.path.split("/").pop();
    return base === label || base === label + ".md";
  });
  const open = async (label) => {
    if (!lib()) { back(); await until(lib); }
    (await until(() => rowIn(label))).click();
  };
  const md = () => q("#md");
  const status = () => q("#glyph-status").textContent;
  const typeAtEnd = (text) => {
    md().focus();
    getSelection().selectAllChildren(md());
    getSelection().collapseToEnd();
    document.execCommand("insertText", false, text);
  };
  const sheet = (button) => qa("#glyph-format button").find((b) => b.getAttribute("aria-label") === button || b.textContent === button);

  // The folder page.
  await until(() => rowIn("note"));
  ok("it opens on the top folder, by name", lib() && heading().length > 0 && !shown(q("#glyph-nav .glyph-round")), heading());
  ok("counts its folders and notes", /1 folder, \d+ notes/.test(q(".glyph-lib-count").textContent), q(".glyph-lib-count").textContent);
  const folder = q('.glyph-lib-folder[data-folder="drafts"]');
  ok("a folder is a row with its count", folder && /drafts\s*2/.test(folder.textContent), folder && folder.textContent);
  ok("notes are grouped by when they changed", qa(".glyph-lib-when").map((h) => h.textContent).includes("Today"));
  ok("a note shows its title and the start of its text",
    /A note beside the PDF/.test(rowIn("note").textContent) && rowIn("note").querySelector(".glyph-lib-title").textContent === "Note",
    rowIn("note").textContent);
  ok("nothing scrolls sideways", document.documentElement.scrollWidth <= innerWidth + 1 &&
    q("#glyph-library").scrollWidth <= innerWidth + 1);

  folder.click();
  await until(() => heading() === "drafts");
  ok("a folder opens on a page of its own, with Back", heading() === "drafts" && shown(q("#glyph-nav .glyph-round")));
  ok("an old note sorts under its year", qa(".glyph-lib-when").map((h) => h.textContent).includes("2024"),
    qa(".glyph-lib-when").map((h) => h.textContent).join("|"));
  ok("a note with no heading is titled by its first line", !!qa(".glyph-lib-title").find((t) => t.textContent === "Loose ideas"));
  back();
  await until(() => !heading().startsWith("drafts"));
  ok("Back returns to the top folder", lib() && !!rowIn("note"));

  const search = q(".glyph-search input");
  search.value = "spring";
  search.dispatchEvent(new Event("input"));
  ok("search finds a note in another folder, and says where it is",
    rowIn("plan") && /drafts/.test(rowIn("plan").textContent) && qa(".glyph-lib-note").length === 1,
    qa(".glyph-lib-note").map((r) => r.dataset.path).join(","));
  search.value = "";
  search.dispatchEvent(new Event("input"));

  // A note.
  await open("note");
  await until(() => !lib() && md() && md().innerText.includes("A note beside"));
  ok("a note opens full screen", !lib() && md().innerText.includes("A note beside"));
  ok("with Back, Share and the menu at the top",
    shown(q("#glyph-nav .glyph-round")) && shown(q('#glyph-nav [aria-label="Share"]')) && shown(q('#glyph-nav [aria-label="More"]')));
  ok("and its tools at the bottom, the microphone among them",
    shown(q(".glyph-aa")) && shown(q(".glyph-check")) && shown(q(".glyph-mic")));
  const nav = q("#glyph-nav").getBoundingClientRect();
  ok("nothing of the note sits under the top bar",
    md().getBoundingClientRect().top >= nav.bottom - 1, md().getBoundingClientRect().top + " vs " + nav.bottom);

  // Aa.
  q(".glyph-aa").click();
  await until(() => shown(q("#glyph-format")));
  ok("Aa opens the format sheet", shown(q("#glyph-format")));
  ok("Done appears while writing", shown(q(".glyph-done")));
  sheet("Heading").click();
  ok("Heading makes the line a heading", md().lastElementChild && md().querySelector("h1:last-of-type") &&
    sheet("Heading").getAttribute("aria-pressed") === "true");
  sheet("Body").click();
  ok("Body makes it plain text again", sheet("Body").getAttribute("aria-pressed") === "true");
  typeAtEnd(" Plain words added");
  ok("the sheet fits the screen", q("#glyph-format").getBoundingClientRect().left >= 0 &&
    q("#glyph-format").getBoundingClientRect().right <= innerWidth);
  sheet("Close").click();
  await until(() => !shown(q("#glyph-format")));
  q(".glyph-check").click();
  ok("the checklist button adds a checklist item", !!md().querySelector('input[type="checkbox"]'));
  q(".glyph-done").click();
  await until(() => !shown(q(".glyph-done")));
  ok("Done stops writing", !shown(q(".glyph-done")) && !md().contains(document.activeElement));

  // The menu.
  q('#glyph-nav [aria-label="More"]').click();
  await until(() => shown(q("#glyph-more")));
  const item = (label) => qa("#glyph-more button").find((b) => b.textContent === label || b.getAttribute("aria-label") === label);
  ok("the menu offers copy, markdown, text size and look",
    item("Copy as Markdown") && item("Show Markdown") && item("Larger text") && item("Dark"));
  item("Dark").click();
  ok("the look can be set to dark", document.documentElement.getAttribute("data-theme") === "dark");
  item("Auto").click();
  ok("and back to following the phone", !document.documentElement.hasAttribute("data-theme"));
  item("Show Markdown").click();
  ok("Show Markdown shows the file as text", body.classList.contains("glyph-raw") && /# Note/.test(q("#glyph-raw").value));
  q('#glyph-nav [aria-label="More"]').click();
  item("Show Formatted").click();
  ok("and Show Formatted goes back", !body.classList.contains("glyph-raw"));

  // Dictation into the note, where the caret was.
  q(".glyph-mic").click();
  await until(() => q("#glyph-voice").dataset.state === "recording");
  ok("the microphone opens the recorder, listening", shown(q("#glyph-voice")) && /0:0\d/.test(q(".glyph-voice-clock").textContent),
    q("#glyph-voice").dataset.state + " / " + q("#glyph-voice").textContent + " / overlay " + body.dataset.overlay);
  ok("with the language to choose: Auto, English, Română",
    qa(".glyph-voice-langs button").map((b) => b.textContent).join("|") === "Auto|English|Rom\u00e2n\u0103");
  q(".glyph-voice-stop").click();
  await until(() => !shown(q("#glyph-voice")), 8000);
  ok("Stop writes it into the note", /Zebra one two/.test(md().innerText), md().innerText.slice(-120));
  ok("in paragraphs where the speaker paused",
    qa("#md p").filter((p) => /Zebra|Four/.test(p.textContent)).length === 2,
    qa("#md p").map((p) => p.textContent).join(" | "));
  ok("and says how much it added", /Added \d+ words/.test(status()), status());
  await until(() => writes.some((w) => w.path === "note.md" && /Zebra/.test(w.text)), 5000);
  ok("the dictation is saved to the note", writes.some((w) => w.path === "note.md" && /Zebra/.test(w.text)));

  heard = "CASE:silence";
  q(".glyph-mic").click();
  await until(() => q("#glyph-voice").dataset.state === "recording");
  q(".glyph-voice-stop").click();
  ok("silence says so instead of adding anything",
    await until(() => /No speech/.test(q("#glyph-voice").textContent)), q("#glyph-voice").textContent);
  qa("#glyph-voice button").find((b) => b.textContent === "Cancel").click();
  ok("Cancel closes the recorder", await until(() => !shown(q("#glyph-voice"))));

  // New notes.
  writes.length = 0;
  await sleep(300);
  q('#glyph-dock [aria-label="New note"]').click();
  await until(() => !lib() && md().querySelector("h1"));
  ok("a new note starts on a title line", !lib() && md().firstElementChild && md().firstElementChild.tagName === "H1");
  document.execCommand("insertText", false, "Grocery list");
  await sleep(1000);
  ok("nothing is saved before the title line is finished", writes.length === 0, writes.length + " writes");
  document.execCommand("insertParagraph");
  document.execCommand("insertText", false, "Eggs");
  await until(() => writes.some((w) => w.create && w.path === "Grocery list.md"), 5000);
  ok("then it is saved under that title", writes.some((w) => w.create && w.path === "Grocery list.md"),
    JSON.stringify(writes.map((w) => w.path)));
  back();
  await until(lib);
  await sleep(500);
  ok("and it is in the folder when you go back", rowIn("Grocery list") && !!rowIn("Grocery list").textContent.match(/Eggs/),
    rowIn("Grocery list") && rowIn("Grocery list").textContent);

  q('#glyph-dock [aria-label="New note"]').click();
  await until(() => !lib() && md().querySelector("h1"));
  document.execCommand("insertText", false, "Grocery list");
  document.execCommand("insertParagraph");
  document.execCommand("insertText", false, "Milk");
  back();
  await until(lib);
  await until(() => rowIn("Grocery list 2"), 5000);
  ok("a second note with the same title gets a number", !!rowIn("Grocery list 2"));

  q('#glyph-dock [aria-label="New note"]').click();
  await until(() => !lib() && md().querySelector("h1"));
  back();
  await until(lib);
  await sleep(500);
  ok("an empty new note is just let go", !qa(".glyph-lib-note").some((r) => /New note/.test(r.textContent)));

  heard = "CASE:pause";
  q('#glyph-dock [aria-label="New voice note"]').click();
  await until(() => q("#glyph-voice").dataset.state === "recording");
  q(".glyph-voice-stop").click();
  await until(() => !shown(q("#glyph-voice")), 8000);
  ok("a voice note from the folder page becomes a new note", !lib() && /Zebra one two/.test(md().innerText),
    "lib " + lib() + " / voice " + q("#glyph-voice").dataset.state + " " + q("#glyph-voice").textContent.slice(0, 80) +
    " / overlay " + body.dataset.overlay + " / md " + md().innerText.slice(0, 60) + " / status " + status());
  back();
  await until(lib);
  ok("named after its first words", await until(() => qa(".glyph-lib-note").some((r) => /^Zebra/.test(r.dataset.path)), 5000));

  ok("no page errors", errors.length === 0, errors.join(" | "));
  ok("nothing was reported as going wrong", reports.length === 0, reports.join(" | "));
  ok("the security policy refused nothing", blocked.length === 0, blocked.slice(0, 3).join(" | "));
  return JSON.stringify(out);
})()
