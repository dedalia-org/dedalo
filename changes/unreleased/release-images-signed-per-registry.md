---
title: The official Docker image now carries its signature in every registry that publishes it
type: fixed
audience: admin
date: 2026-10-25
---
The 7.0.0-beta.7 image reached GitHub Container Registry and Docker Hub without its
signature, so `cosign verify` (and the installer's Official check) refused it there. The
release process now signs the image in each registry it publishes to, with the same
official identity, and a release already published unsigned is signed in place when its
signature can be proven from the build. Verify an image as described in
[Checking the signature](./install/docker.md#checking-the-signature).
