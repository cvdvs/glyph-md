// Round-trip fidelity: what the app would write back must not lose the author's
// content. Run against Scripts/fixtures/fidelity.md in either engine.
//
// These are regression pins for defects measured on real documents: an unclosed
// comment swallowing the file, provenance comments being deleted, deliberate
// blank lines in a fillable brief being deleted, and table cells being truncated.
(function () {
  const r = {};
  const src = window.__initial || "";
  const out = window.glyphGetText();

  // Nothing the author wrote may disappear.
  for (let i = 1; i <= 10; i++) {
    r["fid" + i] = out.indexOf("FID-" + i) >= 0;
  }

  r.commentKept = out.indexOf("provenance: source") >= 0;
  r.blankAnswerLinesKept =
    out.split("\n").filter((l) => l.trim() === "&nbsp;").length >= 2;
  r.headingKept = /^##\s+FID-9/m.test(out);
  r.fenceKept = out.indexOf("```python") >= 0;
  r.tableKept = (out.match(/^\|/gm) || []).length >= 5;
  // A pipe inside [[target|alias]] is part of the link, not a column break.
  // Both forms must survive untouched — rewriting one into the other would
  // change the file on every save.
  r.aliasedWikilinkKept = out.indexOf("[[target-one|ALIAS]]") >= 0;
  r.escapedWikilinkKept = out.indexOf("[[target-two\\|ALIAS2]]") >= 0;
  r.tableColumnsIntact =
    [...document.querySelectorAll("#md tr")].every((row) => row.children.length === 2);

  // Stability: a second pass must not keep changing the document, or every open
  // would rewrite the file again.
  window.renderMarkdown(out);
  const twice = window.glyphGetText();
  r.idempotent = twice === out;

  // The chip must stay a span the app resolves by name — never an anchor with
  // an href the document supplied.
  const chips = [...document.querySelectorAll("#md span.wikilink")];
  r.wikilinkChips = chips.length > 0;
  r.wikilinksHaveNoHref = chips.every((c) => !c.hasAttribute("href"));
  r.wikilinksCarryTarget = chips.every((c) => /^!?\[\[.+\]\]$/.test(c.getAttribute("data-raw") || ""));

  // Two trailing spaces are a deliberate line break. They look identical here
  // (marked runs with breaks:true) but not in Obsidian, where a soft newline
  // joins the lines — so dropping them changes how the file reads elsewhere.
  r.hardBreakKept = /hard break {2}\n/.test(out);
  r.softWrapNotPromoted = /Soft wrap A\nsoft wrap B/.test(out);
  r.noJoinerLeaked = out.indexOf("\u2060") < 0;

  r.ok = Object.keys(r).every((k) => r[k] === true);
  return JSON.stringify(r);
})()
