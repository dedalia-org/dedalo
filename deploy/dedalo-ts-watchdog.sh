#!/usr/bin/env bash
#
# WATCHDOG PROBE — curl /health over the unix socket; on red, choose the
# remedy: if a PENDING, UNCONFIRMED code update exists (the sentinel at
# <backup root>/last_code_update.json — see deploy/dedalo-code-rollback.sh for
# the contract), the new tree booted dead → start the ROLLBACK unit; otherwise
# it is an ordinary hang/death → today's dedalo-ts-restart.service.
#
# INSTALLED OUT OF TREE, like the rollback script: the shipped copy lives at
# <repo>/deploy/, the installed copy at /opt/dedalo/bin/dedalo-ts-watchdog.sh
# (the units point there). The watchdog must stay runnable while the app tree
# is mid-swap or gone. Refresh after updating (PRODUCTION.md §12):
#   sudo install -m 0755 deploy/dedalo-ts-watchdog.sh /opt/dedalo/bin/
#
# Invoked by dedalo-ts-watchdog.service every 30 s (via the .timer). A GREEN
# probe exits 0 and touches nothing. A RED probe exits non-zero AFTER starting
# the chosen remedy unit, so the journal keeps the failure visible.
#
# Usage:
#   dedalo-ts-watchdog.sh [--socket /run/dedalo/dedalo_ts.sock]
#     [--app-dir /opt/dedalo/master_dedalo] [--backup-root <dir>]
#     [--restart-unit dedalo-ts-restart.service]
#     [--rollback-unit dedalo-ts-rollback.service]
#
# The two unit names default to the single-instance units. A templated
# multi-instance host (docs/install/multi_instance.md) passes its own,
# e.g. --restart-unit dedalo-ts-restart@site1.service.
#
# BOOT GRACE (--service <unit> --grace <seconds>; finding F3, campaign 2 L7):
# boot migrations and the search-store backfill run BEFORE the server binds
# its socket, and can take minutes. A probe in that window sees no socket and
# restarts a healthy boot — mid-migration, every 30 s, until the start limit
# fails the unit. So while <unit> is `activating`, or has been active for less
# than <seconds>, a red probe is SKIPPED (exit 0, said in the journal). A boot
# marker the engine may write, /run/<runtime dir>/booting holding its pid,
# extends the skip while that pid lives (bounded by the grace times four).
# Without --service the probe behaves as before (no grace). --uptime-file
# (default /proc/uptime) is the clock the age is measured on — systemd's
# ActiveEnterTimestampMonotonic counts from boot in microseconds, as it does.

set -euo pipefail

SOCKET="/run/dedalo/dedalo_ts.sock"
APP_DIR="/opt/dedalo/master_dedalo"
BACKUP_ROOT=""
RESTART_UNIT="dedalo-ts-restart.service"
ROLLBACK_UNIT="dedalo-ts-rollback.service"
SERVICE=""
GRACE=0
UPTIME_FILE="/proc/uptime"
while [ $# -gt 0 ]; do
	case "$1" in
		--socket) SOCKET="$2"; shift 2 ;;
		--app-dir) APP_DIR="$2"; shift 2 ;;
		--backup-root) BACKUP_ROOT="$2"; shift 2 ;;
		--restart-unit) RESTART_UNIT="$2"; shift 2 ;;
		--rollback-unit) ROLLBACK_UNIT="$2"; shift 2 ;;
		--service) SERVICE="$2"; shift 2 ;;
		--grace) GRACE="$2"; shift 2 ;;
		--uptime-file) UPTIME_FILE="$2"; shift 2 ;;
		*) echo "ERROR: unknown arg $1" >&2; exit 2 ;;
	esac
done

# --- backup-root resolution: SAME precedence as the engine's readEnv --------
# (identical chain to deploy/dedalo-code-rollback.sh — keep the two in step):
# 1. --backup-root  2. DEDALO_BACKUP_PATH in the process environment
# 3. DEDALO_BACKUP_PATH in <private>/.env ($DEDALO_PRIVATE_DIR, default the
#    checkout's sibling `private/`)  4. <parent of APP_DIR>/backups/code.
# Without step 3 a relocated-backups install has the watchdog looking at a
# sentinel that is not there and RESTARTING broken swapped-in code forever
# instead of rolling it back. Unreadable .env → default, said out loud.
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
		echo "== watchdog: WARN — $env_file exists but is unreadable; falling back to the default backup root" >&2
	fi
	BACKUP_ROOT="$(dirname "$APP_DIR")/backups/code"
}
resolve_backup_root
SENTINEL="$BACKUP_ROOT/last_code_update.json"

# --fail-with-body: non-2xx is red (exit 22) and the BODY is still kept — a
# red /health may carry a boot fact (below) that no restart can fix (curl
# >= 7.76). --max-time bounds a hung server.
if HEALTH_BODY="$(curl --fail-with-body --silent --show-error --max-time 10 \
	--unix-socket "$SOCKET" http://localhost/health)"; then
	exit 0
fi

# Red — but a server still BOOTING is not dead (see BOOT GRACE above).
in_boot_grace() {
	[ -n "$SERVICE" ] || return 1
	case "$GRACE" in ''|*[!0-9]*) return 1 ;; esac
	local state entered now_us age marker pid
	state="$(systemctl show -p ActiveState --value "$SERVICE" 2>/dev/null || true)"
	[ "$state" = "activating" ] && return 0
	entered="$(systemctl show -p ActiveEnterTimestampMonotonic --value "$SERVICE" 2>/dev/null || echo 0)"
	now_us="$(awk '{printf "%d", $1 * 1000000}' "$UPTIME_FILE" 2>/dev/null || echo 0)"
	case "$entered" in ''|*[!0-9]*) entered=0 ;; esac
	case "$now_us" in ''|*[!0-9]*) now_us=0 ;; esac
	# An age is KNOWN only with both clocks read and the entry in the past —
	# an unreadable clock must never read as "young" (that would skip forever).
	[ "$now_us" -gt 0 ] && [ "$entered" -gt 0 ] && [ "$entered" -le "$now_us" ] || return 1
	age=$(( (now_us - entered) / 1000000 ))
	[ "$age" -lt "$GRACE" ] && return 0
	marker="$(dirname "$SOCKET")/booting"
	if [ -f "$marker" ] && [ "$age" -lt $(( GRACE * 4 )) ]; then
		pid="$(head -n1 "$marker" 2>/dev/null || true)"
		case "$pid" in ''|*[!0-9]*) return 1 ;; esac
		kill -0 "$pid" 2>/dev/null && return 0
	fi
	return 1
}
if in_boot_grace; then
	echo "== watchdog: /health not answering, but $SERVICE is still booting (within the ${GRACE}s grace) — skipped" >&2
	exit 0
fi

# Red — but a server that REFUSED to start (exit 78, EX_CONFIG: not installed,
# configuration missing, install unfinished — src/config/install_state.ts) is
# not a crash: restarting re-reads the same missing configuration. The units
# carry RestartPreventExitStatus=78; without this check the restart unit below
# would override that every 30 s. Each property is read in its OWN call:
# `systemctl show -p A -p B --value` prints in systemd's order, not ours.
refused_not_installed() {
	[ -n "$SERVICE" ] || return 1
	local result status
	result="$(systemctl show -p Result --value "$SERVICE" 2>/dev/null || true)"
	status="$(systemctl show -p ExecMainStatus --value "$SERVICE" 2>/dev/null || true)"
	[ "$result" = "exit-code" ] && [ "$status" = "78" ]
}
if refused_not_installed; then
	echo "== watchdog: $SERVICE refused to start (exit 78: not installed / configuration missing) — not restarting; see its journal" >&2
	exit 0
fi

# Red. A pending, unconfirmed update means the freshly swapped tree is the
# suspect — restarting it would only re-run the same broken code. (A boot whose
# migration failed WITHOUT moving the schema leaves the sentinel pending, so it
# is rolled back here; one that moved the schema wrote needs_restore before it
# listened — src/core/update/boot_confirm.ts — and is not pending.)
if [ -f "$SENTINEL" ] \
	&& grep -q '"status"[[:space:]]*:[[:space:]]*"pending"' "$SENTINEL" \
	&& grep -q '"rollback_attempted"[[:space:]]*:[[:space:]]*false' "$SENTINEL"; then
	echo "== watchdog: /health RED with a pending unconfirmed code update — starting rollback" >&2
	systemctl start "$ROLLBACK_UNIT"
	exit 1
fi

# Red because of a BOOT FACT (update audit 2026-10-29, U-01/U-04; owner rule
# D-2): this boot's schema migration failed, or the database's data version is
# AHEAD of the code (older code over a newer database). The server answers;
# a restart re-reads the same database and a rollback (old code on a moved
# schema) makes it worse. A human restores a compatible backup or fixes
# forward — the watchdog only says so, every tick, and never loops a restart.
if printf '%s' "$HEALTH_BODY" | grep -q '"boot_schema"[[:space:]]*:[[:space:]]*"failed"' \
	|| printf '%s' "$HEALTH_BODY" | grep -q '"data_version"[[:space:]]*:[[:space:]]*{[^}]*"state"[[:space:]]*:[[:space:]]*"ahead"'; then
	echo "== watchdog: /health RED on a boot fact (failed boot migration or data version ahead of code) — the server NEEDS A HUMAN: no rollback, no restart; see its journal and $SENTINEL" >&2
	exit 1
fi

echo "== watchdog: /health RED — restarting the server" >&2
systemctl start "$RESTART_UNIT"
exit 1
