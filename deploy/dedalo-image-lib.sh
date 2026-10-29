# shellcheck shell=bash
#
# DÉDALO IMAGE HOST LIBRARY — the functions every Docker-HOST tool shares
# (installer unification D2, 2026-10-09). SOURCED, never executed.
#
# WHY A SHARED LIBRARY. Three host programs make the same decisions about the
# same file: install.sh (where the image comes from, written once), the image
# updater deploy/dedalo-image-update.sh (pull or build, re-pin, roll back) and
# the opt-in host updater. Each one re-deriving "which compose file", "what is a
# version", "which registries are official" would drift the first time one of
# them is fixed — exactly how the old updater came to default to the full stack
# while install.sh installed the simple one. One library, one answer.
#
# THE .dedalo.env CONTRACT (host side only — never the engine's /private/.env):
#   DEDALO_COMPOSE_FILE   the stack: docker-compose.simple.yml | docker-compose.yml
#   DEDALO_IMAGE          the repository, no tag (localhost/dedalo for a local build)
#   DEDALO_VERSION        the pinned tag: X.Y.Z, X.Y.Z-(alpha|beta|rc).N for a prerelease,
#                         or X.Y.Z-dev for a developer image (dedalo_version_grammar)
#   DEDALO_IMAGE_MODE     pull | build
#   DEDALO_IMAGE_VERIFY   cosign | none
# Writer: the terminal installer (src/core/install/host/stack/files.ts — docker and
# trial routes; the full stack by hand: the docs/install/docker.md recipe). Readers:
# compose (`image: ${DEDALO_IMAGE}:${DEDALO_VERSION}`) and this library. The image
# updater is the ONE re-pinner, and it changes DEDALO_VERSION only.
#
# IT NEVER SOURCES .dedalo.env — it PARSES it (dedalo_env_get). Sourcing would
# execute whatever the file holds, with the privileges of whoever runs the host
# tool (root, for the host updater); a KEY=VALUE reader executes nothing.
#
# THE OFFICIAL REGISTRY LIST arrives through dedalo_registries_load, which RESETS
# every name deploy/image_registries.sh defines before sourcing that generated
# file: a signing identity or a registry inherited from the caller's environment
# can never stand in for the generated one.
#
# Bash 3.2 (macOS): no ${x,,}, no mapfile, no associative arrays; an EMPTY array
# is never expanded bare under `set -u`. Every function is `set -euo pipefail`
# safe and returns a status instead of exiting. Gates:
# test/unit/install_sh_image_source.test.ts, test/unit/image_update_script_native.test.ts,
# test/unit/release_identity_shell_parity.test.ts (the release identity, its
# grammars and its order, held to the engine's src/core/update/release_identity.ts).

# --- grammar ------------------------------------------------------------------

DEDALO_ENV_KEY_RE='^[A-Z_][A-Z0-9_]*$'
# One canonical version number: no leading zero, so `7.0.01` can never name a
# second `7.0.1` (release_identity.ts RELEASE_VERSION_RE, the same rule).
DEDALO_NUMBER_RE='(0|[1-9][0-9]*)'
DEDALO_TRIPLE_PART_RE="${DEDALO_NUMBER_RE}\\.${DEDALO_NUMBER_RE}\\.${DEDALO_NUMBER_RE}"
# The prerelease labels, in semver precedence order (owner Q9) — the twin of
# PRERELEASE_LABELS. The grammar and dedalo_prerelease_rank both read this list.
DEDALO_PRERELEASE_LABELS='alpha beta rc'
DEDALO_PRERELEASE_RE="-(${DEDALO_PRERELEASE_LABELS// /|})\\.${DEDALO_NUMBER_RE}"
# THE RELEASE IDENTITY (src/core/update/release_identity.ts — what a tree CALLS
# ITSELF): X.Y.Z for an exact stable tag, X.Y.Z-(alpha|beta|rc).N for an exact
# prerelease tag, X.Y.Z-dev for anything untagged.
DEDALO_RELEASE_VERSION_RE="^${DEDALO_TRIPLE_PART_RE}(${DEDALO_PRERELEASE_RE})?$"
DEDALO_DEV_IDENTITY_RE="^${DEDALO_TRIPLE_PART_RE}-dev$"
# AN IMAGE TAG (DEDALO_VERSION, --version): the identity it names, spelled the
# way an image tag can carry it — a release or prerelease identity IS its tag,
# a dev identity is X.Y.Z-dev (imageTagOf / identityOfImageTag).
DEDALO_VERSION_RE="^${DEDALO_TRIPLE_PART_RE}(-dev|${DEDALO_PRERELEASE_RE})?$"
# isRepositoryReference (src/core/update/image_registries.ts), in ERE: an optional
# host[:port]/, then lowercase path components — and NO tag or digest.
DEDALO_REPO_HOST_RE='[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?'
DEDALO_REPO_COMPONENT_RE='[a-z0-9]+([._-][a-z0-9]+)*'
DEDALO_REPOSITORY_RE="^(${DEDALO_REPO_HOST_RE}/)?${DEDALO_REPO_COMPONENT_RE}(/${DEDALO_REPO_COMPONENT_RE})*$"
DEDALO_DIGEST_RE='^sha256:[0-9a-f]{64}$'
# parseDeclaredTriple (src/core/update/code_build_plan.ts): whitespace-insensitive.
DEDALO_TRIPLE_RE='Object\.freeze\(\[[[:space:]]*[0-9]+[[:space:]]*,[[:space:]]*[0-9]+[[:space:]]*,[[:space:]]*[0-9]+[[:space:]]*,?[[:space:]]*\]\)'
# The stack file name DEDALO_COMPOSE_FILE may hold: a file in the stack directory.
DEDALO_COMPOSE_FILE_RE='^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$'
# The override that adds the build (deploy/compose.build.yml).
DEDALO_BUILD_OVERRIDE='deploy/compose.build.yml'
# The terminal installer's own override (the Let's Encrypt renewal service of the
# full stack): part of the stack WHEN IT EXISTS, so every host tool drives the
# stack the installer built (src/core/install/host/stack/compose.ts, same order).
DEDALO_INSTALL_OVERRIDE='compose.override.yaml'
# The keys of the contract above, in the order install.sh writes them.
DEDALO_ENV_IMAGE_KEYS='DEDALO_COMPOSE_FILE DEDALO_IMAGE DEDALO_VERSION DEDALO_IMAGE_MODE DEDALO_IMAGE_VERIFY'

dedalo_version_grammar() {
	[[ "${1-}" =~ $DEDALO_VERSION_RE ]]
}

dedalo_repository_grammar() {
	local ref="${1-}"
	[ "${#ref}" -le 255 ] && [[ "$ref" =~ $DEDALO_REPOSITORY_RE ]]
}

dedalo_digest_grammar() {
	[[ "${1-}" =~ $DEDALO_DIGEST_RE ]]
}

# --- the release identity: grammar and order ---------------------------------

dedalo_identity_grammar() {
	[[ "${1-}" =~ $DEDALO_RELEASE_VERSION_RE ]] || [[ "${1-}" =~ $DEDALO_DEV_IDENTITY_RE ]]
}

# dedalo_identity_of_tag TAG — the identity an image tag names (identityOfImageTag).
# The spellings are the same now (X.Y.Z-dev is both the tag and the identity), so
# this is the grammar check and nothing else. Status 1 for a string that is no tag.
dedalo_identity_of_tag() {
	dedalo_version_grammar "${1-}" || return 1
	printf '%s' "$1"
}

# dedalo_image_tag_of IDENTITY — the image tag an identity is built and published
# under (imageTagOf): identity → itself (X.Y.Z-dev included). Status 1 for a
# string that is no identity.
dedalo_image_tag_of() {
	dedalo_identity_grammar "${1-}" || return 1
	printf '%s' "$1"
}

# dedalo_version_triple TAG|IDENTITY — the X.Y.Z (the DATA version) either names:
# everything from the first `-` or `.` that starts a word (-beta.6, -dev).
# (Parameter expansion, not BASH_REMATCH: every name this library reads is one it
# sets — deploy_env_contract_tripwire.)
dedalo_version_triple() {
	dedalo_version_grammar "${1-}" || dedalo_identity_grammar "${1-}" || return 1
	printf '%s' "${1%%[-.][a-z]*}"
}

# dedalo_prerelease_rank LABEL — its index in DEDALO_PRERELEASE_LABELS.
dedalo_prerelease_rank() {
	local label='' rank=0
	for label in $DEDALO_PRERELEASE_LABELS; do
		if [ "$label" = "${1-}" ]; then
			echo "$rank"
			return 0
		fi
		rank=$((rank + 1))
	done
	return 1
}

# dedalo_identity_key IDENTITY — five canonical numbers `X Y Z R N` that order as
# compareReleaseIdentities does: R is the prerelease's rank (alpha 0, beta 1,
# rc 2), then a DEV identity (R = the label count), then the stable release
# (R = the label count + 1). A dev identity sits above every prerelease of its
# triple and strictly below that triple's stable release.
dedalo_identity_key() {
	local identity="${1-}" major='' minor='' patch='' prerelease='' labels=''
	dedalo_identity_grammar "$identity" || return 1
	IFS=. read -r major minor patch <<<"$(dedalo_version_triple "$identity")"
	# shellcheck disable=SC2086 # deliberate split: count the labels
	labels="$(set -- $DEDALO_PRERELEASE_LABELS && echo "$#")"
	case "$identity" in
		*-dev) printf '%s %s %s %s 0' "$major" "$minor" "$patch" "$labels" ;;
		*-*)
			prerelease="${identity#*-}" # label.N
			printf '%s %s %s %s %s' "$major" "$minor" "$patch" \
				"$(dedalo_prerelease_rank "${prerelease%%.*}")" "${prerelease#*.}"
			;;
		*) printf '%s %s %s %s 0' "$major" "$minor" "$patch" "$((labels + 1))" ;;
	esac
}

# dedalo_number_cmp A B — -1, 0 or 1 between two CANONICAL numbers of any length
# (no arithmetic, so no overflow past 2^63: the grammar does not bound a number,
# so neither may the comparison). Canonical: a longer number is the larger one.
dedalo_number_cmp() {
	if [ "${#1}" -ne "${#2}" ]; then
		if [ "${#1}" -gt "${#2}" ]; then echo 1; else echo -1; fi
	elif [ "$1" = "$2" ]; then
		echo 0
	elif [[ "$1" > "$2" ]]; then
		echo 1
	else
		echo -1
	fi
}

# dedalo_identity_cmp A B — prints -1, 0 or 1 between two RELEASE IDENTITIES in
# semver §11 precedence (compareReleaseIdentities, held to the ONE ordering
# fixture test/fixtures/release_identity/ordering.json):
#   7.0.0-alpha.1 < 7.0.0-beta.5 < 7.0.0-beta.6 < 7.0.0-rc.1 < 7.0.0 < 7.0.1
# Status 2 for anything that is no identity: a silent order for garbage is how a
# downgrade gets waved through.
dedalo_identity_cmp() {
	local left='' right='' order=0 i=0
	left="$(dedalo_identity_key "${1-}")" && right="$(dedalo_identity_key "${2-}")" || return 2
	# shellcheck disable=SC2206 # deliberate split: five canonical numbers each
	local left_key=($left) right_key=($right)
	while [ "$i" -lt 5 ]; do
		order="$(dedalo_number_cmp "${left_key[i]}" "${right_key[i]}")"
		if [ "$order" != 0 ]; then
			echo "$order"
			return 0
		fi
		i=$((i + 1))
	done
	echo 0
}

# dedalo_version_cmp A B — prints -1, 0 or 1 between two IMAGE TAGS, ordered as the
# identities they name (dedalo_identity_cmp): X.Y.Z-dev orders as X.Y.Z, so the
# callers decide what an equal -dev means. Status 2 for a string that is no tag.
dedalo_version_cmp() {
	local left='' right=''
	left="$(dedalo_identity_of_tag "${1-}")" && right="$(dedalo_identity_of_tag "${2-}")" || return 2
	dedalo_identity_cmp "$left" "$right"
}

# dedalo_is_dev_tag TAG — status 0 for a developer image tag (X.Y.Z-dev).
dedalo_is_dev_tag() {
	dedalo_version_grammar "${1-}" && [ "${1%-dev}" != "$1" ]
}

# dedalo_is_prerelease_tag TAG — status 0 for a prerelease tag (X.Y.Z-beta.N …).
dedalo_is_prerelease_tag() {
	dedalo_version_grammar "${1-}" && [ "${1#*-}" != "$1" ] && ! dedalo_is_dev_tag "$1"
}

# dedalo_release_tag_version TAG — the version an EXACT release tag names
# (`v7.0.0-beta.6` → `7.0.0-beta.6`; releaseVersionOfTag), status 1 for anything
# else: a describe past a tag, a foreign suffix, a non-canonical number.
dedalo_release_tag_version() {
	case "${1-}" in v*) : ;; *) return 1 ;; esac
	[[ "${1#v}" =~ $DEDALO_RELEASE_VERSION_RE ]] || return 1
	printf '%s' "${1#v}"
}

# dedalo_repository_normalize REF — the comparable form (normalizeRepository):
# lowercase, and Docker Hub's implicit host made implicit (docker.io/x ≡ x).
dedalo_repository_normalize() {
	local lowered=''
	lowered="$(printf '%s' "${1-}" | tr '[:upper:]' '[:lower:]')"
	lowered="${lowered#index.docker.io/}"
	printf '%s' "${lowered#docker.io/}"
}

# --- the .dedalo.env file -----------------------------------------------------

# THE LINE RULES ARE COMPOSE'S (its dotenv parser, the subset an operator writes),
# because compose is the other reader of this file and the two must never disagree
# about which image runs: leading whitespace and an `export ` prefix are ignored; a
# value in single or double quotes is what lies between them (anything after the
# closing quote — a comment — is dropped); an UNQUOTED value ends at a `#` that
# follows whitespace (an inline comment), and its trailing whitespace is dropped.
# The LAST line assigning a key wins. Gate: install_sh_image_source (section B).

# dedalo_env_line_value KEY LINE — the value LINE assigns to KEY (status 0), or
# status 1 when LINE does not assign KEY.
dedalo_env_line_value() {
	local key="$1" line="${2%$'\r'}"
	line="${line#"${line%%[![:space:]]*}"}"
	case "$line" in export[[:space:]]*) line="${line#export}"; line="${line#"${line%%[![:space:]]*}"}" ;; esac
	case "$line" in "$key="*) ;; *) return 1 ;; esac
	dedalo_env_value_of "${line#*=}"
}

# dedalo_env_value_of RAW — the text after `KEY=`, read by the rules above.
dedalo_env_value_of() {
	local raw="${1#"${1%%[![:space:]]*}"}" quote=''
	quote="${raw:0:1}"
	case "$quote" in
		\" | \') dedalo_env_quoted "$quote" "${raw:1}" ;;
		*) printf '%s' "$raw" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//' ;;
	esac
}

# dedalo_env_quoted QUOTE REST — up to the closing QUOTE; an unterminated quote is
# kept literally (compose refuses such a file; this reader never guesses past it).
dedalo_env_quoted() {
	case "$2" in
		*"$1"*) printf '%s' "${2%%"$1"*}" ;;
		*) printf '%s%s' "$1" "$2" ;;
	esac
}

# dedalo_env_get FILE KEY — the value of the LAST line assigning KEY, read by the
# rules above. Prints nothing for an absent key or file; status 2 only for a
# malformed KEY.
dedalo_env_get() {
	local file="${1-}" key="${2-}" line='' value='' found=''
	[[ "$key" =~ $DEDALO_ENV_KEY_RE ]] || return 2
	[ -f "$file" ] || return 0
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in *"$key"*) ;; *) continue ;; esac
		if found="$(dedalo_env_line_value "$key" "$line")"; then value="$found"; fi
	done <"$file"
	printf '%s' "$value"
}

# dedalo_env_set FILE KEY VALUE — rewrite FILE ATOMICALLY (a temp file in the same
# directory, then mv) with every line assigning KEY (by the rules above: indented,
# `export`-prefixed or commented ones too) replaced by `KEY=VALUE` and every other
# line byte-identical; KEY is appended when absent. umask 077: the file holds the
# database password. Refuses a value carrying a line break.
dedalo_env_set() {
	local file="${1-}" key="${2-}" value="${3-}" tmp='' line='' found='false'
	[[ "$key" =~ $DEDALO_ENV_KEY_RE ]] || return 2
	case "$value" in *$'\n'* | *$'\r'*) return 2 ;; esac
	[ -f "$file" ] || return 1
	tmp="$(umask 077 && mktemp "$(dirname "$file")/.dedalo-env.XXXXXX")" || return 1
	{
		while IFS= read -r line || [ -n "$line" ]; do
			if dedalo_env_assigns "$key" "$line"; then
				printf '%s=%s\n' "$key" "$value"
				found='true'
			else
				printf '%s\n' "$line"
			fi
		done <"$file"
		if [ "$found" = 'false' ]; then printf '%s=%s\n' "$key" "$value"; fi
	} >"$tmp" || { rm -f "$tmp"; return 1; }
	mv -f "$tmp" "$file"
}

# dedalo_env_assigns KEY LINE — status 0 when LINE assigns KEY.
dedalo_env_assigns() {
	case "$2" in *"$1"*) dedalo_env_line_value "$1" "$2" >/dev/null ;; *) return 1 ;; esac
}

# dedalo_env_isolate — forget any value of the contract's keys inherited from the
# caller's shell. Compose gives the SHELL precedence over --env-file, so an
# exported DEDALO_VERSION would silently outvote the pinned one.
dedalo_env_isolate() {
	unset DEDALO_COMPOSE_FILE DEDALO_IMAGE DEDALO_VERSION DEDALO_IMAGE_MODE DEDALO_IMAGE_VERIFY
}

# dedalo_env_problems FILE — one line per contract key that is missing or invalid
# (`KEY reason`); prints nothing when the file is complete.
dedalo_env_problems() {
	local file="${1-}" key='' value=''
	for key in $DEDALO_ENV_IMAGE_KEYS; do
		value="$(dedalo_env_get "$file" "$key")"
		if [ -z "$value" ]; then
			printf '%s missing\n' "$key"
		elif ! dedalo_env_value_valid "$key" "$value"; then
			printf '%s invalid\n' "$key"
		fi
	done
}

dedalo_env_value_valid() {
	case "$1" in
		DEDALO_COMPOSE_FILE) [[ "$2" =~ $DEDALO_COMPOSE_FILE_RE ]] ;;
		DEDALO_IMAGE) dedalo_repository_grammar "$2" ;;
		DEDALO_VERSION) dedalo_version_grammar "$2" ;;
		DEDALO_IMAGE_MODE) [ "$2" = 'pull' ] || [ "$2" = 'build' ] ;;
		DEDALO_IMAGE_VERIFY) [ "$2" = 'cosign' ] || [ "$2" = 'none' ] ;;
		*) return 1 ;;
	esac
}

# --- the checkout ---------------------------------------------------------------

# dedalo_checkout_version DIR — the X.Y.Z the checkout at DIR declares in
# src/core/update/version.ts: the FIRST Object.freeze([a, b, c]) triple, read
# whitespace- and line-break-insensitively — the same answer parseDeclaredTriple
# gives (gate: install_sh_image_source). Status 1 when unreadable or absent.
dedalo_checkout_version() {
	local file="${1-}/src/core/update/version.ts" found=''
	[ -r "$file" ] || return 1
	found="$(tr '\011\012\013\014\015' '     ' <"$file" | grep -oE "$DEDALO_TRIPLE_RE" | head -n 1)" || true
	[ -n "$found" ] || return 1
	found="$(printf '%s' "$found" | tr -cs '0-9' ' ')"
	# shellcheck disable=SC2086 # deliberate split: three numbers
	set -- $found
	[ "$#" -eq 3 ] || return 1
	printf '%s.%s.%s' "$1" "$2" "$3"
}

# --- the release identity of a tree -----------------------------------------------
#
# THE SHELL TWIN of src/core/update/release_identity.ts resolveReleaseIdentity +
# build_stamp.ts readReleaseIdentityOf (owner decision 2026-10-15, C3i-F1): what a
# Dédalo tree CALLS ITSELF, decided from that tree's own evidence, by the same rules
# in the same order. Its one consumer that matters is the image label: a local
# build is labelled with the identity the engine inside it will report, read from
# the very snapshot docker builds. Held to the engine resolver over the same real
# git trees by test/unit/release_identity_shell_parity.test.ts.
#
# The evidence:
#  - src/core/update/build_info.txt: `<sha> <date> <describe>` in a `git archive`
#    (export-subst; <describe> is the exact `v*` tag, a past-the-tag describe or
#    empty), the legacy `<sha> <date>` of an archive made before 2026-10-15, or the
#    unexpanded `$Format:` placeholder in a checkout;
#  - a CHECKOUT (placeholder + .git): one bounded `git describe --exact-match`;
#  - src/core/update/install_stamp.json's channel — read only for a legacy stamp.
# The rules:
#  1/2. an exact stable or prerelease tag naming version.ts's triple → that version;
#  3.   anything else with describe evidence (untagged, past a tag, a tag naming
#       another triple, an old git's unexpanded field) → X.Y.Z-dev;
#  4.   a legacy stamp → X.Y.Z, or X.Y.Z-dev on a dev-channel install;
#  5.   the channel never overrides a tag (owner Q5).
#  No evidence at all (a placeholder with no git to ask) → X.Y.Z-dev.

DEDALO_BUILD_INFO='src/core/update/build_info.txt'
DEDALO_INSTALL_STAMP='src/core/update/install_stamp.json'
# The stamp lines parseBuildInfo accepts (release_identity.ts SHA / ISO_DATE). The
# describe field may be EMPTY (no `v*` tag reachable): its separating space stays,
# and that space is what tells an untagged three-field stamp from a legacy one.
DEDALO_STAMP_SHA_RE='[0-9a-f]{7,64}'
DEDALO_STAMP_DATE_RE='[0-9]{4}-[0-9]{2}-[0-9]{2}T[-0-9:.+Z]+'
DEDALO_DESCRIBED_STAMP_RE="^(${DEDALO_STAMP_SHA_RE}) (${DEDALO_STAMP_DATE_RE}) ([^[:space:]]*)$"
DEDALO_LEGACY_STAMP_RE="^(${DEDALO_STAMP_SHA_RE}) (${DEDALO_STAMP_DATE_RE})$"
# How long a checkout's git may take to name its tag (CHECKOUT_DESCRIBE_TIMEOUT_MS,
# 3 s). Whole seconds: `date +%s` is the only portable clock.
DEDALO_DESCRIBE_TIMEOUT_S=3

# dedalo_checkout_next_dev DIR — the NEXT dev triple the checkout declares
# (version.ts DEDALO_NEXT_RELEASE: the release an untagged build precedes), the
# same answer parseDeclaredNextDevTriple gives. Status 1 when absent.
dedalo_checkout_next_dev() {
	local file="${1-}/src/core/update/version.ts" found=''
	[ -r "$file" ] || return 1
	found="$(tr '\011\012\013\014\015' '     ' <"$file" | sed 's/^.*DEDALO_NEXT_RELEASE//' | grep -oE "$DEDALO_TRIPLE_RE" | head -n 1)" || true
	[ -n "$found" ] || return 1
	found="$(printf '%s' "$found" | tr -cs '0-9' ' ')"
	# shellcheck disable=SC2086 # deliberate split: three numbers
	set -- $found
	[ "$#" -eq 3 ] || return 1
	printf '%s.%s.%s' "$1" "$2" "$3"
}

# dedalo_release_identity DIR — prints the release identity of the Dédalo tree at
# DIR (X.Y.Z | X.Y.Z-(alpha|beta|rc).N | X.Y.Z-dev). Never fails on odd evidence
# (it says -dev, as the engine does); status 1 only when DIR declares no version.
# An UNTAGGED tree is named by the NEXT triple (dedalo_checkout_next_dev); a tag
# names its own release, which must not be below the DATA triple it runs on.
dedalo_release_identity() {
	local dir="${1-}" triple='' next='' line='' describe='' evidence='none' legacy='false' tagged=''
	triple="$(dedalo_checkout_version "$dir")" || return 1
	triple="$(dedalo_canonical_triple "$triple")"
	next="$(dedalo_checkout_next_dev "$dir")" || next="$triple"
	next="$(dedalo_canonical_triple "$next")"
	line="$(dedalo_stamp_line "$dir/$DEDALO_BUILD_INFO")"
	if [[ "$line" =~ $DEDALO_DESCRIBED_STAMP_RE ]]; then
		describe="${line#* }"     # drop the sha…
		describe="${describe#* }" # …and the date (neither holds a space)
		evidence='stamp'
	elif [[ "$line" =~ $DEDALO_LEGACY_STAMP_RE ]]; then
		legacy='true'
	elif [ -e "$dir/.git" ] && describe="$(dedalo_checkout_describe "$dir")"; then
		# no expanded stamp, and git is there to ask (a checkout)
		evidence='git'
	fi
	if [ "$evidence" = 'none' ]; then
		if [ "$legacy" = 'true' ] && [ "$(dedalo_install_channel "$dir")" != 'dev' ]; then
			printf '%s' "$triple"
		else
			printf '%s-dev' "$next"
		fi
		return 0
	fi
	if tagged="$(dedalo_release_tag_version "$describe")" &&
		[ "$(dedalo_triple_cmp "$(dedalo_version_triple "$tagged")" "$triple")" -ge 0 ]; then
		printf '%s' "$tagged"
	else
		printf '%s-dev' "$next"
	fi
}

# dedalo_triple_cmp A B — -1, 0 or 1 between two canonical X.Y.Z triples.
dedalo_triple_cmp() {
	local a1='' a2='' a3='' b1='' b2='' b3='' order=0
	IFS=. read -r a1 a2 a3 <<<"$1"
	IFS=. read -r b1 b2 b3 <<<"$2"
	for order in "$(dedalo_number_cmp "$a1" "$b1")" "$(dedalo_number_cmp "$a2" "$b2")" "$(dedalo_number_cmp "$a3" "$b3")"; do
		if [ "$order" != 0 ]; then
			echo "$order"
			return 0
		fi
	done
	echo 0
}

# dedalo_canonical_triple X.Y.Z — the triple as numbers (`07` → `7`): the engine
# reads version.ts's literals as numbers, so a tag compares against those.
# The leading zeros are stripped as TEXT, never by arithmetic: `$((10#…))` wraps a
# component past 2^63 (99999999999999999999 → 7766279631452241919) and the triple
# would name another release.
dedalo_canonical_triple() {
	local a='' b='' c=''
	IFS=. read -r a b c <<<"$1"
	printf '%s.%s.%s' "$(dedalo_strip_zeros "$a")" "$(dedalo_strip_zeros "$b")" "$(dedalo_strip_zeros "$c")"
}

# dedalo_strip_zeros DIGITS — the same digits with leading zeros removed (`007` → `7`,
# `0` stays `0`). Text only: the value is never converted to a number.
dedalo_strip_zeros() {
	local digits="$1"
	while [ "${#digits}" -gt 1 ] && [ "${digits:0:1}" = 0 ]; do digits="${digits:1}"; done
	printf '%s' "$digits"
}

# dedalo_stamp_line FILE — the stamp's first line as parseBuildInfo reads it:
# leading whitespace (blank lines included) dropped, the line terminator (and a
# CR) removed, nothing else — a trailing space is meaningful (see above).
dedalo_stamp_line() {
	local content='' line=''
	content="$(cat "${1-}" 2>/dev/null)" || content=''
	content="${content#"${content%%[![:space:]]*}"}"
	line="${content%%$'\n'*}"
	printf '%s' "${line%$'\r'}"
}

# dedalo_install_channel DIR — `master` or `dev` from the tree's install stamp when
# it is one parseInstallStamp trusts (a 64-hex digest AND a known channel); nothing
# otherwise. A KEY:"value" reader, not a JSON parser: the engine's stamp is one
# line of plain keys, and an escaped quote can never complete a match.
dedalo_install_channel() {
	local file="${1-}/$DEDALO_INSTALL_STAMP" flat='' channel=''
	[ -f "$file" ] || return 0
	flat="$(tr '\011\012\013\014\015' '     ' <"$file")"
	printf '%s' "$flat" | grep -qE '"digest"[[:space:]]*:[[:space:]]*"[a-f0-9]{64}"' || return 0
	channel="$(printf '%s' "$flat" | grep -oE '"channel"[[:space:]]*:[[:space:]]*"(master|dev)"' | tail -n 1)" || true
	case "$channel" in
		*'"master"') printf 'master' ;;
		*'"dev"') printf 'dev' ;;
	esac
}

# dedalo_checkout_describe DIR — the exact `v*` tag of the checkout's HEAD (status
# 0; empty when git answers "no exact tag" — a normal untagged commit), or status 1
# when git could not answer (absent, too slow, any other error). The same question
# build_stamp.ts readCheckoutDescribe asks, the same way:
#  - --exact-match: only a commit that IS a release may call itself one;
#  - --match 'v[0-9]*': a newer non-release annotated tag on the same commit must
#    not hide the release tag;
#  - no --tags: lightweight tags are ignored, as the archive's %(describe) ignores
#    them — a checkout and an archive of one commit always agree (owner Q7);
#  - safe.directory for THIS tree only (root reads an operator's checkout), no
#    fsmonitor helper, no inherited GIT_* (a GIT_DIR would describe ANOTHER
#    repository), the C locale (a translated git's "no tag" must still read as one);
#  - BOUNDED: git runs in the background with its output in files, and is killed
#    at the deadline — nothing waits on a pipe a stray grandchild could hold open.
dedalo_checkout_describe() {
	local dir='' work='' pid='' started='' status=0 out=''
	started="$(date +%s)" || return 1
	dir="$(cd "${1-}" 2>/dev/null && pwd -P)" || return 1
	work="$(mktemp -d "${TMPDIR:-/tmp}/dedalo-describe.XXXXXX")" || return 1
	(
		for name in $(compgen -e); do
			case "$name" in GIT_* | LANGUAGE) unset "$name" 2>/dev/null || true ;; esac
		done
		LC_ALL=C
		export LC_ALL
		exec git -c "safe.directory=$dir" -c core.fsmonitor=false -C "$dir" \
			describe --exact-match --match 'v[0-9]*' HEAD
	) >"$work/out" 2>"$work/err" </dev/null &
	pid=$!
	while kill -0 "$pid" 2>/dev/null; do
		if [ $(($(date +%s) - started)) -gt "$DEDALO_DESCRIBE_TIMEOUT_S" ]; then
			kill -9 "$pid" 2>/dev/null || true
			wait "$pid" 2>/dev/null || true
			rm -rf "$work"
			return 1
		fi
		sleep 0.1
	done
	wait "$pid" || status=$?
	out="$(tr -d '[:space:]' <"$work/out")"
	if [ "$status" -ne 0 ]; then
		out=''
		grep -qiE 'no tag exactly matches|no names found|cannot describe' "$work/err" || status=-1
	fi
	rm -rf "$work"
	[ "$status" -ge 0 ] || return 1
	printf '%s' "$out"
}

# --- the local build ------------------------------------------------------------
#
# THE ONE LOCAL BUILD (C3-46, owner 2026-10-14). The installer's stack_image
# (through deploy/dedalo-image-build.sh) and the image updater's build mode both
# build HERE, from a CLEAN SNAPSHOT of the checkout's last commit — never from
# the working tree. `git archive HEAD` is the mechanism the release archive and
# the production route use: committed files only (an uncommitted edit, an
# untracked file, .dedalo.env, deploy/certs never travel) and build_info.txt
# arrives EXPANDED (export-subst), so the engine reports the version the image
# is tagged with — never `X.Y.Z-dev` under an `:X.Y.Z` tag. A build straight
# from the checkout (`compose … -f deploy/compose.build.yml build`) reads the
# working tree and its unexpanded `$Format:` placeholder: it reports `-dev`.

# The snapshot's directory, inside the checkout's run dir (STACK_RUN_DIR,
# src/core/install/host/layout.ts — git-ignored and docker-ignored).
DEDALO_IMAGE_CONTEXT='.dedalo-install/image-context'

# dedalo_is_checkout DIR — status 0 when DIR is a git checkout (DIR/.git exists:
# a directory, or a file for a linked worktree — the installer's sourceIsGit).
dedalo_is_checkout() {
	[ -n "${1-}" ] && [ -e "$1/.git" ]
}

# dedalo_no_checkout_sentence DIR — the refusal of a build with no git to snapshot.
dedalo_no_checkout_sentence() {
	printf '%s is not a git checkout: a local image is built from a clean snapshot of a git commit (git archive), and a release tree has no commit to snapshot (it is its own build context only at install) — pull the image instead (DEDALO_IMAGE_MODE=pull), or install from a git checkout' "${1-this directory}"
}

# What a local build says it is (dedalo_image_labels): the project, not the checkout.
DEDALO_IMAGE_SOURCE='https://github.com/dedalia-org/dedalo'
DEDALO_IMAGE_URL='https://dedalo.dev'
DEDALO_IMAGE_DESCRIPTION='Dédalo — cultural heritage management system (engine, client and tools)'
DEDALO_IMAGE_LICENSES='AGPL-3.0-only'

# dedalo_image_labels CHECKOUT [TREE] — the OCI labels of a local build, one
# `key=value` per line (campaign 3b N1): without them the image inherits the
# base image's (`org.opencontainers.image.version=1.4.3-debian`, bun's source and
# revision), and the version label is what the updater and the installer read as
# "which release is this". version = the RELEASE IDENTITY of TREE (default: the
# checkout) spelled as an image tag (dedalo_image_tag_of — `7.0.0-beta.7`, or
# `7.0.0-dev` for an untagged commit): what the engine inside the image will call
# itself, never whatever the image is tagged (C3i-F1: a beta built as `:7.0.0`
# was labelled `7.0.0` and passed for the stable release). The builder passes
# the snapshot it builds, so the label is read from the very bytes docker gets.
# revision and created = the checkout's HEAD; source, url, description and
# licenses = Dédalo's own (DEDALO_IMAGE_SOURCE …), never the base image's and
# never blank (campaign 3c D6: a local build carried four empty labels). source
# is the project's repository — the published source a local build's revision
# belongs to; licenses = package.json's (gate: install_stack_steps_native).
# Status 1 when TREE declares no version or the checkout has no commit.
dedalo_image_labels() {
	local checkout="${1-}" tree="${2:-${1-}}" identity='' version='' meta=''
	identity="$(dedalo_release_identity "$tree")" || return 1
	version="$(dedalo_image_tag_of "$identity")" || return 1
	meta="$(git -c "safe.directory=$checkout" -c core.fsmonitor=false -C "$checkout" \
		log -1 --format='%H %cI' HEAD)" || return 1
	printf '%s\n' \
		'org.opencontainers.image.title=Dédalo' \
		"org.opencontainers.image.version=$version" \
		"org.opencontainers.image.revision=${meta%% *}" \
		"org.opencontainers.image.created=${meta#* }" \
		"org.opencontainers.image.source=$DEDALO_IMAGE_SOURCE" \
		"org.opencontainers.image.url=$DEDALO_IMAGE_URL" \
		"org.opencontainers.image.description=$DEDALO_IMAGE_DESCRIPTION" \
		"org.opencontainers.image.licenses=$DEDALO_IMAGE_LICENSES"
}

# dedalo_tag_part REF — the tag of an image reference (empty when it has none: a
# colon followed by a path is a registry port, not a tag).
dedalo_tag_part() {
	local part="${1##*:}"
	case "$part" in "$1" | */*) part='' ;; esac
	printf '%s' "$part"
}

# dedalo_image_build CHECKOUT TAG [DOCKER] — `DOCKER build --tag TAG` of the
# checkout's HEAD: archived and extracted into CHECKOUT/DEDALO_IMAGE_CONTEXT
# (git with safe.directory for this one command — root builds an operator's
# checkout — and fsmonitor off), the tarball removed before the build reads the
# dir, the dir removed after the build, green or red. The build's own output is
# passed through (BUILDKIT_PROGRESS from the caller). The image's OCI labels are
# its own (dedalo_image_labels over the snapshot), never the base image's. A TAG
# that names another release than the snapshot's identity is BUILT (the tag is
# the operator's name for it) but SAID: the label tells the truth. Status: 0
# built, 1 failed, 2 usage, 3 refused (no git, or a -dev tag — the sentence on stderr).
dedalo_image_build() {
	local checkout="${1-}" tag="${2-}" docker="${3:-docker}" dir='' status=0 line='' label='' named=''
	local labels=()
	[ -n "$checkout" ] && [ -n "$tag" ] || return 2
	# Docker has no nightly images (VERSIONING_SPEC §2, S3): no -dev tag is ever built.
	if dedalo_is_dev_tag "$(dedalo_tag_part "$tag")"; then
		printf 'refused: %s is a developer tag — Docker has no nightly images, so no image is built for it\n' "$tag" >&2
		return 3
	fi
	if ! dedalo_is_checkout "$checkout"; then
		dedalo_no_checkout_sentence "$checkout" >&2
		printf '\n' >&2
		return 3
	fi
	dir="$checkout/$DEDALO_IMAGE_CONTEXT"
	rm -rf "$dir" "$dir.tar" && mkdir -p "$dir" || return 1
	if git -c "safe.directory=$checkout" -c core.fsmonitor=false -C "$checkout" \
		archive --format=tar -o "$dir.tar" HEAD && tar -xf "$dir.tar" -C "$dir" && rm -f "$dir.tar" &&
		line="$(dedalo_image_labels "$checkout" "$dir")"; then
		while IFS= read -r label; do labels+=(--label "$label"); done <<<"$line"
		named="$(printf '%s\n' "$line" | sed -n 's/^org\.opencontainers\.image\.version=//p')"
		if [ "$(dedalo_tag_part "$tag")" != "$named" ]; then
			printf 'note: %s holds a commit that calls itself %s — its version label says so\n' "$tag" "$named" >&2
		fi
		"$docker" build --tag "$tag" "${labels[@]}" "$dir" || status=$?
	else
		printf 'could not archive the last commit of %s\n' "$checkout" >&2
		status=1
	fi
	rm -rf "$dir" "$dir.tar"
	[ "$status" -eq 0 ] || return 1
}

# --- compose --------------------------------------------------------------------

# dedalo_compose_args ENVFILE [plain|build] — the compose argv, one per line:
#   -f <DEDALO_COMPOSE_FILE> [-f deploy/compose.build.yml] [-f compose.override.yaml]
#   --env-file <ENVFILE>
# The env file is MANDATORY and must exist: it carries the TLS decision and the
# image pin, and a compose command without it resolves the built-in defaults.
# The installer's override joins only when it exists (an install made by hand has none).
dedalo_compose_args() {
	local env_file="${1-}" variant="${2-plain}" stack=''
	[ -n "$env_file" ] && [ -f "$env_file" ] || return 1
	case "$env_file" in *$'\n'*) return 1 ;; esac
	stack="$(dedalo_env_get "$env_file" DEDALO_COMPOSE_FILE)"
	[[ "$stack" =~ $DEDALO_COMPOSE_FILE_RE ]] && [ -f "$stack" ] || return 1
	printf '%s\n' -f "$stack"
	case "$variant" in
		plain) : ;;
		build) printf '%s\n' -f "$DEDALO_BUILD_OVERRIDE" ;;
		*) return 2 ;;
	esac
	if [ -f "$DEDALO_INSTALL_OVERRIDE" ]; then printf '%s\n' -f "$DEDALO_INSTALL_OVERRIDE"; fi
	printf '%s\n' --env-file "$env_file"
}

# dedalo_compose ENVFILE plain|build ARGS… — `docker compose` with those argv.
dedalo_compose() {
	local env_file="${1-}" variant="${2-}" listed='' line=''
	local compose_argv=()
	shift 2 || return 2
	listed="$(dedalo_compose_args "$env_file" "$variant")" || return 1
	while IFS= read -r line; do compose_argv+=("$line"); done <<<"$listed"
	docker compose "${compose_argv[@]}" "$@"
}

# --- the official registries ----------------------------------------------------

# dedalo_registries_load FILE — reset, then source the GENERATED list
# (deploy/image_registries.sh). Status 1 when it is missing or inconsistent.
dedalo_registries_load() {
	local file="${1-}"
	DEDALO_REGISTRY_IDS=()
	DEDALO_REGISTRY_LABELS=()
	DEDALO_REGISTRY_ROLES=()
	DEDALO_REGISTRY_REPOSITORIES=()
	DEDALO_IMAGE_SIGNING_ISSUER=''
	DEDALO_IMAGE_SIGNING_IDENTITY_REGEXP=''
	[ -f "$file" ] || return 1
	# shellcheck source=deploy/image_registries.sh
	. "$file"
	dedalo_registries_consistent
}

dedalo_registries_consistent() {
	local count="${#DEDALO_REGISTRY_IDS[@]}"
	[ "${#DEDALO_REGISTRY_LABELS[@]}" -eq "$count" ] &&
		[ "${#DEDALO_REGISTRY_ROLES[@]}" -eq "$count" ] &&
		[ "${#DEDALO_REGISTRY_REPOSITORIES[@]}" -eq "$count" ]
}

dedalo_registry_count() {
	echo "${#DEDALO_REGISTRY_IDS[@]}"
}

# dedalo_offered_registries — one TAB-separated line per PROVISIONED official
# registry, in the generated order (primary first, then the mirrors):
#   <index> <id> <label> <role> <repository>
dedalo_offered_registries() {
	local i=0 count=''
	count="$(dedalo_registry_count)"
	while [ "$i" -lt "$count" ]; do
		printf '%s\t%s\t%s\t%s\t%s\n' "$i" "${DEDALO_REGISTRY_IDS[i]}" "${DEDALO_REGISTRY_LABELS[i]}" \
			"${DEDALO_REGISTRY_ROLES[i]}" "${DEDALO_REGISTRY_REPOSITORIES[i]}"
		i=$((i + 1))
	done
}

# dedalo_official_index REPOSITORY — the index of the official registry that
# repository IS (normalized), printed; status 1 for a repository of your own.
dedalo_official_index() {
	local wanted='' i=0 count=''
	wanted="$(dedalo_repository_normalize "${1-}")"
	count="$(dedalo_registry_count)"
	while [ "$i" -lt "$count" ]; do
		if [ "$(dedalo_repository_normalize "${DEDALO_REGISTRY_REPOSITORIES[i]}")" = "$wanted" ]; then
			echo "$i"
			return 0
		fi
		i=$((i + 1))
	done
	return 1
}

# dedalo_image_available REPOSITORY:TAG — 0 available, 1 absent, 2 unknown (no
# network, no permission, no tool). `docker manifest inspect` first, then
# `docker buildx imagetools inspect`; only a registry SAYING "not found" is absent.
dedalo_image_available() {
	local ref="${1-}" said='' absent='false'
	if said="$(docker manifest inspect "$ref" 2>&1 >/dev/null)"; then return 0; fi
	if dedalo_says_absent "$said"; then absent='true'; fi
	if said="$(docker buildx imagetools inspect "$ref" 2>&1 >/dev/null)"; then return 0; fi
	if dedalo_says_absent "$said"; then absent='true'; fi
	if [ "$absent" = 'true' ]; then return 1; fi
	return 2
}

dedalo_says_absent() {
	printf '%s' "${1-}" | grep -qiE 'no such manifest|manifest unknown|not found'
}

# dedalo_probe_registries VERSION — one availability code per official registry
# (dedalo_image_available over <repository>:VERSION), one per line, in order.
dedalo_probe_registries() {
	local version="${1-}" i=0 count='' code=0
	count="$(dedalo_registry_count)"
	while [ "$i" -lt "$count" ]; do
		code=0
		dedalo_image_available "${DEDALO_REGISTRY_REPOSITORIES[i]}:$version" || code=$?
		echo "$code"
		i=$((i + 1))
	done
}

# dedalo_default_source CODE… — the index of the first official registry whose
# code is 0 (available), else `build`: the published image when this version is
# published, a local build when it is not. Pure: the codes are its input.
dedalo_default_source() {
	local i=0 code=''
	for code in "$@"; do
		if [ "$code" = '0' ]; then
			echo "$i"
			return 0
		fi
		i=$((i + 1))
	done
	echo build
}

# --- the image's identity ---------------------------------------------------------

# dedalo_repo_digest REPOSITORY TAG — the registry digest (sha256:…) a pulled
# image carries for THAT repository; status 1 when it has none (a local build).
dedalo_repo_digest() {
	local wanted='' listed='' line='' digest=''
	wanted="$(dedalo_repository_normalize "${1-}")"
	listed="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${1-}:${2-}" 2>/dev/null)" || return 1
	while IFS= read -r line; do
		[ -n "$line" ] || continue
		if [ "$(dedalo_repository_normalize "${line%@*}")" = "$wanted" ]; then digest="${line##*@}"; fi
	done <<<"$listed"
	dedalo_digest_grammar "$digest" || return 1
	printf '%s' "$digest"
}

# dedalo_cosign_verify REPOSITORY@sha256:… — `cosign verify` against the OFFICIAL
# signing identity (the generated list). Status 1 when it does not verify, when
# cosign is missing, or when no identity was loaded: never "verified by default".
dedalo_cosign_verify() {
	local ref="${1-}"
	dedalo_digest_grammar "${ref##*@}" && dedalo_repository_grammar "${ref%@*}" || return 1
	[ -n "$DEDALO_IMAGE_SIGNING_ISSUER" ] && [ -n "$DEDALO_IMAGE_SIGNING_IDENTITY_REGEXP" ] || return 1
	command -v cosign >/dev/null 2>&1 || return 1
	cosign verify \
		--certificate-identity-regexp "$DEDALO_IMAGE_SIGNING_IDENTITY_REGEXP" \
		--certificate-oidc-issuer "$DEDALO_IMAGE_SIGNING_ISSUER" \
		"$ref" >/dev/null
}

# dedalo_image_version_label REPOSITORY TAG — the `org.opencontainers.image.version`
# label of the pulled image REPOSITORY:TAG (the release workflow stamps the tag it
# publishes under). The label lives in the image config, which the signed digest
# covers, so after a verify it is the signer's word, not the registry's.
dedalo_image_version_label() {
	docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "${1-}:${2-}" 2>/dev/null
}

# dedalo_verify_release REPOSITORY DIGEST TAG — the official signature on
# REPOSITORY@DIGEST AND the signed image declaring TAG as its version. A signature
# alone proves only that SOME official run built the bytes: a registry whose tag
# pointers someone else controls could name an older signed release (or a
# developer image) `:<newer version>` and walk an installation backwards past
# every version floor. Status 1 on either failure.
dedalo_verify_release() {
	local declared=''
	dedalo_cosign_verify "${1-}@${2-}" || return 1
	declared="$(dedalo_image_version_label "${1-}" "${3-}")" || return 1
	[ -n "$declared" ] && [ "$declared" = "${3-}" ]
}

# --- one run at a time ------------------------------------------------------------

# dedalo_lock_acquire DIR NAME — a portable lock (mkdir is atomic everywhere;
# macOS has no flock): DIR/.NAME.lock holding the holder's pid. A lock whose
# recorded pid is dead is stale and taken over; one with no pid yet is held.
dedalo_lock_acquire() {
	local lock="${1-}/.${2-}.lock" pid=''
	if mkdir "$lock" 2>/dev/null; then
		echo "$$" >"$lock/pid"
		return 0
	fi
	pid="$(cat "$lock/pid" 2>/dev/null || true)"
	if ! [[ "$pid" =~ ^[0-9]+$ ]] || dedalo_pid_alive "$pid"; then return 1; fi
	rm -rf "$lock"
	mkdir "$lock" 2>/dev/null || return 1
	echo "$$" >"$lock/pid"
}

dedalo_pid_alive() {
	kill -0 "$1" 2>/dev/null || ps -p "$1" >/dev/null 2>&1
}

# dedalo_lock_release DIR NAME — only the holder removes the lock.
dedalo_lock_release() {
	local lock="${1-}/.${2-}.lock"
	if [ "$(cat "$lock/pid" 2>/dev/null || true)" = "$$" ]; then rm -rf "$lock"; fi
}
