---
title: The installer shows that the image pull is alive, and says when docker has gone silent.
type: changed
audience: admin
date: 2026-10-27
---
Before: while docker pulled the image, the installer printed one line and then nothing for as long as the pull ran, so a stalled pull looked like a hung install.
Now: a "still pulling" line with the elapsed time every 30 seconds. When docker has produced no output for 3 minutes, the installer says so and names the resume command (`sh install.sh --route <route> --resume`), so you can stop the pull and resume it.
