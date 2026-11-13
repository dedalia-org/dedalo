/**
 * NO INSTALLATION'S TIPO IS AN ENGINE CONSTANT.
 *
 * `generic_tld_tripwire` holds this line for TESTS. It stops at `test/`, and the
 * same accident is worse one directory over: a tipo belonging to one
 * installation, compiled into `src/`, is not a gate that passes on one machine —
 * it is BEHAVIOUR that is correct on one machine. It does not fail anywhere
 * else, it just quietly resolves nothing.
 *
 * Measured 2026-08-22, that had happened four times, in three distinct shapes,
 * and all four were DEFAULTS — the one place an install name hides in plain
 * sight, because the code around it reads perfectly generic:
 *
 *   - `MAIN_SECTION` defaulted to `oh1`, the oral-history install's section and
 *     the page every user lands on after login. Now empty: a login with no deep
 *     link opens the menu, which is a real state rather than a broken tipo.
 *   - `MENU_SKIP_TIPOS` defaulted to two more installs' menu nodes, in a key
 *     whose own documentation already showed the default as an empty array. Now
 *     empty, as documented.
 *   - a test fixture named after the `dmm` install wrote its record into
 *     `matrix`, the installation's table — moved to the generic `test` TLD.
 *   - the iconography ddo defaults `inner_relation` to `numisdata722`, inherited
 *     verbatim from PHP. It is the ONE survivor, and the baseline below says why.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * The set of install-named tipo literals in `src/` may only SHRINK. Each
 * baseline entry carries WHY it is still there and what removing it costs; a
 * new one is refused, and a stale one is red, because a stale entry is how a
 * ratchet quietly stops ratcheting.
 *
 * SEED-SHIPPED TLDs ARE NOT INSTALL NAMES. `rsc`, `dd`, `hierarchy`, `ontology`,
 * `ontologytype` and `lg` ship with EVERY installation, so `rsc170` in engine
 * code is a reference to the shipped ontology, not to somebody's data. They are
 * excluded here — and only here: a TEST may still not name an `rsc` SECTION,
 * because section_ids collide, which is `generic_tld_tripwire`'s business.
 *
 * ── HONEST LIMITATIONS ───────────────────────────────────────────────────────
 *  - SOURCE TEXT, so a tipo built by concatenation (`${tld}1`) is invisible.
 *    That shape has its own history in the hierarchy family and its own gates
 *    (hierarchy_state_native, "foreign target sections").
 *  - Tipo LITERALS only. A per-install widget directory
 *    (`component_info/widgets/{numisdata,oh,dmm}/`) is a deliberate port layout,
 *    not a hardcode, and is not what this measures.
 *  - The TLD list is imported from the census, never re-typed: one source of
 *    truth, so an install added there is covered here the same day.
 *
 * HERMETIC: filesystem reads of tracked source. No DB, no network, no clock.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { INSTALL_TLDS } from '../../scripts/lib/tld_census.ts';
import { CORE_ONTOLOGY_TLDS } from '../../src/core/ontology/core_tlds.ts';

const SRC_DIR = join(import.meta.dir, '..', '..', 'src');

/**
 * Ships with every installation, so naming one is naming the ONTOLOGY, not an
 * install: the CORE ontologies the install seed carries — linked, never
 * duplicated (src/core/ontology/core_tlds.ts; install_seed_drift_tripwire holds
 * that list equal to the seed's dd_ontology TLD set). `rsc` is the only member
 * that the census also lists (it lists it for the test-side section rule,
 * which is a different question).
 */
const SEED_SHIPPED: ReadonlySet<string> = new Set(CORE_ONTOLOGY_TLDS);

/**
 * `<file>:<tipo>` → why it is still here. SHRINK-ONLY.
 *
 * All four are DEFAULTS, which is the one place an install name can hide in
 * plain sight: the code is generic and the constant it falls back to is not.
 */
const ENGINE_INSTALL_TIPOS: Record<string, string> = {
	'diffusion/resolve/ddo_fns.ts:numisdata722':
		'PHP_DEFAULT_INNER_RELATION — inherited verbatim from component_portal (:479-482), not chosen. Deleting it is a WIRE change: if the one element using get_diffusion_iconography relies on the implicit default, its published column empties. The durable fix is on the ONTOLOGY side (that ddo declares inner_relation), after which this entry goes.',
};

/** This file NAMES every literal it hunts, in its baseline and its prose. */
const SELF = 'engine_install_tld_tripwire.test.ts';

const HUNTED = [...INSTALL_TLDS].filter((tld) => !SEED_SHIPPED.has(tld));

/** `'<tld><digits>'` — a quoted tipo literal. Longest tld first, so `tch` cannot
 * shadow `tchi`. */
const TIPO_LITERAL = new RegExp(
	`'(${[...HUNTED].sort((a, b) => b.length - a.length).join('|')})(\\d+)'`,
	'g',
);

function sourceFiles(dir: string, found: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			sourceFiles(full, found);
		} else if (entry.endsWith('.ts')) {
			found.push(full);
		}
	}
	return found;
}

/** A comment line carries prose, not behaviour — this gate is about behaviour. */
function isComment(line: string): boolean {
	const trimmed = line.trimStart();
	return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

/**
 * A literal PAIRED with an IRI (`['dc11', 'http://purl.org/dc/elements/1.1/']`)
 * is an RDF namespace PREFIX — a fixed vocabulary name that happens to share a
 * TLD's spelling (Dublin Core elements 1.1 under the `dc` pattern), never a tipo.
 */
// `https?:` only: the `//` of the IRI is where lineInstallTipos cuts a trailing comment.
const NAMESPACE_PAIR_TAIL = /^\s*,\s*['"`]https?:/;

/** The install tipos one line of CODE names (comment prose and namespace prefixes excluded). */
function lineInstallTipos(line: string): string[] {
	if (isComment(line)) return [];
	const code = line.split('//')[0] ?? '';
	const tipos: string[] = [];
	for (const match of code.matchAll(TIPO_LITERAL)) {
		const tail = code.slice((match.index ?? 0) + match[0].length);
		if (NAMESPACE_PAIR_TAIL.test(tail)) continue;
		tipos.push(`${match[1]}${match[2]}`);
	}
	return tipos;
}

/** Every `<repo-relative file>:<tipo>` naming an install, in non-comment code. */
function engineInstallTipos(): string[] {
	const keys = new Set<string>();
	for (const file of sourceFiles(SRC_DIR)) {
		const relative = file.slice(file.indexOf('/src/') + 5);
		for (const line of readFileSync(file, 'utf8').split('\n')) {
			for (const tipo of lineInstallTipos(line)) keys.add(`${relative}:${tipo}`);
		}
	}
	return [...keys].sort();
}

describe('no installation tipo is an engine constant', () => {
	test('NO NEW install-named tipo in src/ (shrink-only)', () => {
		const added = engineInstallTipos().filter((key) => !(key in ENGINE_INSTALL_TIPOS));
		expect(
			added,
			"An installation's tipo compiled into the engine is not a portable default — it is behaviour that is correct on exactly one machine and silently resolves nothing everywhere else. Derive it from the ontology, read it from config, or make its absence loud.",
		).toEqual([]);
	});

	test('the baseline is LIVE — a stale entry is a finding', () => {
		const present = new Set(engineInstallTipos());
		expect(
			Object.keys(ENGINE_INSTALL_TIPOS).filter((key) => !present.has(key)),
			'fixed — delete these names in the same change that fixed them',
		).toEqual([]);
	});

	test('ANTI-VACUITY: the scan hunts real TLDs, spares the seed, and reads real files', () => {
		// The TLD set must be non-trivial, or every rule above is free.
		expect(HUNTED.length).toBeGreaterThan(30);
		expect(HUNTED).not.toContain('rsc');
		expect(HUNTED).toContain('numisdata');
		// It must actually be scanning the engine.
		expect(sourceFiles(SRC_DIR).length).toBeGreaterThan(500);
		// And it must match the shape it claims to, and only that shape.
		const probe = (text: string): boolean => new RegExp(TIPO_LITERAL.source).test(text);
		expect(probe("const x = 'numisdata722';")).toBe(true);
		expect(probe("const x = 'rsc170';")).toBe(false); // seed-shipped
		expect(probe('const x = `${tld}1`;')).toBe(false); // derived, not literal — see the header
		expect(probe("const x = 'test480';")).toBe(false); // the generic TLD is the destination
		// A namespace PREFIX paired with its IRI is not a tipo; the same literal alone is.
		const prefix = ['nu', 'misdata7'].join('');
		expect(lineInstallTipos(`\t['${prefix}', 'http://example.org/ns#'],`)).toEqual([]);
		expect(lineInstallTipos(`const x = '${prefix}';`)).toEqual([prefix]);
	});

	test('the file naming these literals is this one, and it is excluded', () => {
		expect(import.meta.file).toBe(SELF);
		expect(engineInstallTipos().every((key) => !key.includes(SELF))).toBe(true);
	});
});
