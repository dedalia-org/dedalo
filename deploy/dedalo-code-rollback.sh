#!/usr/bin/env bash
#
# CODE-UPDATE ROLLBACK — restore the previous code tree after a failed update.
#
# INSTALLED OUT OF TREE. This file SHIPS at <repo>/deploy/, but its installed
# home is the ROOT-OWNED bin dir OUTSIDE the instance dir (ROOT_BIN_DIR in the
# units: /opt/dedalo/bin/ by hand, /opt/dedalo/instances/<i>/bin/ from the
# installer), alongside the pinned bun. The swap pipeline renames the
# whole app tree; a rollback script living inside that tree vanishes in the
# crash window it exists for (old tree renamed away, new tree not yet in — no
# tree at APP_DIR, no script for systemd's OnFailure= to run). The units point
# at the out-of-tree copy; refresh it after updating (PRODUCTION.md §12):
#   sudo install -m 0755 deploy/dedalo-code-rollback.sh /opt/dedalo/bin/
#
# EVERY MOVE STAYS INSIDE THE INSTANCE DIR (engineering/PRODUCTION.md §2.2): the
# app tree is an entry of the instance dir (the service user's), the backup it
# restores and the failed tree's parking place (<backupRoot>/failed_<stamp>) are
# entries of the backup root below it — so the instance dir's parent may be
# root-owned. Gate: test/unit/code_update.test.ts (the instance-dir rule) runs
# this script against a scratch instance dir whose parent is 0555.
#
# Fired by systemd (dedalo-ts-rollback.service) in exactly two situations:
#   - dedalo-ts.service exhausts its start limit and enters `failed`
#     (OnFailure= on the main unit): the new tree never boots;
#   - the watchdog (dedalo-ts-watchdog.sh) sees a red /health while a
#     pending, unconfirmed code update exists: the new tree boots but is dead.
#
# THE SENTINEL is the contract: <backupRoot>/last_code_update.json, written by
# the update pipeline (src/core/update/code_update.ts) with status "pending"
# BEFORE the swap's first rename — it names the backupDir the pipeline INTENDS
# to create, so a crash at any point leaves a sentinel this script can read:
#   { "version", "previousVersion": <RELEASE IDENTITIES of the new / the old
#       tree, e.g. 7.0.0-beta.7 / 7.0.0-beta.5 (data triples before 2026-10-30);
#       this script only LOGS them, never compares them>,
#     "updateMode", "stamp",
#     "backupDir": <absolute path of the backed-up old tree>,
#     "installDigest": <sha256 of the installed archive, absent pre-2026-08-24>,
#     "status": "pending" | "confirmed" | "rolled_back" | "needs_restore",
#     "rollback_attempted": false | true }
# installDigest is REWRITTEN VERBATIM below and must never be dropped: on the
# dev channel the release identity is identical on both sides of the swap, so it
# is the only field that tells the new tree from the restored old one. A rewrite that
# lost it would leave a `pending` sentinel that the OLD tree happily confirms.
# The NEW tree flips status to "confirmed" once it listens and reaches the
# database and its boot migrations succeeded; a failed boot migration that
# already moved the schema flips it to "needs_restore" instead (a database
# backup restore by a human — this script never acts on it, U-01/D-2). This script acts ONLY on status=="pending" && rollback_attempted==
# false, and flips rollback_attempted to true BEFORE touching the filesystem —
# a rollback that itself fails must never loop.
#
# FOUR STATES of a pending, unattempted sentinel (each is logged by name):
#   state 1  backupDir exists, APP_DIR missing/broken — the crash landed
#            BETWEEN the two renames (window W1): restore backupDir → APP_DIR.
#   state 2  backupDir missing, APP_DIR present — the crash landed BEFORE the
#            first rename: nothing was swapped, nothing to restore; mark the
#            sentinel attempted and exit 0.
#   state 3  both present — the normal post-swap rollback: park the failed
#            tree, restore the backup.
#   state 4  sentinel confirmed / absent / already attempted — exit 0.
#
# LOAD-BEARING INVARIANT: the update pipeline backs up the old tree WITH its
# node_modules (it no longer strips it). That is the ONLY reason `mv backupDir
# APP_DIR` + `systemctl start` yields a bootable server with no network and no
# `bun install`. If that invariant ever changes, this script changes with it.
#
# JSON handling: the systemd hosts are Debian minimal — jq is NOT assumed.
# Chosen approach: a grep/sed reader over the known, machine-written key set
# (the sentinel is produced by one writer with a fixed shape, never by hand),
# plus a FULL REWRITE of the file when patching. A sed in-place patch of one
# key would silently corrupt on an unexpected layout; rewriting the whole
# object from the values just read is idempotent and self-evidently valid.
#
# Usage:
#   dedalo-code-rollback.sh [--app-dir /opt/dedalo/master_dedalo]
#     [--backup-root /opt/dedalo/backups/code] [--service dedalo-ts]
#     [--socket /run/dedalo/dedalo_ts.sock] [--check] [--no-restart]
#
# --check       exit 0 when a pending, unattempted sentinel is there (a rollback
#               would act), 1 otherwise; changes nothing (a unit's ExecCondition=).
# --no-restart  do the file work only; the caller restarts the service. The
#               installer's per-instance unit (dedalo-ts-rollback@<i>) runs this
#               script AS THE INSTANCE USER — every tree it moves and the sentinel
#               are the instance's — and only the restart as root
#               (ExecStartPost=+systemctl …). A root process never reads the
#               instance-written sentinel or moves instance-named paths.
#
# REFUSED, whoever runs it: a sentinel that is a symbolic link, a backupDir that
# is a symbolic link or lies outside the backup root (it is read from a file
# the instance writes — never trusted to name any other path).

set -euo pipefail

APP_DIR="/opt/dedalo/master_dedalo"
BACKUP_ROOT=""
SERVICE="dedalo-ts"
SOCKET="/run/dedalo/dedalo_ts.sock"
CHECK_ONLY=false
RESTART=true
while [ $# -gt 0 ]; do
	case "$1" in
		--app-dir) APP_DIR="$2"; shift 2 ;;
		--backup-root) BACKUP_ROOT="$2"; shift 2 ;;
		--service) SERVICE="$2"; shift 2 ;;
		--socket) SOCKET="$2"; shift 2 ;;
		--check) CHECK_ONLY=true; shift ;;
		--no-restart) RESTART=false; shift ;;
		*) echo "ERROR: unknown arg $1" >&2; exit 2 ;;
	esac
done

log() { echo "== rollback: $*"; }

# --- backup-root resolution: SAME precedence as the engine's readEnv --------
# 1. --backup-root  2. DEDALO_BACKUP_PATH in the process environment
# 3. DEDALO_BACKUP_PATH in <private>/.env (private dir = $DEDALO_PRIVATE_DIR,
#    default: the checkout's sibling `private/` — src/config/env.ts)
# 4. the documented default <parent of APP_DIR>/backups/code.
# The systemd units do NOT source .env, so without step 3 any install that
# relocated backups gets a script looking in the wrong place and exiting 0
# "nothing to do" — the whole contract silently inert. A wrong or unreadable
# .env degrades to the default and SAYS so; it never fails silently.
# Parser: the conservative KEY=value subset src/config/env.ts parseEnvFile
# accepts — comments ignored, one pair of surrounding quotes stripped, last
# assignment wins. No interpolation, no multiline.
resolve_backup_root() {
	if [ -n "$BACKUP_ROOT" ]; then return 0; fi
	if [ -n "${DEDALO_BACKUP_PATH:-}" ]; then
		BACKUP_ROOT="$DEDALO_BACKUP_PATH"
		return 0
	fi
	local private_dir env_file value
	private_dir="${DEDALO_PRIVATE_DIR:-$(dirname "$APP_DIR")/private}"
	env_file="$private_dir/.env"
	if [ -f "$env_file" ] && [ -r "$env_file" ]; then
		value="$(sed -n 's/^[[:space:]]*DEDALO_BACKUP_PATH[[:space:]]*=[[:space:]]*//p' "$env_file" | tail -n1)"
		value="${value%$'\r'}"
		case "$value" in
			\"*\") value="${value#\"}"; value="${value%\"}" ;;
			\'*\') value="${value#\'}"; value="${value%\'}" ;;
		esac
		if [ -n "$value" ]; then
			BACKUP_ROOT="$value"
			return 0
		fi
	elif [ -e "$env_file" ]; then
		log "WARN — $env_file exists but is unreadable; falling back to the default backup root" >&2
	fi
	BACKUP_ROOT="$(dirname "$APP_DIR")/backups/code"
}
resolve_backup_root
SENTINEL="$BACKUP_ROOT/last_code_update.json"

# --- sentinel reader (fixed machine-written shape; see header) --------------
json_str() { # json_str <key> — first string value for the key, or ''
	sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$SENTINEL" | head -n1
}
json_raw() { # json_raw <key> — first bare (non-string) value, or ''
	sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*\([a-z]*\).*/\1/p' "$SENTINEL" | head -n1
}

write_sentinel() { # write_sentinel <status> <rollback_attempted>
	# Rewrites ONLY the two keys this script owns (U-37, audit 2026-10-29): every
	# other key — installDigest, backup_waived (the durable waiver trace), and any
	# key a later engine adds — survives verbatim. The two keys are matched as
	# quoted JSON keys, and the rewrite is read back before it replaces the file.
	# ATOMIC + DURABLE (U-19): a temp file in the same directory, synced, renamed
	# over the sentinel, then the directory synced — a crash or a full disk leaves
	# the previous bytes or these, never a torn file read as "nothing to do".
	local tmp
	tmp="$SENTINEL.rollback.$$.tmp"
	sed -e 's/\("status"[[:space:]]*:[[:space:]]*\)"[^"]*"/\1"'"$1"'"/' \
		-e 's/\("rollback_attempted"[[:space:]]*:[[:space:]]*\)[a-z]*/\1'"$2"'/' \
		"$SENTINEL" > "$tmp" || { rm -f "$tmp"; return 1; }
	if [ "$(json_str_of "$tmp" status)" != "$1" ] || [ "$(json_raw_of "$tmp" rollback_attempted)" != "$2" ]; then
		rm -f "$tmp"
		echo "== rollback: RED — could not rewrite $SENTINEL (status/rollback_attempted not found); manual intervention required" >&2
		return 1
	fi
	sync_path "$tmp"
	mv -f "$tmp" "$SENTINEL"
	sync_path "$(dirname "$SENTINEL")"
}
json_str_of() { sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n1; }
json_raw_of() { sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*\([a-z]*\).*/\1/p' "$1" | head -n1; }
sync_path() { # flush one file/dir: GNU sync takes paths (the production
	# hosts); BSD/macOS sync takes none, so fsync the path itself where python3
	# exists, and only then fall back to a global sync (correct, but slow on a
	# busy disk)
	if [ "$(uname -s)" = Linux ]; then # GNU coreutils sync flushes just the path; BSD sync ignores any argument (even --version) and flushes EVERYTHING
		sync "$1" && return 0
	fi
	if command -v python3 >/dev/null 2>&1 \
		&& python3 -c 'import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY)
os.fsync(fd)' "$1" 2>/dev/null; then
		return 0
	fi
	sync
}

health_wait() { # up to 30s for /health over the unix socket (deploy.sh idiom)
	for _ in $(seq 1 30); do
		if curl -fsS --unix-socket "$SOCKET" http://localhost/health >/dev/null 2>&1; then
			return 0
		fi
		sleep 1
	done
	return 1
}

# --- the sentinel is a plain file, never a link ------------------------------
if [ -L "$SENTINEL" ]; then
	echo "== rollback: RED — $SENTINEL is a symbolic link; refusing; manual intervention required" >&2
	exit 1
fi

# --- state 4: nothing to do? ------------------------------------------------
if [ ! -f "$SENTINEL" ]; then
	$CHECK_ONLY && exit 1
	log "state 4 — no sentinel at $SENTINEL — nothing to do"
	exit 0
fi
STATUS="$(json_str status)"
ATTEMPTED="$(json_raw rollback_attempted)"
# A sentinel that exists but carries no status is TORN or foreign (U-19): it is
# never "nothing to do" — a crash mid-update is exactly when it gets torn.
if [ -z "$STATUS" ]; then
	echo "== rollback: RED — $SENTINEL exists but has no readable status (torn or foreign); manual intervention required" >&2
	exit 1
fi
if [ "$STATUS" != "pending" ]; then
	$CHECK_ONLY && exit 1
	log "state 4 — sentinel status is '$STATUS' (not pending) — nothing to do"
	exit 0
fi
if [ "$ATTEMPTED" != "false" ]; then
	$CHECK_ONLY && exit 1
	log "state 4 — rollback already attempted (rollback_attempted=$ATTEMPTED) — refusing to loop; manual intervention required" >&2
	exit 0
fi
if $CHECK_ONLY; then
	log "a pending, unattempted code update is recorded — the rollback acts"
	exit 0
fi

VERSION="$(json_str version)"
PREVIOUS_VERSION="$(json_str previousVersion)"
UPDATE_MODE="$(json_str updateMode)"
STAMP="$(json_str stamp)"
BACKUP_DIR="$(json_str backupDir)"
INSTALL_DIGEST="$(json_str installDigest)"

# --- sanity gates: refuse absurd inputs, loudly -----------------------------
if [ -z "$BACKUP_DIR" ]; then
	echo "== rollback: RED — sentinel has empty backupDir; manual intervention required" >&2
	exit 1
fi
if [ "$BACKUP_DIR" = "$APP_DIR" ]; then
	echo "== rollback: RED — backupDir equals APP_DIR ('$APP_DIR'); refusing; manual intervention required" >&2
	exit 1
fi
case "$BACKUP_DIR" in
	*/../*|*/..|*/./*) echo "== rollback: RED — backupDir '$BACKUP_DIR' is not a plain path; refusing; manual intervention required" >&2; exit 1 ;;
	"${BACKUP_ROOT%/}"/*) ;;
	*) echo "== rollback: RED — backupDir '$BACKUP_DIR' lies outside the backup root '$BACKUP_ROOT'; refusing; manual intervention required" >&2; exit 1 ;;
esac
if [ -L "$BACKUP_DIR" ]; then
	echo "== rollback: RED — backupDir '$BACKUP_DIR' is a symbolic link; refusing; manual intervention required" >&2
	exit 1
fi

# An app tree is PRESENT when it can at least name the server entrypoint —
# a bare or empty directory left by a mid-swap crash does not count.
app_present=false
if [ -f "$APP_DIR/src/server.ts" ]; then
	app_present=true
fi

if [ ! -d "$BACKUP_DIR" ]; then
	if $app_present; then
		# --- state 2: the crash happened BEFORE the first rename ------------
		# The sentinel is written pre-swap and names the backupDir the
		# pipeline INTENDED to create; it never got there, so the old tree
		# was never moved and there is nothing to restore. Mark the sentinel
		# so nothing fires on it again, and leave the tree alone.
		write_sentinel "pending" "true"
		log "state 2 — sentinel pending but backupDir '$BACKUP_DIR' was never created and $APP_DIR still holds a tree; nothing was swapped, nothing to restore — sentinel marked attempted"
		exit 0
	fi
	echo "== rollback: RED — sentinel pending, backupDir '$BACKUP_DIR' missing AND no tree at $APP_DIR — nothing restorable; manual intervention required" >&2
	exit 1
fi

# --- states 1 & 3: once-only guard FIRST, then act --------------------------
write_sentinel "pending" "true"

if $app_present; then
	log "state 3 — post-swap rollback: restoring $PREVIOUS_VERSION over failed $VERSION ($UPDATE_MODE, stamp $STAMP)"
else
	log "state 1 — crash window W1: no usable tree at $APP_DIR; restoring $PREVIOUS_VERSION from $BACKUP_DIR ($UPDATE_MODE, stamp $STAMP)"
fi

FAILED_DIR="$BACKUP_ROOT/failed_$STAMP"
if [ -e "$APP_DIR" ]; then
	mv "$APP_DIR" "$FAILED_DIR"
	log "failed tree parked at $FAILED_DIR"
fi
# The backup carries its own node_modules (see header) — this mv is the
# complete restore, no install step.
mv "$BACKUP_DIR" "$APP_DIR"
# Carry .git back from the failed tree if the backup lacks it (the pipeline
# preserves .git in the LIVE tree across swaps, so the backup may not have it).
if [ ! -e "$APP_DIR/.git" ] && [ -e "$FAILED_DIR/.git" ]; then
	mv "$FAILED_DIR/.git" "$APP_DIR/.git"
	log "carried .git back from the failed tree"
fi

write_sentinel "rolled_back" "true"

if ! $RESTART; then
	log "restored — the restart is the unit's (ExecStartPost, as root)"
	exit 0
fi

# The start limit is what fired us — clear it or `start` is refused.
systemctl reset-failed "$SERVICE" || true
systemctl start "$SERVICE"

if health_wait; then
	if [ -e "$FAILED_DIR" ]; then
		log "GREEN — previous tree ($PREVIOUS_VERSION) healthy; failed $VERSION kept at $FAILED_DIR"
	else
		log "GREEN — previous tree ($PREVIOUS_VERSION) healthy; failed $VERSION left no tree to park"
	fi
	exit 0
fi
echo "== rollback: RED — restored tree never went green on /health — manual intervention required (failed tree: $FAILED_DIR)" >&2
exit 1
