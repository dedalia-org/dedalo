---
title: The ontology status panel names URL components that are wrongly marked as translatable
type: added
audience: admin
date: 2026-11-11
wc: WC-2026-11-11-ontology-model-rules
---
A URL component (`component_iri`) is never translatable: a URL has no language, and its versions in other languages are stored as language versions of one value. A URL node marked as translatable in the ontology — or with the *translatable* field left empty, which counts as translatable — made imports save plain cells in the importer's language, with no warning. The status panel of the ontology parser tool, and the message of every rebuild and ontology update, now name each such node as "node(s) break a model rule". It is an error in the master ontology: Dédalo reports it and does not ignore the setting, so it must be corrected there and reach the installation through an ontology update. The ontology shipped with this release has no such node. See [Ontology parser](./using/tools/using_ontology_parser.md).
