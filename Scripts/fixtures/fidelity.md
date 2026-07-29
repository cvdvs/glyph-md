---
title: Fidelity fixture
---

# Round-trip cases

<!-- provenance: source https://example.com | captured 2026-07-28 -->

FID-1 a paragraph after a closed comment.

&nbsp;

FID-2 the blank answer line above is deliberate and must survive.

&nbsp;

| ID | Note |
| --- | --- |
| [[target-one|ALIAS]] | FID-3 an aliased wikilink in a table cell, unescaped |
| [[target-two\|ALIAS2]] | FID-10 the same thing already escaped |
| plain | FID-4 an ordinary row |

```python
# FID-5 a comment inside a fence is code, not markdown
```

FID-6 inline `code`, **bold**, *italic*, a [link](https://example.com), and a bare
https://example.com URL.

<!-- FID-7 an unclosed comment must not swallow the rest

FID-8 this paragraph comes after the unclosed comment and must survive.

## FID-9 a heading after it must survive too
Line one with a hard break  
line two follows.

Soft wrap A
soft wrap B.

Inline code holding a backtick: ``FID-12 a`b`` must round-trip, not downgrade.

````
```
FID-11 a triple-backtick example lives inside this block and must stay one block
```
````
