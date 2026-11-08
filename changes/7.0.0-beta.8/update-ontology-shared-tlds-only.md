---
title: An ontology update only touches the shared ontologies.
type: changed
audience: admin
wc: WC-2026-10-30-update-door-refusals
date: 2026-10-30
---
"Update ontology" now refuses any TLD that is not one of the installation's active shared ontologies (`ACTIVE_ONTOLOGY_TLDS`), the core TLDs or the shared value lists. Local TLDs and `localontology` overrides can no longer be overwritten by an update. On a master, the ontology export files are now written atomically: a failed export keeps the previous file instead of serving a truncated one.
