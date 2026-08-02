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

    // --- select all, and copy as markdown ---
    // Select All was dead in the Mac app's formatted view: WebKit's selectAll:
    // selects nothing while the page's activeElement is BODY, which is the
    // state the app leaves behind after making the web view first responder
    // (measured: 0 characters vs 1327 with the article focused). And Copy gave
    // the RENDERED text, with every heading, bullet and emphasis flattened
    // away. Both are page-side now, so both are assertable in every engine.
    {
      var savedCopyDoc = window.glyphGetText();
      window.renderMarkdown(
        "# Title\n\nFirst **bold** line.\n\n## Second\n\n- one\n- two\n\nLast line.\n");

      var count = window.glyphSelectAll();
      var selAll = window.getSelection().toString();
      r.selectAllReturnsLength = typeof count === "number" && count > 0;
      r.selectAllSpansWholeNote =
        selAll.indexOf("Title") >= 0 && selAll.indexOf("Last line") >= 0;

      var all = window.glyphCopyText("all");
      r.copyAllIsMarkdown = all.indexOf("# Title") >= 0 && all.indexOf("## Second") >= 0 &&
                            all.indexOf("**bold**") >= 0 && all.indexOf("- one") >= 0;
      r.copyAllMatchesFile = all === window.glyphGetText();

      // A multi-block selection must stop where the selection stops.
      var mdEl = document.getElementById("md");
      var h2 = mdEl.querySelector("h2");
      var list = mdEl.querySelector("ul");
      var sel = window.getSelection();
      var rg = document.createRange();
      rg.setStartBefore(h2);
      rg.setEndAfter(list);
      sel.removeAllRanges(); sel.addRange(rg);
      var part = window.glyphCopyText("selection");
      r.copySelectionKeepsBlocks = part.indexOf("## Second") >= 0 && part.indexOf("- one") >= 0;
      r.copySelectionStopsAtSelection =
        part.indexOf("# Title") < 0 && part.indexOf("Last line") < 0;

      // A selection that begins and ends INSIDE one paragraph clones bare text
      // and inline elements. serializeBlock has no case for those and falls
      // through to outerHTML, so without the paragraph-wrapping pass this puts
      // raw <strong> markup on the clipboard instead of markdown (rule 14).
      var strong = mdEl.querySelector("strong");
      var rg2 = document.createRange();
      rg2.setStartBefore(strong.previousSibling || strong);
      rg2.setEndAfter(strong);
      sel.removeAllRanges(); sel.addRange(rg2);
      var inline = window.glyphCopyText("selection");
      r.copyPartialKeepsEmphasis = inline.indexOf("**bold**") >= 0;
      r.copyPartialLeaksNoHtml = inline.indexOf("<strong") < 0 && inline.indexOf("</") < 0;

      // Nothing selected falls back to the whole note, so one shortcut covers
      // both of the things a reader wants.
      sel.removeAllRanges();
      r.copySelectionFallsBackToWhole =
        window.glyphCopyText("selection") === window.glyphGetText();

      // Every surface but macOS writes the clipboard from here, and the phone
      // is not a secure context so navigator.clipboard does not exist there.
      r.copyClipboardHelper = typeof window.glyphCopyToClipboard === "function";

      // cloneContents() returns the CONTENTS of a range and never the element
      // they sat in, so selecting part of a list hands over bare <li> nodes and
      // part of a table bare <tr>. serializeBlock has a case for neither.
      // Measured before the re-wrap: two bullets came back as "alpha\nbeta",
      // two checklist items as " one\n two", and two table rows as
      // "\n1\n2\n\n\n3\n4". Selecting a few bullets is the most ordinary
      // "copy a section" there is, so these are the cases that matter most.
      var pick = function (a, b) {
        var g = document.createRange();
        g.setStartBefore(a); g.setEndAfter(b);
        var s2 = window.getSelection(); s2.removeAllRanges(); s2.addRange(g);
      };

      window.renderMarkdown("# T\n\n- alpha\n- beta\n- gamma\n\nafter\n");
      var lis = document.querySelectorAll("#md ul li");
      pick(lis[0], lis[1]);
      r.copyPartOfListKeepsMarkers = window.glyphCopyText("selection") === "- alpha\n- beta";

      window.renderMarkdown("- [ ] one\n- [x] two\n- [ ] three\n");
      var tlis = document.querySelectorAll("#md ul li");
      pick(tlis[0], tlis[1]);
      r.copyPartOfChecklistKeepsBoxes =
        window.glyphCopyText("selection") === "- [ ] one\n- [x] two";

      window.renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n");
      var trs = document.querySelectorAll("#md table tbody tr");
      if (trs.length >= 2) {
        pick(trs[0], trs[1]);
        var rowsMd = window.glyphCopyText("selection");
        // Markdown has no table without a header row, so the first selected row
        // becomes one. What matters is that it is still a table, not loose text.
        r.copyPartOfTableStaysATable =
          rowsMd.indexOf("| 1 | 2 |") >= 0 && rowsMd.indexOf("| 3 | 4 |") >= 0 &&
          rowsMd.indexOf("---") >= 0;
      }

      window.renderMarkdown("> quoted one\n>\n> quoted two\n\nafter\n");
      var qps = document.querySelectorAll("#md blockquote p");
      if (qps.length) {
        pick(qps[0], qps[qps.length - 1]);
        r.copyInsideQuoteKeepsMarker =
          window.glyphCopyText("selection").indexOf("> quoted one") === 0;
      }

      window.renderMarkdown("> [!note] Heads up\n> the body line\n");
      var cbs = document.querySelectorAll("#md .callout p");
      if (cbs.length) {
        pick(cbs[cbs.length - 1], cbs[cbs.length - 1]);
        r.copyInsideCalloutKeepsType =
          window.glyphCopyText("selection").indexOf("[!note]") >= 0;
      }

      // Whatever the selection, raw markup must never reach the clipboard.
      r.copyNeverLeaksMarkup = !/<(li|tr|td|th|ul|ol|table|p|strong|span|input)[ >]/i
        .test(window.glyphCopyText("selection"));

      window.renderMarkdown(savedCopyDoc);
      r.copyRestoredDoc = window.glyphGetText().indexOf("#") >= 0;
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
