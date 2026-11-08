---
title: The publication tool asks for the number of pending deletions without using the retry action.
type: changed
audience: admin
date: 2026-10-28
wc: WC-2026-10-28-count-pending-deletions
---
The publication tool shows how many deletions are still waiting to reach the publication server. It now gets that number from a separate, read-only request instead of the request that retries the deletions. Nothing changes on screen; read-only checks of the installation no longer block it.
