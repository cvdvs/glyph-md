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

  // ------------------------------------------------ folders, moves, the Trash
  const more = () => q('#glyph-nav [aria-label="More"]');
  const menu = (label) => qa("#glyph-more .glyph-menu-item").find((b) => b.textContent === label);
  const askShown = () => shown(q("#glyph-ask"));
  const askButton = (label) => qa("#glyph-ask button").find((b) => b.textContent === label);
  const folderRowIn = (name) => qa(".glyph-lib-folder").find((r) => r.dataset.folder.split("/").pop() === name);
  const press = (el) => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true,
    clientX: 60, clientY: el.getBoundingClientRect().top + 20 }));
  const nameIt = async (text, go) => {
    const input = await until(() => askShown() && q("#glyph-ask .glyph-ask-input"));
    input.value = text;
    askButton(go).click();
  };

  if (!lib()) { back(); await until(lib); }
  while (q('#glyph-nav [aria-label="Back"]') && shown(q("#glyph-nav .glyph-round")) && heading() !== "Notes") {
    back();
    await sleep(100);
  }
  ok("a folder page has a menu of its own", shown(more()) && !shown(q('#glyph-nav [aria-label="Share"]')));
  more().click();
  await until(() => menu("New Folder…"));
  ok("at the top it only makes folders", !!menu("New Folder…") && !menu("Move to Trash"),
    qa("#glyph-more .glyph-menu-item").map((b) => b.textContent).join(", "));
  menu("New Folder…").click();
  const nameField = await until(() => askShown() && q("#glyph-ask .glyph-ask-input"));
  ok("New Folder asks for a name, with the field ready to type in", !!nameField && document.activeElement === nameField);
  nameField.value = "a/b";
  askButton("Create").click();
  await sleep(100);
  ok("a name with a slash is explained, not sent", askShown() && /can’t have/.test(q(".glyph-ask-note").textContent));
  await nameIt("Projects", "Create");
  ok("the new folder is on the page, empty", await until(() => folderRowIn("Projects")) &&
    folderRowIn("Projects").textContent.includes("0") && !askShown());

  // A note moved while an edit is still on its way: the edit goes with it.
  q('#glyph-dock [aria-label="New note"]').click();
  await until(() => !lib() && md().querySelector("h1"));
  document.execCommand("insertText", false, "Move me");
  document.execCommand("insertParagraph");
  document.execCommand("insertText", false, "Body text");
  back();
  await until(lib);
  await until(() => rowIn("Move me"), 5000);
  await open("Move me");
  await until(() => md().innerText.includes("Body text"));
  typeAtEnd(" EXTRA");
  more().click();
  await until(() => menu("Move to…"));
  ok("a note's menu can move, rename and trash it", !!menu("Move to…") && !!menu("Rename File…") && !!menu("Move to Trash"));
  menu("Move to…").click();
  await until(() => askShown() && q('.glyph-pick-row[data-folder="Projects"]'));
  ok("the folder it is in now cannot be chosen", q('.glyph-pick-row[data-folder=""]').disabled &&
    !q('.glyph-pick-row[data-folder="Projects"]').disabled);
  q('.glyph-pick-row[data-folder="Projects"]').click();
  ok("it says where the note went", await until(() => /Moved to Projects/.test(status()), 8000), status());
  ok("and the note stays open", !lib() && md().innerText.includes("EXTRA"));
  back();
  await until(lib);
  ok("Back now leads to its new folder", heading() === "Projects" && !!(await until(() => rowIn("Move me"))), heading());

  more().click();
  await until(() => menu("Rename Folder…"));
  ok("inside a folder the menu has the folder's own actions",
    !!menu("Rename Folder…") && !!menu("Move to…") && !!menu("Move to Trash"));
  menu("Rename Folder…").click();
  await nameIt("Work", "Rename");
  ok("a renamed folder is still the page you are on", await until(() => heading() === "Work"), heading());
  ok("and its note came along", !!(await until(() => rowIn("Move me"))) && rowIn("Move me").dataset.path === "Work/Move me.md");

  press(rowIn("Move me"));
  await until(() => menu("Rename File…"));
  ok("a long press on a note opens its menu beside it",
    shown(q("#glyph-more")) && Math.abs(q("#glyph-more").getBoundingClientRect().top - rowIn("Move me").getBoundingClientRect().top) < 140);
  menu("Rename File…").click();
  ok("renaming starts from the current name",
    (await until(() => askShown() && q("#glyph-ask .glyph-ask-input"))).value === "Move me");
  await nameIt("Moved note", "Rename");
  ok("and the file takes the new one", await until(() => rowIn("Moved note"), 5000));

  press(rowIn("Moved note"));
  await until(() => menu("Move to Trash"));
  menu("Move to Trash").click();
  ok("a note goes to the Trash at once, without a question",
    await until(() => !rowIn("Moved note"), 5000) && !askShown());
  const undo = () => q("#glyph-undo");
  ok("and offers Undo, naming it by its title", shown(undo()) && /Move me/.test(undo().textContent) && /Trash/.test(undo().textContent),
    undo().textContent);
  q(".glyph-undo-button").click();
  ok("Undo puts it back", !!(await until(() => rowIn("Moved note"), 5000)) && !shown(undo()));

  // A swipe to the left shows Move and Delete; all the way across deletes.
  const pointer = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
    pointerId: 7, pointerType: "touch", isPrimary: true, clientX: x, clientY: y }));
  const swipe = async (el, dx) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    pointer(el, "pointerdown", x, y);
    for (let i = 1; i <= 6; i++) { pointer(el, "pointermove", x + dx * i / 6, y + 1); await sleep(16); }
    pointer(el, "pointerup", x + dx, y + 1);
    await sleep(400);
  };
  const wrapOf = (row) => row.closest(".glyph-swipe");
  await swipe(rowIn("Moved note"), -120);
  ok("a swipe to the left opens Move and Delete", shown(wrapOf(rowIn("Moved note")).querySelector(".glyph-swipe-delete")) &&
    shown(wrapOf(rowIn("Moved note")).querySelector(".glyph-swipe-move")) &&
    Math.round(rowIn("Moved note").getBoundingClientRect().left) < 0, rowIn("Moved note").style.transform);
  rowIn("Moved note").click();
  await sleep(300);
  ok("a tap on the open row only closes it", lib() && !rowIn("Moved note").style.transform);
  await swipe(rowIn("Moved note"), -40);
  ok("a short swipe springs back", !rowIn("Moved note").style.transform);
  await swipe(rowIn("Moved note"), -380);
  ok("a swipe all the way across deletes it", await until(() => !rowIn("Moved note"), 5000) && shown(undo()));

  back();
  await until(() => heading() === "Notes");

  // A swipe to the right pins a note: Pinned is the first section on its page.
  await until(() => rowIn("Grocery list"));
  await swipe(rowIn("Grocery list"), 120);
  const pinButton = await until(() => wrapOf(rowIn("Grocery list")).querySelector(".glyph-swipe-pin"));
  ok("a swipe to the right shows Pin", shown(pinButton) && pinButton.getAttribute("aria-label") === "Pin");
  pinButton.click();
  const pinnedHead = () => qa(".glyph-lib-when").find((h) => h.textContent === "Pinned");
  ok("a pinned note heads its folder", !!(await until(pinnedHead, 5000)) &&
    pinnedHead().nextElementSibling.querySelector(".glyph-lib-note").dataset.path === "Grocery list.md" &&
    qa(".glyph-lib-note").filter((r) => r.dataset.path === "Grocery list.md").length === 1);
  await until(() => rowIn("Grocery list 2"));
  await swipe(rowIn("Grocery list 2"), 330);
  ok("a swipe all the way across pins at once", await until(() => pinnedHead() &&
    pinnedHead().nextElementSibling.querySelectorAll(".glyph-lib-note").length === 2, 5000));
  press(rowIn("Grocery list 2"));
  await until(() => menu("Unpin"));
  menu("Unpin").click();
  ok("the menu unpins", await until(() => pinnedHead() &&
    pinnedHead().nextElementSibling.querySelectorAll(".glyph-lib-note").length === 1, 5000));
  ok("a folder has nothing to pin", (await (async () => {
    await swipe(folderRowIn("drafts"), 120);
    return !folderRowIn("drafts").style.transform && !wrapOf(folderRowIn("drafts")).querySelector(".glyph-swipe-pin");
  })()));
  await swipe(folderRowIn("drafts"), -120);
  wrapOf(folderRowIn("drafts")).querySelector(".glyph-swipe-delete").click();
  ok("a folder with notes in it asks before the Trash",
    /the 2 files in it/.test((await until(() => askShown() && q(".glyph-ask-text"))).textContent));
  askButton("Cancel").click();
  await sleep(200);
  ok("and Cancel keeps it", !askShown() && !!folderRowIn("drafts"));

  more().click();
  menu("New Folder…").click();
  await nameIt("Inbox", "Create");
  await until(() => folderRowIn("Inbox"));
  more().click();
  menu("New Folder…").click();
  await nameIt("Archive", "Create");
  await until(() => folderRowIn("Archive"));
  press(folderRowIn("Inbox"));
  await until(() => menu("Move to…"));
  menu("Move to…").click();
  await until(() => askShown() && q('.glyph-pick-row[data-folder="Archive"]'));
  ok("a folder cannot be moved into itself, or to where it is",
    q('.glyph-pick-row[data-folder="Inbox"]').disabled && q('.glyph-pick-row[data-folder=""]').disabled);
  q('.glyph-pick-row[data-folder="Archive"]').click();
  ok("a folder moves into another", await until(() => !folderRowIn("Inbox"), 5000));
  folderRowIn("Archive").click();
  ok("and is found inside it", !!(await until(() => folderRowIn("Inbox"))));
  back();
  await until(() => heading() === "Notes");
  press(folderRowIn("Work"));
  await until(() => menu("Move to Trash"));
  menu("Move to Trash").click();
  ok("an empty folder goes to the Trash without a question", await until(() => !folderRowIn("Work"), 5000) && !askShown());

  // ------------------------------------------------ the plain address and the secure one
  // On the plain address the recorder sends you to the secure one, and the note
  // goes with you. Without MediaRecorder this page looks like the plain address.
  ok("a note opens by name", await window.glyphOpenNote("note.md") === true && /A note beside the PDF/.test(md().innerText));
  const recorder = window.MediaRecorder;
  window.MediaRecorder = undefined;
  q(".glyph-mic").click();
  const go = await until(() => q(".glyph-voice-link"));
  ok("without a microphone the recorder offers the secure address, and says to keep that one",
    !!go && /Home Screen/.test(q("#glyph-voice").textContent), q("#glyph-voice").textContent);
  const token = (location.hash.match(/token=([a-f0-9]+)/) || [])[1];
  // The pairing token is never printed (rule 44), not even in a test's detail.
  const hideToken = (text) => String(text).split(token).join("…");
  ok("and the way there opens this same note",
    !!go && go.dataset.to === "https://glyph.test/#token=" + token + "&open=note.md",
    go && hideToken(go.dataset.to));
  qa("#glyph-voice button").find((b) => b.textContent === "Cancel").click();
  window.MediaRecorder = recorder;
  await until(() => !shown(q("#glyph-voice")));

  // Arriving there. Safari may reuse the tab it opened last time, so only the
  // part after # changes, and the page has to notice.
  location.hash = "#token=" + token + "&open=" + encodeURIComponent("drafts/plan.md");
  ok("arriving with a note in the address opens it",
    !!(await until(() => !lib() && /Plan for spring/.test(md().innerText))), md().innerText.slice(0, 80));
  ok("and the address keeps only the pairing, for a Home Screen icon saved from there",
    location.hash === "#token=" + token, hideToken(location.hash));
  back();
  ok("Back goes to that note's folder", !!(await until(() => lib() && rowIn("plan"))) && /drafts/.test(heading()), heading());
  back();
  await until(() => lib() && rowIn("note"));

  ok("no page errors", errors.length === 0, errors.join(" | "));
  ok("nothing was reported as going wrong", reports.length === 0, reports.join(" | "));
  ok("the security policy refused nothing", blocked.length === 0, blocked.slice(0, 3).join(" | "));
  return JSON.stringify(out);
})()
