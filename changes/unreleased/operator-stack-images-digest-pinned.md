---
title: The Docker stacks now pin PostgreSQL, nginx, certbot, MariaDB and pgvector to an exact version and digest.
type: security
audience: admin
date: 2026-11-12
---
Before, the Docker stacks pulled `postgres:18`, `nginx:alpine`, `mariadb:11`,
`pgvector/pgvector:pg18` and `certbot/certbot` (no version at all). These tags move
upstream, so two installs of the same Dédalo release could run different images, and
an image changed upstream would be pulled on the next start. The installer also
requested Let's Encrypt certificates with an unpinned `certbot/certbot`.

Now every image that is not Dédalo's own is written in the stack file as
`name:<version>@sha256:<digest>`: a version you can read, plus the exact bytes. The
installer reads the images from the stack file, so the certificate request, the
renewal service and the image list an abort prints all use the same pinned images.
The full stack's Let's Encrypt renewal is now a `certbot` service in
`docker-compose.yml` (profile `letsencrypt`), turned on by the installer's
`compose.override.yaml`. New versions arrive with Dédalo releases; they reach a stack
when its checkout is updated and the stack is started again with `ddc up -d`.

A Let's Encrypt install made before this change must edit its `compose.override.yaml`
once: its old `certbot` service keeps the unpinned image and is no longer started, so
certificate renewal would stop. The image updater refuses such a stack and prints the
two-line replacement; the Docker install guide has the steps.

Because a pinned image has no plain tag on the machine, the `docker image rm` commands
in the Docker and Trial removal steps now read the images from the stack file.

The weekly secret scan of the repository history now also covers the shipped `vendor/`
directory; before, a broad exception excluded all of it.
