---
title: Production, Docker and Trial installs keep a log of the run.
type: added
audience: admin
date: 2026-11-08
---
Every line the run shows, the engine steps' output included, is appended to `install.log` (`0600`) beside the install record: `/var/lib/dedalo-install/<instance>/` on Production, `<checkout>/.dedalo-install/` on Docker and Trial. Passwords and the salt never reach it. A completed `--abort` removes it with the record.
