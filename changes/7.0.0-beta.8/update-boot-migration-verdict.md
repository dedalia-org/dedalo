---
title: A code update whose database migration fails is no longer confirmed.
type: fixed
audience: admin
wc: WC-2026-10-30-health-boot-facts
date: 2026-10-30
---
When the new code started but one of its boot database migrations failed, the update was still marked as confirmed and `/health` stayed green, so the automatic rollback never ran. Now `/health` answers 503 with `boot_schema: "failed"` and the update is not confirmed. If nothing had been applied yet, the watchdog rolls the code back as before. If a migration had already changed the database, the update is marked `needs_restore` and nothing is rolled back automatically: restore the pre-update database backup together with the previous code. `/health` also reports `data_version`, and a code update is refused while a data update is still pending.
