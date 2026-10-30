---
title: Irreversible maintenance actions now require the superuser, maintenance mode and a recent backup.
type: changed
audience: admin
date: 2026-10-30
breaking: true
wc: WC-2026-10-30-maintenance-door-classes
---
The maintenance actions that change stored data with no undo (the move tools when not in dry-run mode, resetting hierarchies, the data update, restoring a previous code version, and restoring the ontology from a recovery file) now run only for the superuser, only in maintenance mode, and only when a recent verified database backup exists. They also cannot run while an update is in progress, or while another of these actions is running. Before, any global administrator could run them at any time. Dry runs of the move tools are unchanged. On a code server, building a release archive for other installations is now reserved to the superuser. Make a backup in **Make backup** before using them.
