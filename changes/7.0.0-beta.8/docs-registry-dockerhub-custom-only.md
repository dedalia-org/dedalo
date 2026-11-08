---
title: The Docker install guide says the Official image comes from GitHub Container Registry only, and that the Docker Hub mirror is reached through a custom image.
type: changed
audience: admin
date: 2026-10-27
---
Before: the registry table listed the Docker Hub mirror as available, with no word on how an installation reaches it, and the host `install.sh --status --json` was described as reading only the checkout.
Now: the page says the **Official** choice pulls from GitHub Container Registry only, that Docker Hub is reached only through the `custom` choice (`--image-repository docker.io/dedalia/dedalo`), and that a custom image is trusted as pulled, not signature-checked. The host `--status --json` reports the same install record as the in-container command.
