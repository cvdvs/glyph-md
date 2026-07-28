// Shared assertion suite for the Glyph shared UI layer (Resources/viewer.html).
//
// One file, run identically by three hosts:
//   - Scripts/webkit-smoke.m   (macOS WKWebView — the engine the shipping Mac app uses)
//   - Scripts/engine-smoke.mjs (headless Chrome/Blink — the engine Windows WebView2 uses)
//   - the portable shell's --selftest (Windows + Linux, in the real app)
//
// It assumes the page has already rendered a document via window.renderMarkdown().
// It returns a JSON string. Every key whose name is an assertion must be true;
// `serialized` is compared by the caller against Scripts/fixtures/golden-sample.md
// so a mismatch produces a readable diff instead of an opaque hash.
//
// It must not depend on anything from its host: no modules, no fetch, no crypto.
(function () {
  var r = {};
  var fail = function (name, err) { r[name] = false; r[name + "Error"] = String(err); };

  try {
    var md = document.getElementById("md");
    r.editable = !!md && md.contentEditable === "true";

    // --- rendering: the document survived parsing into the expected shapes ---
    r.callouts = md.querySelectorAll(".callout").length;
    r.foldableCallouts = md.querySelectorAll("details.callout").length;
    r.calloutIcons = md.querySelectorAll(".callout-icon").length;
    r.tables = md.querySelectorAll("table").length;
    r.tags = md.querySelectorAll(".tag").length;
    r.wikilinks = md.querySelectorAll(".wikilink").length;
    r.tasks = md.querySelectorAll("li.task").length;
    r.codeBlocks = md.querySelectorAll("pre").length;
    r.props = !!document.querySelector(".props");
    r.headings = md.querySelectorAll("h1,h2,h3,h4").length;

    // Colors must actually apply. On an engine without color-mix() support the
    // whole declaration is dropped and these come back transparent/empty —
    // which is exactly the silent breakage this assertion exists to catch.
    var h2 = md.querySelector("h2");
    r.headingColored = !!h2 && getComputedStyle(h2).color !== getComputedStyle(md).color;
    var tag = md.querySelector(".tag");
    var tagBg = tag ? getComputedStyle(tag).backgroundColor : "";
    r.tagTinted = !!tagBg && tagBg !== "rgba(0, 0, 0, 0)" && tagBg !== "transparent";
    var callout = md.querySelector(".callout");
    var coBg = callout ? getComputedStyle(callout).backgroundColor : "";
    r.calloutTinted = !!coBg && coBg !== "rgba(0, 0, 0, 0)" && coBg !== "transparent";

    // --- round-trip: rendered DOM serializes back to the source markdown ---
    var ser0 = window.glyphSerialize();
    r.serialized = ser0;
    r.roundtripCallout = ser0.indexOf("> [!important]-") >= 0;
    r.roundtripTable = ser0.indexOf("| Shortcut | Does |") >= 0;
    r.roundtripFence = ser0.indexOf("```css") >= 0;
    r.roundtripTask = ser0.indexOf("- [x] Tabs") >= 0;
    r.roundtripWikilink = ser0.indexOf("[[Wikilinks]]") >= 0;
    r.roundtripHighlight = ser0.indexOf("==highlights==") >= 0;
    // Fenced code must keep its internal newlines. <pre>a<br>b</pre>.textContent
    // is "ab", so a naive serializer silently welds code lines together.
    r.fenceKeepsNewlines = /```css\n[^\n]+\n[^\n]+\n```/.test(ser0);
    r.noNbsp = ser0.indexOf(" ") < 0;
    r.noZwsp = ser0.indexOf("​") < 0;

    var sel = getSelection();
    var place = function (node, offset) {
      var rg = document.createRange();
      rg.setStart(node, offset);
      rg.collapse(true);
      sel.removeAllRanges();
      sel.addRange(rg);
    };

    // --- typing into the live editor reaches the markdown ---
    md.focus();
    var p = md.querySelector("p");
    place(p.firstChild, 0);
    document.execCommand("insertText", false, "SMOKE-TYPED ");
    r.typed = window.glyphSerialize().indexOf("SMOKE-TYPED") >= 0;

    // --- toolbar acts on a selection and produces real markdown ---
    var rg = document.createRange();
    rg.setStart(p.firstChild, 0);
    rg.setEnd(p.firstChild, 11);
    sel.removeAllRanges();
    sel.addRange(rg);
    window.glyphToolbar("bold");
    r.bold = window.glyphSerialize().indexOf("**SMOKE-TYPED**") >= 0;

    // --- markdown-as-you-type block rule ---
    var np = document.createElement("p");
    np.textContent = "## ";
    md.appendChild(np);
    place(np.firstChild, 3);
    r.blockRule = tryBlockRules();
    document.execCommand("insertText", false, "Smoke Heading");
    r.heading = window.glyphSerialize().indexOf("## Smoke Heading") >= 0;

    // --- markdown-as-you-type inline rule ---
    var ip = document.createElement("p");
    ip.innerHTML = "<br>";
    md.appendChild(ip);
    place(ip, 0);
    "see **wow**".split("").forEach(function (ch) {
      document.execCommand("insertText", false, ch);
      tryInlineRules();
    });
    r.inlineRule = !!ip.querySelector("strong");

    // --- list creation (the engine-divergent one: Chromium nests the new list
    //     inside the old paragraph, WebKit does not) ---
    var lp = document.createElement("p");
    lp.innerHTML = "<br>";
    md.appendChild(lp);
    place(lp, 0);
    "- ".split("").forEach(function (ch) {
      document.execCommand("insertText", false, ch);
      tryBlockRules();
    });
    document.execCommand("insertText", false, "smoke item");
    r.bullets = window.glyphSerialize().indexOf("- smoke item") >= 0;

    // --- images must stay RELATIVE. On Windows the page is loaded with no base
    //     URL, so a serializer that reads img.src (absolute) instead of the
    //     original path writes a broken link into the user's file. ---
    if (typeof window.glyphInsertImage === "function") {
      var ep = document.createElement("p");
      ep.innerHTML = "<br>";
      md.appendChild(ep);
      place(ep, 0);
      window.glyphInsertImage("pic.png");
      var serImg = window.glyphSerialize();
      r.imageRelative = /!\[[^\]]*\]\(pic\.png\)/.test(serImg);
      r.imageNotAbsolute = serImg.indexOf("file://") < 0 && serImg.indexOf("http") !== 0;
    }

    // The portable shell resolves a relative image against the document's own
    // folder, because its page is loaded from a temp file and has no baseURL.
    // The display src may be absolute; what goes BACK to the file must still be
    // the path the author wrote, or every save would rewrite her notes with
    // paths that only work on the machine that opened them.
    {
      // Restored at the end: later assertions (and, with --chrome, the tab the
      // shell is holding) expect the document this page opened with.
      var savedDoc = window.glyphGetText();
      window.__glyphDocDir = "file:///tmp/glyph-test-notes/";
      window.renderMarkdown("Before\n\n![a cat](pics/cat.png)\n\nAfter\n");
      var shown = document.querySelector("#md img");
      r.docDirResolves = !!shown &&
        shown.getAttribute("src") === "file:///tmp/glyph-test-notes/pics/cat.png";
      r.docDirKeepsOriginal = !!shown &&
        shown.getAttribute("data-local-src") === "pics/cat.png";
      var serDoc = window.glyphSerialize();
      r.docDirRoundTrips = /!\[a cat\]\(pics\/cat\.png\)/.test(serDoc);
      r.docDirLeaksNoPath = serDoc.indexOf("file:///tmp") < 0;
      r.docDirKeepsProse = serDoc.indexOf("Before") >= 0 && serDoc.indexOf("After") >= 0;
      // A note cannot forge the attribute the serializer trusts: it is not in
      // the allowlist, so the sanitizer must strip it before we ever read it.
      window.renderMarkdown('<img src="real.png" data-local-src="../../../etc/passwd">\n');
      var forged = document.querySelector("#md img");
      r.docDirNotForgeable = !forged || forged.getAttribute("data-local-src") !==
        "../../../etc/passwd";
      r.docDirForgeryNotWritten = window.glyphSerialize().indexOf("etc/passwd") < 0;
      window.__glyphDocDir = undefined;
      // With no document folder the behaviour must be exactly what it was.
      window.renderMarkdown("![x](pics/cat.png)\n");
      var plain = document.querySelector("#md img");
      r.noDocDirUnchanged = !!plain && plain.getAttribute("src") === "pics/cat.png" &&
        !plain.hasAttribute("data-local-src");
      window.renderMarkdown(savedDoc);
      r.docDirRestoredDoc = window.glyphGetText().indexOf("#") >= 0;
    }

    r.ok = Object.keys(r).every(function (k) {
      if (k === "serialized" || /Error$/.test(k)) return true;
      var v = r[k];
      return typeof v === "boolean" ? v : typeof v === "number" ? v > 0 : true;
    });
  } catch (e) {
    fail("exception", e && e.stack ? e.stack : e);
    r.ok = false;
  }

  return JSON.stringify(r);
})()
