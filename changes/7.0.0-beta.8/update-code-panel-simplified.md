---
title: The code update panel is simpler — the installed version, what blocks an update and how to fix it, everything else folded away.
type: changed
audience: admin
date: 2026-11-06
breaking: false
wc: WC-2026-11-06-update-panel-verdicts
---
**Maintenance → Update Code** used to show every readiness check, the database backup, provenance facts and restore points at once. It now shows:

- the **current version**, in large type, with its date, the kind of build and the code server it came from;
- **Ready to update** or **Update blocked** — and, when blocked, only the checks that block, each with why and a numbered **How to fix it** list;
- the code server and the **Check available updates** button (with the choice of which builds are offered, remembered by the browser);
- a closed **Details** section with every check, the installation's facts and the restore points.

Maintenance mode and the database backup are no longer panel checks: the version window handles both when you choose a release (it has the maintenance switch and the backup waiver).

Two checks that always read *unknown* now give a real answer. **Enough free disk space** applies the update's own rule in advance (for example *932 GB free · about 1.4 GB needed*; the first look may say *being measured*). **Only Dédalo files in the code folder** now works on every installation, including checkouts and copied trees, and names anything that does not belong — the update refuses to start while it is there.

**Maintenance → Serve Code** follows the same layout: the **published release** in large type, **Ready to publish** or **Cannot publish** with only the blocking checks (each with a fix list), the three Build rows, and a closed **Details** section with every check, the build source, the tags, other archives and what installations are offered.
