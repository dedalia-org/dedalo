/**
 * THE RUNTIME-PATH CENSUS — one declarative description of every filesystem
 * path this engine WRITES to at runtime (or that an operator can point at
 * one), each with the config key that moves it and the consumer that uses it.
 *
 * WHY THIS EXISTS (2026-08-23). `src/core/update/code_update.ts renameSwap()`
 * renames the whole `projectRoot` to a backup and moves a new release tree
 * into its place, carrying forward only `node_modules` and `.git`. Any
 * RUNTIME/OPERATOR data whose path resolves INSIDE `projectRoot` is therefore
 * silently moved into the backup directory by a code update — the measured
 * offenders were the default media root (`<tree>/media`: the entire media
 * library, `.publication` access markers, the diffusion media index, upload
 * staging), the hard-coded ontology recovery dump
 * (`<tree>/install/db/dd_ontology_recovery.sql.gz`), the ontology IO dir, the
 * transform-definitions dir, and the `ts_state.json` cwd fallback. The census
 * makes that class of loss impossible to reintroduce silently:
 *
 *  - `RUNTIME_PATH_CENSUS` is THE authoritative list (media_tree.ts style:
 *    every entry carries the `consumer` that reads/writes it, so an omission
 *    can never be anonymous).
 *  - `runtimePathsInsideTree(targetRoot)` answers the updater's question:
 *    which census paths currently resolve inside the code tree — the swap
 *    blockers. The updater (code_update.ts, which imports THIS module) refuses
 *    the swap and names each entry's env key so the operator can move the data
 *    deliberately, never lose it silently.
 *  - `runtime_paths_census_tripwire.test.ts` is the DEC-12 gate: every
 *    `projectRoot`/`process.cwd()` path construction in src/ is either
 *    census-registered or exempted here WITH A REASON (serving shipped code
 *    and assets is not runtime data), the census resolves without throwing,
 *    and every env key is a real catalog key.
 *
 * DESIGN RULES
 *
 *  - Resolution goes through `readEnv`/the typed readers and the
 *    `privateDir`/`projectRoot` constants — NEVER the frozen `config` object.
 *    Two reasons: the census must observe env mutations a test makes at
 *    runtime (the tripwire's positive control plants a root and asks again),
 *    and this module is imported by the updater, which must stay cheap and
 *    cycle-free (`import_scc_tripwire`).
 *  - `resolve()` is a PURE QUESTION: it computes the effective path and never
 *    mkdirs, probes, or writes. `null` means "unconfigured" (the engine's
 *    behaviour is then disabled, so there is nothing to protect).
 *  - Entries mirror EXACTLY the resolution their consumer performs, legacy
 *    fallbacks included — a census that answers a cleaner question than the
 *    engine asks would bless a swap that still loses the legacy data.
 */

import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { legacyAwareDefaultDir } from '../../config/catalog/media.ts';
import { privateDir, processEnvValue, projectRoot, readEnv } from '../../config/env.ts';
import { readString } from '../../config/readers.ts';
import { deriveProcessesDir } from '../media/processes_dir.ts';
import { registryPath } from '../publication_host/registry.ts';
import { runtimePath } from '../publication_host/runtime.ts';
import { secretsRoot } from '../publication_host/secrets.ts';

/** One runtime-writable path the engine (or its operator) can aim somewhere. */
export interface RuntimePathEntry {
	/** Stable census id. */
	readonly id: string;
	/** The config key an operator flips to move it; null = hard-coded. */
	readonly envKey: string | null;
	/** 'file.ts:symbol' — who reads/writes it. */
	readonly consumer: string;
	/** The EFFECTIVE path right now; null = unconfigured. */
	readonly resolve: () => string | null;
	/** The updater's remedy when the generic "move it, or set <key>" is wrong advice
	 * (a function: it may depend on the install's role, read at refusal time). */
	readonly remedy?: () => string;
}

/** Trim-to-null: an empty env value is "unset", exactly as the readers treat it. */
function optional(key: string): string | null {
	const value = readEnv(key);
	return value !== undefined && value !== '' ? value : null;
}

// ---------------------------------------------------------------------------
// The ontology recovery file (DEDALO_ONTOLOGY_RECOVERY_PATH — new key,
// 2026-08-23; the path was hard-coded in-tree before).
// ---------------------------------------------------------------------------

/** The pre-2026-08-23 in-tree location (what a code update used to move away). */
export const LEGACY_RECOVERY_FILE_PATH: string = join(
	projectRoot,
	'install',
	'db',
	'dd_ontology_recovery.sql.gz',
);

/**
 * Where a NEW recovery dump is written: the configured key, else the modern
 * `<private>/db/` slot. Never the legacy in-tree path — the build side must
 * not keep the legacy file growing.
 */
export function recoveryFileWritePath(): string {
	return (
		optional('DEDALO_ONTOLOGY_RECOVERY_PATH') ??
		join(privateDir, 'db', 'dd_ontology_recovery.sql.gz')
	);
}

/**
 * The EFFECTIVE recovery file for the READ side: the write path, unless it
 * does not exist yet and the legacy in-tree file does — then the legacy file
 * is read (nobody's last-good dump is orphaned by the rename) with a one-line
 * warning naming the key that ends the fallback.
 */
export function resolveRecoveryFilePath(): string {
	const modern = recoveryFileWritePath();
	if (!existsSync(modern) && existsSync(LEGACY_RECOVERY_FILE_PATH)) {
		console.warn(
			`[runtime_paths] reading the ontology recovery file from its LEGACY in-tree location '${LEGACY_RECOVERY_FILE_PATH}' — a code update moves it away with the old tree. Rebuild it (it lands at '${modern}'), or set DEDALO_ONTOLOGY_RECOVERY_PATH.`,
		);
		return LEGACY_RECOVERY_FILE_PATH;
	}
	return modern;
}

// ---------------------------------------------------------------------------
// THE CENSUS
// ---------------------------------------------------------------------------

export const RUNTIME_PATH_CENSUS: readonly RuntimePathEntry[] = Object.freeze([
	{
		id: 'private_dir',
		envKey: 'DEDALO_PRIVATE_DIR',
		consumer: 'src/config/env.ts:privateDir',
		resolve: () => privateDir,
	},
	{
		id: 'media_root',
		envKey: 'MEDIA_PATH',
		consumer: 'src/config/config.ts:buildMediaConfig',
		// Mirrors buildMediaConfig exactly: the test seam outranks everything,
		// then MEDIA_PATH, then the legacy-aware default (catalog/media.ts).
		resolve: () =>
			optional('DEDALO_TEST_MEDIA_ROOT') ??
			optional('MEDIA_PATH') ??
			legacyAwareDefaultDir('MEDIA_PATH', ['media'], ['media']),
	},
	{
		id: 'ontology_recovery_file',
		envKey: 'DEDALO_ONTOLOGY_RECOVERY_PATH',
		consumer: 'src/core/ontology/recovery_file.ts:restoreDdOntologyRecoveryFromFile',
		resolve: () => resolveRecoveryFilePath(),
	},
	{
		id: 'ontology_data_io_dir',
		envKey: 'ONTOLOGY_DATA_IO_DIR',
		consumer: 'src/core/ontology/data_io.ts:setOntologyIoPath',
		// readString applies the catalog default, which is legacy-aware
		// (src/config/catalog/maintenance.ts probeOntologyLegacyDir): the
		// legacy in-tree dir SHIPS the vendored release, which does not count,
		// so a stock install resolves to <private>/import/ontology. Only an
		// install whose legacy dir holds files the release does not ship (or an
		// ontology server) resolves in-tree — and moving the SHIPPED files is
		// wrong advice, hence the remedy. An ontology SERVER's exports carry the
		// shipped names and it SERVES them from here: moving only the residue
		// and creating the private dir would repoint a live master at an empty
		// dir, so its remedy is the whole version directory.
		resolve: () => readString('ONTOLOGY_DATA_IO_DIR'),
		remedy: () =>
			readEnv('IS_AN_ONTOLOGY_SERVER')?.trim() === 'true'
				? 'this ontology server serves its exports from here: copy EVERY <major.minor>/ directory (the served exports included) into <private dir>/import/ontology — it serves from there once that directory exists, so never create it empty — then restart; or set ONTOLOGY_DATA_IO_DIR'
				: 'move the files that are not ontology release files (recovery/, .staging, anything else) into <private dir>/import/ontology — creating that directory ends the fallback — or set ONTOLOGY_DATA_IO_DIR',
	},
	{
		id: 'transform_definitions_dir',
		envKey: 'DEDALO_TRANSFORM_DEFINITIONS_DIR',
		consumer: 'src/core/update/transform/definitions.ts:listTransformDefinitions',
		resolve: () => readString('DEDALO_TRANSFORM_DEFINITIONS_DIR'),
	},
	{
		id: 'ts_state_path',
		envKey: 'DEDALO_TS_STATE_PATH',
		consumer: 'src/core/resolve/server_state.ts:statePath',
		resolve: () => optional('DEDALO_TS_STATE_PATH') ?? join(privateDir, 'ts_state.json'),
	},
	{
		id: 'session_db_path',
		envKey: 'DEDALO_SESSION_DB_PATH',
		consumer: 'src/core/security/session_store.ts:sessionDbPath',
		resolve: () =>
			optional('DEDALO_SESSION_DB_PATH') ?? join(privateDir, 'dedalo_ts_sessions.sqlite'),
	},
	{
		// Core never imports diffusion: the path is spelled here and pinned equal to
		// mediaCopyStateDir() by test/unit/media_copy_native.test.ts.
		id: 'media_copy_state_dir',
		envKey: null,
		consumer:
			'src/diffusion/targets/mediastore/media_copy.ts:mediaCopyStateDir (publication-host copy: local sha cache)',
		resolve: () => join(privateDir, 'media_copy'),
	},
	{
		id: 'backup_dir',
		envKey: 'DEDALO_BACKUP_DIR',
		consumer: 'src/config/config.ts:buildConfig (ops.backupDir)',
		// The documented unset behaviour: backups/db inside the private dir
		// (install/directories.ts targetDirs).
		resolve: () => optional('DEDALO_BACKUP_DIR') ?? join(privateDir, 'backups', 'db'),
	},
	{
		id: 'backup_path',
		envKey: 'DEDALO_BACKUP_PATH',
		consumer: 'src/core/update/code_update.ts:renameSwap (code backup staging)',
		resolve: () => optional('DEDALO_BACKUP_PATH') ?? resolve(projectRoot, '..', 'backups', 'code'),
	},
	{
		id: 'server_unix_socket',
		envKey: 'SERVER_UNIX_SOCKET',
		consumer: 'src/server.ts:startServer',
		resolve: () => readString('SERVER_UNIX_SOCKET'),
	},
	{
		id: 'media_processes_dir',
		envKey: 'DEDALO_MEDIA_PROCESSES_DIR',
		consumer: 'src/core/media/jobs.ts (media job process files)',
		// THE SAME FUNCTION jobs.ts processesDir uses (processes_dir.ts
		// deriveProcessesDir), fed from env, not config (design rule): under the
		// test-media seam the default is the suite sibling `<test media root>.processes`.
		resolve: () =>
			deriveProcessesDir(
				optional('DEDALO_MEDIA_PROCESSES_DIR'),
				optional('DEDALO_TEST_MEDIA_ROOT'),
				join(privateDir, 'processes'),
			),
	},
	{
		id: 'geoip_dir',
		envKey: 'DEDALO_GEOIP_DIR',
		consumer: 'src/core/geoip (IP-to-country database cache)',
		resolve: () => readString('DEDALO_GEOIP_DIR'),
	},
	{
		id: 'mcp_media_import_dir',
		envKey: 'DEDALO_MCP_MEDIA_IMPORT_DIR',
		consumer: 'src/ai/mcp (path-based media ingest drop-box)',
		resolve: () => optional('DEDALO_MCP_MEDIA_IMPORT_DIR'),
	},
	{
		id: 'ai_model_store',
		envKey: 'DEDALO_AI_MODEL_STORE',
		consumer: 'src/core/ai/model_store.ts:modelStoreRoot',
		// Mirrors modelStoreRoot exactly: `resolve(privateDir, configured)` —
		// which ACCEPTS an absolute in-tree path — else `<private>/ai_models`.
		// Model weights are re-downloadable (LOW severity), but the census's
		// whole value is being TOTAL.
		resolve: () => {
			const configured = (readString('DEDALO_AI_MODEL_STORE') ?? '').trim();
			return configured === '' ? resolve(privateDir, 'ai_models') : resolve(privateDir, configured);
		},
	},
	{
		id: 'code_files_dir',
		envKey: 'DEDALO_CODE_FILES_DIR',
		consumer: 'src/core/update (code-server release archives)',
		resolve: () => optional('DEDALO_CODE_FILES_DIR'),
	},
	{
		id: 'code_server_git_dir',
		envKey: 'DEDALO_CODE_SERVER_GIT_DIR',
		consumer: 'src/core/update (code-server build checkout)',
		resolve: () => optional('DEDALO_CODE_SERVER_GIT_DIR'),
	},
	{
		id: 'source_version_local_dir',
		envKey: 'DEDALO_SOURCE_VERSION_LOCAL_DIR',
		consumer:
			'none — retirement candidate: code updates stage in <DEDALO_BACKUP_PATH>/.code_staging (src/core/update/code_update.ts)',
		resolve: () => optional('DEDALO_SOURCE_VERSION_LOCAL_DIR'),
	},
	{
		id: 'client_publish_dir',
		envKey: 'DEDALO_CLIENT_PUBLISH_DIR',
		consumer: 'src/core/install/client_publish.ts:publishClientAtBoot',
		// THE SAME READ the publisher makes: the PROCESS env only (a container mount the
		// private .env cannot know); unset = nothing published (every non-container install).
		resolve: () => {
			const value = (processEnvValue('DEDALO_CLIENT_PUBLISH_DIR') ?? '').trim();
			return value === '' ? null : value;
		},
	},
	{
		id: 'publication_hosts_registry',
		envKey: null,
		consumer: 'src/core/publication_host/registry.ts:registryPath',
		// THE SAME FUNCTION the store uses (design rule: mirror the consumer exactly):
		// <private>/publication_hosts.json, the non-secret host list (phase 3, E2).
		resolve: () => registryPath(),
	},
	{
		id: 'publication_hosts_runtime',
		envKey: null,
		consumer: 'src/core/publication_host/runtime.ts:runtimePath',
		// THE SAME FUNCTION the store uses: beside the registry,
		// <private>/publication_hosts_runtime.json, the observed per-host results (phases 4-6).
		resolve: () => runtimePath(),
	},
	{
		id: 'publication_hosts_secrets',
		envKey: null,
		consumer: 'src/core/publication_host/secrets.ts:secretsRoot',
		// <private>/publication_hosts/<name>/{token,engine_bundle.pem}, 0700/0600 (phase 3, E3);
		// a unix-socket host holds `token` only.
		resolve: () => secretsRoot(),
	},
]);

/**
 * Census paths that resolve inside `targetRoot` (the code tree) — the swap
 * blockers. The updater refuses when this is non-empty and prints each entry's
 * `envKey` (or, for a null key, its id) so the operator knows exactly which
 * setting moves the data out of harm's way.
 */
export function runtimePathsInsideTree(
	targetRoot: string,
): { id: string; envKey: string | null; path: string; remedy?: string }[] {
	const root = resolve(targetRoot);
	const inside: { id: string; envKey: string | null; path: string; remedy?: string }[] = [];
	for (const entry of RUNTIME_PATH_CENSUS) {
		const raw = entry.resolve();
		if (raw === null) continue;
		const path = resolve(raw);
		if (path === root || path.startsWith(root + sep)) {
			inside.push({
				id: entry.id,
				envKey: entry.envKey,
				path,
				...(entry.remedy !== undefined ? { remedy: entry.remedy() } : {}),
			});
		}
	}
	return inside;
}

// ---------------------------------------------------------------------------
// STATIC-SCAN EXEMPTIONS — the tripwire's allowlist, kept HERE so the census
// and its exemptions travel together. A file appears here ONLY when its
// projectRoot/process.cwd() path constructions are code/asset serving or
// read-only introspection — never runtime data an update could move.
// ---------------------------------------------------------------------------

export const RUNTIME_PATH_SCAN_EXEMPTIONS: Readonly<Record<string, string>> = Object.freeze({
	'src/core/install/seed_sources.ts':
		'the install seed SOURCES: repo files (install/db/seed, the ontology release, the migrations) the compiler READS — code-tree assets, never runtime state',
	'src/core/install/seed_manifest.ts':
		'fingerprints the repo-owned seed sources and the compiler files in the checkout (reads only); the manifest it writes is the committed artefact beside the vendored seed',
	'src/core/install/seed_build.ts':
		'the install seed COMPILER: reads repo sources and writes the vendored seed + manifest INTO the checkout on purpose — a committed build artefact (like docs/change_log.md), not installation state; its child script is a code path',
	'src/config/env.ts':
		'defines projectRoot and privateDir themselves; the ../private default is the census private_dir entry',
	'src/config/catalog/media.ts':
		'catalog default thunks (legacyAwareDefaultDir): every path they can produce is a census-registered default, and the legacy existence check must name the in-tree location',
	'src/core/install/runtime_paths.ts':
		'the census itself: the legacy recovery-file path and the backup_path default must name in-tree/sibling locations to report them',
	'src/core/install/dev_tls.ts':
		'names the ONE local-CA generator shipped in the checkout (deploy/dedalo-tls-rotate.sh) to RUN it — code, replaced WITH the tree; the material it writes goes to <private>/tls (paths.ts devTlsDir), never under projectRoot',
	'src/core/install/paths.ts':
		'shipped install assets (seed dump, vendored hierarchy imports, sample.env template) — release content replaced WITH the tree, not runtime data',
	'src/core/client_libs/registry.ts':
		'serves shipped third-party client libraries from the code tree — release content, not runtime data',
	'src/server.ts': 'reads the shipped .bun-version pin — release content, not runtime data',
	'src/core/update/code_update.ts':
		'the updater: it operates ON the code tree by design and consults this census before any swap',
	'src/core/install/client_publish.ts':
		'CLIENT_ROOT is the SHIPPED client tree (release content, replaced WITH the tree): it is served from there and copied OUT of it; the publisher writes only under DEDALO_CLIENT_PUBLISH_DIR (census entry client_publish_dir), never into the tree',
	'src/core/update/code_manifest.ts':
		"RELEASE_NOTES_DIR is the master's shipped changes/ tree (changes/<version>/release.json, frozen at the release cut — release content, read-only); the manifest writes nothing",
	'src/core/update/catalog_file.ts':
		"UPDATE_CATALOG_DIR is the SHIPPED install/update/ tree (catalog.json + each release's data-rung SQL files — release content, replaced WITH the tree); the loader only reads it",
	'src/core/update/status.ts':
		'the readiness PANEL: read-only introspection of the live tree (the shipped .bun-version pin, the unaccounted root entries) — it writes nothing and asks this census itself for the swap blockers',
	'src/core/area_maintenance/widgets/system_info.ts':
		'statfsSync(process.cwd()) — a read-only disk-usage probe, writes nothing',
});

/**
 * Bootstrap keys read before the config catalog exists (src/config/env.ts).
 * The tripwire accepts these as "registered" even though they have no catalog
 * entry: the catalog itself is loaded THROUGH them.
 */
export const RUNTIME_PATH_BOOTSTRAP_KEYS: readonly string[] = Object.freeze(['DEDALO_PRIVATE_DIR']);
