// A wide window: every folder on the left, the chosen folder's notes beside it,
// the note on the right, as Notes on a Mac. Run through Scripts/pdf-smoke.mjs
// --suite wide-smoke, at desktop size, in Blink and in WebKit.
(async () => {
  const out = window.__pdfSmokeOut = [];
  const ok = (what, cond, detail) =>
    out.push({ what, pass: !!cond, detail: detail == null ? "" : String(detail) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(50); }
    return null;
  };
  const writes = [];
  const realFetch = window.fetch;
  window.fetch = function (url, opts) {
    if (opts && opts.method === "PUT") writes.push(JSON.parse(opts.body));
    return realFetch.apply(this, arguments);
  };
  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.message));
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const body = document.body;
  const box = (el) => el.getBoundingClientRect();
  const shown = (el) => !!el && !el.hidden && getComputedStyle(el).display !== "none" && box(el).width > 0;
  const side = (folder) => q('.glyph-side-row[data-folder="' + folder + '"]');
  const note = (name) => qa(".glyph-lib-note").find((r) => r.dataset.path.split("/").pop() === name);

  await until(() => note("note.md"));
  ok("a wide window shows three panes", body.classList.contains("glyph-wide") &&
    box(q(".glyph-lib-side")).right <= box(q(".glyph-lib-list")).left + 1 &&
    box(q(".glyph-lib-list")).right <= box(q("#content")).left + 1);
  ok("every folder is in the sidebar, the top one chosen",
    side("") && side("drafts") && side("").getAttribute("aria-current") === "true");
  ok("with nothing open, the right says what to do", body.classList.contains("glyph-no-doc") &&
    /Choose a note/.test(getComputedStyle(q("#content"), "::before").content));
  ok("no Back button, since nothing is hidden", !shown(q("#glyph-nav .glyph-round")));

  side("drafts").click();
  await until(() => note("plan.md"));
  ok("choosing a folder lists its notes", note("plan.md") && !note("note.md") &&
    q(".glyph-lib-listtitle").textContent === "drafts");
  note("plan.md").click();
  await until(() => q("#md") && q("#md").innerText.includes("Plan for spring"));
  ok("a note opens on the right, beside the list", q("#md").innerText.includes("Plan for spring") &&
    shown(q(".glyph-lib-list")) && box(q("#md")).left > box(q(".glyph-lib-list")).right - 1);
  ok("and is marked in the list", note("plan.md").getAttribute("aria-current") === "true");
  ok("its tools are along the top", shown(q(".glyph-aa")) && box(q(".glyph-aa")).top < 100 &&
    shown(q('#glyph-nav [aria-label="Share"]')));

  // ------------------------------------------------ a note opened from Finder on the Mac
  ok("a note from another folder opens from the Mac", await window.glyphOpenNote("note.md") === true &&
    q("#md").innerText.includes("A note beside the PDF"));
  ok("with the list moved to its folder, and the note marked there",
    side("").getAttribute("aria-current") === "true" && note("note.md") &&
    note("note.md").getAttribute("aria-current") === "true");
  ok("one already open is shown again", await window.glyphOpenNote("drafts/plan.md") === true &&
    q("#md").innerText.includes("Plan for spring") && side("drafts").getAttribute("aria-current") === "true");
  ok("one the Mac's disk spells differently still opens", await window.glyphOpenNote("Drafts/Plan.md") === true &&
    q("#md").innerText.includes("Plan for spring"));
  const statusBefore = q("#glyph-status") ? q("#glyph-status").textContent : "";
  ok("a note the list does not show is refused, so the Mac opens it itself",
    await window.glyphOpenNote("drafts/nowhere.md") === false && await window.glyphOpenNote(".hidden/plan.md") === false);
  ok("PDFs and books stay with the Mac too",
    await window.glyphOpenNote("book.pdf") === false && await window.glyphOpenNote("novel.epub") === false);
  ok("a refusal puts up no message and leaves the note open", q("#md").innerText.includes("Plan for spring") &&
    (q("#glyph-status") ? q("#glyph-status").textContent : "") === statusBefore);

  q('#glyph-dock [aria-label="New note"]').click();
  await until(() => q("#md").querySelector("h1") && !q("#md").innerText.includes("Plan for spring"));
  document.execCommand("insertText", false, "Desk idea");
  document.execCommand("insertParagraph");
  document.execCommand("insertText", false, "A lamp for the reading corner.");
  await until(() => writes.some((w) => w.create), 5000);
  ok("a new note goes into the folder chosen on the left",
    writes.some((w) => w.create && w.path === "drafts/Desk idea.md"), JSON.stringify(writes.map((w) => w.path)));
  ok("and appears in its list straight away", await until(() => note("Desk idea.md"), 5000));

  const search = q(".glyph-search input");
  ok("search is shown at the top of the list", shown(q(".glyph-search")) && box(search).width > 100 &&
    box(search).top < box(q(".glyph-lib-rows")).top, JSON.stringify(box(search)));
  search.value = "beside";
  search.dispatchEvent(new Event("input"));
  ok("and finds notes in every folder", !!(await until(() => note("note.md"))));
  search.focus();
  search.value = "besid";
  search.dispatchEvent(new Event("input"));
  ok("typing in it keeps its focus, because the list redraws around it",
    document.activeElement === search && q(".glyph-search input") === search);
  search.value = "";
  search.dispatchEvent(new Event("input"));
  // ------------------------------------------------ folders, as on a Mac
  const menu = (label) => qa("#glyph-more .glyph-menu-item").find((b) => b.textContent === label);
  const askShown = () => shown(q("#glyph-ask"));
  const askButton = (label) => qa("#glyph-ask button").find((b) => b.textContent === label);
  const nameIt = async (text, go) => {
    const input = await until(() => askShown() && q("#glyph-ask .glyph-ask-input"));
    input.value = text;
    askButton(go).click();
  };
  const rightClick = (el, x, y) => el.dispatchEvent(new MouseEvent("contextmenu",
    { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  const fire = (el, type) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
  };

  side("").click();
  const newFolderButton = q(".glyph-side-new");
  ok("New Folder sits at the foot of the sidebar", shown(newFolderButton) &&
    box(newFolderButton).bottom > innerHeight - 60 && box(newFolderButton).right <= box(q(".glyph-lib-side")).right,
    JSON.stringify(box(newFolderButton)));
  newFolderButton.click();
  await until(askShown);
  const sheetBox = box(q("#glyph-ask"));
  ok("its question sits in the middle of the window",
    Math.abs((sheetBox.left + sheetBox.right) / 2 - innerWidth / 2) < 4 && sheetBox.top < innerHeight / 2,
    JSON.stringify(sheetBox));
  ok("and says where the folder will go", /^In /.test(q(".glyph-ask-note").textContent));
  await nameIt("Desk", "Create");
  ok("the new folder is in the sidebar, and chosen",
    await until(() => side("Desk") && side("Desk").getAttribute("aria-current") === "true"));
  ok("an empty folder says so", /0 notes/.test(q(".glyph-lib-count").textContent));

  q('#glyph-dock [aria-label="New note"]').click();
  await until(() => q("#md").querySelector("h1") && !q("#md").innerText.includes("Desk idea"));
  document.execCommand("insertText", false, "Drag me");
  document.execCommand("insertParagraph");
  document.execCommand("insertText", false, "Across the sidebar.");
  const dragged = await until(() => note("Drag me.md"), 5000);
  ok("a note in the list can be dragged", !!dragged && dragged.draggable);
  fire(dragged, "dragstart");
  const over = fire(side("drafts"), "dragover");
  ok("a folder in the sidebar takes it", over.defaultPrevented && side("drafts").classList.contains("glyph-drop"));
  ok("the folder it is already in does not", !fire(side("Desk"), "dragover").defaultPrevented);
  fire(side("drafts"), "drop");
  fire(dragged, "dragend");
  ok("dropped on a folder, it moves there", await until(() => !note("Drag me.md"), 5000));
  side("drafts").click();
  ok("and is listed in it, still open", !!(await until(() => note("Drag me.md"))) &&
    note("Drag me.md").getAttribute("aria-current") === "true" && q("#md").innerText.includes("Across the sidebar"));

  fire(side("Desk"), "dragstart");
  fire(side("drafts"), "drop");
  ok("a folder dragged onto another goes inside it", await until(() => side("drafts/Desk") && !side("Desk"), 5000));
  fire(side("drafts"), "dragstart");
  ok("but never into itself", !fire(side("drafts/Desk"), "dragover").defaultPrevented);
  fire(side("drafts"), "dragend");
  ok("the top folder cannot be dragged at all", !side("").draggable);

  rightClick(side("drafts/Desk"), 120, 300);
  await until(() => menu("Rename Folder…"));
  const menuBox = box(q("#glyph-more"));
  ok("a right-click opens a small menu where the pointer is",
    Math.abs(menuBox.left - 120) < 2 && Math.abs(menuBox.top - 300) < 2 && menuBox.width < 260, JSON.stringify(menuBox));
  menu("Rename Folder…").click();
  await nameIt("Old desk", "Rename");
  ok("a folder is renamed from its menu", await until(() => side("drafts/Old desk") && !side("drafts/Desk"), 5000));
  rightClick(side("drafts/Old desk"), 120, 300);
  await until(() => menu("Move to Trash"));
  menu("Move to Trash").click();
  ok("and an empty one goes to the Trash from it, without a question",
    await until(() => !side("drafts/Old desk"), 5000) && !askShown());

  side("drafts").click();
  await until(() => note("Drag me.md"));
  rightClick(note("Drag me.md"), 700, 200);
  await until(() => menu("Pin"));
  menu("Pin").click();
  const pinnedHead = () => qa(".glyph-lib-when").find((h) => h.textContent === "Pinned");
  ok("a note pinned from its menu heads the list", !!(await until(pinnedHead, 5000)) &&
    pinnedHead().nextElementSibling.querySelector(".glyph-lib-note").dataset.path === "drafts/Drag me.md");
  ok("the Mac window has no swipe rows", !q(".glyph-swipe"));

  rightClick(note("Drag me.md"), 700, 200);
  await until(() => menu("Move to Trash"));
  ok("a right-click on a note offers its own actions", !!menu("Move to…") && !!menu("Rename File…"));
  menu("Move to Trash").click();
  ok("a note sent to the Trash leaves the list", await until(() => !note("Drag me.md"), 5000));
  ok("and the page beside it, since it was open", body.classList.contains("glyph-no-doc"));
  ok("with Undo beside the note pane", shown(q("#glyph-undo")) &&
    box(q("#glyph-undo")).left > box(q(".glyph-lib-list")).right);

  ok("no page errors", errors.length === 0, errors.join(" | "));
  return JSON.stringify(out);
})()
