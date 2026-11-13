/**
 * THE WRITABLE ROOTS CHECK (owner ruling C32, 2026-11-13).
 *
 * A production instance's server unit runs `ProtectSystem=strict`: the whole
 * file system is read-only to the engine except the roots its drop-in lists in
 * `ReadWritePaths=` (src/core/install/host/systemd/render.ts writableRoots —
 * the install folder, the backup dir, the web root and the published client,
 * the socket dirs, the temp dirs). The installer writes that same list as a JSON
 * manifest beside the drop-in and names it in DEDALO_WRITABLE_ROOTS_MANIFEST.
 *
 * At boot, BEFORE any listener or writer, the engine reads the manifest and
 * checks every path it is configured to write against the roots. One outside →
 * the boot is REFUSED with NOT_INSTALLED_EXIT_CODE (78, EX_CONFIG — the class the
 * units never restart), one stderr line naming the path, the roots and the ROOT
 * command that re-renders the units from the install's plan. Why a refusal and
 * not a warning: under `strict` the path would fail at its FIRST WRITE — in the
 * middle of an upload, a backup or an export — with an EROFS nobody connects to a
 * `.env` edit; a refusal at boot names the cause while the operator is at the
 * keyboard. A manifest that is named but unreadable or malformed refuses too
 * (fail closed: the unit SAYS there is one). Unset: no check — every installation
 * that is not a production systemd instance (docker, trial, developer).
 *
 * Reads only src/config (readEnv, the frozen config) — the lowest layer; the
 * paths it judges are the engine's configured writers, one list, here.
 * Gate: test/unit/install_state_boot.test.ts (writable roots).
 */

import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { config } from './config.ts';
import { privateDir, projectRoot, readEnv } from './env.ts';
import { NOT_INSTALLED_EXIT_CODE } from './install_state.ts';

export const WRITABLE_ROOTS_MANIFEST_FORMAT = 1;

export interface WritableRootsManifest {
	format: number;
	instance: string;
	stamp: string;
	/** The roots the unit's ReadWritePaths= opened, absolute, as the installer derived them. */
	read_write_paths: string[];
	/** The ROOT command that re-renders the units (and this manifest) from the install's plan. */
	refresh: string;
}

/** A configured path the engine writes under, with the name an operator knows it by. */
export interface ConfiguredWritablePath {
	label: string;
	path: string;
}

/** Is `path` equal to `root` or below it? (`/` covers everything.) The installer's twin: render.ts pathUnderRoot. */
export function pathUnderRoot(path: string, root: string): boolean {
	if (root === '/') return true;
	return path === root || path.startsWith(`${root}/`);
}

/** The manifest's shape, or the reason it is not one. */
export function parseWritableRootsManifest(text: string): WritableRootsManifest | string {
	let parsed: Partial<WritableRootsManifest>;
	try {
		parsed = JSON.parse(text) as Partial<WritableRootsManifest>;
	} catch {
		return 'not JSON';
	}
	if (parsed === null || typeof parsed !== 'object') return 'not an object';
	if (parsed.format !== WRITABLE_ROOTS_MANIFEST_FORMAT)
		return `format ${String(parsed.format)}, expected ${WRITABLE_ROOTS_MANIFEST_FORMAT}`;
	if (typeof parsed.instance !== 'string' || parsed.instance === '') return 'no instance';
	if (typeof parsed.refresh !== 'string' || parsed.refresh === '') return 'no refresh command';
	if (
		!Array.isArray(parsed.read_write_paths) ||
		parsed.read_write_paths.length === 0 ||
		parsed.read_write_paths.some((root) => typeof root !== 'string' || !root.startsWith('/'))
	) {
		return 'read_write_paths is not a non-empty list of absolute paths';
	}
	return {
		format: parsed.format,
		instance: parsed.instance,
		stamp: typeof parsed.stamp === 'string' ? parsed.stamp : '',
		read_write_paths: parsed.read_write_paths,
		refresh: parsed.refresh,
	};
}

/** Every configured path that lies under NO root, as `<label> <path>`. */
export function writableRootsViolations(
	roots: readonly string[],
	paths: readonly ConfiguredWritablePath[],
): string[] {
	return paths
		.filter(({ path }) => !roots.some((root) => pathUnderRoot(path, root)))
		.map(({ label, path }) => `${label} ${path}`);
}

/**
 * The paths THIS engine writes, from its frozen config — absolute, deduplicated.
 * Every writer the engine has: the private dir (sessions, state, backups/db by
 * default, export artifacts, ontology IO…), the media root, the explicit backup
 * dir, the explicit export / ontology IO / transform-definitions / geoip dirs,
 * the client publish dir, the socket dir, the instance dir the code update swaps
 * the tree inside, and the temp dir.
 */
export function configuredWritablePaths(): ConfiguredWritablePath[] {
	const entries: [string, string | null | undefined][] = [
		['the private directory', privateDir],
		['the instance directory (the code update renames the tree inside it)', dirname(projectRoot)],
		['MEDIA_PATH', config.media.rootPath],
		['DEDALO_BACKUP_DIR', config.ops.backupDir],
		['DEDALO_EXPORT_ARTIFACTS_DIR', config.ops.exportArtifactsDir],
		['ONTOLOGY_DATA_IO_DIR', config.ops.ontologyDataIoDir],
		['DEDALO_TRANSFORM_DEFINITIONS_DIR', config.ops.transformDefinitionsDir],
		['DEDALO_GEOIP_DIR', config.geoip.dir],
		['DEDALO_SESSION_DB_PATH', readEnv('DEDALO_SESSION_DB_PATH')],
		['DEDALO_CLIENT_PUBLISH_DIR', readEnv('DEDALO_CLIENT_PUBLISH_DIR')],
		[
			'SERVER_UNIX_SOCKET (its directory)',
			config.server.unixSocketPath === '' ? null : dirname(config.server.unixSocketPath),
		],
		['the temp directory', tmpdir()],
	];
	const seen = new Set<string>();
	const paths: ConfiguredWritablePath[] = [];
	for (const [label, value] of entries) {
		if (typeof value !== 'string' || value.trim() === '') continue;
		const path = resolve(value);
		if (seen.has(path)) continue;
		seen.add(path);
		paths.push({ label, path });
	}
	return paths;
}

/**
 * Why this engine must not start under its unit's writable roots, or null: no
 * manifest named (no check), or every configured path under a listed root.
 * `manifestPath` and `paths` are seams for the gate; production passes none.
 */
export function writableRootsRefusal(
	manifestPath: string | undefined = readEnv('DEDALO_WRITABLE_ROOTS_MANIFEST'),
	paths:
		| readonly ConfiguredWritablePath[]
		| (() => readonly ConfiguredWritablePath[]) = configuredWritablePaths,
): string | null {
	if (manifestPath === undefined || manifestPath.trim() === '') return null;
	let text: string;
	try {
		text = readFileSync(manifestPath, 'utf8');
	} catch (error) {
		return `writable-roots manifest ${manifestPath} (DEDALO_WRITABLE_ROOTS_MANIFEST) cannot be read (${(error as { code?: string }).code ?? 'error'}): the service unit runs under ProtectSystem=strict and this engine cannot tell which paths it may write. Re-render the units as root from the install's plan (scripts/ops/host_units_refresh.ts --instance <i>), then start it again`;
	}
	const manifest = parseWritableRootsManifest(text);
	if (typeof manifest === 'string') {
		return `writable-roots manifest ${manifestPath} is malformed (${manifest}): re-render the units as root from the install's plan (scripts/ops/host_units_refresh.ts --instance <i>), then start it again`;
	}
	const configured = typeof paths === 'function' ? paths() : paths;
	const outside = writableRootsViolations(manifest.read_write_paths, configured);
	if (outside.length === 0) return null;
	return `${outside.join('; ')} ${outside.length === 1 ? 'lies' : 'lie'} outside every writable root of the service unit (${manifest.read_write_paths.join(' ')}): under ProtectSystem=strict the first write there would fail. Re-render the units from the install's plan as root — ${manifest.refresh} — then start the instance again (or move the path back under a listed root in .env)`;
}

/** Print the refusal and exit 78 when a configured path is outside the unit's writable roots; return otherwise. */
export function refuseBootOutsideWritableRoots(): void {
	const refusal = writableRootsRefusal();
	if (refusal === null) return;
	console.error(
		`[boot] REFUSED — ${refusal} (exit ${NOT_INSTALLED_EXIT_CODE}; supervisors must not restart)`,
	);
	process.exit(NOT_INSTALLED_EXIT_CODE);
}
