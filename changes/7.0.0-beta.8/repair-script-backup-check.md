---
title: The section-id repair script now checks for a recent backup before it writes.
type: changed
audience: admin
date: 2026-10-30
breaking: false
---
`scripts/migrate_section_id_locators.ts --apply` rewrites stored records without Time Machine history, so a recent database backup is the only way back. It now refuses to apply unless a recent verified backup exists; `--waive-backup` proceeds anyway and records who waived it in the log. It also cannot run while an update or another irreversible maintenance action is running. Dry runs are unchanged.
