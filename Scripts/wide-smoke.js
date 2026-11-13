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
  ok("no page errors", errors.length === 0, errors.join(" | "));
  return JSON.stringify(out);
})()
