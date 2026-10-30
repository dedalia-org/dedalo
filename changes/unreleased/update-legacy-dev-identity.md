---
title: Older development builds are offered the nightly again
type: fixed
audience: admin
date: 2026-10-30
---
A development build made before 26 October 2026 reports its version as `7.0.0.dev`. The code server could not read that form, treated the installation as the stable release, and so listed no nightly in its update panel. The code server now reads the older form as `7.0.0-dev`, so these installations can update through the panel again.
