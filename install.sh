#!/bin/sh
# Dédalo v7 — THE INSTALLER'S BOOTSTRAP (terminal installer phase 4, 2026-10-12).
#
#   sh install.sh [--release <file|https-url> --release-sha256 <sha256>]
#                 [--offline-bun <bun zip> [<SHASUMS256.txt>]] [--mirror <https base url>]
#                 [--] [installer arguments…]
#
# Operator guides: docs/install/installer_reference.md (every route and flag),
# docs/install/quickstart.md, docs/install/production.md, docs/install/docker.md.
#
# WHAT IT DOES, AND ONLY THIS. Every install — production, docker, trial,
# developer — is the ONE TypeScript installer (scripts/install.ts): its
# questions, its plan, its steps, its resume. This file only gets it running:
#
#   1. a Linux host (glibc) on x86_64 or aarch64 — every route; or macOS (Apple
#      silicon or Intel) — the docker and trial routes, through Docker Desktop
#      (the production route is Linux-only: the installer's System check says
#      so). Anything else is refused. `--route production` on a Linux system
#      the production route does not support is refused HERE, before anything
#      is downloaded or installed, with the installer's own sentence (campaign
#      3 C3-24; the TypeScript System check stays the authority — the table
#      below is its twin, held equal by the gate);
#   2. THE RELEASE: the checkout this file sits in (proven to be a Dédalo tree),
#      or --release: an archive (.zip as the code server cuts it, or .tar.gz)
#      HASHED BEFORE ANYTHING READS IT and refused unless it equals
#      --release-sha256 — there is no "confirm on the terminal" instead: a yes
#      is not integrity. Its member names are checked (relative, no `..`), then
#      it is extracted into a private stage. Release FIRST: the Bun pin and the
#      hash table below come from the verified release, never from elsewhere;
#   3. BUN AT THE RELEASE'S PIN (.bun-version): the zip of this host's asset is
#      checked against the hash table COMMITTED in the release (.bun-sha256,
#      derived from Bun's signed SHASUMS256.txt.asc — a mirror cannot substitute
#      bytes; on macOS its twin .bun-sha256-darwin, the same signed payload's
#      darwin rows); Bun's own SHASUMS256.txt, when fetched or given, must AGREE or
#      both are refused. The verified zip is CACHED and re-hashed against the
#      table on every reuse (a cached binary is never trusted by its --version);
#      the binary is unpacked from it afresh each run. Production's host steps
#      install the instance runtime from this same verified zip;
#   4. the installer's own dependencies (a release carries no node_modules):
#      `bun install --frozen-lockfile --production --ignore-scripts`, only when
#      the tree has none. Under sudo in a checkout that is NOT root's (an
#      operator's clone), they are installed BY THAT CHECKOUT'S OWNER (runuser,
#      a root-owned copy of the verified Bun it can run): root never writes in
#      a user's tree (campaign 3 C3-24 — a root-owned node_modules the user
#      could not `git clean`, and a 400 MB /root/.bun). Root installing into its
#      own tree (a staged --release) keeps Bun's package cache under the cache
#      root below, never in /root/.bun;
#   5. `exec bun scripts/install.ts <your arguments>` — stdin and the terminal
#      are the installer's; your arguments reach it unchanged. Bun starts with
#      --no-env-file (no stray .env), --no-install and the release's own
#      bunfig (never one from the directory you run this in).
#
# THE CACHE: as root /var/lib/dedalo-install (the host's install state root,
# 0755; bun/<pin>/ and release/<sha256>/ under it 0700); otherwise
# ${XDG_CACHE_HOME:-~/.cache}/dedalo-install (0700). Production needs root:
# `sudo sh install.sh …` (the installer itself says so when it is not).
#
# Library mode (the gates): `set -- --lib; . ./install.sh` defines the
# functions and runs nothing. POSIX sh: no bash-isms, no `local`. Functions
# return or die (exit 3); every `$(…)` that can die ends `|| exit 3`.
# Gates: test/unit/install_bootstrap_sh.test.ts (owner: the gates package).
#
# Exit codes: 3 refused here; otherwise the installer's own.

set -eu

# ── constants (the host agent's twins: publication/host_agent/deploy/install.sh) ──
BUN_ASSETS='bun-linux-aarch64 bun-linux-x64-baseline bun-linux-x64 bun-darwin-aarch64 bun-darwin-x64-baseline bun-darwin-x64'
BUN_RELEASE_BASE=https://github.com/oven-sh/bun/releases/download
PIN_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
TABLE_PIN_RE='^# bun-v[0-9]+\.[0-9]+\.[0-9]+$'
TABLE_SIGNED_BY_RE='^# signed-by: [0-9A-F]{40}$'
SHA256_RE='^[0-9a-f]{64}$'
ROOT_CACHE=/var/lib/dedalo-install
# The files that make a directory a Dédalo tree this bootstrap can start.
TREE_FILES='scripts/install.ts .bun-version .bun-sha256 package.json bun.lock'
# The production route's systems (<ID>:<VERSION_ID or its major>) and their words — the
# twins of src/core/install/host/os_support.ts OS_ROWS / supportedOsList (gate-held equal).
SUPPORTED_PRODUCTION='ubuntu:26.04 debian:13 rhel:10 rocky:10 almalinux:10'
SUPPORTED_PRODUCTION_WORDS='Ubuntu 26.04 LTS, Debian 13 (trixie), RHEL / Rocky Linux / AlmaLinux 10'

die() {
	printf 'install.sh: %s\n' "$*" >&2
	exit 3
}

say() {
	printf '%s\n' "$*" >&2
}

# ── the host ──────────────────────────────────────────────────────────────────

# refuse_kernel <uname -s>: Linux (every route) or Darwin (docker and trial through
# Docker Desktop — the production route's own System check refuses a Mac).
refuse_kernel() {
	case "$1" in
		Linux | Darwin) ;;
		*) die "this installer runs on Linux, or on macOS for the trial and Docker routes (this is $1) — see docs/install/quickstart.md" ;;
	esac
}

# refuse_musl <uname -s>: Bun ships no musl build this pin table names (Linux only).
refuse_musl() {
	[ "$1" = Linux ] || return 0
	for _musl in /lib/ld-musl-*; do
		[ -e "$_musl" ] && die "musl libc ($_musl): no supported Bun build — use a glibc distribution"
	done
	return 0
}

# pick_asset <uname -m> <cpuinfo file>: the Bun asset of this CPU.
pick_asset() {
	case "$1" in
		x86_64)
			if grep -qw avx2 "$2" 2>/dev/null; then echo bun-linux-x64; else echo bun-linux-x64-baseline; fi
			;;
		aarch64 | arm64) echo bun-linux-aarch64 ;;
		*) die "no Bun build for CPU '$1'" ;;
	esac
}

# pick_darwin_asset <uname -m> <avx2: yes|no>: the macOS Bun asset of this CPU.
pick_darwin_asset() {
	case "$1" in
		arm64 | aarch64) echo bun-darwin-aarch64 ;;
		x86_64)
			if [ "$2" = yes ]; then echo bun-darwin-x64; else echo bun-darwin-x64-baseline; fi
			;;
		*) die "no Bun build for CPU '$1'" ;;
	esac
}

# darwin_avx2: yes when this Intel Mac's CPU has AVX2 (sysctl), else no.
darwin_avx2() {
	case " $(sysctl -n machdep.cpu.leaf7_features 2>/dev/null || true) " in
		*" AVX2 "*) echo yes ;;
		*) echo no ;;
	esac
}

# host_asset <uname -s> <uname -m>: the Bun asset of this host.
host_asset() {
	if [ "$1" = Darwin ]; then
		pick_darwin_asset "$2" "$(darwin_avx2)"
	else
		pick_asset "$2" /proc/cpuinfo
	fi
}

# hash_table <tree> <uname -s>: the committed table that vouches for this host's asset.
hash_table() {
	if [ "$2" = Darwin ]; then
		[ -f "$1/.bun-sha256-darwin" ] || die "$1 is not a Dédalo release for macOS (no .bun-sha256-darwin)"
		echo "$1/.bun-sha256-darwin"
	else
		echo "$1/.bun-sha256"
	fi
}

# $SHA256 <file> prints '<hex>  <file>'. Resolved once: sha256sum, else shasum -a 256.
resolve_sha256() {
	if command -v sha256sum >/dev/null 2>&1; then
		SHA256=sha256sum
	elif command -v shasum >/dev/null 2>&1; then
		SHA256='shasum -a 256'
	else
		die 'no sha256sum (coreutils) on this host'
	fi
}

# require_tool <command> <why>: the tool is on PATH, or die naming the package to install.
# The bootstrap runs BEFORE host_packages, so what it needs the host must already have.
require_tool() {
	command -v "$1" >/dev/null 2>&1 \
		|| die "$1 is not installed and is needed $2 — install it first (Debian/Ubuntu: apt-get install $1; RHEL family: dnf install $1)"
}

sha_of() {
	# shellcheck disable=SC2086 # $SHA256 is a command with its arguments
	$SHA256 "$1" | cut -d' ' -f1
}

# cache_root <uid>: where verified downloads are kept.
cache_root() {
	if [ "$1" = 0 ]; then
		echo "$ROOT_CACHE"
	else
		echo "${XDG_CACHE_HOME:-${HOME:?HOME is not set}/.cache}/dedalo-install"
	fi
}

# prepare_cache <dir> <uid>: the cache root. As root it is the host's install state
# root, 0755 (the installer serves the Let's Encrypt challenge from a directory
# under it — its own subdirectories are 0700); otherwise the user's own, 0700.
prepare_cache() {
	[ ! -L "$1" ] || die "$1 is a symbolic link: refused"
	if [ "$2" != 0 ]; then
		private_dir "$1"
		return 0
	fi
	mkdir -p "$1" || die "cannot create $1"
	chmod 0755 "$1" || die "cannot set the mode of $1"
}

# private_dir <dir>: create it (and parents) and make it 0700.
private_dir() {
	mkdir -p "$1" || die "cannot create $1"
	chmod 0700 "$1" || die "cannot make $1 private"
}

# fetch <https url> <file> <max bytes>: https only, redirects included.
fetch() {
	case "$1" in https://*) ;; *) die "refusing a non-https download: $1" ;; esac
	require_tool curl "to download $1"
	curl -fsSL --proto =https --proto-redir =https --tlsv1.2 --max-filesize "$3" -o "$2" "$1" \
		|| die "download failed: $1"
}

# ── the release ───────────────────────────────────────────────────────────────

# check_tree <dir>: a Dédalo tree this bootstrap can start, or die.
check_tree() {
	for _file in $TREE_FILES; do
		[ -f "$1/$_file" ] || die "$1 is not a Dédalo release (no $_file)"
	done
}

# member_names_ok <names file>: every archive member relative, no '.'/'..' segment.
member_names_ok() {
	! grep -Eq '^/|(^|/)\.\.?(/|$)' "$1"
}

# archive_kind <name>: zip | tgz, or die.
archive_kind() {
	case "$1" in
		*.zip) echo zip ;;
		*.tar.gz | *.tgz) echo tgz ;;
		*) die "--release must be a .zip or a .tar.gz archive: $1" ;;
	esac
}

# list_members <kind> <archive> <names file>
list_members() {
	if [ "$1" = zip ]; then
		unzip -Z1 "$2" >"$3" || die 'cannot list the release archive'
	else
		tar -tzf "$2" >"$3" || die 'cannot list the release archive'
	fi
}

# extract_members <kind> <archive> <dir>
extract_members() {
	if [ "$1" = zip ]; then
		unzip -q -o "$2" -d "$3" || die 'cannot extract the release archive'
	else
		tar -xzf "$2" -C "$3" --no-same-owner || die 'cannot extract the release archive'
	fi
}

# tree_root <extracted dir>: the tree itself, or its ONE top-level directory (dedalo_code/).
tree_root() {
	if [ -f "$1/scripts/install.ts" ]; then
		echo "$1"
		return 0
	fi
	_found=''
	for _child in "$1"/*; do
		if [ -f "$_child/scripts/install.ts" ]; then
			[ -z "$_found" ] || die 'the release archive holds more than one tree'
			_found=$_child
		fi
	done
	[ -n "$_found" ] || die 'the release archive holds no Dédalo tree (no scripts/install.ts)'
	echo "$_found"
}

# stage_release <file|https-url> <sha256> <cache>: the verified, extracted tree's path.
stage_release() {
	printf '%s\n' "$2" | grep -Eq "$SHA256_RE" \
		|| die '--release needs --release-sha256 <the sha256 the release was published with> (64 hex digits)'
	_kind=$(archive_kind "$1") || exit 3
	_stage=$3/release/$2
	private_dir "$_stage"
	_archive=$_stage/release.$_kind
	case "$1" in
		https://*) fetch "$1" "$_archive" 2000000000 ;;
		*) cp "$1" "$_archive" || die "cannot read $1" ;;
	esac
	_got=$(sha_of "$_archive") || exit 3
	[ "$_got" = "$2" ] || {
		rm -f "$_archive"
		die "the release archive has sha256 $_got, not $2: refused (nothing was extracted)"
	}
	list_members "$_kind" "$_archive" "$_stage/members"
	member_names_ok "$_stage/members" || die 'the release archive names a member outside itself: refused'
	rm -rf "$_stage/tree"
	private_dir "$_stage/tree"
	extract_members "$_kind" "$_archive" "$_stage/tree"
	tree_root "$_stage/tree"
}

# read_pin <tree>: the one x.y.z line of .bun-version.
read_pin() {
	[ "$(wc -l <"$1/.bun-version" | tr -d ' ')" -le 1 ] || die '.bun-version holds more than one line'
	_pin=$(tr -d '\r\n' <"$1/.bun-version")
	printf '%s\n' "$_pin" | grep -Eq "$PIN_RE" || die ".bun-version '$_pin' is not <major>.<minor>.<patch>"
	echo "$_pin"
}

# ── Bun ───────────────────────────────────────────────────────────────────────

# verify_bun_zip <zip> <sums|-> <asset> <pin> <table>: the committed table, then the
# cross-check. Dies on any disagreement (the zip is removed: it is not the release).
verify_bun_zip() {
	_zip=$1 _sums=$2 _asset=$3 _pin=$4 _table=$5
	case " $BUN_ASSETS " in
		*" $_asset "*) ;;
		*) die "'$_asset' is not a Bun asset ($BUN_ASSETS)" ;;
	esac
	printf '%s\n' "$_pin" | grep -Eq "$PIN_RE" || die "pin '$_pin' is not <major>.<minor>.<patch>"
	[ -f "$_table" ] || die "no hash table $_table"
	sed -n 1p "$_table" | grep -Eq "$TABLE_PIN_RE" || die ".bun-sha256 line 1 is not '# bun-v<pin>'"
	[ "$(sed -n 1p "$_table")" = "# bun-v$_pin" ] \
		|| die ".bun-sha256 line 1 is not '# bun-v$_pin' (table and .bun-version disagree)"
	sed -n 2p "$_table" | grep -Eq "$TABLE_SIGNED_BY_RE" || die ".bun-sha256 line 2 is not '# signed-by: <fingerprint>'"
	_n=$(grep -Ec "^[0-9a-f]{64}  $_asset\\.zip\$" "$_table") || true
	[ "$_n" = 1 ] || die ".bun-sha256 names $_asset.zip $_n times (exactly once required)"
	_want=$(grep -E "^[0-9a-f]{64}  $_asset\\.zip\$" "$_table" | cut -d' ' -f1)
	[ -f "$_zip" ] || die "no archive $_zip"
	_got=$(sha_of "$_zip") || exit 3
	[ "$_got" = "$_want" ] || {
		rm -f "$_zip"
		die "$_asset.zip has sha256 $_got, .bun-sha256 says $_want: not the pinned release (removed)"
	}
	[ "$_sums" = - ] && return 0
	[ -f "$_sums" ] || die "no SHASUMS file $_sums"
	_n=$(grep -c "  $_asset\\.zip\$" "$_sums") || true
	[ "$_n" = 1 ] || die "SHASUMS256.txt names $_asset.zip $_n times (exactly once required)"
	_line=$(grep "  $_asset\\.zip\$" "$_sums" | tr -d '\r')
	[ "$_line" = "$_want  $_asset.zip" ] || {
		rm -f "$_zip"
		die "SHASUMS256.txt disagrees with .bun-sha256 for $_asset.zip: refusing both"
	}
}

# obtain_bun_zip <dir> <asset> <pin>: the zip into <dir> (offline copy, the cache, or a
# download with Bun's SHASUMS256.txt beside it). Prints the sums file, or '-'.
obtain_bun_zip() {
	_zip=$1/$2.zip
	if [ -n "$OFFLINE_BUN" ]; then
		cp "$OFFLINE_BUN" "$_zip" || die "cannot copy $OFFLINE_BUN"
		[ -n "$OFFLINE_SUMS" ] || { echo -; return 0; }
		cp "$OFFLINE_SUMS" "$1/SHASUMS256.txt" || die "cannot copy $OFFLINE_SUMS"
		echo "$1/SHASUMS256.txt"
		return 0
	fi
	if [ -s "$_zip" ]; then
		echo -
		return 0
	fi
	_base=${MIRROR:-$BUN_RELEASE_BASE}
	fetch "$_base/bun-v$3/$2.zip" "$_zip" 200000000
	fetch "$_base/bun-v$3/SHASUMS256.txt" "$1/SHASUMS256.txt" 1000000
	echo "$1/SHASUMS256.txt"
}

# unpack_bun <zip> <asset> <dir> <pin>: the binary, unpacked afresh, answering the pin.
unpack_bun() {
	rm -rf "$3"
	private_dir "$3"
	unzip -q -o -j "$1" "$2/bun" -d "$3" || die "unzip of $2.zip failed"
	chmod 0755 "$3/bun" || die "cannot make $3/bun executable"
	_said=$("$3/bun" --version 2>/dev/null) || die "bun --version failed (a noexec filesystem under $3, or a glibc older than Bun needs)"
	[ "$_said" = "$4" ] || die "bun --version says '$_said', the pin is $4"
}

# provide_bun <tree> <pin> <asset> <cache> [<table>]: the path of a verified Bun at the pin
# (<table>: the committed hash table of this host — .bun-sha256 unless given).
provide_bun() {
	_dir=$4/bun/$2
	private_dir "$_dir"
	_sums=$(obtain_bun_zip "$_dir" "$3" "$2") || exit 3
	verify_bun_zip "$_dir/$3.zip" "$_sums" "$3" "$2" "${5:-$1/.bun-sha256}"
	unpack_bun "$_dir/$3.zip" "$3" "$_dir/run" "$2"
	echo "$_dir/run/bun"
}

# tree_owner_uid <dir>: the uid that owns it (GNU stat, else BSD stat).
tree_owner_uid() {
	stat -c %u "$1" 2>/dev/null || stat -f %u "$1" 2>/dev/null || die "cannot read the owner of $1"
}

# deps_user <tree> <uid> <kernel>: the account that installs the tree's dependencies —
# its OWNER when root runs in a tree that is not root's (Linux); '' = this process.
deps_user() {
	[ "$2" = 0 ] && [ "$3" = Linux ] || return 0
	_owner=$(tree_owner_uid "$1") || exit 3
	[ "$_owner" != 0 ] || return 0
	_name=$(getent passwd "$_owner" | cut -d: -f1) || true
	[ -n "$_name" ] || die "$1 is owned by uid $_owner, which has no account — chown it to its user, or install from a --release archive"
	echo "$_name"
}

# shared_bun <bun> <cache> <pin>: a root-owned 0755 copy of the verified Bun another account
# can RUN (the verified cache is root's alone, 0700) — never one it can replace.
shared_bun() {
	mkdir -p "$2/bun-shared/$3" || die "cannot create $2/bun-shared/$3"
	chmod 0755 "$2/bun-shared" "$2/bun-shared/$3" || die "cannot set the mode of $2/bun-shared"
	cp "$1" "$2/bun-shared/$3/bun" || die "cannot copy Bun to $2/bun-shared/$3"
	chmod 0755 "$2/bun-shared/$3/bun" || die "cannot make $2/bun-shared/$3/bun executable"
	echo "$2/bun-shared/$3/bun"
}

# install_deps <bun> <tree> <uid> <cache> <kernel> <pin>: the installer's dependencies, when
# the tree has none — as the tree's owner (deps_user), or as this process with root's
# package cache under <cache> (never /root/.bun).
install_deps() {
	[ -d "$2/node_modules" ] && return 0
	say 'Installing the installer'"'"'s dependencies (bun install --frozen-lockfile --production)…'
	_as=$(deps_user "$2" "$3" "$5") || exit 3
	if [ -n "$_as" ]; then
		require_tool runuser "to install the dependencies as $_as, the owner of $2"
		_run=$(shared_bun "$1" "$4" "$6") || exit 3
		say "  as $_as (the owner of $2: root never writes in it)"
		(cd "$2" && runuser -u "$_as" -- "$_run" install --frozen-lockfile --production --ignore-scripts ${DEPS_QUIET-}) \
			|| die 'bun install failed — see its output above (this host needs to reach the npm registry once)'
		return 0
	fi
	if [ "$3" = 0 ]; then
		(cd "$2" && BUN_INSTALL_CACHE_DIR="$4/bun-install-cache" "$1" install --frozen-lockfile --production --ignore-scripts ${DEPS_QUIET-}) \
			|| die 'bun install failed — see its output above (this host needs to reach the npm registry once)'
		return 0
	fi
	(cd "$2" && "$1" install --frozen-lockfile --production --ignore-scripts ${DEPS_QUIET-}) \
		|| die 'bun install failed — see its output above (this host needs to reach the npm registry once)'
}

# root_bun_env <uid> <cache>: as root, the installer's own Bun keeps nothing in /root/.bun —
# its runtime transpiler cache (Bun's default is ~/.bun/install/cache/@t@: campaign C4 left
# 4.4 MB there) is off, and a package cache, were one ever needed, sits under <cache>. The
# children the installer starts get a fixed environment (host/runner.ts): this reaches only it.
root_bun_env() {
	[ "$1" = 0 ] || return 0
	BUN_RUNTIME_TRANSPILER_CACHE_PATH=0
	BUN_INSTALL_CACHE_DIR="$2/bun-install-cache"
	export BUN_RUNTIME_TRANSPILER_CACHE_PATH BUN_INSTALL_CACHE_DIR
}

# plain_output [installer args…]: will the installer run in its plain line mode (--plain, TERM
# unset or dumb, stdout not a terminal)?
plain_output() {
	case "${TERM-}" in '' | dumb) return 0 ;; esac
	[ -t 1 ] || return 0
	for _arg in "$@"; do
		[ "$_arg" = --plain ] && return 0
	done
	return 1
}

# plain_colours [installer args…]: in the plain mode nothing the bootstrap runs may colour its
# output either (NO_COLOR, FORCE_COLOR=0 — the dependency install's bun honours them) nor draw
# a progress bar (DEPS_QUIET=--no-progress): the plain mode promises no escape sequence of any
# kind (campaign 3 C3-58, 3b N25).
plain_colours() {
	if plain_output "$@"; then
		export NO_COLOR=1 FORCE_COLOR=0
		# NO_COLOR does not cover cursor movement: the progress bar's ESC[<n>D / ESC[0K
		# reached the plain transcript (campaign 3b N25).
		DEPS_QUIET=--no-progress
	fi
}

# os_value <os-release file> <KEY>: one value, its quotes removed ('' when absent).
os_value() {
	sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n 1 | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//'
}

# wants_production [installer args…]: do the installer's arguments ask for the production route?
wants_production() {
	_prev=''
	for _arg in "$@"; do
		case "$_prev $_arg" in '--route production' | *' --route=production') return 0 ;; esac
		_prev=$_arg
	done
	return 1
}

# os_release_file: /etc/os-release — or, under the gates' scratch seam (the installer's own,
# host/scratch.ts), the scratch root's, which must carry its marker.
os_release_file() {
	_root=${DEDALO_INSTALL_HOST_ROOT:-}
	if [ -z "$_root" ]; then
		echo /etc/os-release
		return 0
	fi
	[ -d "$_root/.dedalo_install_scratch" ] || die "DEDALO_INSTALL_HOST_ROOT=$_root is not a scratch root (no .dedalo_install_scratch)"
	echo "$_root/etc/os-release"
}

# production_os_gate <os-release file> <kernel> [installer args…]: `--route production` on a
# Linux system the route does not support is refused before anything is fetched or installed.
production_os_gate() {
	_file=$1 _kernel=$2
	shift 2
	wants_production "$@" || return 0
	[ "$_kernel" = Linux ] || return 0
	_id=$(os_value "$_file" ID | tr '[:upper:]' '[:lower:]')
	_ver=$(os_value "$_file" VERSION_ID)
	case " $SUPPORTED_PRODUCTION " in
		*" $_id:$_ver "* | *" $_id:${_ver%%.*} "*) return 0 ;;
	esac
	_name=$(os_value "$_file" PRETTY_NAME)
	[ -n "$_name" ] || _name=${_id:-this system}
	die "$_name is not supported — the production route supports $SUPPORTED_PRODUCTION_WORDS (newest releases only)"
}

# bun_config <tree> <cache>: the release's own bunfig (an empty one when it has none).
bun_config() {
	if [ -f "$1/bunfig.toml" ]; then
		echo "$1/bunfig.toml"
		return 0
	fi
	: >"$2/empty.bunfig.toml" || die 'cannot write an empty bunfig'
	echo "$2/empty.bunfig.toml"
}

# ── the arguments ─────────────────────────────────────────────────────────────

RELEASE='' RELEASE_SHA='' OFFLINE_BUN='' OFFLINE_SUMS='' MIRROR=''

# need_value <flag> <count of remaining args>
need_value() {
	[ "$2" -ge 2 ] || die "$1 needs a value"
}

# The bootstrap's own flags come first; everything from the first other argument
# (or after `--`) is the installer's, passed through unchanged.
parse_args() {
	while [ $# -gt 0 ]; do
		case "$1" in
			--release) need_value "$1" $#; RELEASE=$2; shift 2 ;;
			--release-sha256) need_value "$1" $#; RELEASE_SHA=$2; shift 2 ;;
			--offline-bun)
				need_value "$1" $#
				OFFLINE_BUN=$2
				shift 2
				case "${1-}" in *SHASUMS256.txt) OFFLINE_SUMS=$1; shift ;; esac
				;;
			--mirror) need_value "$1" $#; MIRROR=$2; shift 2 ;;
			--wizard)
				die '--wizard is retired: the installer asks every question in the terminal (sh install.sh).'
				;;
			--) shift; break ;;
			*) break ;;
		esac
	done
	REST_COUNT=$#
}

if [ "${1-}" = --lib ]; then
	# shellcheck disable=SC2317 # library mode: sourced by the gates
	return 0 2>/dev/null || exit 0
fi

main() {
	KERNEL=$(uname -s)
	refuse_kernel "$KERNEL"
	refuse_musl "$KERNEL"
	OS_RELEASE=$(os_release_file) || exit 3
	production_os_gate "$OS_RELEASE" "$KERNEL" "$@"
	resolve_sha256
	require_tool unzip 'to unpack the Bun runtime'
	[ -z "$MIRROR" ] || case "$MIRROR" in https://*) ;; *) die '--mirror must start with https://' ;; esac
	[ -n "$RELEASE" ] || [ -z "$RELEASE_SHA" ] || die '--release-sha256 without --release'
	_uid=$(id -u)
	CACHE=$(cache_root "$_uid") || exit 3
	prepare_cache "$CACHE" "$_uid"
	if [ -n "$RELEASE" ]; then
		SRC=$(stage_release "$RELEASE" "$RELEASE_SHA" "$CACHE") || exit 3
	else
		SRC=$(cd "$(dirname "$0")" && pwd) || exit 3
	fi
	check_tree "$SRC"
	PIN=$(read_pin "$SRC") || exit 3
	ASSET=$(host_asset "$KERNEL" "$(uname -m)") || exit 3
	TABLE=$(hash_table "$SRC" "$KERNEL") || exit 3
	BUN=$(provide_bun "$SRC" "$PIN" "$ASSET" "$CACHE" "$TABLE") || exit 3
	plain_colours "$@"
	install_deps "$BUN" "$SRC" "$_uid" "$CACHE" "$KERNEL" "$PIN"
	CONFIG=$(bun_config "$SRC" "$CACHE") || exit 3
	root_bun_env "$_uid" "$CACHE"
}

parse_args "$@"
shift $(($# - REST_COUNT))
main "$@"
exec "$BUN" --no-env-file --no-install --config="$CONFIG" "$SRC/scripts/install.ts" "$@"
