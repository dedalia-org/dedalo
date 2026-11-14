---
title: Interlaced videos are now deinterlaced when their web versions are built.
type: fixed
audience: admin
date: 2026-10-02
---
Every video quality was meant to be deinterlaced, but the encoder was given the deinterlace filter and the colour-correction filter as two separate options, and ffmpeg keeps only the last one. The deinterlace step was silently skipped, so video recorded interlaced (most analogue and DV tape transfers) got web versions with visible combing on movement. Both encoding passes now receive one combined filter, and interlaced video is deinterlaced. Progressive video is left untouched: only frames marked as interlaced are processed.

Existing versions are **not** rebuilt automatically. To fix a video already in the archive, rebuild its qualities with the [media versions tool](./using/tools/using_media_versions.md); the original file is never changed.
