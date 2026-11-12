#!/usr/bin/env bash
#
# HOSTED ENVIRONMENT — the configuration every hosted tier that needs a database
# composes IN-PROCESS. Sourced, never executed.
#
# ONE COPY. scripts/ci/db_tier.sh composed this block itself, and the day a second
# hosted tier needed the same database (scripts/ci/instance_tier.sh: the gates that
# BOOT a real server over the wire — the browser suite and the two update drills)
# the block would have been duplicated, and the two copies would have drifted the
# way every hand-maintained pair in this repo has drifted. So the block moved here
# and both tiers `source` it. The rules that pin it (ci_workflow_tripwire rules 6
# and 13) follow `source` lines, so what they held over db_tier.sh they hold over
# the sourced text of every hosted tier.
#
# Every value is exported HERE rather than written into a ../private/.env, so what
# the runner sees is visible in this file and identical on every runner. Process env
# outranks the file anyway. Externally provided values always win
# (`: "${VAR:=default}"` keeps them), which is how a caller renames its ENTITY or
# points at another Postgres.
#
# NO `secrets.` REACHES ANY HOSTED TIER, and that is the fork-safety property: anyone
# may open a PR, so the workflow gives it its own empty Postgres and nothing more.
#
# Usage:  source scripts/ci/hosted_env.sh   (from the repo root; cd there first)

# Puppeteer is a devDep. The db tier never launches a browser; the instance tier
# launches the CI image's Chromium (PUPPETEER_EXECUTABLE_PATH, set by ci/Dockerfile;
# scripts/client_test_runner.ts). Never download one on a runner.
export PUPPETEER_SKIP_DOWNLOAD=1

# ---------------------------------------------------------------------------
# The 8 required-no-default catalog keys. Pinned by rule 6 of
# test/unit/ci_workflow_tripwire.test.ts: add a required key to the catalog
# without stubbing it here and the tripwire goes red BEFORE CI does.
: "${ENTITY:=ci_hosted}"
: "${DB_HOST:=127.0.0.1}"
: "${DB_PORT:=5432}"
: "${DB_USER:=postgres}"
: "${DB_PASSWORD:=postgres}"
# The APPLICATION database name. It never exists on a runner and is never
# created: the suite derives its own name as <DB_NAME>_test and the preload
# refuses to fall back to this one.
: "${DB_NAME:=dedalo_ci}"

# LANGUAGE keys. NOT `: "${VAR:=<json>}"` for the object map: a `}` inside the
# default TERMINATES the parameter expansion, so the catalog receives a
# truncated map and rejects it. Same trap hermetic.sh documents.
#
# These MIRROR the development install's language set rather than a minimal
# ["lg-eng"], deliberately: labels fall back along the configured chain and
# several goldens were harvested under it, so a narrower set here would not be a
# smaller test -- it would be a different one.
if [ -z "${DEDALO_APPLICATION_LANGS:-}" ]; then
	DEDALO_APPLICATION_LANGS='{"lg-spa":"Castellano","lg-cat":"Català","lg-eng":"English","lg-fra":"Français","lg-por":"Português","lg-deu":"German","lg-ell":"Ελληνικά","lg-ita":"Italiano"}'
fi
: "${DEDALO_APPLICATION_LANGS_DEFAULT:=lg-spa}"
: "${DEDALO_DATA_LANG_DEFAULT:=lg-spa}"
: "${PROJECTS_DEFAULT_LANGS:=[\"lg-spa\",\"lg-cat\",\"lg-vlca\",\"lg-eus\",\"lg-eng\",\"lg-por\",\"lg-fra\",\"lg-ara\",\"lg-ell\",\"lg-deu\",\"lg-ita\",\"lg-nep\"]}"
# The publication languages: what config derives from PROJECTS_DEFAULT_LANGS,
# stated, so a local suite (test/helpers/suite_posture.ts) pins the same value.
: "${DEDALO_DIFFUSION_LANGS:=[\"lg-spa\",\"lg-cat\",\"lg-vlca\",\"lg-eus\",\"lg-eng\",\"lg-por\",\"lg-fra\",\"lg-ara\",\"lg-ell\",\"lg-deu\",\"lg-ita\",\"lg-nep\"]}"

# Wall-clock. Europe/Madrid is the catalog default and the dev install does not
# set the key, so both sides already agree -- pinning it means a change to that
# default cannot silently move CI. Do NOT set TZ: nothing in this repo does, and
# test/unit/area_dashboard_tz.test.ts proves the engine is host-TZ-immune by
# running probes under UTC+14 and UTC-11.
: "${DEDALO_TIMEZONE:=Europe/Madrid}"

# THE CONFIG THE FROZEN FIXTURES WERE HARVESTED UNDER (2026-08-31).
#
# The parity tier replays PHP bodies recorded on ONE installation and compares them
# byte-for-byte. Several of those bodies embed CONFIGURATION — not records — and this tier
# composes its whole environment in-process, so a key the developer's ../private/.env
# happens to supply is simply absent here and the comparison diverges. That is not a
# regression and does not belong in engineering/parity_baseline.json: it is this tier
# failing to declare the configuration the repo's own fixtures require.
#
# MEASURED 2026-08-31: with the census addressing fixed but these eight unset, the tier
# reports 5 unlisted regressions (382/264/105/13). With them it reports 382/269/100/13 and
# ZERO drift — necessary and sufficient, none of the five is corpus-bound.
#
#   environment_differential plain_vars .... DEDALO_DEV_MODE (DEVELOPMENT_SERVER, SHOW_DEBUG,
#                                            SHOW_DEVELOPER — read at module load, so it must
#                                            be exported before the process starts),
#                                            DEDALO_DIFFUSION_NATIVE (the WC-003 branch),
#                                            DEDALO_UPLOAD_SERVICE_CHUNK_FILES (5, not the
#                                            catalog default 4)
#   environment_differential page_globals .. DEDALO_ENTITY_ID — compared EXACTLY; ENTITY is a
#                                            different key and does not feed it
#   component_image_context_differential ... the two DEDALO_IMAGE_* lists, which the gate's own
#                                            comment names as install-config overrides
#   tool_export_differential ............... DEDALO_MEDIA_EXPORT_BASE — unset yields no URL at
#                                            all (config.ts refuses to guess a host); the value
#                                            is only string-compared, so it is a fixture constant
#   section_tools_differential ............. DEDALO_DIFFUSION_DOMAIN — a hard THROW, not a diff
#                                            (test/helpers/zzd_diffusion_fixture.ts
#                                            requireDomainName). The engine matches a domain BY
#                                            TERM and the fixture is provisioned with whatever
#                                            name is configured, so `test` — the repo-owned
#                                            generic domain the client suite already pins — is
#                                            correct here. NEVER an installation's (`mht`): that
#                                            would bind this tier to one machine's ontology.
: "${DEDALO_DEV_MODE:=true}"
: "${DEDALO_DIFFUSION_NATIVE:=true}"
: "${DEDALO_DIFFUSION_DOMAIN:=test}"
: "${DEDALO_ENTITY_ID:=10}"
: "${DEDALO_UPLOAD_SERVICE_CHUNK_FILES:=5}"
: "${DEDALO_IMAGE_EXTENSIONS_SUPPORTED:=jpg,jpeg,png,tif,tiff,bmp,psd,raw,heic}"
: "${DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS:=avif}"
# Held EQUAL to test/helpers/suite_posture.ts (the local `bun test` preload pins the same
# value) by test/unit/media_export_base.test.ts — change both or neither.
: "${DEDALO_MEDIA_EXPORT_BASE:=http://localhost:8080/dedalo/media}"

# Postgres client. An OLDER CLIENT REFUSES a newer server; the CI image ships
# postgresql-client-18 (ci/Dockerfile) at this path.
# src/core/install/pg_bin.ts probes an explicit path first, then Apple-Silicon
# Homebrew (macOS-only), then bare PATH -- so on Linux this key or PATH is the
# only way it resolves.
: "${DEDALO_PG_BIN_PATH:=/usr/lib/postgresql/18/bin}"

# Run-scoped scratch surfaces, exported so two jobs on one host cannot collide.
# The instance tier's server processes (client run, update drills) scope their OWN
# sockets, session stores and state files under scratch dirs they create — these
# four are what the in-process gates and the suite build see.
# The two table names MUST carry the `dedalo_ts_test_` prefix: the overrides are
# TEST SEAMS and the engine enforces /^dedalo_ts_test_[a-z0-9_]*$/ AT MODULE
# LOAD (src/diffusion/jobs/schema.ts resolveJobsTable + its diffusion_delete.ts
# twin — do not weaken those; the prefix IS the guard against redirecting
# production to an arbitrary table). The original `dedalo_ts_ci_*` values were a
# latent module-load throw: no db-tier gate happened to import schema.ts yet,
# but test/unit/diffusion_jobs_table_seam.test.ts does, so wiring it (or any
# schema.ts importer) into this tier with the old names would have killed the
# whole run at import. ci_workflow_tripwire.test.ts now scans every literal
# under scripts/ and test/ against the engine's own regex.
: "${DIFFUSION_JOBS_TABLE:=dedalo_ts_test_ci_diffusion_jobs}"
: "${DIFFUSION_ACTIVITY_TABLE:=dedalo_ts_test_ci_activity_diffusion}"
: "${DEDALO_SESSION_DB_PATH:=${TMPDIR:-/tmp}/dedalo_ci_sessions.sqlite}"
: "${DEDALO_TS_STATE_PATH:=${TMPDIR:-/tmp}/dedalo_ci_ts_state.json}"

export ENTITY DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME
export DEDALO_DEV_MODE DEDALO_DIFFUSION_NATIVE DEDALO_DIFFUSION_DOMAIN DEDALO_ENTITY_ID
export DEDALO_UPLOAD_SERVICE_CHUNK_FILES DEDALO_MEDIA_EXPORT_BASE
export DEDALO_IMAGE_EXTENSIONS_SUPPORTED DEDALO_IMAGE_ALTERNATIVE_EXTENSIONS
export DEDALO_APPLICATION_LANGS DEDALO_APPLICATION_LANGS_DEFAULT DEDALO_DATA_LANG_DEFAULT
export PROJECTS_DEFAULT_LANGS DEDALO_DIFFUSION_LANGS DEDALO_TIMEZONE DEDALO_PG_BIN_PATH
export DIFFUSION_JOBS_TABLE DIFFUSION_ACTIVITY_TABLE DEDALO_SESSION_DB_PATH DEDALO_TS_STATE_PATH

# DELIBERATELY UNSET, each for a reason:
#   ORACLE_MODE              -- defaults to `fixtures`; the parity store replays credless.
#   PHP_API_*                -- the oracle is decommissioned; live legs must stay off.
#   DEDALO_DIFFUSION_DB_*    -- composed PER LANE by test/preload/suite_mariadb.ts (the
#                               socket of the suite's own MariaDB server, its user, a
#                               blank host/port), never exported here: db_tier.sh starts
#                               that server, the instance tier starts none. An export here
#                               would be overwritten by the preload anyway (PUB-05).
#   DEDALO_DEBUG_API_ERRORS  -- moves the error-disclosure ladder; 28 test references.
#   DEDALO_RAG_*             -- the gates that need it set it themselves.

# The suite media root lives at ../private/test_media/<suite db> and that BASE is
# not overridable (test/helpers/test_media_root.ts derives it and may not import
# the config layer). On a runner the parent does not exist, and the preload still
# ARMS the guard at a nonexistent path -- so every media door would refuse, with
# a confusing message, unless the directory is creatable.
mkdir -p ../private
