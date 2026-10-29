---
title: The cataloguing tool shows only its own thesauri, marks used types, and shows every configured coin again.
type: fixed
audience: user
date: 2026-10-29
breaking: false
wc: WC-2026-10-29-area-declared-hierarchy-types
---
Four defects of the cataloguing tool are fixed, restoring the behaviour of version 6:

- **Only the configured thesauri load.** When the tool's configuration limits the thesaurus panel
  to some hierarchy typologies (for example `hierarchy_types: [8]`), only those hierarchies are
  loaded; thesauri of any other typology no longer appear.
- **Used types are marked again.** A record already used as a term shows the highlighted
  background behind its drag handle. The "Relation list" (`component_inverse`) field now carries
  the records that point to each record, as in version 6, wherever it is shown.
- **Portals inside portals keep their configured limit.** A nested portal declared with, for
  example, `limit: 4` (the ordered coins) showed only one item after any refresh or save; it now
  shows the configured number.
- **Thumbnails in the tool's record list are whole** — no longer clipped or overlapping.
