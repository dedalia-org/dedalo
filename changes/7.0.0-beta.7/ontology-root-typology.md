---
title: The ontology status panel reports a TLD shown under the wrong typology, and the hierarchy typology groups are filed where the master ontology files them
type: fixed
audience: admin
date: 2026-10-21
---

In the ontology tree, each TLD hangs under the typology set in its registry record. A TLD placed under a different typology used to be reported as in sync. The ontology status panel now reports it as drift, and **Rebuild** puts it back under the right typology. Separately, the first time a thesaurus is created, Dédalo registers the `hierarchytype` and `hierarchymtype` groups itself, because no ontology update brings them in. It used to file them under *Core*, with generic names. It now uses the typology and names that the master ontology gives them. Installations that registered these groups before this change keep their current placement, which stays consistent and is not reported as drift.
