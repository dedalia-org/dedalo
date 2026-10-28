#!/usr/bin/env bash
#
# IMAGE UPDATE — the code update of a Docker installation: replace the IMAGE,
# with a database backup before, a health check after, and an automatic rollback
# (the container sibling of the tree-swap pipeline in src/core/update/code_update.ts).
#
# WHY AN IMAGE SWAP, NOT A TREE SWAP. In the shipped stacks the code tree lives
# INSIDE the image; only /private, the media tree, the client and the socket are
# volumes. A tree swap inside the container would land in its writable layer and
# be DISCARDED at the next recreation — so an image install updates by replacing
# the image, and rolls back by re-pinning the previous one. That is atomic and
# complete: the old image is bit-identical to what ran before, dependencies
# included. The engine refuses the in-container swap and points here.
#
# Usage (from anywhere; it works in the stack directory — this checkout):
#   ./deploy/dedalo-image-update.sh --version <X.Y.Z | X.Y.Z-(alpha|beta|rc).N>
#       [--env-file .dedalo.env] [--outcome-file FILE] [--request-id UUID]
#       [--no-backup] [--health-timeout SECONDS (default 900)]
#       [--skip-version-check] [--ref <git ref> (build mode, a prerelease version)]
#       [--check]
#
# --check is a DRY RUN: it runs only the read-only steps below (2-4 and the image
# check of 7), so it reports whether a real run would be accepted. It takes no lock
# (step 1), no backup, no rollback tag and changes no file (.dedalo.env included). No container
# is started, stopped, recreated or written: the one container contact is step 4's
# read-only question to the running engine (`exec … check-target`), because only the
# engine itself can walk the version exactly as a real run does. No layer is pulled:
# the image is checked by its manifest, and when DEDALO_IMAGE_VERIFY=cosign its
# signature and the version label of EVERY platform are read from the registry.
# Accepted: `check: would update <from> -> <to>` and exit 0. Refused: the same refusal
# and non-zero exit a real run gives, and no outcome file is written. In build mode
# the release is judged on a clean export of its ref (git archive, the bytes the
# builder snapshots): the same local-changes and release-identity refusals, while the
# checkout, its HEAD and the working tree stay where they are (no fetch, no build).
#
# A VERSION IS AN IMAGE TAG, and names a RELEASE IDENTITY (deploy/dedalo-image-lib.sh
# — the twin of src/core/update/release_identity.ts): X.Y.Z a release,
# X.Y.Z-beta.N (alpha, beta, rc) a prerelease of it. A -dev identity is no image
# (VERSIONING_SPEC §2, S3): a -dev version is refused here, in every mode.
# They order as semver does — 7.0.0-beta.6 < 7.0.0-beta.7 < 7.0.0-rc.1 < 7.0.0.
#
# EVERYTHING ELSE COMES FROM .dedalo.env (parsed through deploy/dedalo-image-lib.sh):
# the stack (DEDALO_COMPOSE_FILE), the repository (DEDALO_IMAGE), the pinned
# version (DEDALO_VERSION), pull or build (DEDALO_IMAGE_MODE) and whether a pull
# must carry Dédalo's signature (DEDALO_IMAGE_VERIFY). The retired flags --mode,
# --image and --tag (and DEDALO_IMAGE_UPDATE_MODE) let one run pull from a
# repository the installation never chose; now the source is the operator's
# recorded answer and nothing else.
#
# THE STEPS, in order — each refuses before the next one changes anything:
#    1. one run at a time (a mkdir lock in the stack directory);
#    2. .dedalo.env is complete, or the exact lines to add are printed (the
#       adoption path of an installation that predates the image pin);
#    3. the version is a release or prerelease (never -dev) and moves FORWARD in
#       release order; a refusal WITHIN one data version (X.Y.Z) — a step back
#       that crosses no migration — is waived by --skip-version-check, which the
#       first update of a stack BUILT from a beta before 7.0.0-beta.7 needs (it is
#       pinned at the bare X.Y.Z although it runs the beta: owner Q4); a step back
#       to an older data version is never waived;
#    4. the RUNNING engine walks the version (scripts/ops/image_update_channel.ts
#       check-target: exit 0 ok, 3 refused + reason, anything else unavailable —
#       refused unless --skip-version-check, which the first update from an image
#       that predates that program needs); an engine blind to prereleases (it
#       cannot read the tag, or sees rc.1 → X.Y.Z as X.Y.Z → X.Y.Z) is asked about
#       the DATA walk instead, X.Y.Z-dev (engine_blind_to_identity);
#    5. a verified database dump through the stack's `backup` service, unless
#       --no-backup (a waiver the operator types, never the default);
#    6. the running image is tagged <DEDALO_IMAGE>:rollback-<UTC stamp>;
#    7. the new image: `docker pull` (+ `cosign verify` of its digest when
#       DEDALO_IMAGE_VERIFY=cosign), or the release checked out and built here
#       from a CLEAN SNAPSHOT of that commit — the installer's own builder,
#       dedalo_image_build (git archive → docker build → snapshot removed): no
#       uncommitted or untracked file in the image; the commit checked out must
#       BE the version asked for (its release identity — a release or prerelease
#       is its exact annotated tag v<version>, a -dev build any commit of that
#       data version), or it is refused before anything is built; a tree without
#       git is refused (nothing to check out or snapshot);
#    8. DEDALO_VERSION is re-pinned (the ONE key this script writes);
#    9. `up -d dedalo backup` — postgres and nginx are never touched;
#   10. the compose healthcheck: `healthy` is green; `starting` AND `unhealthy` keep
#       waiting until --health-timeout (boot migrations run BEFORE the socket binds,
#       so /health is red through them and Docker flips the state to `unhealthy`
#       ~2 min in — a state it recovers from on the first green probe); red is the
#       deadline, or the engine process restarting (a crash is not a slow boot);
#   11. green keeps only the newest rollback tag; red re-tags the rollback image
#       as the old version, re-pins it (re-checks out the old ref in build mode),
#       brings it back and waits again;
#   12. --outcome-file receives ONE JSON object; exit 0 only on green.
#
# THE OUTCOME (one object, every value from a closed set or a checked grammar —
# no quote or backslash can reach it; read by scripts/ops/image_update_channel.ts):
#   {"schema":1,"request_id":uuid|null,"from":"<tag>","to":"<tag>","mode":"pull"|"build"|null,
#    "image":"<repository>","status":"green"|"rolled_back"|"rollback_failed"|"refused"|"failed",
#    "detail":"healthy"|"health_timeout"|"unhealthy"|"pull_failed"|"verify_failed"|
#             "build_failed"|"backup_failed"|"version_refused"|"same_version"|
#             "downgrade_refused"|"not_running"|"env_incomplete"|"locked",
#    "backup":"/backups/db/…"|null,"digest":"sha256:…"|null,"started_at":ISO,"finished_at":ISO}
# `refused` changed nothing; `failed` tried and left the running stack as it was.
# A usage error (exit 2) writes no outcome.
#
# THREAT NOTE. The host decides the repository, the mode and every flag; a caller
# chooses only a version, and that version still has to walk forward, survive the
# engine's check, the backup and the health check. The engine never gets docker.
#
# The whole program is functions and `main "$@"; exit` on ONE line: bash reads a
# script as it runs, and build mode checks out another version of THIS file.

set -euo pipefail

# --- output -------------------------------------------------------------------

say() { printf '== image-update: %s\n' "$*" >&2; }

usage() {
	printf 'Usage: %s --version <X.Y.Z|X.Y.Z-(alpha|beta|rc).N> [--env-file F] [--outcome-file F] [--request-id UUID]\n' "$0" >&2
	printf '         [--no-backup] [--health-timeout SECONDS] [--skip-version-check] [--ref <git ref>] [--check]\n' >&2
	exit 2
}

# --- arguments ----------------------------------------------------------------

TARGET='' ENV_FILE='.dedalo.env' OUTCOME_FILE='' REQUEST_ID='' NO_BACKUP='false'
HEALTH_TIMEOUT='900' SKIP_VERSION_CHECK='false' GIT_REF='' CHECK_ONLY='false'
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
GIT_REF_RE='^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,199}$'

parse_args() {
	while [ "$#" -gt 0 ]; do
		case "$1" in
			--version | --env-file | --outcome-file | --request-id | --health-timeout | --ref)
				[ "$#" -ge 2 ] || usage
				parse_value "$1" "$2"
				shift 2
				;;
			--no-backup) NO_BACKUP='true'; shift ;;
			--skip-version-check) SKIP_VERSION_CHECK='true'; shift ;;
			--check) CHECK_ONLY='true'; shift ;;
			*) say "unknown argument: $1"; usage ;;
		esac
	done
	check_args
}

parse_value() {
	case "$1" in
		--version) TARGET="$2" ;;
		--env-file) ENV_FILE="$2" ;;
		--outcome-file) OUTCOME_FILE="$2" ;;
		--request-id) REQUEST_ID="$2" ;;
		--health-timeout) HEALTH_TIMEOUT="$2" ;;
		--ref) GIT_REF="$2" ;;
	esac
}

check_args() {
	[ -n "$TARGET" ] || usage
	if [ -n "$REQUEST_ID" ] && ! [[ "$REQUEST_ID" =~ $UUID_RE ]]; then say 'the request id is not a UUID'; usage; fi
	if ! [[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]{0,5}$ ]]; then say 'the health timeout is a number of seconds'; usage; fi
	if [ -n "$GIT_REF" ] && ! [[ "$GIT_REF" =~ $GIT_REF_RE ]]; then say 'that is not a git ref'; usage; fi
	ENV_FILE="$(absolute_path "$ENV_FILE")"
	if [ -n "$OUTCOME_FILE" ]; then OUTCOME_FILE="$(absolute_path "$OUTCOME_FILE")"; fi
}

# Relative paths are the CALLER's, resolved before the script moves to the stack.
absolute_path() {
	case "$1" in
		/*) printf '%s' "$1" ;;
		*) printf '%s/%s' "$(pwd)" "$1" ;;
	esac
}

# --- the outcome ----------------------------------------------------------------

STARTED_AT='' FROM='' MODE='' IMAGE='' VERIFY='' BACKUP_PATH='' DIGEST='' STAMP=''
ROLLBACK_REF='' PREV_HEAD='' PREV_BRANCH=''
ISO_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
BACKUP_PATH_RE='^/[A-Za-z0-9._/+:-]+$'

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# json_value VALUE CHECK FALLBACK — "VALUE" when the CHECK function accepts it,
# else FALLBACK (null, or ""): nothing outside a checked grammar is ever written.
json_value() {
	if [ -n "$1" ] && "$2" "$1"; then printf '"%s"' "$1"; else printf '%s' "$3"; fi
}

uuid_grammar() { [[ "$1" =~ $UUID_RE ]]; }
mode_grammar() { [ "$1" = 'pull' ] || [ "$1" = 'build' ]; }
iso_grammar() { [[ "$1" =~ $ISO_RE ]]; }
backup_path_grammar() { [[ "$1" =~ $BACKUP_PATH_RE ]]; }

outcome_json() {
	local status="$1" detail="$2"
	printf '{"schema":1,"request_id":%s,"from":%s,"to":%s,"mode":%s,"image":%s,' \
		"$(json_value "$REQUEST_ID" uuid_grammar null)" \
		"$(json_value "$FROM" dedalo_version_grammar '""')" \
		"$(json_value "$TARGET" dedalo_version_grammar '""')" \
		"$(json_value "$MODE" mode_grammar null)" \
		"$(json_value "$IMAGE" dedalo_repository_grammar '""')"
	printf '"status":"%s","detail":"%s","backup":%s,"digest":%s,"started_at":%s,"finished_at":%s}\n' \
		"$status" "$detail" \
		"$(json_value "$BACKUP_PATH" backup_path_grammar null)" \
		"$(json_value "$DIGEST" dedalo_digest_grammar null)" \
		"$(json_value "$STARTED_AT" iso_grammar null)" \
		"$(json_value "$(now_iso)" iso_grammar null)"
}

write_outcome() {
	local tmp=''
	[ -n "$OUTCOME_FILE" ] || return 0
	tmp="$(mktemp "$(dirname "$OUTCOME_FILE")/.image-update-outcome.XXXXXX")" &&
		outcome_json "$1" "$2" >"$tmp" && mv -f "$tmp" "$OUTCOME_FILE" ||
		say "could not write the outcome to $OUTCOME_FILE"
}

# finish STATUS DETAIL [message] — write the outcome, print the verdict, exit.
finish() {
	local status="$1" detail="$2" verdict=''
	if [ -n "${3-}" ]; then say "$3"; fi
	# A dry run writes no outcome: nothing was run, so there is no outcome to report.
	if [ "$CHECK_ONLY" != 'true' ]; then write_outcome "$status" "$detail"; fi
	verdict="$(printf '%s' "$status" | tr '[:lower:]_' '[:upper:] ')"
	say "$verdict ($detail): ${FROM:-?} -> $TARGET${IMAGE:+ ($IMAGE)}"
	if [ "$status" = 'green' ]; then exit 0; fi
	exit 1
}

# --- compose --------------------------------------------------------------------

dc() { dedalo_compose "$ENV_FILE" plain "$@"; }

running_container() { dc ps -q "$1" 2>/dev/null | head -n 1 || true; }

# --- 2. the env file ------------------------------------------------------------

read_env() {
	MODE="$(dedalo_env_get "$ENV_FILE" DEDALO_IMAGE_MODE)"
	IMAGE="$(dedalo_env_get "$ENV_FILE" DEDALO_IMAGE)"
	FROM="$(dedalo_env_get "$ENV_FILE" DEDALO_VERSION)"
	VERIFY="$(dedalo_env_get "$ENV_FILE" DEDALO_IMAGE_VERIFY)"
}

check_env() {
	local problems='' key='' why=''
	[ -f "$ENV_FILE" ] || finish refused env_incomplete "no $ENV_FILE here — run this from the stack directory, or name it with --env-file"
	problems="$(dedalo_env_problems "$ENV_FILE")"
	if [ -z "$problems" ] && ! [ -f "$(dedalo_env_get "$ENV_FILE" DEDALO_COMPOSE_FILE)" ]; then
		problems='DEDALO_COMPOSE_FILE names a file that is not in this directory'
	fi
	[ -n "$problems" ] || return 0
	say "$ENV_FILE does not say where this installation's image comes from:"
	while read -r key why; do
		say "  $key is $why"
	done <<<"$problems"
	# The lines to paste: bare KEY=value, no indentation, no inline comment — exactly
	# the shape both readers of the file (compose and this script) agree on.
	say 'Add (or correct) these lines in it:'
	while read -r key why; do
		printf '%s=%s\n' "$key" "$(suggested_value "$key")" >&2
	done <<<"$problems"
	say 'A local build (the values above) is right for an installation that built its image here; to pull, see docs/install/docker.md.'
	finish refused env_incomplete
}

suggested_value() {
	case "$1" in
		DEDALO_COMPOSE_FILE) echo 'docker-compose.simple.yml' ;;
		DEDALO_IMAGE) echo 'localhost/dedalo' ;;
		# the image tag of this checkout's own release identity (7.0.0-beta.7, 7.0.0-dev):
		# what a build here is tagged and labelled — never the bare data version (C3i-F1)
		DEDALO_VERSION) checkout_image_tag || echo '<the release or prerelease this installation runs>' ;;
		DEDALO_IMAGE_MODE) echo 'build' ;;
		DEDALO_IMAGE_VERIFY) echo 'none' ;;
	esac
}

# checkout_image_tag — the image tag of this checkout's identity, or status 1 when the
# identity is a -dev build (no image is ever named by one: VERSIONING_SPEC §2).
checkout_image_tag() {
	local identity=''
	identity="$(dedalo_release_identity .)" || return 1
	dedalo_is_dev_tag "$identity" && return 1
	dedalo_image_tag_of "$identity"
}

# --- 3. the version -------------------------------------------------------------

check_version() {
	local order='' why='' hint=''
	dedalo_version_grammar "$TARGET" ||
		finish refused version_refused "'$TARGET' is not a version (X.Y.Z or X.Y.Z-alpha.N / -beta.N / -rc.N)"
	# Docker has no nightly images: a -dev version is refused whatever the pin (VERSIONING_SPEC S3).
	if dedalo_is_dev_tag "$TARGET"; then
		finish refused version_refused "Docker has no nightly images: $TARGET is a development build, so there is no image to install. Nightlies reach tree installs through the code update path (tree archives); a Docker install runs tagged releases only"
	fi
	# --ref names the commit of a prerelease built under another name (owner Q3); a
	# release is built from its own tag only.
	if [ -n "$GIT_REF" ] && { [ "$MODE" != 'build' ] || ! dedalo_is_prerelease_tag "$TARGET"; }; then
		finish refused version_refused '--ref names what to build: build mode, and a prerelease version only (a release is built from its own tag)'
	fi
	order="$(dedalo_version_cmp "$TARGET" "$FROM")"
	case "$order" in
		-1) why="$TARGET comes before the pinned $FROM" ;;
		0) why="$TARGET is the pinned version" ;;
	esac
	[ -n "$why" ] || return 0
	# Back to an older DATA version: never — its migrations ran on this database.
	if [ "$(dedalo_version_triple "$TARGET")" != "$(dedalo_version_triple "$FROM")" ]; then
		finish refused downgrade_refused "$why"
	fi
	# Within ONE data version no migration separates the two, so the operator may
	# waive the order — and one installation must (owner Q4): a stack BUILT from a
	# beta before 7.0.0-beta.7 is pinned at the bare X.Y.Z while it runs that beta,
	# so its first prerelease update reads as a step back.
	if [ "$SKIP_VERSION_CHECK" = 'true' ]; then
		say "$why — waived (--skip-version-check: same data version $(dedalo_version_triple "$FROM"), no migration between them)"
		return 0
	fi
	# The hint is for a stack pinned at a BARE X.Y.Z (a beta built before beta.7). A
	# pin that already names a prerelease or -dev is not that stack: no hint for it.
	hint=''
	# The same release asked for again is its own outcome: nothing steps back,
	# so there is no skip hint — the hint below is for a step back only.
	if [ "$order" = '0' ]; then finish refused same_version "$why"; fi
	case "$FROM" in
		*-*) ;;
		*) hint=". A stack built from a beta before 7.0.0-beta.7 is pinned at the bare $(dedalo_version_triple "$FROM") although it runs that beta: if this is one, re-run ONCE with --skip-version-check (it waives this order within the data version $(dedalo_version_triple "$FROM") only — never a step back to an older one; docs/install/docker.md)" ;;
	esac
	finish refused downgrade_refused "$why$hint"
}

# --- 4. the engine's own walk ---------------------------------------------------

ENGINE_SAID='' ENGINE_CODE=0

# engine_check TAG — ask the running engine; its reason id in ENGINE_SAID (a-z_
# only, bounded: it reaches the terminal), its exit code in ENGINE_CODE.
engine_check() {
	local said=''
	ENGINE_CODE=0
	said="$(dc exec -T dedalo bun scripts/ops/image_update_channel.ts check-target "$1" 2>/dev/null)" || ENGINE_CODE=$?
	ENGINE_SAID="$(printf '%s' "$said" | tr -cd 'a-z_' | head -c 64)"
}

# engine_blind_to_identity — status 0 when the engine's refusal of TARGET is about
# a PRERELEASE it cannot see, not about the data walk. Every engine that predates
# the identity walk (7.0.0-beta.6 and older) reads only X.Y.Z(-dev) and knows only
# its own X.Y.Z — and the engine that answers is the OLD image, so no later engine
# fixes this for the stack being updated. A current engine answers a prerelease
# itself (scripts/ops/image_update_channel.ts: the identity walk from what the image
# calls itself) and never says either blind answer for one: its same-X.Y.Z refusal
# is `not_newer_release`, which is never re-asked. Two answers are blind: `malformed_version` for a prerelease target (it cannot read
# the tag), and `downgrade_or_same_version` for a release from a prerelease of the
# same X.Y.Z (rc.1 → 7.0.0: it sees 7.0.0 → 7.0.0). The walk of either is its DATA
# walk (design 2.8.3: the same X.Y.Z crosses no migration, another X.Y.Z must be
# the next rung), and an engine of any age answers exactly that for X.Y.Z-dev:
# the same X.Y.Z or the next rung legal, a skip or a step back refused. Release
# order WITHIN the data version was step 3's job.
engine_blind_to_identity() {
	[ "$ENGINE_CODE" = 3 ] || return 1
	case "$ENGINE_SAID" in
		malformed_version) dedalo_is_prerelease_tag "$TARGET" ;;
		downgrade_or_same_version)
			dedalo_is_prerelease_tag "$FROM" &&
				[ "$(dedalo_version_triple "$TARGET")" = "$(dedalo_version_triple "$FROM")" ]
			;;
		*) return 1 ;;
	esac
}

check_with_engine() {
	local asked="$TARGET"
	[ -n "$(running_container dedalo)" ] || finish refused not_running 'the dedalo service is not running — start it (up -d dedalo) and run this again'
	engine_check "$TARGET"
	if engine_blind_to_identity; then
		asked="$(dedalo_version_triple "$TARGET")-dev"
		say "the running engine does not know prerelease versions: asking it about the data version of $TARGET ($asked) instead"
		engine_check "$asked"
	fi
	case "$ENGINE_CODE" in
		0) return 0 ;;
		3) finish refused version_refused "the engine refuses $asked: $ENGINE_SAID" ;;
	esac
	if [ "$SKIP_VERSION_CHECK" = 'true' ]; then
		say 'the engine could not check the version walk — skipped (--skip-version-check)'
		return 0
	fi
	finish refused version_refused 'the running engine could not check this version (an image older than its update channel?). If it predates it, re-run with --skip-version-check'
}

# --- 7 (dry run). the new image, read and not pulled ----------------------------

# remote_digest REF — the registry digest REF names, read from its manifest (no
# layer is pulled); status 1 when the registry does not say one.
remote_digest() {
	local digest=''
	digest="$(docker buildx imagetools inspect "$1" --format '{{.Manifest.Digest}}' 2>/dev/null)" || return 1
	dedalo_digest_grammar "$digest" || return 1
	printf '%s' "$digest"
}

# remote_version_label REF — the org.opencontainers.image.version label of EVERY
# platform's image config REF names, read from the registry (no layer pulled), one
# bracketed value per platform: "[7.0.1][7.0.1]" for a multi-platform index,
# "[7.0.1]" for a single image; a platform without the label reads "[]". The
# template takes both shapes: `.Image` is a platform map for an index (where
# `.Image.Config` is absent) and one image for a single manifest. Verified against
# registry-1.docker.io (alpine:3.19, its index and one of its platform digests).
remote_version_label() {
	docker buildx imagetools inspect "$1" --format '{{if .Image.Config}}[{{index .Image.Config.Labels "org.opencontainers.image.version"}}]{{else}}{{range $platform, $image := .Image}}[{{index $image.Config.Labels "org.opencontainers.image.version"}}]{{end}}{{end}}' 2>/dev/null
}

# declares_version LABELS — status 0 when LABELS (remote_version_label) names TARGET
# for every platform and there is at least one. Fails closed: an empty answer, a
# platform without the label, or another version anywhere is a refusal.
declares_version() {
	[ -n "$1" ] && [ -z "${1//"[$TARGET]"/}" ]
}

# check_build_source — the read-only half of build mode (the dry run): what
# build_image would refuse, judged on a clean export of the release ref. git archive
# applies export-subst, so the export carries the same stamp the builder's snapshot
# does; the checkout, its HEAD and its working tree are not moved, and nothing is
# fetched or built.
check_build_source() {
	local ref='' tree='' identity=''
	dedalo_is_checkout "$(pwd)" || finish refused build_failed "$(dedalo_no_checkout_sentence "$(pwd)")"
	[ -z "$(git status --porcelain --untracked-files=no)" ] ||
		finish refused build_failed 'this checkout has local changes to tracked files — commit or discard them first'
	ref="$(build_ref)"
	git rev-parse --verify -q "$ref^{commit}" >/dev/null ||
		finish refused build_failed "$ref is not a commit of this checkout — fetch it first (git fetch --all --tags), or name another with --ref"
	tree="$(mktemp -d)"
	if ! git archive "$ref" | tar -x -C "$tree"; then
		rm -rf "$tree"
		finish refused build_failed "could not export $ref"
	fi
	identity="$(dedalo_release_identity "$tree" || true)"
	rm -rf "$tree"
	builds_target "$identity" ||
		finish refused version_refused "$ref is ${identity:-no Dédalo version}, not $TARGET"
}

# check_image — the read-only half of step 7 (the dry run). Pull mode: the image is
# in the registry and, when the install asks for it, its signed digest carries the
# version it names — the same two claims dedalo_verify_release makes after a pull
# (the labels of every platform here, where a real pull reads the one it fetched:
# stricter, never looser). Build mode: check_build_source.
check_image() {
	local ref="$IMAGE:$TARGET" digest='' labels='' code=0
	if [ "$MODE" = 'build' ]; then
		check_build_source
		return 0
	fi
	dedalo_image_available "$ref" || code=$?
	[ "$code" = 0 ] || finish refused pull_failed "could not pull $ref (the registry has no such image, or it could not be reached: code $code)"
	[ "$VERIFY" = 'cosign' ] || return 0
	command -v cosign >/dev/null 2>&1 || finish refused verify_failed 'DEDALO_IMAGE_VERIFY=cosign but cosign is not installed on this host'
	digest="$(remote_digest "$ref" || true)"
	labels="$(remote_version_label "$IMAGE@$digest" || true)"
	[ -n "$digest" ] && dedalo_cosign_verify "$IMAGE@$digest" && declares_version "$labels" ||
		finish refused verify_failed "$ref does not carry Dédalo's signature for version $TARGET"
	say "signature verified (dry run): $IMAGE@$digest is version $TARGET"
}

# --- 5. the backup --------------------------------------------------------------

take_backup() {
	local said=''
	if [ "$NO_BACKUP" = 'true' ]; then
		say 'NO pre-update backup (--no-backup): a failed update can only roll the CODE back'
		return 0
	fi
	[ -n "$(dc ps -q --status running backup 2>/dev/null || true)" ] ||
		finish refused backup_failed 'the backup service is not running — start it (up -d backup), or waive the backup with --no-backup'
	say 'taking a verified database backup first…'
	said="$(dc exec -T backup /opt/dedalo/master_dedalo/deploy/dedalo-db-backup.sh \
		--label pre-image-update --dir /backups/db \
		--db-key DB_NAME --host-key DB_HOST --port-key DB_PORT \
		--user-key DB_USER --password-key DB_PASSWORD --socket-key DB_SOCKET \
		--pg-dump pg_dump --pg-restore pg_restore)" || finish failed backup_failed 'the database backup failed — nothing was changed'
	BACKUP_PATH="$(printf '%s\n' "$said" | sed -n 's/^dedalo-db-backup: verified \([^ ]*\).*$/\1/p' | tail -n 1)"
	backup_path_grammar "$BACKUP_PATH" || finish failed backup_failed 'the backup reported no verified dump — nothing was changed'
	say "backup: $BACKUP_PATH"
}

# --- 6. the rollback anchor -----------------------------------------------------

anchor_rollback() {
	local container='' image_id=''
	container="$(running_container dedalo)"
	image_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null || true)"
	dedalo_digest_grammar "$image_id" || finish refused not_running 'could not read the image the engine runs — nothing was changed'
	STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
	ROLLBACK_REF="$IMAGE:rollback-$STAMP"
	docker tag "$image_id" "$ROLLBACK_REF" || finish failed not_running "could not tag the running image as $ROLLBACK_REF"
	say "the running image is kept as $ROLLBACK_REF"
}

# --- 7. the new image -----------------------------------------------------------

pull_image() {
	docker pull "$IMAGE:$TARGET" || finish failed pull_failed "could not pull $IMAGE:$TARGET"
	DIGEST="$(dedalo_repo_digest "$IMAGE" "$TARGET" || true)"
	[ "$VERIFY" = 'cosign' ] || return 0
	command -v cosign >/dev/null 2>&1 || finish failed verify_failed 'DEDALO_IMAGE_VERIFY=cosign but cosign is not installed on this host'
	[ -n "$DIGEST" ] && dedalo_verify_release "$IMAGE" "$DIGEST" "$TARGET" ||
		finish failed verify_failed "$IMAGE:$TARGET does not carry Dédalo's signature for version $TARGET"
	say "signature verified: $IMAGE@$DIGEST is version $TARGET"
}

# build_ref — the commit a build checks out: --ref, or the prerelease's own tag (a
# release or prerelease is built from its exact annotated tag; -dev is never built).
build_ref() {
	if [ -n "$GIT_REF" ]; then
		echo "$GIT_REF"
	else
		echo "v$TARGET"
	fi
}

# builds_target IDENTITY — status 0 when a commit of that identity builds TARGET.
builds_target() {
	[ "$(dedalo_image_tag_of "$1" || true)" = "$TARGET" ]
}

restore_checkout() {
	if [ -n "$PREV_BRANCH" ]; then
		git checkout -q "$PREV_BRANCH"
	else
		git checkout -q --detach "$PREV_HEAD"
	fi
}

# build_image — the release checked out here, then built by THE local builder
# (dedalo_image_build, deploy/dedalo-image-lib.sh — the installer's): a clean
# snapshot of that commit, never the working tree, so no uncommitted or untracked
# file reaches the image and it reports the version it is tagged with. The
# library was sourced before the checkout: the builder that runs is this one.
# Tracked changes are still refused: the checkout itself moves to the release.
# WHAT was checked out is judged by its RELEASE IDENTITY (dedalo_release_identity
# — what the engine built from it will call itself), not by the triple version.ts
# declares: a release or prerelease target must be exactly that tagged release.
build_image() {
	local ref='' identity=''
	dedalo_is_checkout "$(pwd)" || finish refused build_failed "$(dedalo_no_checkout_sentence "$(pwd)")"
	[ -z "$(git status --porcelain --untracked-files=no)" ] ||
		finish refused build_failed 'this checkout has local changes to tracked files — commit or discard them first'
	PREV_HEAD="$(git rev-parse HEAD)"
	PREV_BRANCH="$(git symbolic-ref -q --short HEAD || true)"
	git fetch --all --tags --quiet || finish failed build_failed 'git fetch failed'
	ref="$(build_ref)"
	git checkout -q --detach "$ref" || finish refused build_failed "could not check out $ref"
	identity="$(dedalo_release_identity . || true)"
	if ! builds_target "$identity"; then
		restore_checkout
		finish refused version_refused "$ref is ${identity:-no Dédalo version}, not $TARGET"
	fi
	if ! dedalo_image_build "$(pwd)" "$IMAGE:$TARGET"; then
		restore_checkout
		finish failed build_failed "the build of $ref failed — the running stack is unchanged"
	fi
}

# --- 10. health -----------------------------------------------------------------

HEALTH_DETAIL=''

# health_wait — green on the first `healthy`. `unhealthy` is NOT final: Docker
# reports it after start_period + retries x interval (~2 min in both stacks) while
# boot migrations still run, and flips back on the first green probe, so only the
# deadline or a RESTART of the engine process (RestartCount > 0: it exited — a
# crash, never a slow boot) is red. At the deadline the detail is the last state
# seen: `unhealthy` (it answered red) or `health_timeout` (it never answered).
health_wait() {
	local attempts=$(((HEALTH_TIMEOUT + 4) / 5)) i=0 seen='' state=''
	while [ "$i" -lt "$attempts" ]; do
		seen="$(health_state)"
		state="${seen#* }"
		[ "$state" = 'healthy' ] && return 0
		if [[ "$seen" =~ ^[1-9][0-9]*\  ]]; then
			say "the engine process restarted (${seen%% *} time(s)) before it came up healthy"
			HEALTH_DETAIL='unhealthy'
			return 1
		fi
		sleep 5
		i=$((i + 1))
	done
	HEALTH_DETAIL='health_timeout'
	if [ "$state" = 'unhealthy' ]; then HEALTH_DETAIL='unhealthy'; fi
	return 1
}

# health_state — "<restart count> <health status>" of the engine container, or
# empty while there is none.
health_state() {
	local container=''
	container="$(running_container dedalo)"
	[ -n "$container" ] || return 0
	docker inspect --format '{{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true
}

# --- 11. green, or back ---------------------------------------------------------

prune_rollback_tags() {
	local tag=''
	for tag in $(docker image ls --format '{{.Tag}}' "$IMAGE" 2>/dev/null || true); do
		case "$tag" in
			"rollback-$STAMP") : ;;
			rollback-*) docker rmi "$IMAGE:$tag" >/dev/null 2>&1 || true ;;
		esac
	done
}

roll_back() {
	local failure="$1"
	say "the new version did not come up healthy ($failure) — ROLLING BACK to $FROM"
	docker tag "$ROLLBACK_REF" "$IMAGE:$FROM" || finish rollback_failed "$failure" "could not re-tag $ROLLBACK_REF"
	dedalo_env_set "$ENV_FILE" DEDALO_VERSION "$FROM" || finish rollback_failed "$failure" "could not re-pin DEDALO_VERSION=$FROM"
	if [ "$MODE" = 'build' ]; then restore_checkout || say 'could not restore the previous checkout'; fi
	if dc up -d --no-build dedalo backup && health_wait; then
		finish rolled_back "$failure" "back on $FROM, healthy — the update FAILED; the database backup is ${BACKUP_PATH:-not taken}"
	fi
	finish rollback_failed "$failure" "the rollback to $FROM is NOT healthy either — manual intervention required (backup: ${BACKUP_PATH:-not taken})"
}

# --- main -----------------------------------------------------------------------

main() {
	parse_args "$@"
	cd "$(dirname "$0")/.."
	# shellcheck source=deploy/dedalo-image-lib.sh
	. deploy/dedalo-image-lib.sh
	dedalo_registries_load deploy/image_registries.sh || say 'deploy/image_registries.sh is missing — no official signing identity loaded'
	dedalo_env_isolate
	STARTED_AT="$(now_iso)"
	read_env
	# A dry run takes no lock: it changes nothing a running update could be holding.
	if [ "$CHECK_ONLY" != 'true' ]; then
		dedalo_lock_acquire "$(pwd)" dedalo-image-update ||
			finish refused locked "another image update is running (lock: $(pwd)/.dedalo-image-update.lock)"
		trap 'dedalo_lock_release "$(pwd)" dedalo-image-update' EXIT
	fi
	check_env
	check_version
	check_with_engine
	if [ "$CHECK_ONLY" = 'true' ]; then
		check_image
		printf 'check: would update %s -> %s\n' "$FROM" "$TARGET"
		exit 0
	fi
	take_backup
	anchor_rollback
	if [ "$MODE" = 'pull' ]; then pull_image; else build_image; fi
	dedalo_env_set "$ENV_FILE" DEDALO_VERSION "$TARGET" || finish failed pull_failed "could not re-pin DEDALO_VERSION in $ENV_FILE"
	say "pinned DEDALO_VERSION=$TARGET; recreating dedalo and backup…"
	if dc up -d dedalo backup && health_wait; then
		prune_rollback_tags
		finish green healthy "healthy at $IMAGE:$TARGET (previous image kept as $ROLLBACK_REF)"
	fi
	roll_back "${HEALTH_DETAIL:-unhealthy}"
}

main "$@"; exit
