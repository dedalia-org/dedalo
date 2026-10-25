---
title: An ontology update now removes the nodes a new package no longer carries.
type: fixed
audience: admin
date: 2026-10-21
wc: WC-2026-10-21-ontology-update-rebuild
---
Before, **Update ontology** only added and refreshed nodes: a node dropped upstream stayed in the
runtime ontology for good, and a record whose TLD field named another TLD was silently written
into that other TLD. Each updated TLD is now re-derived in one transaction by the same writer the
ontology parser uses: dropped nodes go, a misfiled record is skipped and named in the update's
warnings, and the nodes that remain keep their internal ids. A model that the update adds or
renames now reaches every component that uses it in the same update, including components in
another updated TLD. A typology grouper that this installation created (for a thesaurus or TLD
of a typology the release does not ship) is kept: the update re-creates its record instead of
removing it, so the thesauri under it stay in the ontology tree. See
[Ontology write pipeline](./core/ontology/ontology_write.md).
