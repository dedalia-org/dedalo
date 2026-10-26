#!/usr/bin/env bash
#
# DEPLOY — git-based deploy to a Linux/systemd host, with health check and
# automatic rollback.
#
# ⚠ PARKED (2026-07-09): no staging/production server exists yet. This script
# is wired and reviewed but has never run against a real host — exercise it
# on the first staging box together with engineering/STAGING_VALIDATION.md
# before trusting it for production. Invoked by
# .github/workflows-selfhosted/deploy.yml once the DEPLOY_HOST/DEPLOY_SSH_KEY
# secrets exist; equally runnable by hand.
#
# ⚠ KNOWN GAPS AGAINST THE DOCUMENTED LAYOUT (docs/install/production.md), to
# close when it is first exercised — until then pass --bun and mind the user:
#   - --bun defaults to $HOME/.bun/bin/bun OF THE SSH LOGIN USER. The canonical
#     pinned runtime is /opt/dedalo/.bun/bin/bun: pass `--bun` explicitly (the
#     workflow above does not yet).
#   - git and bun run AS THE SSH LOGIN USER, not as the service user. The
#     production service user `dedalo` has a nologin shell and cannot be that
#     login, so files the checkout and `bun install` create end up owned by the
#     wrong user. The remote steps need `sudo -u dedalo` (and the login user a
#     sudoers entry for it plus `systemctl restart <service>`), or a login whose
#     identity is the service user's.
#   - it updates the code only: the out-of-tree copies in /opt/dedalo/bin/
#     (dedalo-code-rollback.sh, dedalo-ts-watchdog.sh) are not refreshed.
#
# Model (engineering/PRODUCTION.md):
#   - the repo IS the artifact: deploy = fetch + checkout <ref> on the host
#     (refs give a rollback identity; no rsync of build outputs)
#   - bun is the PINNED binary path on the host (never floating `bun` — the
#     .bun-version pin is load-bearing), deps via --frozen-lockfile
#   - boot migrations run inside the server at startup (install/db/migrate.ts)
#     — deploy does NOT run a separate migrate step
#   - health = GET /health over the unix socket via the reverse-proxy-side
#     curl; 200 only when Postgres answers
#   - on red health: roll back to the previously deployed ref, restart,
#     re-check, exit 1 either way
#
# Usage:
#   deploy/deploy.sh --host user@host --ref <sha|tag|branch> \
#     [--app-dir /opt/dedalo/master_dedalo] [--service dedalo-ts] \
#     [--socket /run/dedalo/dedalo_ts.sock] [--bun /opt/dedalo/.bun/bin/bun]

set -euo pipefail

HOST="" REF="" APP_DIR="" SERVICE="dedalo-ts" SOCKET="/run/dedalo/dedalo_ts.sock" REMOTE_BUN=""
while [ $# -gt 0 ]; do
	case "$1" in
		--host) HOST="$2"; shift 2 ;;
		--ref) REF="$2"; shift 2 ;;
		--app-dir) APP_DIR="$2"; shift 2 ;;
		--service) SERVICE="$2"; shift 2 ;;
		--socket) SOCKET="$2"; shift 2 ;;
		--bun) REMOTE_BUN="$2"; shift 2 ;;
		*) echo "ERROR: unknown arg $1" >&2; exit 2 ;;
	esac
done
[ -n "$HOST" ] && [ -n "$REF" ] || { echo "Usage: deploy.sh --host user@host --ref <ref> [...]" >&2; exit 2; }
APP_DIR="${APP_DIR:-/opt/dedalo/master_dedalo}"
REMOTE_BUN="${REMOTE_BUN:-\$HOME/.bun/bin/bun}"

# The whole deploy runs as ONE remote script so a dropped connection can't
# leave a half-applied state without the rollback logic on the far side.
ssh -o BatchMode=yes "$HOST" \
	APP_DIR="$APP_DIR" SERVICE="$SERVICE" SOCKET="$SOCKET" REF="$REF" REMOTE_BUN="$REMOTE_BUN" \
	'bash -s' <<'REMOTE'
set -euo pipefail
cd "$APP_DIR"

health_wait() { # up to 30s for /health over the unix socket
	for _ in $(seq 1 30); do
		if curl -fsS --unix-socket "$SOCKET" http://localhost/health >/dev/null 2>&1; then
			return 0
		fi
		sleep 1
	done
	return 1
}

PREV="$(git rev-parse HEAD)"
echo "== deploy: $PREV -> $REF on $(hostname) ($APP_DIR)"

# --tags: the engine names itself after the exact annotated release tag of its
# commit (a checkout asks git describe at boot), so the tags must be here.
git fetch --all --tags --prune
git checkout --detach "$REF"

# A release ref must BE that release: a lightweight tag, a tag on another commit or
# one naming another version than version.ts would run as X.Y.Z-dev and pass for
# nothing (release identity, owner 2026-10-15). Judged by the deployed tree's own
# library (dedalo_release_identity — the engine resolver's shell twin); a ref that
# predates it is deployed unchecked, and says so.
IDENTITY='' RELEASE_REF=''
if [ -f deploy/dedalo-image-lib.sh ] && IDENTITY="$(bash -c '. deploy/dedalo-image-lib.sh && command -v dedalo_release_identity >/dev/null && dedalo_release_identity .')"; then
	RELEASE_REF="$(bash -c '. deploy/dedalo-image-lib.sh && dedalo_release_tag_version "$1"' ref "$REF" || true)"
	if [ -n "$RELEASE_REF" ] && [ "v$IDENTITY" != "$REF" ]; then
		echo "ERROR: $REF is not a release this tree can call itself (it says $IDENTITY: a lightweight tag, or a tag naming another version) — not deployed." >&2
		git checkout --detach "$PREV"
		exit 1
	fi
	echo "== deploy: $REF is release identity $IDENTITY"
else
	IDENTITY=''
	echo "== deploy: $REF predates the release identity — not checked"
fi

# pinned bun; the server itself re-asserts the .bun-version pin at boot
BUN="$(eval echo "$REMOTE_BUN")"
WANT="$(tr -d '[:space:]' < .bun-version)"
HAVE="$("$BUN" --version | tr -d '[:space:]')"
if [ "$WANT" != "$HAVE" ]; then
	echo "ERROR: host bun $HAVE != pinned $WANT — install the pinned bun before deploying." >&2
	git checkout --detach "$PREV"
	exit 1
fi
"$BUN" install --frozen-lockfile --production

sudo systemctl restart "$SERVICE"
if health_wait; then
	echo "== deploy: GREEN at $(git rev-parse HEAD)${IDENTITY:+ ($IDENTITY)}"
	exit 0
fi

echo "== deploy: /health never went green — ROLLING BACK to $PREV" >&2
git checkout --detach "$PREV"
"$BUN" install --frozen-lockfile --production
sudo systemctl restart "$SERVICE"
if health_wait; then
	echo "== deploy: rollback healthy at $PREV (deploy FAILED)" >&2
else
	echo "== deploy: ROLLBACK ALSO UNHEALTHY — manual intervention required" >&2
fi
exit 1
REMOTE
