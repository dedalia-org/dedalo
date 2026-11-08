---
title: The installer checks that a local ontology source is readable before it changes anything.
type: fixed
audience: admin
date: 2026-11-08
---
On the production route, an offline ontology source (`--ontology-source`) in your home directory used to pass the plan, then stop the install halfway with "no such file or directory": the engine steps read the source as the instance's service user, who cannot enter a home directory closed to other users. The System check now refuses such a source before anything is installed and names the directory or file in the way, and a permission error is reported as one. See [Offline installs](./install/installer_reference.md#offline-installs-ontology-source).
