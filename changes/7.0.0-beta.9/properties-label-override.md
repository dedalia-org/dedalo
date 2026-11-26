---
title: "An element's `properties.label` lang map now replaces its label in the edit and list contexts, chosen through the same language fallback as every ontology label."
type: added
audience: developer
date: 2026-11-22
wc: WC-2026-11-22-properties-label-override-chain
---
An ontology node (or a request's properties override) whose `properties.label` is an object
keyed by language code shows that text as the element's label instead of its term. A missing
language degrades like every other ontology label: the declared equivalent language (Valencian
reads Catalan), then the structure language, then the first non-empty entry. A plain string
`label` does not override.
