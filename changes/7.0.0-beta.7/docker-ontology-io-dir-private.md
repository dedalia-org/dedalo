---
title: Docker stacks — ontology update no longer fails with EACCES
type: fixed
audience: admin
date: 2026-10-20
---

Both Docker stacks now set `ONTOLOGY_DATA_IO_DIR=/private/import/ontology`. Before this, the engine fell back to the in-tree `install/import/ontology`, which is root-owned in the image, so **Maintenance → Update ontology** died with `EACCES: permission denied, mkdir '…/install/import/ontology/7.0/.staging'`. Existing installs pick this up from the updated compose file: `docker compose up -d` recreates the engine container, and no manual `chown` is needed.
