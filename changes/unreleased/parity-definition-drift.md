---
title: Four read-path comparison tests now expect the current ontology definitions.
type: changed
audience: developer
date: 2026-10-28
wc: WC-2026-10-28-parity-definition-drift
---
After the ontology refresh, four tests that compare the engine with frozen answers saw definition changes made on the master ontology: a section tool's "coins" role points at the portal again instead of an alias, the mint section is called "Ceca", and two more components are now cloned into the test ontology. Each test keeps the old frozen value and checks the new one explicitly.
