# WC-2026-10-11-rich-text-sanitizer-tokenizer — saved rich text is sanitized by a spec tokenizer

- **Date:** 2026-10-11 (audit 2026-09-26 CLIENT-2, closure plan Step 8, lane 2).
- **Decision:** CLIENT-2 — the ONE rich-text sanitizer is rebuilt on an HTML5
  tokenizer (Bun HTMLRewriter / lol-html); denylist contract kept.
- **Shape before (PHP / earlier TS):** `sanitizeRichText` was a regex denylist.
  It let these through to storage LIVE: `<img/onerror=…>`, a handler glued to a
  closing quote (`src="x"onerror=…`), character-referenced schemes
  (`&#106;avascript:`, `java&#x09;script:`, `&Tab;javascript:`,
  `javascript&colon;`, `&#0000106…`), content hidden in RCDATA/foreign content
  (`<title>`, `<svg><![CDATA[…]]>`), the noscript mutation and `<template>`.
  It also CORRUPTED benign text: `<a title="x onclick=y">` lost part of its
  title, and prose such as `x = "javascript:foo" and the onion=3` was rewritten.
  `svg`/`math`/`iframe` tags were dropped but their content kept.
- **Shape after (TS):** the value a `component_text_area` save stores (and the
  indexation-grid fragment, and the pdf extractor's html payload) differs from
  before only where the old pass was wrong:
  - removed WITH content: `script, style, iframe, noscript, noembed, noframes,
    xmp, plaintext, template, svg, math, title, textarea` (svg/math/iframe/noscript
    content used to survive as text; title/textarea are RCDATA whose kept raw
    markup a tree-builder veto — `<select><title>` — or any re-parse revives);
  - comments removed, every bogus-comment spelling included (`<!x>`, `<?x>`,
    `</ x>`);
  - the stored value is CONTEXT-FREE: it ends in the tokenizer's data state. A
    construct left open at end of input — an EOF-in-tag tail such as
    `<img src=x onerror=alert(1) `, an open comment, an open doctype, an open
    RCDATA element — is DROPPED (a browser drops an EOF-in-tag too), and a final
    raw `<` becomes `&lt;`. So a value wrapped (`<mark>…</mark>`) or joined with
    another by the client still tokenizes as it did alone;
  - the cut is BOUNDED (≤ 23 tokenizer passes per fixed-point pass, whatever the tail's length; the
    first version spent one pass per `<` of the open tail — O(n²)). A tail with
    ≤ 16 `<` is cut exactly where the unbounded walk cut it (byte-identical). A
    longer tail is cut at the last offset one marked boundary pass proves to be
    in the data state (≤ 4 candidates verified): such a cut may ALSO drop
    invisible markup just before the tail — stray end tags, comments, a
    doctype, CDATA — never a text node and never an element. When no candidate
    verifies (or the boundary pass cannot reproduce the value byte for byte),
    the WHOLE value is stored HTML-escaped (`& < > " '` as entities): kept as
    visible text, never markup, never silently emptied;
  - removed as a tag, content kept: `object, embed, form, base, meta, link,
    applet, frame, frameset`;
  - every `on*` attribute removed; every attribute whose value, after resolving
    numeric and scheme-relevant named character references (`&Tab;`
    `&NewLine;` `&colon;` `&sol;` — the ASCII-valued names of the HTML5 table
    that can spell a denylisted scheme) and the WHATWG URL
    whitespace rules, starts with `javascript:`, `vbscript:`, `data:text/html`
    or `data:application/` is set to `#` (now including the encoded spellings);
  - ONE verdict per attribute NAME: a duplicated name (`<a href="ok"
    href="javascript:…">`) is stored ONCE, with the FIRST value — the one a
    browser keeps — judged as above; the later occurrences are dropped. Judging
    each occurrence in turn rewrote the first to `#` and stored the dangerous
    duplicate behind it, live for a last-wins consumer (an export
    re-serialiser). The kept attribute moves to the end of the tag; a
    duplicated name the rewriter cannot emit (`=x`) is dropped;
  - text nodes and every untouched element are emitted byte-identical (the
    prose and title corruption is gone).
  - the stored value is a FIXED POINT of the sanitizer: the pass is re-run on
    its own output until it changes nothing (≤ `SANITIZE_PASS_LIMIT` = 4
    passes; not reached → stored HTML-escaped whole, as above). A single pass
    judged its INPUT's tokens and could emit others: a removal spliced its
    neighbours (`<<script></script>img src=x onerror=…>` stored a live
    `<img onerror>`), and an svg/math implicitly closed by an ancestor's end
    tag (`<b><svg></b><![CDATA[ a><img src=x onerror=…>]]>`) left the tokenizer
    in foreign content, so the CDATA came out as untouched "text" that parses
    as live markup once the root is removed. Such values are now stored with
    the markup judged (`<b><img src=x>]]>`); every stored value satisfies
    `s(s(x)) === s(x)`. Benign values are a fixed point of the first pass —
    unchanged, one pass;
- **Reason:** a stored payload must be judged the way a browser parses it, and
  a sanitizer that corrupts prose destroys the curator's record.
- **Gate reconciliation:** no parity gate or oracle-harvest fixture asserts a
  sanitized save of these shapes (the harvest is read-path; the stored corpus
  holds no such values), so NO re-harvest. Gate: `test/unit/html_sanitize.test.ts`
  — hostile corpus judged by the independent spec-parser oracle
  (`test/helpers/html_oracle.ts`, cheerio/parse5, incl. the noscript round trip),
  generated case / leading-control / named-reference scheme spellings, the
  in-select tree-builder veto generated over every spec text-state tag, the
  duplicated-attribute rule judged on a last-wins view (htmlparser2),
  byte-identity on the benign corpus, idempotence, and context-freedom (every
  output wrapped in `<mark>` and every corpus pair joined, judged by the oracle),
  the fixed point (foreign content implicitly closed by every formatting/block
  ancestor, every removal kind spliced, nested splices past the pass limit),
  and the bounded cut: G1 pass count (equal at 1K and 256K `<`, ≤ 25), G2 data
  state by a parse5-tokenizer oracle (corpus, tails, seeded fuzz, the closer
  alone on unsanitized input), G3 every proposed boundary is a data-state
  offset (none inside raw text), G4 equivalence with the old walk (identical
  ≤ 16 `<`, otherwise a prefix dropping no text/element), G5 the escape
  fallback. Values stored BEFORE this
  entry are not rewritten; a one-shot re-sanitize sweep is a ledgered follow-up.

## Addendum 2026-11-12 (T1-14) — writers governed

The sanitizer governs the stored value of every writer that reaches
`src/core/section/record/write_value_gates.ts#applyWriteValueGates`: the save door
(`saveComponentData`) and, since `WC-2026-11-12-translation-write-value-gates`, automatic
translation (`translateAndWrite`). The writer set is censused by
`test/unit/component_value_gate_census_tripwire.test.ts`; Time Machine replays are named
exemptions there (they restore stored bytes).
