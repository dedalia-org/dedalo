---
title: The data update refuses a step meant for a newer version than the running code.
type: fixed
audience: admin
date: 2026-10-31
wc: WC-2026-10-31-update-rung-above-code
---
A development or nightly build could already list the data update of the next release and run it. The database then stood at a newer data version than the code serving it, and the health check turned red. "Update data" now refuses such a step before running anything and says which code version it needs. Install a build of that version first.
