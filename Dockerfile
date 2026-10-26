# Dédalo v7 — container image.
#
# Operator guide: docs/install/docker.md
#
# The runtime is PINNED (.bun-version / package.json engines.bun). Keep this tag
# and that pin in lockstep — the engine is coupled to version-specific runtime
# behaviour, and a silent drift is a data-corruption class, not a performance
# regression (gate: test/unit/ops_runtime_pin.test.ts).
#
# THE BASE IS PINNED BY DIGEST TOO (2026-10-09). A tag is a pointer its publisher
# can move; the digest is the bytes this file was written against, and the
# published Dédalo images (.github/workflows/image-release.yml) are signed — a
# signature over an image whose base quietly changed under the same tag would vouch
# for bytes nobody chose. The tag stays for the reader and for Dependabot (the
# `docker` entry for "/" in .github/dependabot.yml proposes digest AND tag bumps);
# a tag-bump PR stays red until .bun-version moves with it — the lockstep above.
#
# LAYER ORDER IS A CONTRACT: OS + toolchain → system policy and markers →
# dependencies → the CODE, LAST. Successive releases then SHARE every big layer
# (the ~1 GB apt toolchain, node_modules) until the base digest, the apt line or
# the lockfile changes, so an operator pulling a patch release downloads the code
# layer, not the toolchain again. Only the provenance stamp (one small file) and
# image metadata follow the code. Gate: test/unit/product_image_tripwire.test.ts.
#
# THREE STAGES, one lineage — see "Build targets" at the foot of this file:
#   runtime     the image, production dependencies only
#   dev         runtime + the devDependencies (client test harness, less, linters)
#   production  the DEFAULT target; a bare alias of `runtime`
FROM oven/bun:1.4.4-debian@sha256:93d5032fe06d163427822dc1598f420363759bb18155c9cc90eb1be05a64a19e AS runtime

# --- OS packages -------------------------------------------------------------
# The image MUST ship a `psql` that is NOT OLDER than the PostgreSQL server it
# talks to (18 in docker-compose.yml): the installer, the seed restore, the
# hierarchy import and the backup widget all shell out to it, and an older client
# refuses to connect to a newer server. Debian's own postgresql-client is too
# old, so the PostgreSQL project's repository (PGDG) is added.
#
# The media toolchain is not optional either: without it, uploads produce no
# derivatives and no thumbnails.
#   ffmpeg  → transcoding, posterframes, probing (also ships qt-faststart)
#   imagemagick (7 on trixie: `magick`; a v6 convert/identify host is handled
#             by the engine's fallback)
#   libheif-plugin-aomenc → AVIF WRITE for ImageMagick: trixie's libheif ships
#             decoders only, so without it the `.avif` alternative versions
#             (DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS) are refused on upload
#   poppler-utils → pdftotext / pdftohtml / pdfinfo, AND the page box the PDF
#             rasterizer refuses on (engine/pdf.ts readPdfPageSize)
#   ghostscript → the PDF page rasterizer, spawned BY THE ENGINE (not as an
#             ImageMagick delegate, which the shipped policy denies: a delegate
#             child is unbounded and survives the kill that ends the request —
#             audit MEDIA-01). Explicit because --no-install-recommends drops it,
#             so without this line a container built PDF covers through a
#             delegate that was not even installed
#   ocrmypdf → optional automatic OCR
#   librsvg2-bin → rsvg-convert, the ONLY SVG rasterizer (component_svg thumbs /
#             web derivatives): ImageMagick's SVG path emits MVG, which the
#             shipped policy denies (engine rasterizeSvg)
#   git, unzip, gzip, file → used by the code-update subsystem and MIME sniffing
#   rsync   → the `backup` service of both compose stacks: it is what copies the
#             media originals and /private into dated generations
#             (deploy/dedalo-tree-backup.sh). Without it that service refuses
#             rather than half-copy, which would leave a containerised install
#             with a database dump and no files (added 2026-08-30, P0-13).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-client-18 \
      ffmpeg imagemagick libheif-plugin-aomenc librsvg2-bin poppler-utils ocrmypdf ghostscript \
      git unzip gzip file rsync \
 && rm -rf /var/lib/apt/lists/*

# --- ImageMagick policy, system-wide (audit MEDIA-01 / MEDIA-02) -------------
# The engine already points its OWN ImageMagick spawns at the shipped policy via
# MAGICK_CONFIGURE_PATH (core/media/engine/binaries.ts), and splices the
# DEDALO_MAGICK_LIMIT_* `-limit` argv into each of them. Neither reaches an
# ImageMagick process this engine did not build: a delegate child, a maintenance
# `convert` in a shell, anything a future script adds. Installing the SAME FILE at
# the system config path makes the coder denials and the resource ceiling the
# container-wide law instead of a property of one caller.
#
# Debian ships ImageMagick 6, whose config path is /etc/ImageMagick-6; the v7 path
# is written too, so an image built on a base that has moved on keeps the policy.
# This REPLACES Debian's own policy.xml deliberately: the shipped file is the
# considered version of the trade-off — the PS/EPS/XPS/MSL/MVG/URL coders are
# denied, so is the Ghostscript delegate (the engine spawns gs itself), and the
# resource ceiling applies container-wide. Gate:
# test/unit/magick_policy_tripwire.test.ts.
#
# THE DIRECTORY IS CREATED, NEVER TESTED FOR. An `if [ -d "$d" ]` guard made the
# whole system-wide half a SILENT NO-OP on any base image whose ImageMagick config
# path moved — the build stayed green, the gate (which reads this file's text)
# stayed green, and the container ran under the distribution's permissive policy.
# An unconditional install of a config file that only ImageMagick reads costs an
# empty directory at worst.
#
# A SINGLE-FILE COPY, ahead of the code: the policy is system configuration, so it
# belongs with the toolchain layers and must not force them to rebuild when any
# other source file changes. The tmp copy is removed in the same RUN.
COPY src/core/media/engine/imagemagick-policy/policy.xml /tmp/dedalo-magick-policy.xml
RUN set -eu; \
    for d in /etc/ImageMagick-6 /etc/ImageMagick-7; do \
      install -d "$d"; \
      cp /tmp/dedalo-magick-policy.xml "$d/policy.xml"; \
    done; \
    rm -f /tmp/dedalo-magick-policy.xml

# --- The image-channel marker (src/core/update/channel.ts) --------------------
# The code tree (copied below, last) is BAKED into this image: a code-update tree swap would
# land in the container's writable layer and be discarded on the next
# recreation, so the updater must refuse and point at deploy/dedalo-image-update.sh.
# "Running in a container" does not say that (the CI toolchain image runs the
# update drills against trees it owns), so THIS build states it positively.
# Outside the tree on purpose: nothing that exports or bind-mounts a tree can
# carry it. A checkout bind-mounted over /opt/dedalo still reads `tree_swap`
# (channel.ts's mount check). Path = IMAGE_TREE_MARKER_PATH; gate:
# test/unit/update_channel_native.test.ts.
RUN install -d /etc/dedalo \
 && printf '%s\n' /opt/dedalo/master_dedalo > /etc/dedalo/image_tree

# --- Writable trees ----------------------------------------------------------
# THE CONTAINER PROBLEM: `../private/` is a SIBLING of the repo, and in an image
# there is no writable parent to create it in. DEDALO_PRIVATE_DIR relocates the
# whole private tree — .env, the session store, the state file, the backups — and
# BOTH the configuration read side and the installer write side honour it.
# Mount a named volume here or the secrets die with the container.
ENV DEDALO_PRIVATE_DIR=/private

# Created here, owned by `bun`, so an EMPTY named volume mounted over them
# inherits that ownership (Docker copies the image path's ownership into a fresh
# named volume — it does NOT do this for bind mounts).
#
# /backups is the `backups` volume of both stacks (the `backup` service writes the
# nightly dumps there; the full stack's engine reads them and the make_backup
# widget writes them). It was missing from this line from 2026-08-30 to
# 2026-10-08, so the volume came up root-owned: the CLI install died at
# `→ directories` (DEDALO_BACKUP_DIR=/backups/db) and the backup service wrote
# nothing, ever. The copy-up also applies to an EXISTING volume while it is
# empty (measured 2026-10-08), and nothing could write to those, so a rebuild
# heals an existing install with no manual chown.
# Gate: test/unit/stack_ops_policy_tripwire.test.ts (every writable named
# volume of an image-built service is listed here).
#
# /srv/dedalo/client is the `client` volume of both stacks: the engine PUBLISHES its
# own client tree there at boot (src/core/install/client_publish.ts) and nginx
# serves it read-only, so the browser always runs the client of the engine it
# talks to — a pulled image never serves against a host checkout's older client.
#
# /srv/dedalo/media is the media tree's ROOT, at the tree's one mode (0750 —
# src/core/install/media_tree.ts MEDIA_DIR_MODE; nginx reads it through the
# group): `mkdir -p` under the build's umask made it 0755, and every install
# and every boot then warned `mode_differs` on it (campaign 3 C3-19). The
# volume copies this mode up on first use. Gate: install_stack_steps_native.
RUN mkdir -p /private /srv/dedalo/media /srv/dedalo/client /run/dedalo /backups \
 && chown -R bun:bun /private /srv/dedalo/media /srv/dedalo/client /run/dedalo /backups \
 && chmod 0750 /srv/dedalo/media

# --- Application -------------------------------------------------------------
# Everything above is the same for every release built on this base; everything
# from here on is the release. Dependencies first, the code last (header: LAYER
# ORDER IS A CONTRACT).
WORKDIR /opt/dedalo/master_dedalo

# Dependencies first, so a source change does not re-resolve the whole tree.
# --frozen-lockfile refuses to silently resolve a different tree than the one
# that was tested. --production drops the dev dependencies (test harness,
# linters); the browser libraries the client loads are runtime dependencies, so
# they stay.
COPY package.json bun.lock* bun.lockb* ./
RUN bun install --frozen-lockfile --production

# THE APPLICATION TREE, ENTRY BY ENTRY — never `COPY . .` (audit OPS-01).
# `install.sh` writes the local-CA private key, the site key and the DB password
# into the build context (deploy/certs/, .dedalo.env) BEFORE it runs
# `compose build`, and an image carrying that CA key is a browser-trusted
# signing key for every workstation the operator was told to install the CA on —
# travelling to wherever the image travels (a registry, a `docker save`
# tarball). `.dockerignore` denies the whole ROOT and re-includes only the
# tracked top-level entries, then re-applies a census derived from every tracked
# `.gitignore` plus a depth-agnostic secret-shape deny; this list is the second,
# independent layer: `deploy/` is not named here, so no COPY can reach a key even
# if an ignore rule were wrong.
#
# GENERATED from the tracked tree — regenerate with `bun run context:gen`
# (`bun run deploy/build_context.ts`) after adding or removing a top-level entry. Policy + reasons: deploy/build_context.ts.
# Gate: test/unit/build_context_secret_tripwire.test.ts.
# >>> BUILD-CONTEXT ALLOWLIST — generated by deploy/build_context.ts >>>
COPY .agents ./.agents
COPY changes ./changes
COPY client ./client
COPY docs ./docs
COPY engineering ./engineering
COPY install ./install
COPY overrides ./overrides
COPY presentation ./presentation
COPY publication ./publication
COPY scripts ./scripts
COPY src ./src
COPY tools ./tools
COPY vendor ./vendor
COPY .bun-sha256 .bun-sha256-darwin .bun-version .dockerignore .gitattributes .gitignore .gitleaks.toml AGENTS.md Dockerfile License.md README.md SECURITY.md biome.jsonc bun.lock bunfig.toml cliff.toml docker-compose.simple.yml docker-compose.yml install.sh mkdocs.yml package.json tsconfig.json ./
# <<< BUILD-CONTEXT ALLOWLIST <<<

# --- Release provenance (src/core/update/install_stamp.ts) ------------------
# A release image is built by .github/workflows/image-release.yml from a
# `git archive` of the release commit — the SAME mechanism as the code server's
# `<v>.zip`, so `build_info.txt` arrives expanded (export-subst) exactly as in the
# archive. This file NEVER writes build_info.txt: that would forge the commit
# provenance build_stamp.ts reads (test/unit/build_stamp_native.test.ts holds the
# committed placeholder).
#
# What the archive cannot say is WHICH CHANNEL it is: a developer build of master is
# a git archive too, and would otherwise report a bare release version. So the
# workflow passes the channel and the sha256 of the archive it built from, and this
# step writes the install stamp a tree-swap install writes for the same purpose:
#   both empty      no-op — a local build (a checkout, unexpanded build_info.txt)
#                   stays honestly `.dev`;
#   channel master      a stable release (`X.Y.Z`, the tag its archive expands to);
#   channel prerelease  a prerelease release (`X.Y.Z-beta.N`, ditto) — release
#                       posture, offered on the `prerelease` channel (install_stamp.ts);
#   channel dev         `.dev` on an expanded build (X.Y.Z.dev);
#   anything else   (one set without the other, another channel, a digest that is
#                   not 64 lowercase hex) FAILS the build — a half-stated provenance
#                   is a lie in an image somebody will sign.
# Root-owned and read-only to the engine; the last layer that writes the tree.
ARG DEDALO_RELEASE_CHANNEL=""
ARG DEDALO_RELEASE_ARCHIVE_SHA256=""
RUN set -eu; \
    channel="${DEDALO_RELEASE_CHANNEL:-}"; digest="${DEDALO_RELEASE_ARCHIVE_SHA256:-}"; \
    if [ -z "$channel" ] && [ -z "$digest" ]; then echo "provenance: none (a local build reports .dev)"; exit 0; fi; \
    case "$channel" in master|prerelease|dev) ;; *) echo "DEDALO_RELEASE_CHANNEL must be master, prerelease or dev, set together with DEDALO_RELEASE_ARCHIVE_SHA256 (got channel '$channel')" >&2; exit 1 ;; esac; \
    case "$digest" in *[!0-9a-f]*|'') echo "DEDALO_RELEASE_ARCHIVE_SHA256 must be 64 lowercase hex, set together with DEDALO_RELEASE_CHANNEL" >&2; exit 1 ;; esac; \
    if [ "${#digest}" -ne 64 ]; then echo "DEDALO_RELEASE_ARCHIVE_SHA256 must be 64 lowercase hex (got ${#digest} characters)" >&2; exit 1; fi; \
    printf '{"digest":"%s","channel":"%s"}\n' "$digest" "$channel" > src/core/update/install_stamp.json; \
    echo "provenance: channel $channel, archive sha256 $digest"

USER bun

EXPOSE 3600

# umask 0027 — NARROW (P2-15 / OPS-05, corrected 2026-08-31).
#
# This was `umask 0000`, bought for one correct reason: connecting to a unix
# socket needs WRITE permission on it and the proxy container runs as a different
# user, so with a default umask every request is a 502. But the scope was the
# whole engine process for its whole life, so EVERY file created without an
# explicit mode landed 0666 — the session store and its -wal/-shm, process and
# job records, media derivatives, and ts_state.json, which is not inert: it
# carries media_access_mode (which WINS over .env) and install_status, so writing
# anything but `sealed` into it makes the next boot REFUSE to start (exit 78;
# until 2026-10-12 it re-opened the pre-auth install surface, whose actions
# rewrote ../private/.env and restarted the process). Named volumes bound that in the shipped stacks; a bind-mounted
# /private — which the comments in this file contemplate — is where it bites.
#
# The socket now gets its 0666 explicitly, from the one place that knows which
# file it is (src/server.ts, right after Bun.serve). Everything else inherits a
# umask that does not hand the world a writable private directory.
ENTRYPOINT ["/bin/sh", "-c", "umask 0027; exec \"$@\"", "--"]
CMD ["bun", "run", "src/server.ts"]

# --- Build targets -----------------------------------------------------------
# DEV: the same image with the devDependencies put BACK. `--production` above
# drops mocha and chai, and both are registered client libs
# (src/core/client_libs/registry.ts, `devOnly`) — without them the browser test
# harness at /dedalo/test/client/ loads nothing and every script 404s as a JSON
# error envelope ("MIME type ('application/json') is not executable"). `less`
# comes back too, so `bun run dev` (with the LESS watcher) works here.
#
# It is a LAYER ON TOP of the finished runtime stage, not a fork of it: there is
# exactly one copy of the OS packages, the source copy and the runtime settings,
# so a dev image can never drift from what production runs.
#
# Reinstalling needs to write into the root-owned node_modules, hence the
# root/bun sandwich; the chown keeps the tree owned by the user that runs it,
# and the cache root installed into is dropped in the SAME layer (a separate RUN
# would delete nothing — the bytes would already be committed).
#
#   docker build --target dev -t dedalo:dev .          # or `target: dev` in a
#                                                      # compose build: mapping
#
# DEV_MODE IS SEPARATE. This target only puts the bytes on disk; the SERVING
# guard (src/core/client_libs/serving.ts, `lib.devOnly === true && !isDevMode()`)
# still refuses a dev-only lib unless DEDALO_DEV_MODE=true. Both are required.
FROM runtime AS dev
USER root
RUN bun install --frozen-lockfile \
 && chown -R bun:bun /opt/dedalo/master_dedalo/node_modules \
 && rm -rf /root/.bun
USER bun

# PRODUCTION: the default target, because Docker builds the LAST stage when none
# is named — and that must never be `dev`. Keep this stage last, and keep it
# empty; `docker compose build` on the production/simple stacks names no target
# and lands here, inheriting every runtime setting (ENTRYPOINT, CMD, USER, ENV,
# EXPOSE) through the FROM.
#
# On BuildKit (the default since Docker 23) an untargeted build resolves the
# graph and never executes `dev`. A LEGACY builder — possible on an old Container
# Station — runs every stage in file order instead: the image is still correct,
# it just pays for the dev install on the way past.
FROM runtime AS production
