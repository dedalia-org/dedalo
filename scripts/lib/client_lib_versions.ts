/**
 * CLIENT-LIB VERSIONS DOC — the ONE renderer of the generated regions of
 * `docs/development/vendored_library_versions.md`.
 *
 * WHY THIS EXISTS. The page's version table was prose over two machine sources —
 * `package.json` (the pins) and `src/core/client_libs/registry.ts` (which lib id
 * maps to which package) — and prose rots: eight npm rows were stale when
 * re-measured on 2026-08-28, and five more (three, geoman, turf, highlightjs,
 * mocha) had drifted again by 2026-10-02. The vendored rows were already gated
 * against `vendor/vendor_manifest.json` (vendor_advisory_tripwire); the npm rows
 * were nobody's. So the npm rows and the source-count table are now OUTPUT:
 *
 *   bun run libs:gen     re-render the regions in place
 *   bun run libs:check   render, compare, exit 1 on drift
 *
 * and `test/unit/client_lib_versions_doc_tripwire.test.ts` demands byte identity,
 * so the only way to change those rows is to change their sources and re-run.
 *
 * Pure: every function takes its inputs (registry, package.json, page text), so the
 * gate can feed it constructed inputs. Only `readPackageJson` touches disk.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientLib } from '../../src/core/client_libs/registry.ts';
import { escapeMarkdownCell } from '../../test/helpers/regex_escape.ts';

export const DOC_PATH = 'docs/development/vendored_library_versions.md';

/** The generated regions, by name. Each appears exactly once in the page. */
export const REGIONS = ['client-libs:sources', 'client-libs:npm'] as const;
export type RegionName = (typeof REGIONS)[number];

const SOURCES_NOTE =
	'package.json + src/core/client_libs/registry.ts · regenerate: bun run libs:gen';

export function beginMark(region: RegionName): string {
	return `<!-- BEGIN GENERATED ${region} — ${SOURCES_NOTE} -->`;
}
export function endMark(region: RegionName): string {
	return `<!-- END GENERATED ${region} -->`;
}

/** The slice of package.json the renderer reads. */
export interface PackageJsonPins {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

export function readPackageJson(root: string): PackageJsonPins {
	return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJsonPins;
}

/**
 * An exact pin. The registry header's law is "pinned EXACTLY (no `^`)": a range
 * would make the rendered version a claim about what MIGHT be installed, so it is
 * refused rather than printed.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const NPM_BASE_PREFIX = 'node_modules/';

/** One rendered npm row, before formatting — exported so the gate can compare. */
export interface NpmRow {
	id: string;
	pkg: string;
	version: string;
	installedAs: 'dependency' | 'devDependency';
	note: string;
}

/**
 * The npm rows, in registry order. THROWS (never skips) on a registry entry whose
 * package is not pinned, is pinned twice, or is pinned to a range — an npm row the
 * renderer cannot state truthfully must stop the render, not vanish from the page.
 */
export function npmRows(libs: Readonly<Record<string, ClientLib>>, pkg: PackageJsonPins): NpmRow[] {
	const rows: NpmRow[] = [];
	for (const [id, lib] of Object.entries(libs)) {
		if (lib.source !== 'npm') continue;
		if (!lib.base.startsWith(NPM_BASE_PREFIX)) {
			throw new Error(`client lib "${id}": npm base "${lib.base}" is not under ${NPM_BASE_PREFIX}`);
		}
		const name = lib.base.slice(NPM_BASE_PREFIX.length);
		const runtime = pkg.dependencies?.[name];
		const dev = pkg.devDependencies?.[name];
		if (runtime !== undefined && dev !== undefined) {
			throw new Error(
				`client lib "${id}": package "${name}" is in BOTH dependencies and devDependencies`,
			);
		}
		const spec = runtime ?? dev;
		if (spec === undefined) {
			throw new Error(`client lib "${id}": package "${name}" is not pinned in package.json`);
		}
		if (!EXACT_VERSION.test(spec)) {
			throw new Error(
				`client lib "${id}": package "${name}" is pinned to "${spec}", not an exact version`,
			);
		}
		rows.push({
			id,
			pkg: name,
			version: spec,
			installedAs: runtime !== undefined ? 'dependency' : 'devDependency',
			note: lib.note ?? '',
		});
	}
	return rows;
}

/** A markdown cell: no raw pipe, backslash or newline may break the row. */
function cell(text: string): string {
	return escapeMarkdownCell(text);
}

export function renderNpmRegion(
	libs: Readonly<Record<string, ClientLib>>,
	pkg: PackageJsonPins,
): string {
	const lines = [
		beginMark('client-libs:npm'),
		'',
		'| id | Package | Version | Installed as | Notes |',
		'|---|---|---|---|---|',
	];
	for (const row of npmRows(libs, pkg)) {
		const as = row.installedAs === 'dependency' ? 'dependency' : '**devDependency**';
		lines.push(`| ${row.id} | \`${row.pkg}\` | ${row.version} | ${as} | ${cell(row.note)} |`);
	}
	lines.push('', endMark('client-libs:npm'));
	return lines.join('\n');
}

export function renderSourcesRegion(libs: Readonly<Record<string, ClientLib>>): string {
	const entries = Object.entries(libs);
	const npm = entries.filter(([, l]) => l.source === 'npm').length;
	const vendorIds = entries
		.filter(([, l]) => l.source === 'vendor')
		.map(([id]) => id)
		.sort();
	return [
		beginMark('client-libs:sources'),
		'',
		'| Source | Count | Root | In git? |',
		'|---|---|---|---|',
		`| **npm** | ${npm} | \`node_modules/\` | no — \`bun install\` |`,
		`| **vendor** | ${vendorIds.length} | \`vendor/\` | **yes** — committed (${vendorIds.join(', ')}) |`,
		'',
		endMark('client-libs:sources'),
	].join('\n');
}

/**
 * Replace one region (markers included) in `page`. THROWS unless the page holds
 * exactly one BEGIN and one END for that region, in that order — a duplicated or
 * missing marker would otherwise splice the wrong span or nothing at all.
 */
export function spliceRegion(page: string, region: RegionName, rendered: string): string {
	const begin = beginMark(region);
	const end = endMark(region);
	const count = (needle: string): number => page.split(needle).length - 1;
	if (count(begin) !== 1 || count(end) !== 1) {
		throw new Error(
			`${DOC_PATH}: region "${region}" needs exactly one "${begin}" and one "${end}" (found ${count(begin)} / ${count(end)})`,
		);
	}
	const at = page.indexOf(begin);
	const until = page.indexOf(end);
	if (until < at) throw new Error(`${DOC_PATH}: region "${region}" END precedes its BEGIN`);
	return page.slice(0, at) + rendered + page.slice(until + end.length);
}

/** The whole page with every region re-rendered from its sources. */
export function renderPage(
	page: string,
	libs: Readonly<Record<string, ClientLib>>,
	pkg: PackageJsonPins,
): string {
	let next = spliceRegion(page, 'client-libs:sources', renderSourcesRegion(libs));
	next = spliceRegion(next, 'client-libs:npm', renderNpmRegion(libs, pkg));
	return next;
}
