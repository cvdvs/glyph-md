// Asserts that a hostile markdown document cannot execute code or exfiltrate.
//
// Run against Scripts/fixtures/hostile.md in whichever engine is being tested.
// Every key must be true; the caller fails the build otherwise.
//
// A markdown file is untrusted input for this app — notes arrive from model
// output, downloads and cloned repos — so these are the load-bearing assertions.
(function () {
  const r = {};
  const md = document.getElementById("md");
  const all = [...md.querySelectorAll("*")];

  // Nothing executed.
  r.noScriptRan = !window.__XSS_SCRIPT;
  r.noImgOnerror = !window.__XSS_IMG;
  r.noSvgOnload = !window.__XSS_SVG;
  r.noMixedCaseHref = !window.__XSS_MIXED;
  r.noTabScheme = !window.__XSS_TAB;
  // The document is embedded in a <script> block; "</script>" inside it must not
  // close that block. This one bypasses the sanitizer entirely if it works.
  r.noScriptBreakout = !window.__BREAKOUT;
  r.pageIntact = typeof window.renderMarkdown === "function";

  // Nothing dangerous survived into the DOM.
  r.noIframes = md.querySelectorAll("iframe").length === 0;
  r.noForms = md.querySelectorAll("form").length === 0;
  r.noObjects = md.querySelectorAll("object,embed,applet").length === 0;
  r.noMeta = md.querySelectorAll("meta,base,link").length === 0;
  r.noStyleTags = md.querySelectorAll("style").length === 0;
  // Our callout icons are added after sanitizing and are trusted; a document
  // must not be able to introduce its own SVG.
  r.noDocumentSvg = md.querySelectorAll("svg:not(.callout-icon)").length === 0;

  r.noEventHandlers = !all.some((el) =>
    [...el.attributes].some((a) => a.name.toLowerCase().startsWith("on")));
  r.noInlineStyle = !all.some((el) => el.hasAttribute("style"));
  // id would allow DOM clobbering (a document could shadow window.md).
  r.noIds = !all.some((el) => el.hasAttribute("id"));

  const badScheme = /^\s*(javascript|vbscript|livescript|data:text\/html)/i;
  r.noDangerousHrefs = !all.some((el) => {
    const h = el.getAttribute && el.getAttribute("href");
    return h && badScheme.test(h.replace(/[\u0000-\u0020]/g, ""));
  });

  // No silent network calls: a remote image is a tracking beacon that fires on open.
  r.noRemoteImages = ![...md.querySelectorAll("img")].some((i) => {
    const s = i.getAttribute("src") || "";
    return /^https?:/i.test(s);
  });

  // Legitimate authoring still works.
  r.keepsUnderline = md.querySelectorAll("u").length > 0;
  r.keepsBreak = md.querySelectorAll("br").length > 0;
  r.keepsSub = md.querySelectorAll("sub").length > 0;
  r.keepsKbd = md.querySelectorAll("kbd").length > 0;
  r.keepsHeading = md.querySelectorAll("h1").length > 0;
  r.keepsText = md.textContent.indexOf("More normal text") >= 0;

  // A payload must not be able to persist itself back into the user file.
  const ser = window.glyphSerialize();
  r.serializedHasNoScript = ser.toLowerCase().indexOf("<script") < 0;
  r.serializedHasNoHandler = !/\son\w+\s*=/i.test(ser);
  r.serializedHasNoIframe = ser.toLowerCase().indexOf("<iframe") < 0;
  // Display-only attributes this app adds must never be written into the file.
  r.serializedHasNoInternals = ser.indexOf("data-remote-src") < 0
    && ser.indexOf("remote-img") < 0
    && ser.indexOf("data-alt") < 0;
  // The author's own image markdown must survive untouched.
  r.imageRoundTrips = /!\[remote beacon\]\(https:\/\/evil\.example\/beacon\.png\)/.test(ser);

  r.ok = Object.keys(r).every((k) => r[k] === true);
  return JSON.stringify(r);
})()
