---
title: An archive restore no longer plants ontology definitions that the next ontology rebuild would delete
type: fixed
audience: admin
date: 2026-10-21
---

An archive carries the ontology definitions of its sections, but not the ontology records they are built from. Restoring it into an installation whose ontology already has records for the same TLD used to add those definitions anyway: the next ontology update (or a rebuild from the ontology parser tool) removed them again, and the restored records were left without their definitions. The restore now refuses this case before writing anything, and names the TLD and the definitions involved. Install or update that ontology so that it defines them, then run the restore again: the definitions are then found unchanged, or the conflict is named. A TLD for which this installation has no ontology records restores as before. The restore also waits for any ontology rebuild of the same TLD that is in progress, instead of writing at the same time. See [The archive door](./core/exporting_data.md#the-archive-door).
