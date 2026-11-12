---
title: The "recovery mode" switch is gone; a damaged ontology is now repaired from the command line.
type: removed
audience: admin
date: 2026-11-12
wc: WC-2026-11-12-recovery-mode-retired
---
The **Recovery mode** button in *Maintenance → Check config* promised to run Dédalo on a
backup copy of the ontology. It only showed a red banner: the main ontology was still the one
in use. And when the ontology is really broken, the maintenance area cannot open to reach the
button anyway. The button, the banner and the *Recovery mode* line of the runtime status are
removed.

To repair a damaged ontology, stop Dédalo and run `bun scripts/ontology_recover.ts` from the
installation directory. It rebuilds the ontology from its source records and, if needed,
first puts back the core ontology saved in the recovery file
(*Maintenance → Build database version*). Without `--apply` it only reports what it would do.
See [Recovery mode](./administration/recovery_mode.md).
