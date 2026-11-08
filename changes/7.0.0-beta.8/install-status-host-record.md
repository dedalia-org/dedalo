---
title: The host `--status --json` on the Docker and trial routes reports the install record the run wrote.
type: fixed
audience: admin
date: 2026-10-27
---
Before: `sh install.sh --route docker --status --json` read the private directory of the host process, which on the Docker route holds no record, and answered `exists: false` for a complete install.
Now: on the docker and trial routes it reads the stack's host record, the one `--resume` reads, and answers its outcome (`complete` after a finished install).
