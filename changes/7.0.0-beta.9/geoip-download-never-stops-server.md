---
title: "A failed download of the IP-to-country database no longer stops the server while it starts."
type: fixed
audience: admin
date: 2026-11-26
---
At start-up the server downloads the free IP-to-country database in the background. A write
failure during that download — for example two servers sharing one private directory and
starting at the same moment — could stop the whole server instead of only skipping the
database. The failure is now reported like any other download problem and the server keeps
running. Each server also downloads into its own temporary files and replaces the database
only once it is complete, so two servers starting together no longer overwrite each other's
download.

**Action needed:** none.
