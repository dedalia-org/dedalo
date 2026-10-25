---
title: A backup's verification proof now survives a power cut, and a backup is reported done only once its name is safely on disk.
type: fixed
audience: admin
date: 2026-10-21
breaking: false
---
When a backup is verified, Dédalo writes a small proof file next to it so the archive is not read in full again. That proof could be lost in a power cut right after the verification, or left half-written by an interrupted write, and the next check then re-read the whole archive. It is now written through the same durable path as every other engine file: complete, synced, and its name synced too. If the disk refuses to make a finished backup's name durable (an I/O error), the backup job now says it failed instead of reporting it done; the backup file itself is kept.
