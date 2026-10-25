---
title: An archive restore refuses an ontology node another writer created between the plan and the write
type: fixed
audience: admin
date: 2026-10-21
breaking: false
---
A restore plans its ontology definitions first and writes them later. A definition another writer created in between used to be overwritten silently, as if it were new. The plan is now checked again at the moment of writing: an identical definition is left alone, and a different one is refused unless the restore was asked to overwrite conflicts. The restore's report now counts what was actually written.
