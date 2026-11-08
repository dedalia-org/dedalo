---
title: Restoring a code copy asks for confirmation whenever the code changes, also between betas.
type: fixed
audience: admin
wc: WC-2026-10-30-restore-point-release-identity
date: 2026-10-30
---
"Update code" used to compare a restore point with the running code by data version only. Every beta of a version shares it, so restoring `7.0.0-beta.5` over `7.0.0-beta.7` asked for no confirmation. Restore points are now listed, named (`dedalo_<release>[_<digest>]_<timestamp>`) and compared by their release name (`7.0.0-beta.5`, `7.0.0`, `7.0.1-dev`), and the restore asks for the confirmation when the release differs, or when the same release comes from another archive. The rollback sentinel names releases too. The status payload adds `data_version` to each restore point.
