---
title: Site builder: `provision remove` and `provision adopt` can no longer be hung by a pipe planted at a turn HOME's `.gitconfig`, a site's `site.json` or an instance marker
type: security
audience: admin
date: 2026-10-21
---
The site builder provisioner reads a few files that an agent or a site
identity can write — a turn HOME's `.gitconfig` when an instance is removed, a
site's `site.json` and the instance marker (`.dedalo_site_instance`) at the
root of an install when it is adopted. A named pipe planted at any of those
names made the root command wait forever. Those reads now open without waiting
and read only a regular file; anything else is treated as unreadable (a marker
that is not a regular file counts as no marker), which each command already
reports. Regular files — including an operator's symlinked password file — are
read as before.
