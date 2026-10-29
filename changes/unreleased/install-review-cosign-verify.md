---
title: The installer Review lists the cosign verify command for an official image, and the registry check reports success.
type: changed
audience: admin
date: 2026-10-26
---
Before: the installer's Review of an official image showed the pull, but not the signature check it would run after it, and a successful registry check was silent.
Now: the Review lists the `cosign verify` command that checks the pulled image's digest against Dédalo's signing identity, so the operator reads the check before the install runs it. When the registry confirms the image is published, the run prints a success line.
