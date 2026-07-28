# A perfectly normal looking note

Some text that looks fine.

<img src=x onerror="window.__XSS_IMG=true">

<script>window.__XSS_SCRIPT = true;</script>

[click me](javascript:window.__XSS_HREF=true)

<svg onload="window.__XSS_SVG=true"></svg>

<a href="vbscript:alert(1)" id="vb">vb</a>

<form action="https://evil.example/steal"><input name="x"></form>

<iframe src="https://example.com"></iframe>

KEEP-4 more normal text.

<a href="JaVaScRiPt&#58;window.__XSS_MIXED=true">mixed case and entity</a>

<a href="java&#x09;script:window.__XSS_TAB=true">tab inside the scheme</a>

<div style="background:url(https://evil.example/beacon)">css exfiltration</div>

<img src="https://evil.example/beacon.png" alt="remote beacon">

<span id="md">DOM clobbering attempt</span>

<base href="https://evil.example/">

<meta http-equiv="refresh" content="0;url=https://evil.example">

Legitimate inline HTML must survive: <u>underline</u>, <br>, <sub>sub</sub>, <kbd>⌘S</kbd>.

Script-block breakout: </script><script>window.__BREAKOUT=true;</script> and the page must survive.

<p class="props">KEEP-3 this paragraph must survive being saved</p>

<span class="wikilink" data-raw="INJECTEDRAW [pay](https://evil.example/pay)">harmless looking words</span>

<style>

KEEP-1 text after an unclosed style tag must still be in the file.

KEEP-2 final line of the document.
