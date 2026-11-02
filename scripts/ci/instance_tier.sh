#!/usr/bin/env bash
#
# INSTANCE CI TIER — the gates that BOOT A REAL SERVER over the wire, on a HOSTED
# runner: the browser client suite, the two code-update drills, the
# publication-host media drill (live Apache + nginx), the publication-host
# agent drill (the real agent over mTLS, live Apache + nginx, real v2 releases),
# the publication-host engine drill (engine ↔ real agent: pair CLI, panel, httpd),
# the public-URL probe drill, and the Bun hash table's signature check.
#
# WHY THIS EXISTS. Three commands the repo relies on ran on NO executing CI:
# scripts/ci/client_gate.sh (the 133-suite browser gate), `bun run test:update`
# and `bun run test:update:dev`. Each was invoked only from
# .github/workflows-selfhosted/, a directory GitHub does not read on a public repo
# (rule 5 of test/unit/ci_workflow_tripwire.test.ts — a self-hosted job there is
# RCE on the data host). "Wired" meant "never reached" (P0-1 residual, GATE-02/03/
# 14/15 of the 2026-08-26 deep audit). This script is their executing home; the
# `instance` job of .github/workflows/db.yml runs it on every PR and every push to
# master/v7, and test/unit/tier_wiring_tripwire.test.ts holds that wiring.
#
# WHY A TIER OF ITS OWN, and not two more stages of db_tier.sh. Every gate here
# STARTS A SERVER PROCESS on a port and drives it through HTTP — a browser, a code
# master, a supervised consumer that restarts itself mid-run. The db tier runs
# in-process gates. Different footprint (Chrome, zip/unzip, ~3 GB of TMPDIR for the
# consumer copy, network for the drill's quarantine `bun install`), different
# failure modes (a port, a socket path, a wedged child), and — decisive — a FRESH
# suite database: the db tier's 725-file unit stage pollutes the fixture it shares
# with everything after it (matrix_users grows with every full run, and the client
# baseline was measured on a clean fixture: AGENTS.md, "ALWAYS measure with the
# reseed on"). A second job with its own service container is that isolation.
#
# WHAT IT SHARES WITH THE DB TIER, by `source`: the whole composed environment
# (scripts/ci/hosted_env.sh — the required keys, the
# fixture-harvest configuration, the seam tables, the Postgres client path). One
# copy, so the two tiers cannot drift; the rules that pin it follow the `source`.
#
# NO `secrets.` REACHES THIS TIER — the same fork-safety property as db_tier.sh.
# THIS SCRIPT MUST NOT CALL hermetic.sh, for the reason db_tier.sh states.
#
# THE UPDATE DRILLS ON A RUNNER. scripts/update_drill.ts used to copy
# ../private/.env into the consumer's private dir and boot the master off the
# checkout's own file — a runner has neither. The drill now composes both from
# scripts/lib/operator_config.ts: the file if present, overlaid by the CATALOG
# keys of the process environment — never PATH, HOME or a runner's GITHUB_TOKEN
# (test/unit/update_drill_config_tripwire.test.ts asserts the negative).
#
# Usage: bash scripts/ci/instance_tier.sh   (from anywhere; cd's to repo root)
#
# Locally, run it the way the runner does — `bun run ci:local --instance` — and
# on macOS with `TMPDIR=/tmp/dd`: the drills bind unix sockets under TMPDIR and
# macOS caps that path at 104 bytes (AGENTS.md, test:update).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# The tier's own name in the composed environment; every other key is shared.
: "${ENTITY:=ci_instance_tier}"
export ENTITY

# shellcheck source=scripts/ci/hosted_env.sh
source scripts/ci/hosted_env.sh

echo "== instance_tier: bun $(bun --version) (pin: $(cat .bun-version))"
# --no-private-env for the same reason as db_tier.sh: the environment is composed
# above, no ../private/.env exists on the runner, and the guard still verifies the
# bun pin. ci_workflow_tripwire rule 13 forbids any command here that needs the file.
bash scripts/ci/env_guard.sh --no-private-env

echo "== instance_tier: build the suite database (from repo-vendored bytes)"
bun run test:db:setup

# ── THE STAGES ARE INDEPENDENT ───────────────────────────────────────────────
#
# Same law as the other two tiers: each stage records its own verdict and the tier
# reports every one of them. Under a bare `set -e` a red client suite would hide
# both drills — the 45-commit silence in another spelling. tier_wiring_tripwire
# holds the accumulator in place on every hosted tier script.
tier_status=0

# ── THE LANES ─────────────────────────────────────────────────────────────────
#
# The stages fall in three LANES that share nothing once each has its own database
# (measured 2026-10-31, ci:local --docker --instance, per stage: crawl 1170 s, phone
# 549 s, publication-host agent + engine 441 s, client 145 s, update drills 80 s):
#   client  — client suite, phone width, the three update drills (one suite DB, in order)
#   crawl   — the feature crawl (the long pole)
#   pubhost — the publication-host drills, the probe, the Bun pin (the agent and engine
#             drills share ONE exec seam and ONE MariaDB lane: in order, never apart)
# DEDALO_CI_INSTANCE_LANES=1 (the default; GitHub's db.yml) runs them one after another
# in the main shell on the suite database, client lane first. =3 (opt-in: ci:local
# --instance-lanes 3 — beside the db tier on a 7.6 GiB Docker VM it overran memory, 2026-10-31)
# runs them CONCURRENTLY, each on its own clone of the suite database
# (scripts/ci/instance_lanes.ts: FILE_COPY clone, marker rewritten, media twin, the
# template SEALED meanwhile); every process of a lane reaches its clone through
# DEDALO_TEST_DATABASE, and its own session store and state file. Each lane's output is
# held in a log and printed WHOLE when the lane ends, so every stage's markers stay
# contiguous for ci:local's parser; each stage reports its own wall time (`TOOK`),
# since the log's arrival time no longer measures it. Ports are fixed per stage
# (client 4420, crawl 4400, phone 4410, update drills 4391+, engine 4460): every runner
# probes "next free" and then binds, so two lanes starting at one floor could both win.
instance_lanes="${DEDALO_CI_INSTANCE_LANES:-1}"
export DEDALO_CI_CLIENT_PORT=4420
# The database whose suite MariaDB lane the publication-host stages start: the
# pubhost lane's clone when the lanes run concurrently ('' = the suite database).
mdb_db=""

took() { echo "== instance_tier: TOOK $((SECONDS - t0))s"; }

# The EXIT trap, set before ANY stage can start a server (tier_wiring_tripwire leg J;
# the stop stays the LAST command — chained, never a second trap): a lane still running
# is killed, the lane clones are swept and the template unsealed, then the suite
# MariaDB of the lane that started it is stopped.
trap 'kill $(jobs -p) 2>/dev/null || :; [ "$instance_lanes" -eq 1 ] || bun run scripts/ci/instance_lanes.ts sweep || :; [ -z "$mdb_db" ] || export DEDALO_TEST_DATABASE="$mdb_db"; bun run scripts/ci/suite_mariadb.ts stop >/dev/null 2>&1 || :' EXIT

# Point the rest of this (sub)shell at one lane database: everything a stage derives
# (media root, vector twin, MariaDB lane, run lock) follows DEDALO_TEST_DATABASE; the
# session store and the state file are scratch files hosted_env.sh names per RUN, so a
# lane gets its own.
in_lane() {
	export DEDALO_TEST_DATABASE="$1"
	export DEDALO_SESSION_DB_PATH="${TMPDIR:-/tmp}/dedalo_ci_sessions_$1.sqlite"
	export DEDALO_TS_STATE_PATH="${TMPDIR:-/tmp}/dedalo_ci_ts_state_$1.json"
}

lane_client() {
	# ── STAGE 1 — THE BROWSER CLIENT SUITE ───────────────────────────────────────
	#
	# scripts/ci/client_gate.sh starts its OWN server on the suite database, logs in
	# for real, pins the diffusion domain and the projects fixture, and drives the
	# Mocha suites in headless Chrome (scripts/client_test_runner.ts). The baseline
	# is IN the runner (`KNOWN_FAILING`, shrink-only; currently empty, so a plain run
	# equals --strict). Runs FIRST in its lane, on the fixture the suite build (or the
	# lane's clone of it) just produced.
	t0=$SECONDS
	echo "== instance_tier: browser client suite (scripts/ci/client_gate.sh)"
	client_rc=0
	bash scripts/ci/client_gate.sh || client_rc=$?
	[ "$client_rc" -eq 0 ] || { echo "== instance_tier: RED in the client suite (exit $client_rc)"; tier_status=1; }
	took

	# ── STAGE 1b — EVERY TOOL AT PHONE WIDTH ─────────────────────────────────────
	#
	# scripts/tool_viewport_check.ts: every tool at 360×740 on the same suite database
	# through the same verified server door as the client suite, real login, scratch
	# records swept. Ratchet: test/helpers/tool_phone_ratchet.ts.
	t0=$SECONDS
	echo "== instance_tier: tools at phone width (bun run test:tools:phone)"
	phone_rc=0
	bun run test:tools:phone --port 4410 || phone_rc=$?
	[ "$phone_rc" -eq 0 ] || { echo "== instance_tier: RED in the tool phone contract (exit $phone_rc)"; tier_status=1; }
	took

	# ── STAGE 2 — THE CODE UPDATER, RELEASE CHANNEL ──────────────────────────────
	#
	# A real master builds and serves the 7.0.1 release through the wire; a
	# git-archive copy of this checkout under a supervisor loop installs it across the
	# planned-death restart (scripts/update_drill.ts). Needs `git clone` of THIS
	# checkout, so the workflow checks out with fetch-depth: 0 — git refuses to clone
	# a shallow repository.
	t0=$SECONDS
	echo "== instance_tier: code updater drill, release channel (bun run test:update)"
	update_rc=0
	bun run test:update || update_rc=$?
	[ "$update_rc" -eq 0 ] || { echo "== instance_tier: RED in the release-channel update drill (exit $update_rc)"; tier_status=1; }
	took

	# ── STAGE 3 — THE CODE UPDATER, DEVELOPER CHANNEL ────────────────────────────
	#
	# The same drill with the release cut from a non-master branch and installed OVER
	# THE SAME VERSION — the only pass that proves the post-swap identity story, where
	# `/health`'s install_digest is what tells the new tree from a rolled-back one.
	# Both channels run: release-only would leave that proof to nobody.
	t0=$SECONDS
	echo "== instance_tier: code updater drill, developer channel (bun run test:update:dev)"
	update_dev_rc=0
	bun run test:update:dev || update_dev_rc=$?
	[ "$update_dev_rc" -eq 0 ] || { echo "== instance_tier: RED in the dev-channel update drill (exit $update_dev_rc)"; tier_status=1; }
	took

	# ── STAGE 3b — THE WHOLE UPDATE RUN ACROSS RELEASES ──────────────────────────
	#
	# scripts/update_full_drill.ts drives the update RUN (src/core/update/run/) with its
	# real effects on scratch surfaces of the suite database: ontology-min refusal → code
	# phase → ontology → schema → data rung → a SIGKILLed child mid-rung resumed by the
	# next process → a planted failing migration → NEEDS_DB_RESTORE. The code swap is a
	# seam there; stages 2-3 prove the real swap.
	t0=$SECONDS
	echo "== instance_tier: update run drill across releases (bun run test:update:full)"
	update_full_rc=0
	bun run test:update:full || update_full_rc=$?
	[ "$update_full_rc" -eq 0 ] || { echo "== instance_tier: RED in the full update-run drill (exit $update_full_rc)"; tier_status=1; }
	took
	return "$tier_status"
}

lane_crawl() {
	# ── STAGE 1c — EVERY FEATURE, AS EVERY PERSONA ───────────────────────────────
	#
	# scripts/feature_crawl.ts: root, a non-root global admin and a project-scoped
	# editor each walk their own menu (list + edit, components, inspector, tools),
	# the permission oracle refuses by direct URL, then the user journeys run.
	# Same suite database and server door. Baseline: test/helpers/feature_crawl_ratchet.ts.
	t0=$SECONDS
	echo "== instance_tier: feature crawl per persona (bun run test:crawl)"
	crawl_rc=0
	bun run test:crawl --port 4400 || crawl_rc=$?
	[ "$crawl_rc" -eq 0 ] || { echo "== instance_tier: RED in the feature crawl (exit $crawl_rc)"; tier_status=1; }
	took
	return "$tier_status"
}

lane_pubhost() {
	# ── STAGE 4 — THE PUBLICATION-HOST MEDIA RULES ON LIVE SERVERS ───────────────
	#
	# scripts/media_publication_host_drill.ts renders the publication-host include with the
	# ENGINE's builders and drives the curl matrix (engineering/PUBLICATION_HOST_SPEC.md §5.1)
	# against a REAL Apache and a REAL nginx on 127.0.0.1: rewrite phase order, alias +
	# captures and location precedence are properties of the engines, which
	# media_protection_tripwire's regex lockstep cannot see. Needs no database. The image
	# ships apache2 + apache2-dev (apxs) + nginx (with the mp4 module); a missing binary is
	# RED, never a skip — the suite MariaDB's policy.
	t0=$SECONDS
	echo "== instance_tier: publication-host media drill (bun run test:media:pubhost)"
	pubhost_rc=0
	bun run test:media:pubhost || pubhost_rc=$?
	[ "$pubhost_rc" -eq 0 ] || { echo "== instance_tier: RED in the publication-host media drill (exit $pubhost_rc)"; tier_status=1; }
	took

	# ── STAGE 5 — THE PUBLICATION-HOST AGENT, LIVE ───────────────────────────────
	#
	# scripts/publication_host_agent_drill.ts boots the REAL agent (publication/host_agent)
	# over mTLS (openssl-issued private CA), drives rules.apply into a live user-mode Apache
	# and nginx, and installs / refuses / rolls back REAL Publication API v2 releases built
	# from publication/server_api/v2 (production node_modules installed into scratch:
	# network). Its exec module runs unmodified and spawns /usr/bin/sudo and
	# /usr/bin/systemctl by absolute path; in this image those are the EXEC SEAM's
	# dispatchers (ci/Dockerfile), which run the drill's stand-ins accepting only its closed
	# argv — no real sudo or systemctl exists to be reached. v2's /health needs a database:
	# the suite MariaDB's zzd target, so this stage starts that server and the tier's EXIT
	# trap stops it (tier_wiring_tripwire leg J). openssl, apxs, nginx, MariaDB or the seam
	# missing is RED, never a skip.
	t0=$SECONDS
	echo "== instance_tier: publication-host agent: start the suite MariaDB target"
	agent_mdb_rc=0
	bun run scripts/ci/suite_mariadb.ts start || agent_mdb_rc=$?
	[ "$agent_mdb_rc" -eq 0 ] || { echo "== instance_tier: RED in the publication-host agent's suite MariaDB start (exit $agent_mdb_rc)"; tier_status=1; }
	took
	t0=$SECONDS
	echo "== instance_tier: publication-host agent dependencies"
	agent_deps_rc=0
	bun install --frozen-lockfile --cwd publication/host_agent || agent_deps_rc=$?
	[ "$agent_deps_rc" -eq 0 ] || { echo "== instance_tier: RED in the publication-host agent dependencies (exit $agent_deps_rc)"; tier_status=1; }
	took
	t0=$SECONDS
	echo "== instance_tier: publication-host agent drill (bun run test:pubhost:agent)"
	agent_rc=0
	bun run test:pubhost:agent || agent_rc=$?
	[ "$agent_rc" -eq 0 ] || { echo "== instance_tier: RED in the publication-host agent drill (exit $agent_rc)"; tier_status=1; }
	took

	# ── STAGE 6 — THE ENGINE SIDE AGAINST THE REAL AGENT ─────────────────────────
	#
	# scripts/publication_host_engine_drill.ts boots a REAL engine server on the suite
	# database (its own scratch private dir, the operator config as environment) and
	# the REAL agent of stage 5's scene (mTLS for Apache, the unix socket for nginx;
	# the same exec seam), pairs them with the pairing CLI
	# (scripts/publication_host_pair.ts, run as the private dir's owner), and drives the
	# publication_hosts widget over the wire: apply_rules into live Apache/nginx
	# (published 200 / unpublished 404), probe, rollback_api of real v2 releases, and
	# the refusals (non-root admin, re-provisioned agent, frozen/dead agent, corrupt
	# registry). It reuses stage 5's suite MariaDB (stage 5's EXIT trap stops it) and
	# agent dependencies. A missing binary or seam is RED, never a skip.
	t0=$SECONDS
	echo "== instance_tier: publication-host engine drill (bun run test:pubhost:engine)"
	engine_rc=0
	bun run test:pubhost:engine || engine_rc=$?
	[ "$engine_rc" -eq 0 ] || { echo "== instance_tier: RED in the publication-host engine drill (exit $engine_rc)"; tier_status=1; }
	took

	# ── STAGE — THE PUBLIC-URL PROBE ON LIVE SERVERS (publication host phase 6) ───
	#
	# scripts/publication_host_probe_drill.ts runs the engine's probePublicGate
	# (engineering/PUBLICATION_HOST_SPEC.md §7) against a REAL Apache and a REAL nginx serving
	# the engine-rendered publication-host include. Rows: gated → ok, open gate → failed,
	# gate down → never ok; invalid probe files and a private address → unknown, with nothing
	# sent. The engine half runs in a child process on scratch private and media roots. No
	# database. Same binaries as the media drill; a missing one is RED.
	t0=$SECONDS
	echo "== instance_tier: public-URL probe drill (bun run test:pubhost:probe)"
	probe_rc=0
	bun run test:pubhost:probe || probe_rc=$?
	[ "$probe_rc" -eq 0 ] || { echo "== instance_tier: RED in the public-URL probe drill (exit $probe_rc)"; tier_status=1; }
	took

	# ── STAGE — THE BUN HASH TABLE'S SIGNATURE (provision init, Q3) ─────────────────
	#
	# scripts/ci/bun_pin_hashes.ts --verify re-verifies, OFFLINE, that the committed .bun-sha256
	# equals the signed payload of ci/bun/SHASUMS256.txt.asc under the pinned Bun release key
	# (gpgv with a key dearmored in TS: no agent, no keyring home, no network). The hashes
	# `provision init` and deploy/install.sh trust come only from that payload
	# (engineering/PUBLICATION_HOST_SPEC.md §9.10). The image carries gpgv; missing = RED (exit 2).
	#
	# NOT A STAGE HERE, by design: the guided install's own drills (bun run test:pubhost:init /
	# test:pubhost:init:el). They need a privileged systemd container and an SELinux VM, which no
	# job inside this image can start; their reasons are LOCAL_ONLY_SCRIPTS rows of
	# test/unit/tier_wiring_tripwire.test.ts (engineering/CI.md, Local-only drills).
	t0=$SECONDS
	echo "== instance_tier: Bun hash table signature (bun run scripts/ci/bun_pin_hashes.ts --verify)"
	pin_rc=0
	bun run scripts/ci/bun_pin_hashes.ts --verify || pin_rc=$?
	[ "$pin_rc" -eq 0 ] || { echo "== instance_tier: RED in the Bun hash table signature (exit $pin_rc)"; tier_status=1; }
	took
	return "$tier_status"
}

# ── RUN THE LANES ───────────────────────────────────────────────────────────────
if [ "$instance_lanes" -eq 1 ]; then
	lane_client || tier_status=1
	lane_crawl || tier_status=1
	lane_pubhost || tier_status=1
else
	t0=$SECONDS
	echo "== instance_tier: lane databases, ${instance_lanes} clones of the suite database (bun run scripts/ci/instance_lanes.ts provision)"
	lanes_rc=0
	# Kept where ci:local keeps the tier logs (DEDALO_CI_LOG_DIR → <repo>/ci-logs/<run>/):
	# a lane that dies must leave its log behind, not take it with the tier. A FRESH
	# directory, never a fixed name: under ci:local --docker every tier shares that mount
	# at once, and anything else that ran this script there (a stubbed drill of it)
	# truncated these logs mid-write when they had one fixed path.
	if [ -n "${DEDALO_CI_LOG_DIR:-}" ]; then
		mkdir -p "$DEDALO_CI_LOG_DIR"
		lane_logs="$(mktemp -d "$DEDALO_CI_LOG_DIR/instance_lanes.XXXXXX")"
	else
		lane_logs="$(mktemp -d)"
	fi
	# Created here, filled by `provision` only after it checked every name (it exits 0
	# only then); never its stdout, which the shard helpers log on.
	: >"$lane_logs/databases"
	bun run scripts/ci/instance_lanes.ts provision "$lane_logs/databases" || lanes_rc=$?
	[ "$lanes_rc" -eq 0 ] || { echo "== instance_tier: RED in the lane databases (exit $lanes_rc)"; tier_status=1; }
	took
	if [ "$lanes_rc" -eq 0 ]; then
		client_db="$(sed -n 1p "$lane_logs/databases")"
		crawl_db="$(sed -n 2p "$lane_logs/databases")"
		mdb_db="$(sed -n 3p "$lane_logs/databases")"
		(in_lane "$client_db" && lane_client) >"$lane_logs/client.log" 2>&1 &
		client_pid=$!
		(in_lane "$crawl_db" && lane_crawl) >"$lane_logs/crawl.log" 2>&1 &
		crawl_pid=$!
		(in_lane "$mdb_db" && lane_pubhost) >"$lane_logs/pubhost.log" 2>&1 &
		pubhost_pid=$!
		echo "-- instance_tier: lanes running — client ($client_db), crawl ($crawl_db), pubhost ($mdb_db); each lane's log prints when it ends"
		for lane in client crawl pubhost; do
			pid_var="${lane}_pid"
			lane_rc=0
			wait "${!pid_var}" || lane_rc=$?
			# Never `cat`: the shared stdout is non-blocking (instance_lanes.ts `print` says why).
			print_rc=0
			bun run scripts/ci/instance_lanes.ts print "$lane_logs/$lane.log" || print_rc=$?
			[ "$print_rc" -eq 0 ] || { echo "== instance_tier: RED in printing lane $lane's log (exit $print_rc; kept: $lane_logs/$lane.log)"; tier_status=1; }
			echo "-- instance_tier: lane $lane ended (exit $lane_rc)"
			# A lane returns 0 or 1 (its accumulator); anything else means it was KILLED and
			# the stages after its last marker never ran — red on the stage it died in, never
			# a summary that silently lacks them.
			[ "$lane_rc" -le 1 ] || echo "== instance_tier: RED in lane $lane — killed (exit $lane_rc); its later stages never ran (log: $lane_logs/$lane.log)"
			[ "$lane_rc" -eq 0 ] || tier_status=1
		done
	fi
	[ -n "${DEDALO_CI_LOG_DIR:-}" ] || rm -rf "$lane_logs"
fi

[ "$tier_status" -eq 0 ] || { echo "== instance_tier: RED"; exit 1; }
echo "== instance_tier: OK"
