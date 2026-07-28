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
  for (let i = 1; i <= 9; i++) {
    r["fid" + i] = out.indexOf("FID-" + i) >= 0;
  }

  r.commentKept = out.indexOf("provenance: source") >= 0;
  r.blankAnswerLinesKept =
    out.split("\n").filter((l) => l.trim() === "&nbsp;").length >= 2;
  r.headingKept = /^##\s+FID-9/m.test(out);
  r.fenceKept = out.indexOf("```python") >= 0;
  r.tableKept = (out.match(/^\|/gm) || []).length >= 4;

  // Stability: a second pass must not keep changing the document, or every open
  // would rewrite the file again.
  window.renderMarkdown(out);
  const twice = window.glyphGetText();
  r.idempotent = twice === out;

  r.ok = Object.keys(r).every((k) => r[k] === true);
  return JSON.stringify(r);
})()
