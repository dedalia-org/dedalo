---
title: Server hardening from the CodeQL review — the tag-badge address refuses over-long requests, rich text keeps only raster-image `data:` links, and literal `&lt;` text is no longer turned into `<`.
type: security
audience: admin
date: 2026-10-25
breaking: false
wc: WC-2026-10-25-tag-id-length-cap, WC-2026-10-25-rich-text-data-url-raster-only
---
- The address that draws the small tag badges in transcriptions (`…/component_text_area/tag/?id=…`)
  needs no login, and a long run of `<` in it made the server spend over a second of processing per
  request. Such an address (longer than 4096 characters, far beyond any real tag) is now refused
  with a `400` before it is read, and the tag clean-up itself runs in linear time — as do the
  other places that strip markup from text (search ordering, publication values, thesaurus empty
  checks, list previews, subtitle files, external-record markup, image annotation envelopes,
  merged RDF publications).
- Rich text keeps a `data:` link in an attribute only when it is a raster image (PNG, JPEG, GIF,
  WebP, AVIF, BMP). Any other `data:` link — an SVG image, XML, plain text — is replaced by `#` when
  the text is saved. Descriptive attributes (`alt`, `title`, …) are not affected, so an alternative
  text that starts with "Data:" is kept.
- Text in which a cataloguer literally typed `&lt;` is now shown, counted and indexed as `&lt;`,
  not as `<`: the indexation grid, the transcription character count, the semantic index and the
  import code lookup decode each entity once. The numeric spellings of the five special characters
  (`&#60;`, `&#x27;`, …) are decoded there too, exactly as the previous engine did.
- Two small file races are closed: the update log and the media access markers are created in one
  step that never empties an existing file, and the staged upload name is size-checked and read
  through the same open file.
