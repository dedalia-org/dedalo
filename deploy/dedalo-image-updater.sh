#!/usr/bin/env bash
#
# THE HOST IMAGE UPDATER — OPT-IN, OFF BY DEFAULT (installer unification D4,
# 2026-10-09). It carries out, on the Docker HOST, an image update that an
# administrator REQUESTED in the code-update panel.
#
#   deploy/dedalo-image-updater.sh [run] [--stack-dir DIR]     one pass (the timer's job)
#   sudo deploy/dedalo-image-updater.sh install-units [--stack-dir DIR] [--user NAME]
#   sudo deploy/dedalo-image-updater.sh uninstall-units
#   deploy/dedalo-image-updater.sh print-units [--stack-dir DIR] [--user NAME]
#
# (--unit-dir DIR and --systemctl PATH re-point the two system locations the
# unit verbs touch; they exist for the gate, which never touches the real ones.)
#
# WHY IT EXISTS. A container installation updates by replacing its IMAGE, and
# only the host can do that. The engine is NEVER given docker.sock: a socket
# that lets the engine replace its own image would let anything that subverts
# the engine run any container, as root, on the host. So the panel can only
# RECORD a request (a file in the engine's private volume, image_update/), and
# this program — installed by the operator, running on the host — acts on it.
# Not installed means not running: the panel then shows the host command to
# type (deploy/dedalo-image-update.sh --version <tag>) instead of a button.
#
# ONE PASS (`run`, every minute from the timer):
#   1. one pass at a time (a mkdir lock in the stack directory); a held lock is
#      a pass already running — this one stops quietly;
#   2. .dedalo.env says where the image comes from, or nothing happens (logged);
#   3. the engine is running, or nothing happens (the request waits);
#   4. HEARTBEAT: tells the engine "a host updater is installed" — its interval,
#      the pinned source and version — which is what turns the panel's manual
#      command into a "Request this update" button. An image older than the
#      update channel has no CLI to receive it: logged, nothing else happens;
#   5. ORPHAN: a request claimed by a pass that never finished (host reboot,
#      timeout) is recorded as failed / interrupted;
#   6. CLAIM: the pending request, if any, becomes in flight;
#   7. HOST FLOORS, checked here whatever the engine said: a UUID request id, a
#      version tag (X.Y.Z or X.Y.Z-(alpha|beta|rc).N; never -dev: Docker has no
#      nightly images, VERSIONING_SPEC §2/S3), and no downgrade against the PINNED
#      DEDALO_VERSION in release order (a prerelease before its release). A request
#      that fails one is recorded as refused and nothing runs;
#   8. `./deploy/dedalo-image-update.sh --version <tag> --request-id <id>
#      --outcome-file <tmp>` — with its backup, health check and rollback. It is
#      NEVER passed --no-backup, --skip-version-check or --ref;
#   9. the outcome that script wrote is handed to the engine untouched (the CLI
#      validates it) through a one-off `compose run` of the pinned image — so it
#      is recorded whether the engine came back, was rolled back, or is down —
#      then through `exec`, and as a last resort into this program's log.
# Every pass that reaches a decision exits 0, so the timer keeps going; only an
# internal error (a usage error, a host floor this program cannot even address)
# exits non-zero, and systemd shows it as a failed run.
#
# THREAT MODEL. What a compromised engine (or a compromised superuser account)
# CAN do through this channel: ask for a newer release or prerelease tag of
# the repository the OPERATOR configured in .dedalo.env. That request still walks
# the engine's linear-upgrade rule, this program's own floors, a mandatory
# database backup and an automatic rollback; with DEDALO_IMAGE_VERIFY=cosign only
# an image signed by Dédalo's release workflow installs. What it CANNOT do:
# choose the repository, pull or build, a flag, a git ref, or anything else that
# is executed — those come from .dedalo.env and from this file. The host never
# reads the channel files itself (their host path varies with Docker Desktop,
# rootless docker or a remote DOCKER_HOST); it talks to the engine's CLI,
# scripts/ops/image_update_channel.ts, through `docker compose exec|run` and
# accepts back only a UUID and a version tag, re-checked here.
#
# WHO RUNS IT. install-units renders units that run as the OWNER of the stack
# directory (the account that ran install.sh), which must be able to use docker:
# a build-mode update runs git in the checkout, and git run as root refuses a
# checkout another account owns (and would leave root-owned files in it). The
# checkout must not be writable by anyone you would not trust with docker — this
# program executes deploy/dedalo-image-update.sh from it.
#
# HOSTS WITHOUT SYSTEMD (a NAS, for instance) run the same pass from the stack
# owner's crontab, once a minute:
#   * * * * * cd /path/to/master_dedalo && ./deploy/dedalo-image-updater.sh >>/path/to/dedalo-image-updater.log 2>&1
#
# Gate: test/unit/image_updater_host_native.test.ts (a stub docker runs the REAL
# channel CLI; a fake update script records its argv). Operator docs:
# docs/install/docker.md (The host updater); engineering/PRODUCTION.md §12.
#
# The whole program is functions and `main "$@"; exit` on ONE line: a build-mode
# update checks out another version of this checkout — this file included —
# while the pass is still running.

set -euo pipefail

# --- settings -----------------------------------------------------------------

# The heartbeat's interval: the timer fires 60 s after the previous pass ended,
# cron every minute. The panel calls the updater alive while the last heartbeat
# is at most max(3 × interval, 180 s) old.
INTERVAL_SECONDS=60
UNIT_NAME='dedalo-image-updater'
UNIT_DIR='/etc/systemd/system'
SYSTEMCTL='systemctl'
CHANNEL_CLI='scripts/ops/image_update_channel.ts'
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
# A path systemd and bash both take literally: no whitespace, quotes, `%`
# (systemd specifiers), `$`, backslashes or anything else outside this set.
SAFE_PATH_RE='^/[A-Za-z0-9._/-]+$'
USER_RE='^[a-z_][a-z0-9_-]{0,31}$'
ENV_FILE='.dedalo.env'

VERB='run' STACK_DIR='' RUN_AS=''

say() { printf '== image-updater: %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }

usage() {
	printf 'Usage: %s [run|install-units|uninstall-units|print-units] [--stack-dir DIR] [--user NAME]\n' "$0" >&2
	printf '         [--unit-dir DIR] [--systemctl PATH]\n' >&2
	exit 2
}

# --- arguments ----------------------------------------------------------------

parse_args() {
	while [ "$#" -gt 0 ]; do
		case "$1" in
			run | install-units | uninstall-units | print-units) VERB="$1"; shift ;;
			--stack-dir | --user | --unit-dir | --systemctl)
				[ "$#" -ge 2 ] && [ -n "$2" ] || usage
				parse_value "$1" "$2"
				shift 2
				;;
			*) say "unknown argument: $1"; usage ;;
		esac
	done
}

parse_value() {
	case "$1" in
		--stack-dir) STACK_DIR="$2" ;;
		--user) RUN_AS="$2" ;;
		--unit-dir) UNIT_DIR="$2" ;;
		--systemctl) SYSTEMCTL="$2" ;;
	esac
}

# The stack directory: --stack-dir, else the checkout this file lives in.
resolve_stack_dir() {
	if [ -z "$STACK_DIR" ]; then STACK_DIR="$(dirname "$0")/.."; fi
	[ -d "$STACK_DIR" ] || die "no such stack directory: $STACK_DIR"
	STACK_DIR="$(cd "$STACK_DIR" && pwd -P)"
}

# --- the engine's CLI, through compose ----------------------------------------

dc() { dedalo_compose "$ENV_FILE" plain "$@"; }

# channel VERB — the channel CLI inside the RUNNING engine (stdin passes through).
channel() { dc exec -T dedalo bun "$CHANNEL_CLI" "$1"; }

# channel_oneoff VERB — the same CLI in a one-off container of the PINNED image,
# which needs no running engine (after a failed rollback there may be none).
channel_oneoff() { dc run --rm --no-deps -T dedalo bun "$CHANNEL_CLI" "$1"; }

engine_running() { [ -n "$(dc ps -q --status running dedalo 2>/dev/null || true)" ]; }

# --- the pinned source (.dedalo.env, through the library) ---------------------

MODE='' IMAGE='' PINNED='' VERIFY=''

read_pinned() {
	MODE="$(dedalo_env_get "$ENV_FILE" DEDALO_IMAGE_MODE)"
	IMAGE="$(dedalo_env_get "$ENV_FILE" DEDALO_IMAGE)"
	PINNED="$(dedalo_env_get "$ENV_FILE" DEDALO_VERSION)"
	VERIFY="$(dedalo_env_get "$ENV_FILE" DEDALO_IMAGE_VERIFY)"
}

# env_ready — .dedalo.env is complete and names a stack file that is here.
env_ready() {
	local problems=''
	[ -f "$ENV_FILE" ] || { say "no $ENV_FILE in $STACK_DIR — nothing to do"; return 1; }
	problems="$(dedalo_env_problems "$ENV_FILE")"
	if [ -n "$problems" ]; then
		say "$ENV_FILE does not say where the image comes from ($(printf '%s' "$problems" | tr '\n' ',' | sed 's/,$//')) — nothing to do"
		return 1
	fi
	dedalo_compose_args "$ENV_FILE" plain >/dev/null || { say "DEDALO_COMPOSE_FILE names no stack file in $STACK_DIR — nothing to do"; return 1; }
}

# --- 4. the heartbeat -----------------------------------------------------------

heartbeat_json() {
	local digest='null' found=''
	found="$(dedalo_repo_digest "$IMAGE" "$PINNED" 2>/dev/null || true)"
	if dedalo_digest_grammar "$found"; then digest="\"$found\""; fi
	# Every value passed dedalo_env_problems' grammars (no quote can reach here).
	printf '{"schema":1,"interval_seconds":%s,"mode":"%s","image":"%s","pinned":"%s","verify":"%s","running_digest":%s}\n' \
		"$INTERVAL_SECONDS" "$MODE" "$IMAGE" "$PINNED" "$VERIFY" "$digest"
}

# send_heartbeat — status 0 sent; 1 the engine has no channel CLI (an older image).
send_heartbeat() {
	local code=0
	heartbeat_json | channel heartbeat >/dev/null 2>&1 || code=$?
	case "$code" in
		0) return 0 ;;
		2) die 'the engine rejected the heartbeat as malformed — this program and the image disagree on its shape' ;;
	esac
	say "the engine did not take the heartbeat (exit $code): an image older than its update channel has no $CHANNEL_CLI — nothing to do until it is updated by hand"
	return 1
}

# --- 5–7. orphan, claim, the host floors ------------------------------------------

REQUEST_ID='' REQUEST_TAG=''

# parse_claim LINE — `<uuid> <tag>` into REQUEST_ID / REQUEST_TAG (anything after
# the first space is the tag, so a trailing word fails the tag grammar). The id
# must be a UUID, or there is nothing to address an outcome to: an internal error.
parse_claim() {
	read -r REQUEST_ID REQUEST_TAG <<<"$1" || true
	[[ "$REQUEST_ID" =~ $UUID_RE ]] || die "the engine answered a request id that is not a UUID — refusing to act on it"
}

# host_floor_refusal — the outcome detail that refuses REQUEST_TAG, or nothing.
# Docker has no nightly images (VERSIONING_SPEC §2, S3): a -dev tag is refused
# whatever DEDALO_VERSION pins, so this program never builds or pulls unreleased
# code with docker access. The nightly reaches a tree install through the code
# update path, never through this program.
host_floor_refusal() {
	local order=''
	if ! dedalo_version_grammar "$REQUEST_TAG"; then echo version_refused; return 0; fi
	if dedalo_is_dev_tag "$REQUEST_TAG"; then
		say "refusing $REQUEST_TAG: Docker has no nightly images, so there is no image to install; a Docker install runs tagged releases only"
		echo version_refused
		return 0
	fi
	order="$(dedalo_version_cmp "$REQUEST_TAG" "$PINNED")"
	if [ "$order" = '-1' ] || [ "$order" = '0' ]; then echo downgrade_refused; fi
}

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# outcome_json STATUS DETAIL — an outcome this program writes itself (an orphan,
# a floor refusal, a crash of the update script). `to` only when it is a tag.
outcome_json() {
	local to='""' at=''
	at="$(now_iso)"
	if dedalo_version_grammar "$REQUEST_TAG"; then to="\"$REQUEST_TAG\""; fi
	printf '{"schema":1,"request_id":"%s","from":"%s","to":%s,"mode":"%s","image":"%s","status":"%s","detail":"%s","backup":null,"digest":null,"started_at":"%s","finished_at":"%s"}\n' \
		"$REQUEST_ID" "$PINNED" "$to" "$MODE" "$IMAGE" "$1" "$2" "$at" "$at"
}

# record_outcome FILE — hand the outcome to the engine: a one-off container of
# the pinned image, then the running engine, then (last resort) this log.
record_outcome() {
	local file="$1"
	if channel_oneoff outcome <"$file" >/dev/null 2>&1; then return 0; fi
	if channel outcome <"$file" >/dev/null 2>&1; then return 0; fi
	say "could not record the outcome in the engine — here it is: $(tr -d '\n' <"$file")"
}

# record_own STATUS DETAIL — record an outcome this program composed.
record_own() {
	local tmp=''
	tmp="$(mktemp "${TMPDIR:-/tmp}/dedalo-image-outcome.XXXXXX")"
	outcome_json "$1" "$2" >"$tmp"
	record_outcome "$tmp"
	rm -f "$tmp"
}

# record_orphan — a request in flight that no pass finished: failed / interrupted.
record_orphan() {
	local line=''
	line="$(channel orphan 2>/dev/null)" || return 0
	[ -n "$line" ] || return 0
	parse_claim "$line"
	say "request $REQUEST_ID ($REQUEST_TAG) was claimed by a pass that never finished — recorded as interrupted"
	record_own failed interrupted
}

# --- 8. the update ----------------------------------------------------------------

# run_update — the update script with exactly three flags; its outcome recorded.
run_update() {
	local tmp='' code=0
	tmp="$(mktemp "${TMPDIR:-/tmp}/dedalo-image-outcome.XXXXXX")"
	say "request $REQUEST_ID: updating to $REQUEST_TAG ($MODE, $IMAGE)"
	./deploy/dedalo-image-update.sh --version "$REQUEST_TAG" --request-id "$REQUEST_ID" --outcome-file "$tmp" || code=$?
	if [ -s "$tmp" ]; then
		record_outcome "$tmp"
	else
		say "the update script ended (exit $code) without an outcome — recorded as interrupted"
		record_own failed interrupted
	fi
	rm -f "$tmp"
	say "request $REQUEST_ID: the update script exited $code"
}

# --- run ------------------------------------------------------------------------

# pass — steps 2–9, after the lock is held.
pass() {
	local line='' refusal=''
	env_ready || return 0
	read_pinned
	engine_running || { say 'the dedalo service is not running — nothing to do'; return 0; }
	send_heartbeat || return 0
	record_orphan
	line="$(channel claim 2>/dev/null)" || { say 'the engine could not answer claim — nothing to do'; return 0; }
	[ -n "$line" ] || return 0
	parse_claim "$line"
	refusal="$(host_floor_refusal)"
	if [ -n "$refusal" ]; then
		say "request $REQUEST_ID asks for '$REQUEST_TAG' over the pinned $PINNED — refused ($refusal)"
		record_own refused "$refusal"
		return 0
	fi
	run_update
	read_pinned
	send_heartbeat || true
}

run_pass() {
	cd "$STACK_DIR"
	# shellcheck source=deploy/dedalo-image-lib.sh
	. deploy/dedalo-image-lib.sh
	dedalo_registries_load deploy/image_registries.sh || say 'deploy/image_registries.sh is missing — the update script will say so too'
	dedalo_env_isolate
	if ! dedalo_lock_acquire "$STACK_DIR" "$UNIT_NAME"; then
		say "a pass is already running (lock: $STACK_DIR/.$UNIT_NAME.lock)"
		return 0
	fi
	trap 'dedalo_lock_release "$STACK_DIR" "$UNIT_NAME"' EXIT
	pass
}

# --- the systemd units --------------------------------------------------------------

# owner_of DIR — the NAME of the account owning DIR. The owner is read as a
# numeric uid (`ls -ldn` prints it the same on GNU and BSD) and named by
# `id -un` — the same probe the root and docker-group checks use — so an owner
# with no account on this host (a bare uid, no passwd entry) is refused by name
# instead of reaching the unit as a number nobody chose.
owner_of() {
	local uid=''
	# shellcheck disable=SC2012 # one directory's owner, not a listing to parse
	uid="$(ls -ldn "$1" | awk '{print $3}')"
	id -un "$uid" 2>/dev/null ||
		die "the owner of $1 (uid $uid) has no account name on this host — name the account the units run as with --user"
}

# check_unit_inputs — the stack path and the account are safe to write into a unit.
check_unit_inputs() {
	[[ "$STACK_DIR" =~ $SAFE_PATH_RE ]] ||
		die "refusing a stack path with whitespace, quotes or other special characters: '$STACK_DIR' — move the checkout to a plain path"
	if [ -z "$RUN_AS" ]; then RUN_AS="$(owner_of "$STACK_DIR")" || exit 1; fi
	[[ "$RUN_AS" =~ $USER_RE ]] || die "refusing the account name '$RUN_AS'"
}

render_service() {
	cat <<UNIT
# Generated by deploy/dedalo-image-updater.sh install-units — re-run it to change.
[Unit]
Description=Dédalo image updater (acts on an update requested in the code-update panel)
Documentation=file://$STACK_DIR/docs/install/docker.md
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=$RUN_AS
WorkingDirectory=$STACK_DIR
ExecStart=/bin/bash $STACK_DIR/deploy/dedalo-image-updater.sh --stack-dir $STACK_DIR
TimeoutStartSec=2h
NoNewPrivileges=yes
PrivateTmp=yes
UNIT
}

render_timer() {
	cat <<UNIT
# Generated by deploy/dedalo-image-updater.sh install-units — re-run it to change.
[Unit]
Description=Run the Dédalo image updater every minute

[Timer]
OnBootSec=2min
OnUnitInactiveSec=60s
AccuracySec=10s

[Install]
WantedBy=timers.target
UNIT
}

print_units() {
	resolve_stack_dir
	check_unit_inputs
	printf '### %s/%s.service\n' "$UNIT_DIR" "$UNIT_NAME"
	render_service
	printf '\n### %s/%s.timer\n' "$UNIT_DIR" "$UNIT_NAME"
	render_timer
}

# require_systemd — root, a systemctl, and the unit directory.
require_systemd() {
	[ "$(id -u)" = '0' ] || die 'install-units and uninstall-units need root (sudo)'
	command -v "$SYSTEMCTL" >/dev/null 2>&1 || die "no $SYSTEMCTL here — this host has no systemd; run the pass from cron instead (see the header of this file)"
	[ -d "$UNIT_DIR" ] || die "no unit directory $UNIT_DIR — this host has no systemd"
}

# require_docker_account — the unit's account can reach docker.
require_docker_account() {
	[ "$RUN_AS" = 'root' ] && return 0
	id -nG "$RUN_AS" 2>/dev/null | tr ' ' '\n' | grep -qx docker ||
		die "$RUN_AS (the owner of $STACK_DIR) is not in the docker group — add it, or name another account with --user"
}

# write_unit NAME RENDERER — atomically, 0644.
write_unit() {
	local tmp=''
	tmp="$(mktemp "$UNIT_DIR/.$1.XXXXXX")"
	"$2" >"$tmp"
	chmod 0644 "$tmp"
	mv -f "$tmp" "$UNIT_DIR/$1"
}

install_units() {
	resolve_stack_dir
	check_unit_inputs
	require_systemd
	require_docker_account
	[ -f "$STACK_DIR/$ENV_FILE" ] || die "no $ENV_FILE in $STACK_DIR — install with ./install.sh first (or write it as docs/install/docker.md says)"
	write_unit "$UNIT_NAME.service" render_service
	write_unit "$UNIT_NAME.timer" render_timer
	"$SYSTEMCTL" daemon-reload
	"$SYSTEMCTL" enable --now "$UNIT_NAME.timer"
	say "installed: $UNIT_DIR/$UNIT_NAME.{service,timer}, running as $RUN_AS over $STACK_DIR"
	say "the panel shows the host updater as alive after its first pass (within about two minutes)"
}

uninstall_units() {
	require_systemd
	"$SYSTEMCTL" disable --now "$UNIT_NAME.timer" || say "the timer was not enabled"
	rm -f "$UNIT_DIR/$UNIT_NAME.service" "$UNIT_DIR/$UNIT_NAME.timer"
	"$SYSTEMCTL" daemon-reload
	say 'removed. The panel shows the host updater as stale from now on and offers the manual command again.'
}

# --- main -------------------------------------------------------------------------

main() {
	parse_args "$@"
	case "$VERB" in
		run) resolve_stack_dir; run_pass ;;
		install-units) install_units ;;
		uninstall-units) uninstall_units ;;
		print-units) print_units ;;
	esac
}

main "$@"; exit
