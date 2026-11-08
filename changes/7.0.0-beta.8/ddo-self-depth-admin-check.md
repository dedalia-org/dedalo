---
title: A column defined with a level-two `section_tipo: "self"` is no longer shown; the new `ddo_self_depth` check lists every such definition.
type: changed
audience: admin
date: 2026-11-04
wc: WC-2026-11-04-ddo-self-first-level-only
---
`section_tipo: "self"` names the target sections of the element that owns a `ddo_map`, so it means something only for a first-level ddo. Until now a ddo below the first level that declared it was guessed and shown; from this version the read skips it and the page shows an `ontology.ddo_self_refused` notice naming the definition, its ddo, its parent and its depth. If an installed ontology still holds such a definition, the column it described is no longer shown. After updating, run the report-only check **Maintenance › Reconcile › `ddo_self_depth`**: it lists every installed definition that declares a deep `self`, with the element whose map holds it and every section or component that reads it. The fix is a definition edit (an explicit `section_tipo` or a source array) made on the master ontology and delivered by an ontology update; the check never rewrites a definition itself. See [Self-resolution](./core/request_config.md#self-resolution-and-dynamic-section_tipo-sources).
