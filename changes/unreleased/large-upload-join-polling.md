---
title: Uploading a very large file no longer fails while the server is still assembling it.
type: fixed
audience: user
date: 2026-11-19
---
When a multi-gigabyte upload finished transferring, assembling it on the server can take minutes. Any assembly still running about 25 seconds after the transfer ended was reported as an error ("the first attempt failed after it may already have been applied"), although the server went on to finish the file, which then never reached the record. The upload now waits for the assembly to finish, for as long as the server keeps making progress (it gives up only after 15 minutes without any), and attaches the file as usual, without an error message for every few seconds of waiting. If the server restarts during the assembly, the upload starts it again straight away instead of waiting 10 minutes. If the assembly fails, for example because the disk is full, the upload now stops with an error instead of retrying it endlessly in the background. Files that hit the error before this fix must be uploaded again.
