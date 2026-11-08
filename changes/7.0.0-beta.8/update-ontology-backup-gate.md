---
title: Update ontology says whether a database backup is in place before you press the button.
type: changed
audience: admin
date: 2026-10-30
wc: WC-2026-10-30-update-ontology-backup-gate
---
An ontology update is refused without a recent, verified database backup. Before, the **Update ontology** panel showed only a checkbox labelled "Update without a recent database backup", out of line with its text, and you learnt about the rule only when the update was refused.

The panel now has a **Database backup** block above the button:

- With a recent, verified backup, it shows the backup's age and no checkbox.
- Without one, it says the update will be refused and how to fix it: make a backup in **Backups** and reload the panel. The checkbox to update without a backup sits below that, with what it costs: if the update goes wrong, the database cannot be restored, and the waiver is recorded with your user. **Replace selected ontologies** stays disabled until you make a backup or tick the box.
