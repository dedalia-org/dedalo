---
title: Ontology updates now check every downloaded file against the master's digest before importing it.
type: security
audience: admin
date: 2026-10-30
breaking: false
wc: WC-2026-10-30-ontology-file-digests
---
An ontology master now records the sha256 of every file it exports in its `ontology.json`, and an installation updating from it refuses any file whose bytes do not match, before anything is decompressed or imported. A master that has not re-exported since this release publishes no digests: its files are still accepted, and the server log says once per update that they were not verified. Re-export the ontologies on the master to publish digests. See [Updating the ontology](./management/updates/updating_ontology.md).
