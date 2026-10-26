# Dédalo v7 — THE CI IMAGE (ghcr.io/renderpci/dedalo-ci; local tag dedalo-ci:local).
#
# ONE TOOLCHAIN, EVERYWHERE THE GATES RUN. Until this image, a hosted job was
# `ubuntu-latest` plus whatever `apt-get` handed it at run time, and a local run was
# native macOS — two different machines judging the same commit. Measured on the
# unit tier: 25 red files on the runner against 3 on a developer box, the difference
# being ffmpeg / ImageMagick / poppler / mariadb the runner simply did not have.
# The workflows (`container:`) and `bun run ci:local -- --docker` both run INSIDE
# this image, so a verdict is a property of the commit, not of the machine.
#
# WHAT IS IN IT, AND WHY (every package is here because a gate or tier needs it):
#   bun (exactly .bun-version) — read from the file in the build context, never
#             re-typed here, and checked against the release's SHASUMS256. The pin
#             is load-bearing (Bun.sql jsonb-inference drift is a data-corruption
#             class); scripts/ci/env_guard.sh re-checks it at run time.
#   postgresql-client-18 (PGDG) — pg_dump/pg_restore/psql refuse a NEWER server
#             than the client, and the service is pgvector:pg18. Resolved through
#             DEDALO_PG_BIN_PATH=/usr/lib/postgresql/18/bin (scripts/ci/hosted_env.sh).
#             Its message catalogs are KEPT (the slim base drops /usr/share/locale)
#             and es_ES/de_DE/fr_FR are generated (`locales`): the backup verifier
#             must reach the same verdict under a server's translated locale, and
#             backup_freshness_deep_native's translated-locale legs (S2-S4) measure
#             that only on a pg_restore that really translates — absent, they SKIP.
#   ffmpeg (ships ffprobe + qt-faststart), imagemagick (7: `magick`) +
#             libheif-plugin-aomenc (AVIF WRITE: trixie's libheif ships decoders
#             only, so without it `.avif` twins — DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS
#             — are refused and the media_tools / alternate-versions gates go red),
#             poppler-utils
#             (pdfinfo/pdftotext/pdftohtml/pdftoppm), ghostscript (the engine-owned
#             PDF rasterizer — explicit, --no-install-recommends drops it),
#             librsvg2-bin (rsvg-convert, the only SVG rasterizer), ocrmypdf (the
#             OCR door, engine/pdf.ts buildOcrArgv; pulls tesseract + eng data), file — the media
#             toolchain the media gates probe with existsSync and otherwise SKIP.
#             Same distro and packages as the product image (../Dockerfile), so a
#             media gate measures what ships.
#   mariadb-server + mariadb-client — the diffusion tier's MariaDB target.
#   apache2 + apache2-dev (apxs) + nginx (mp4 module) — the publication-host media
#             drill (`bun run test:media:pubhost`, instance tier) boots both live.
#   sudo — for its parser only (cvtsudoers): publication/host_agent's sudoers gate
#             validates the rendered rule with the real grammar. setuid bit stripped,
#             and the binary diverted: /usr/bin/sudo and /usr/bin/systemctl are the
#             EXEC SEAM's dispatchers (section below), never the real programs.
#   chromium — the browser the client suite (scripts/client_test_runner.ts) drives.
#             NOT google-chrome: Google publishes no linux/arm64 build, and this
#             image is multi-arch so an Apple-Silicon Mac runs it natively. One
#             distro package on BOTH arches means one browser version everywhere,
#             instead of Chrome on the runner and something else on the Mac. The
#             runner prefers PUPPETEER_EXECUTABLE_PATH over `channel: 'chrome'`,
#             so the ENV below is the whole wiring; PUPPETEER_SKIP_DOWNLOAD stops
#             `bun install` fetching a second one.
#   git, rsync, unzip, zip, xz, curl, procps — the tier scripts, the code-update
#             drills (git clone + zip release) and the backup gates.
#   openssl — the publication-host agent's mTLS boot gate (publication/host_agent
#             tests/boot_mtls.test.ts issues its scratch CA with the CLI) and the
#             agent's live drill (instance tier).
#   gpgv — the `.bun-sha256` census row (test/unit/ops_runtime_pin.test.ts) verifies
#             Bun's clearsigned SHASUMS256.txt.asc (ci/bun/) against the pinned release
#             key on every run: the hashes `provision init` trusts come only from that
#             signed payload. gpgv only: it starts no agent and needs no keyring home.
#   php-fpm — the guided install's v1 pool syntax gate (publication/host_agent
#             tests/init_web_syntax.test.ts: `php-fpm<v> -t -y <rendered pool>`) and the
#             Debian init drill's base (scripts/publication_host_init_drill.ts builds its
#             privileged systemd container FROM this image). Never started here.
#   shellcheck — the publication-host installer's lint gate (publication/host_agent
#             tests/init_install_sh.test.ts: `shellcheck -s sh deploy/install.sh`). That
#             script runs as root on a fresh host before any Bun exists, so a POSIX-sh
#             defect is caught here or on a museum's server: RED on Linux when absent.
#
# BASE: debian:trixie-slim, DIGEST-pinned — the distro of the product image
# (oven/bun:<v>-debian is trixie), so CI and production share a package set.
# Dependabot's docker ecosystem (.github/dependabot.yml) proposes new digests: the
# same "exactness with an updater" rule as .bun-version and the SHA-pinned actions.
# Distro packages are not individually version-pinned: the IMAGE DIGEST the
# workflows pin is the exactness; the weekly rebuild (.github/workflows/ci-image.yml)
# is the updater. /etc/dedalo-ci-versions records what a given build resolved.
#
# THE FINGERPRINT — sha256 of (ci/Dockerfile bytes ++ .bun-version bytes). Written to
# /etc/dedalo-ci-image and to the label org.dedalo.ci.fingerprint (same value), so a
# job can prove it runs in the image built from THIS commit's definition, and a local
# runner can tell a stale dedalo-ci:local from a current one without rebuilding.
# The build REFUSES unless the value passed in equals the one computed from the
# context, so the label can never describe a different Dockerfile than the layers:
#
#   FP="$(cat ci/Dockerfile .bun-version | shasum -a 256 | cut -d' ' -f1)"
#   docker buildx build -f ci/Dockerfile --build-arg DEDALO_CI_FINGERPRINT="$FP" \
#     -t dedalo-ci:local --load .
#
# BUILD CONTEXT = the repo root, but ci/Dockerfile.dockerignore admits exactly two
# files (this one and .bun-version): the image carries a TOOLCHAIN, never the tree —
# the checkout is mounted at run time. (So the ImageMagick policy is not baked in:
# the engine points its own spawns at the shipped policy via MAGICK_CONFIGURE_PATH.)
#
# LAYER ORDER = rate of change, slowest first: OS packages, PGDG, media, browser,
# then bun (moves with .bun-version), then the fingerprint (moves with every edit of
# this file — last, so an edited comment rebuilds one tiny layer, not the toolchain).
#
# Operator notes: ci/README.md.

# debian:trixie-slim — multi-arch INDEX digest (amd64 + arm64 resolve through it).
FROM debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# --- base + PostgreSQL 18 client (PGDG) ---------------------------------------
# Debian's own postgresql-client is older than the pg18 service; an older client
# refuses a newer server.
# The slim base path-excludes /usr/share/locale/*; re-include PostgreSQL's client
# catalogs only (<prog>-18.mo, every language — small), so pg_restore can translate.
# dpkg reads dpkg.cfg.d/ in name order and the LAST match wins: the file must sort
# after the base's `docker` (hence zz-), or the exclude silently outranks it.
RUN set -eux; \
    echo 'path-include /usr/share/locale/*/LC_MESSAGES/*-18.mo' \
      > /etc/dpkg/dpkg.cfg.d/zz-dedalo-ci-pg-messages; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg bash coreutils procps tzdata locales \
      git rsync unzip zip xz-utils gzip file jq openssl gpgv shellcheck; \
    for l in es_ES de_DE fr_FR; do \
      sed -i "s/^# *\($l\.UTF-8 UTF-8\)/\1/" /etc/locale.gen; \
      grep -q "^$l\.UTF-8 UTF-8" /etc/locale.gen; \
    done; \
    locale-gen; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-client-18; \
    test -f /usr/share/locale/es/LC_MESSAGES/pg_dump-18.mo; \
    rm -rf /var/lib/apt/lists/*

# --- media toolchain ------------------------------------------------------------
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ffmpeg imagemagick libheif-plugin-aomenc poppler-utils ghostscript librsvg2-bin \
      ocrmypdf; \
    rm -rf /var/lib/apt/lists/*

# --- MariaDB (diffusion target) -------------------------------------------------
# The package's postinst may try to start the server and fail without an init system;
# that is harmless here — a tier that needs it starts mariadbd itself.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends mariadb-server mariadb-client; \
    rm -rf /var/lib/apt/lists/*

# --- web servers (publication-host media drill) ---------------------------------
# scripts/media_publication_host_drill.ts boots a REAL Apache and nginx (instance tier).
# apache2-dev ships apxs, through which the drill resolves the binary (`apache2` here,
# `httpd` elsewhere) and the module dir; Debian's nginx is built --with-http_mp4_module.
# Neither is started as a service: the drill writes its own configs and runs both as
# the job's uid on 127.0.0.1.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends apache2 apache2-dev nginx; \
    rm -rf /var/lib/apt/lists/*

# --- PHP CLI + FPM (publication-host engine drill, provision init) --------------
# scripts/publication_host_engine_drill.ts pushes a REAL Publication API v1 release through
# the engine's lockstep reconciler; the agent runs `php -l` on every .php before it
# promotes one — the CLI binary is all the drill's `php` stand-in execs. php-fpm: the
# dedicated v1 pool provision init renders is syntax-checked with the real `php-fpm<v> -t`,
# and the Debian init drill reloads it for real. No web-server module (no libapache2-mod-php).
# Its postinst may try to start the service without an init system: harmless here, nothing
# in this image runs it as a service.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends php-cli php-fpm; \
    test -x "$(ls /usr/sbin/php-fpm* | head -n1)"; \
    rm -rf /var/lib/apt/lists/*

# --- sudo (sudo's parser: the publication-host agent's sudoers gate) -------------
# publication/host_agent/tests/provision_render_grants.test.ts parses the rendered sudoers
# rule with `cvtsudoers` (hermetic daemon gate) — sudo's own grammar, and unlike `visudo`
# it does not refuse the job's BARE uid 1001 (no passwd entry). sudo itself is never
# configured nor invoked in this image. Its SETUID BIT IS STRIPPED (dpkg-statoverride, so
# a package upgrade keeps it stripped): the parser needs none, and a setuid-root binary is
# local-escalation surface for uid 1001 (cf. CVE-2025-32463) — without the bit, uid 1001
# truly gains nothing. The `test ! -u` below fails the build if the override ever lapses.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends sudo; \
    dpkg-statoverride --update --add root root 0755 /usr/bin/sudo; \
    test ! -u /usr/bin/sudo; \
    rm -rf /var/lib/apt/lists/*

# --- browser (client suite) -----------------------------------------------------
# Fonts explicitly: --no-install-recommends drops them, and a font-less Chromium
# lays text out with nothing — a layout-sensitive suite would measure a different page.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends chromium fonts-liberation fonts-dejavu-core; \
    rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=1

# The checkout is bind-mounted (ci:local) or created by actions/checkout under a uid
# that is not this container's root; git's safe.directory check would then refuse
# every `git` call the tiers and the update drills make.
RUN git config --system --add safe.directory '*'

# --- bun, exactly .bun-version --------------------------------------------------
# TARGETARCH is set by BuildKit per platform of a multi-arch build.
ARG TARGETARCH
COPY .bun-version /tmp/.bun-version
RUN set -eux; \
    version="$(tr -d '[:space:]' < /tmp/.bun-version)"; \
    case "$TARGETARCH" in \
      amd64) asset="bun-linux-x64" ;; \
      arm64) asset="bun-linux-aarch64" ;; \
      *) echo "ci/Dockerfile: no bun build for TARGETARCH='$TARGETARCH'" >&2; exit 1 ;; \
    esac; \
    base="https://github.com/oven-sh/bun/releases/download/bun-v${version}"; \
    cd /tmp; \
    curl -fsSLO "$base/$asset.zip"; \
    curl -fsSLO "$base/SHASUMS256.txt"; \
    grep " $asset.zip\$" SHASUMS256.txt | sha256sum -c -; \
    unzip -q "$asset.zip"; \
    install -m 0755 "$asset/bun" /usr/local/bin/bun; \
    ln -s /usr/local/bin/bun /usr/local/bin/bunx; \
    rm -rf "$asset" "$asset.zip" SHASUMS256.txt /tmp/.bun-version; \
    test "$(bun --version)" = "$version"

# --- exec seam (the publication-host agent's live drill) -------------------------
# The agent's src/exec.ts spawns ABSOLUTE binaries (/usr/bin/sudo, /usr/bin/systemctl —
# its SUDO / SYSTEMCTL; never a PATH lookup), so the instance tier's drill
# (scripts/publication_host_agent_drill.ts) can only observe and steer the agent's
# privileged commands by putting stand-ins AT those paths, with exec.ts unmodified. This
# disposable image is where that is allowed: each path becomes a DISPATCHER that runs
# <seam dir>/<name> when the drill has written one and otherwise fails (exit 1, saying
# so). The real sudo is diverted to /usr/bin/sudo.distrib (setuid still stripped, and
# re-checked here), and so is systemd's systemctl, which a dependency pulls in (nothing
# here runs systemd). The seam dir is root:root 0770: the job's bare uid 1001 runs with gid
# 0 on every host, so it may arm the seam, and nothing it can arm is privileged.
# Pinned to exec.ts's constants by test/unit/publication_host_agent_drill_kit.test.ts.
RUN set -eux; \
    for bin in /usr/bin/sudo /usr/bin/systemctl; do \
      dpkg-divert --local --rename --divert "$bin.distrib" --add "$bin"; \
    done; \
    dpkg-statoverride --update --add root root 0755 /usr/bin/sudo.distrib; \
    test ! -u /usr/bin/sudo.distrib; \
    install -d -o root -g root -m 0770 /opt/dedalo-ci/exec-seam; \
    for bin in /usr/bin/sudo /usr/bin/systemctl; do \
      name="${bin##*/}"; \
      printf '%s\n' '#!/bin/sh' \
        "# DEDALO CI EXEC SEAM DISPATCHER for $bin (ci/Dockerfile, exec seam)." \
        "seam=/opt/dedalo-ci/exec-seam/$name" \
        'if [ -x "$seam" ]; then exec "$seam" "$@"; fi' \
        "echo \"$name: not available in the CI image (the publication-host agent drill's exec seam is not armed)\" >&2" \
        'exit 1' > "$bin"; \
      chmod 0755 "$bin"; \
    done; \
    ! /usr/bin/sudo -n true 2>/dev/null; \
    ! /usr/bin/systemctl --version 2>/dev/null

# --- fingerprint + version record (LAST — see header) ---------------------------
ARG DEDALO_CI_FINGERPRINT
COPY ci/Dockerfile .bun-version /usr/local/share/dedalo-ci/
RUN set -eu; \
    computed="$(cat /usr/local/share/dedalo-ci/Dockerfile /usr/local/share/dedalo-ci/.bun-version | sha256sum | cut -d' ' -f1)"; \
    if [ "${DEDALO_CI_FINGERPRINT:-}" != "$computed" ]; then \
      echo "ci/Dockerfile: --build-arg DEDALO_CI_FINGERPRINT='${DEDALO_CI_FINGERPRINT:-}' but the context computes '$computed'." >&2; \
      echo "  Pass: --build-arg DEDALO_CI_FINGERPRINT=\"\$(cat ci/Dockerfile .bun-version | shasum -a 256 | cut -d' ' -f1)\"" >&2; \
      exit 1; \
    fi; \
    printf '%s\n' "$computed" > /etc/dedalo-ci-image; \
    { \
      echo "bun $(bun --version)"; \
      echo "$(pg_dump --version)"; \
      echo "$(chromium --version)"; \
      echo "$(ffmpeg -version | head -n1)"; \
      echo "$(magick -version | head -n1)"; \
      echo "$(pdftoppm -v 2>&1 | head -n1)"; \
      echo "gs $(gs --version)"; \
      echo "ocrmypdf $(ocrmypdf --version)"; \
      echo "$(tesseract --version 2>&1 | head -n1)"; \
      echo "$(mariadb --version)"; \
      echo "$(apache2 -v | head -n1)"; \
      echo "$(nginx -v 2>&1)"; \
      echo "$(php -v | head -n1)"; \
      echo "$("$(ls /usr/sbin/php-fpm* | head -n1)" -v | head -n1)"; \
      echo "$(gpgv --version | head -n1)"; \
      echo "shellcheck $(shellcheck --version | sed -n 's/^version: //p')"; \
      echo "$(git --version)"; \
      echo "$(openssl version)"; \
      echo "$(cvtsudoers -V | head -n1)"; \
    } > /etc/dedalo-ci-versions; \
    cat /etc/dedalo-ci-versions
LABEL org.dedalo.ci.fingerprint="${DEDALO_CI_FINGERPRINT}" \
      org.opencontainers.image.source="https://github.com/renderpci/dedalo" \
      org.opencontainers.image.description="Dédalo v7 CI toolchain: bun (.bun-version), pg18 client, media tools, MariaDB, Apache, nginx, Chromium"
ENV DEDALO_CI_IMAGE=1

CMD ["bash"]
