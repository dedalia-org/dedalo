---
title: The bootstrap run as root leaves nothing in `/root/.bun`.
type: fixed
audience: admin
date: 2026-11-08
---
Run with `sudo`, the installer's Bun kept a 4 MB runtime cache in root's home. Root's installer now runs with that cache off.
