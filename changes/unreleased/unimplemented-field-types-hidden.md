---
title: Search, export and cache-update field lists no longer offer obsolete field types.
type: fixed
audience: user
date: 2026-11-12
wc: WC-2026-11-12-unimplemented-component-models
---
Ontologies carried over from older versions still hold field types this version does not implement (for example the old security-areas field of the Profiles section). They were offered in the search panel's field list, in the export field picker and in the cache-update tool, where choosing one did nothing or broke the panel. They are no longer listed, and neither is anything nested inside them. Edit forms already left them out; they now apply the same rule, which also covers two never-implemented field types it used to miss.
