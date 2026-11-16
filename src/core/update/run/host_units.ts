/**
 * THE HOST'S SYSTEMD TEMPLATES, JUDGED AGAINST THIS RELEASE'S TEMPLATES (owner
 * ruling C33, 2026-11-13) — the read behind the update run's `host_units`
 * post-verify predicate (verify.ts).
 *
 * A code update runs as the SERVICE USER and never writes /etc/systemd; the
 * templates a host runs are whatever release installed them (or the last
 * re-render). After a swap this read tells whether they are this release's,
 * and when they are not, the run OFFERS the one root command that re-renders
 * them from the install's plan (scripts/ops/host_units_refresh.ts) — it never
 * runs it, and gains no privilege (the owner's C33 boundary).
 *
 * How the run knows it is a production systemd instance and which command to
 * name: the server drop-in sets DEDALO_WRITABLE_ROOTS_MANIFEST (C32), and the
 * manifest beside the drop-in carries `refresh`, the instance's own re-render
 * command. Unset AND no installer template on the host (docker, trial,
 * developer): nothing to judge. Unset WITH the templates on the host: an
 * instance installed before C32 (its drop-in names no manifest and opens no
 * ReadWritePaths=) — the re-render is offered unconditionally, the command
 * derived from the running tree (`legacy`). The templates are root's,
 * world-readable (0644), so the service user reads them.
 *
 * WHY THIS MODULE RENDERS NOTHING THROUGH src/core/install/host/: that tree is
 * the ROOT installer's and is kept OFF the server's import closure
 * (install_host_privilege_tripwire (d)). The templates are read here as the
 * files of deploy/systemd/ (every `.service`/`.timer` — the installer's
 * UNIT_TEMPLATES, pinned equal to that listing by install_host_render_tripwire),
 * and a host file is this release's when it equals the source with its ONE
 * placeholder, `@@PG_SERVICE@@`, filled by some PostgreSQL unit name — the
 * installer's OS rows substitute exactly that, so no host fact is needed.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { projectRoot, readEnv } from '../../../config/env.ts';
import { parseWritableRootsManifest } from '../../../config/writable_roots.ts';

/** Where the installer writes the templates (host/systemd/render.ts SYSTEMD_DIR — spelled here to stay off host/). */
const SYSTEMD_DIR = '/etc/systemd/system';
const TEMPLATES_DIR = 'deploy/systemd';
/** The one placeholder a template carries, and what the installer fills it with (an OS row's PostgreSQL unit). */
const PG_SERVICE_PLACEHOLDER = '@@PG_SERVICE@@';
const PG_SERVICE_NAME = String.raw`postgresql(?:-\d+)?\.service`;

/** What the run learnt of the host's templates. */
export type HostUnitsState =
	/** Not a production systemd instance (no manifest named, no template on the host): nothing to judge. */
	| { kind: 'not_systemd' }
	/**
	 * A systemd instance installed BEFORE the writable-roots release (C32): the
	 * installer's templates are on the host but no manifest is named — its drop-in
	 * predates `ProtectSystem=strict` and carries no `ReadWritePaths=`. The
	 * re-render is owed whatever the templates say: a template already upgraded by
	 * another instance's install would run THIS instance read-only at its next
	 * restart. `refresh` is derived from the running tree (the instance is the
	 * directory the tree lives in); `templates` are the ones not this release's.
	 */
	| { kind: 'legacy'; refresh: string; templates: string[] }
	/** The manifest is named but unreadable or malformed: the engine would not even boot (C32) — said, not hidden. */
	| { kind: 'manifest_unreadable'; path: string; reason: string }
	/** Every template is this release's. */
	| { kind: 'current'; refresh: string }
	/** Templates that are not this release's (absent counts), and the root command that re-renders them. */
	| { kind: 'differs'; refresh: string; templates: string[] };

/** The seams: the manifest path (DEDALO_WRITABLE_ROOTS_MANIFEST), the host's file reads, the source tree. */
export interface HostUnitsReads {
	manifestPath?: string | undefined;
	/** A host file's text, or null when it is not there (the manifest and /etc/systemd/system/<template>). */
	readText?: (path: string) => Promise<string | null>;
	/** The tree whose deploy/systemd/ is this release's (default: the running one). */
	source?: string;
}

async function readTextOrNull(path: string): Promise<string | null> {
	try {
		return await readFile(path, 'utf8');
	} catch {
		return null;
	}
}

/** The template names this release ships: every unit file of deploy/systemd/, sorted. */
export async function shippedTemplateNames(source: string = projectRoot): Promise<string[]> {
	return (await readdir(join(source, TEMPLATES_DIR)))
		.filter((name) => name.endsWith('.service') || name.endsWith('.timer'))
		.sort();
}

/** Is `onDisk` this template's source with its placeholder filled by a PostgreSQL unit name? */
export function isReleaseRender(templateSource: string, onDisk: string): boolean {
	// (a plain `includes`, never a /g regex's stateful `.test` — its lastIndex alternates answers)
	if (!templateSource.includes(PG_SERVICE_PLACEHOLDER)) return templateSource === onDisk;
	const escaped = templateSource.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
	const pattern = new RegExp(`^${escaped.replaceAll(PG_SERVICE_PLACEHOLDER, PG_SERVICE_NAME)}$`);
	return pattern.test(onDisk);
}

/** The manifest's `refresh` command, or the state that says why it could not be read. */
async function readRefreshCommand(
	manifestPath: string,
	readText: (path: string) => Promise<string | null>,
): Promise<string | Extract<HostUnitsState, { kind: 'manifest_unreadable' }>> {
	const text = await readText(manifestPath);
	if (text === null) {
		return { kind: 'manifest_unreadable', path: manifestPath, reason: 'cannot be read' };
	}
	const manifest = parseWritableRootsManifest(text);
	if (typeof manifest === 'string') {
		return { kind: 'manifest_unreadable', path: manifestPath, reason: manifest };
	}
	return manifest.refresh;
}

/** The templates whose host file is absent or not this release's render, by name. */
async function differingTemplates(
	source: string,
	readText: (path: string) => Promise<string | null>,
): Promise<string[]> {
	const templates: string[] = [];
	for (const name of await shippedTemplateNames(source)) {
		const shipped = await readFile(join(source, TEMPLATES_DIR, name), 'utf8');
		const onDisk = await readText(join(SYSTEMD_DIR, name));
		if (onDisk === null || !isReleaseRender(shipped, onDisk)) templates.push(name);
	}
	return templates;
}

/** The seams resolved: the manifest path (or null — not a systemd instance), the reader, the source tree. */
function resolvedReads(reads: HostUnitsReads): {
	manifestPath: string | null;
	readText: (path: string) => Promise<string | null>;
	source: string;
} {
	const named = reads.manifestPath ?? readEnv('DEDALO_WRITABLE_ROOTS_MANIFEST') ?? '';
	return {
		manifestPath: named.trim() === '' ? null : named,
		readText: reads.readText ?? readTextOrNull,
		source: reads.source ?? projectRoot,
	};
}

/** Which of this release's templates are present on the host at all (a pre-C32 instance is known by them). */
async function presentTemplates(
	source: string,
	readText: (path: string) => Promise<string | null>,
): Promise<string[]> {
	const present: string[] = [];
	for (const name of await shippedTemplateNames(source)) {
		if ((await readText(join(SYSTEMD_DIR, name))) !== null) present.push(name);
	}
	return present;
}

/**
 * The re-render command of an instance whose drop-in names no manifest: the
 * instance is the directory the tree lives in (layout `<instance dir>/<tree>`,
 * writable_roots.ts reads the same), the runtime the one running this engine.
 */
function legacyRefreshCommand(source: string): string {
	return `sudo ${process.execPath} run ${join(source, 'scripts/ops/host_units_refresh.ts')} --instance ${basename(dirname(source))}`;
}

/** Judge the host's templates (see the header). Never throws on a host fact: every outcome is a state. */
export async function readHostUnitsState(reads: HostUnitsReads = {}): Promise<HostUnitsState> {
	const { manifestPath, readText, source } = resolvedReads(reads);
	if (manifestPath === null) {
		// No manifest: a pre-C32 production instance (templates on the host) or not
		// a systemd instance at all (none) — told apart by the host, not assumed.
		if ((await presentTemplates(source, readText)).length === 0) return { kind: 'not_systemd' };
		return {
			kind: 'legacy',
			refresh: legacyRefreshCommand(source),
			templates: await differingTemplates(source, readText),
		};
	}
	const refresh = await readRefreshCommand(manifestPath, readText);
	if (typeof refresh !== 'string') return refresh;
	const templates = await differingTemplates(source, readText);
	return templates.length === 0
		? { kind: 'current', refresh }
		: { kind: 'differs', refresh, templates };
}
