---
title: An unpublished image is no longer reported as an unverified deletion on a copy publication host.
type: fixed
audience: admin
date: 2026-11-08
---

On a publication host that receives media copies, unpublishing an image right after it
was published could leave a stale "unverified deletion" entry on the host panel until a
later synchronisation round. The engine now finishes an immediate withdrawal before the
host's next round checks it, so the panel shows the deletion as verified at once.
