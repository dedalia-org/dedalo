---
title: The image updater brings the stack's PostgreSQL, nginx, certbot, MariaDB and pgvector up to the release's pins — and refuses a new database major, which is a migration.
type: changed
audience: admin
date: 2026-11-13
wc: WC-2026-10-09-update-code-image-channel
---
Before, `deploy/dedalo-image-update.sh` replaced the engine image only: the third-party images the stack file pins (`postgres`, `nginx`, `certbot`, `mariadb`, `pgvector`) reached an installation only when you updated the checkout and ran `ddc up -d` yourself, so an install could run a release's engine beside the previous release's PostgreSQL or nginx for months.

Now the updater reads the stack file's pins first and, after the database dump and before the engine moves, pulls each pin whose running container differs from it and recreates **that service alone**; a service that is not running (an optional profile) is left alone, and `--check` lists what a run would reconcile. A PostgreSQL minor or digest refresh therefore recreates the database container during the update, a few seconds in which the old engine reconnects.

A **new major** of PostgreSQL, MariaDB or pgvector is never applied this way: it is the format of the data on disk, so the run is refused before anything changes (*service_major_mismatch*) and the dependency updater no longer proposes such majors. Moving to a new major is a migration you run on purpose — the procedure is in the Docker install page, *A new PostgreSQL, pgvector or MariaDB major*. A service pin that cannot be pulled or recreated ends the run as *service_pin_failed* with nothing re-pinned and the engine untouched.
