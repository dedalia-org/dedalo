---
title: The Docker install's System checks show cosign, and the Image version help names only the tags the installer accepts.
type: changed
audience: admin
date: 2026-10-27
---
Before: cosign was checked only at the Review, and the Image version help listed `7.0.0` as an accepted tag, which the installer refuses.
Now: the System checks show a cosign row, a warning when cosign is missing (only the official image needs it), and the Image version help names the accepted tags: the installer's own release, or the next release's `-dev` tag.
