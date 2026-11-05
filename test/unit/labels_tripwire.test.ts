/**
 * labels_tripwire — the repo-catalog UI-label invariants (WC-033).
 *
 * Since the 2026-07-16 label-model migration, src/core/labels/ is the SINGLE
 * source of truth for program strings (dd_ontology model='label' rows are
 * inert for the TS engine). Two files, two ROLES: master.json is the SOURCE
 * OF DEFINITIONS (the complete key set with its source strings — authored in
 * MASTER_SOURCE_LANG); catalog/lg-<code>.json are per-lang translations, all
 * equal, sparse allowed — EVERY lang has one, including the master-source
 * lang, whose file is a sparse display-text OVERRIDE of the master (it may
 * be empty; it must never become a duplicate). This gate keeps that model
 * honest:
 *
 *  1. master integrity — parses, non-empty sorted string entries;
 *  2. catalog integrity — same (empty catalog allowed: sparse), plus every
 *     lang's key set ⊆ the master, the master-source lang HAS a catalog
 *     (symmetry is deliberate), and no master-source override entry equals
 *     the master's string byte-for-byte (an equal entry is duplication, not
 *     an override);
 *  3. master completeness — every label key the client statically references
 *     (`get_label.key` / `get_label['key']`) and every plain
 *     'label'/'label_concat' widget rule key in src/ exists in the master, so
 *     a new UI string cannot ship without its definition;
 *  4. the UNCATALOGED_CLIENT_KEYS ratchet — pre-migration client keys that
 *     resolve through call-site `|| 'literal'` chains with conflicting or
 *     missing literals. SHRINK-ONLY: entries may be removed (by defining the
 *     key), never added; a stale entry (no longer referenced, or now defined)
 *     fails.
 *
 * NOT covered (documented, not silently narrowed): dynamic dictionary access
 * (`get_label[variable]`) is unscannable — dead-label detection is therefore
 * out of scope; `label_mark_fallback` widget rules carry their own literal by
 * design and are exempt from check 3. Runtime fallback ORDER (master ←
 * install-default ← alias ← requested) is exercised by the serving code, not
 * here — this gate proves the FILES support it (a complete master).
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MASTER_SOURCE_LANG } from '../../src/core/labels/catalog.ts';

const LABELS_DIR = resolve(import.meta.dir, '../../src/core/labels');
const CATALOG_DIR = join(LABELS_DIR, 'catalog');
const CLIENT_ROOT = resolve(import.meta.dir, '../../client/dedalo');
const SRC_ROOT = resolve(import.meta.dir, '../../src');

/**
 * Client-referenced keys deliberately left UNDEFINED at the migration
 * (2026-07-16): each call site keeps its own `|| 'literal'` fallback because
 * the sites disagree on the string (or carry none), so one master value
 * would silently change bytes at the other sites. Burn-down: pick the
 * intended string per key, add it to master.json, delete the entry here.
 */
const UNCATALOGED_CLIENT_KEYS: ReadonlySet<string> = new Set([
	// THE tools/**/js HALF OF THE CORPUS (P2-20 / GATE-30), visible from
	// 2026-08-31 when this gate stopped walking `client/dedalo` alone. These 30
	// keys are referenced by tool browser code and defined NOWHERE — each resolves
	// through its call-site `|| '<English literal>'`, exactly like the entries
	// below. They are not new debt; they are debt that was outside the census.
	// Same burn-down: pick the intended string, add it to master.json, delete the
	// entry here.
	'alternative_extensions',
	'annotations',
	'bun_engine',
	'characters_per_line',
	'columns',
	'components',
	'connection_status',
	'default',
	'destructive',
	'diffusion_unavailable',
	'drag_component_column',
	'languages',
	'layout',
	'left',
	'link',
	'margins',
	'parents',
	'properties',
	'quality',
	'retry',
	'right',
	'rows',
	'select',
	'select_an_element',
	'show',
	'style',
	'tool_print_confirm_n',
	'tool_print_rendering',
	'tool_print_too_many',
	'error_report', // no call-site literal at all
	'show_more',
	'theme_toggle',
]);

interface Catalog {
	lang: string;
	map: Record<string, string>;
}

function loadMaster(): Record<string, string> {
	return JSON.parse(readFileSync(join(LABELS_DIR, 'master.json'), 'utf8')) as Record<
		string,
		string
	>;
}

function loadCatalogs(): Catalog[] {
	return readdirSync(CATALOG_DIR)
		.sort()
		.map((name) => {
			expect(name).toMatch(/^lg-[a-z0-9_]+\.json$/);
			const map = JSON.parse(readFileSync(join(CATALOG_DIR, name), 'utf8')) as Record<
				string,
				string
			>;
			return { lang: name.replace('.json', ''), map };
		});
}

/** Every file with the extension under root (client is vanilla JS, no maps). */
function* walkFiles(root: string, extension: string): Generator<string> {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) yield* walkFiles(path, extension);
		else if (entry.name.endsWith(extension)) yield path;
	}
}

/**
 * EVERY tree that ships browser JS (P2-20 / GATE-30).
 *
 * This walked `client/dedalo` only. `tools/**​/js` is client code served to the
 * same browser and references 90 distinct `get_label` keys — 60 defined in the
 * master and 30 defined NOWHERE, each resolving through a call-site
 * `|| '<English literal>'`: precisely the shape this ratchet freezes for
 * client/, invisible because the corpus was one hardcoded root.
 */
const BROWSER_JS_ROOTS = [CLIENT_ROOT, resolve(import.meta.dir, '../../tools')];

function clientReferencedKeys(): Set<string> {
	const keys = new Set<string>();
	for (const path of BROWSER_JS_ROOTS.flatMap((root) => [...walkFiles(root, '.js')])) {
		const text = readFileSync(path, 'utf8');
		for (const match of text.matchAll(/get_label\.([A-Za-z0-9_]+)/g)) {
			keys.add(match[1] as string);
		}
		for (const match of text.matchAll(/get_label\[['"]([^'"]+)['"]\]/g)) {
			keys.add(match[1] as string);
		}
	}
	return keys;
}

function srcRuleKeys(): Set<string> {
	const keys = new Set<string>();
	for (const path of walkFiles(SRC_ROOT, '.ts')) {
		const text = readFileSync(path, 'utf8');
		for (const match of text.matchAll(/kind:\s*'label',\s*key:\s*'([^']+)'/g)) {
			keys.add(match[1] as string);
		}
		for (const match of text.matchAll(
			/kind:\s*'label_concat',\s*keys:\s*\[\s*'([^']+)',\s*'([^']+)'\s*\]/g,
		)) {
			keys.add(match[1] as string);
			keys.add(match[2] as string);
		}
	}
	return keys;
}

function expectSortedNonEmptyEntries(name: string, map: Record<string, string>): void {
	const keys = Object.keys(map);
	expect(keys, `${name} keys must be sorted`).toEqual([...keys].sort());
	for (const [key, value] of Object.entries(map)) {
		expect(typeof value, `${name} ${key} must be a string`).toBe('string');
		expect(value, `${name} ${key} must not be empty`).not.toBe('');
	}
}

describe('labels tripwire (WC-033 — master.json defines, catalogs translate)', () => {
	const master = loadMaster();
	const masterKeys = new Set(Object.keys(master));
	const catalogs = loadCatalogs();

	test('the master parses to sorted, non-empty string entries', () => {
		expect(Object.keys(master).length).toBeGreaterThan(0);
		expectSortedNonEmptyEntries('master.json', master);
	});

	test('every catalog parses to sorted, non-empty string entries', () => {
		for (const { lang, map } of catalogs) {
			expectSortedNonEmptyEntries(`${lang}.json`, map);
		}
	});

	test('the master-source lang has a catalog (symmetry), holding only real overrides', () => {
		const override = catalogs.find((catalog) => catalog.lang === MASTER_SOURCE_LANG);
		expect(override).toBeDefined();
		// An entry byte-equal to the master's string is duplication, not an
		// override — the master is this lang's baseline; delete the entry.
		const duplicates = Object.entries(override?.map ?? {})
			.filter(([key, value]) => master[key] === value)
			.map(([key]) => key);
		expect(duplicates, `${MASTER_SOURCE_LANG}.json duplicates master.json entries`).toEqual([]);
	});

	test('every catalog key set is a subset of the master', () => {
		for (const { lang, map } of catalogs) {
			const orphans = Object.keys(map).filter((key) => !masterKeys.has(key));
			expect(orphans, `${lang}.json has keys missing from master.json`).toEqual([]);
		}
	});

	test('every statically client-referenced key is defined (or ratcheted)', () => {
		const missing = [...clientReferencedKeys()]
			.filter((key) => !masterKeys.has(key) && !UNCATALOGED_CLIENT_KEYS.has(key))
			.sort();
		expect(
			missing,
			'client references label keys missing from src/core/labels/master.json — add the definitions (the key ships with the code that uses it)',
		).toEqual([]);
	});

	test('every plain label/label_concat widget rule key is defined', () => {
		const missing = [...srcRuleKeys()].filter((key) => !masterKeys.has(key)).sort();
		expect(missing, 'src widget label rules reference undefined keys').toEqual([]);
	});

	test('ratchet stays honest — every entry still referenced and still undefined', () => {
		const referenced = clientReferencedKeys();
		const stale = [...UNCATALOGED_CLIENT_KEYS]
			.filter((key) => !referenced.has(key) || masterKeys.has(key))
			.sort();
		expect(stale, 'prune UNCATALOGED_CLIENT_KEYS — these entries are no longer real').toEqual([]);
	});

	// -----------------------------------------------------------------------
	// FULL TRANSLATION COVERAGE for the non-error label set.
	//
	// The fallback chain means an untranslated key serves the English master
	// string — safe, but SILENT: a Spanish operator sees one English line in an
	// otherwise Spanish panel and nothing anywhere says why. That is how the
	// whole update_code panel sat at 1/107 translated in every language while
	// its neighbour update_ontology_lead was served in 17.
	//
	// So coverage is an INVARIANT, not a chore: a new UI string must ship with
	// its translations, exactly as it already must ship with its master
	// definition. `error_*` is deliberately out of scope — the error registry
	// is its own subsystem with its own disclosure rules — and is the only
	// exemption; it is asserted below so the carve-out cannot quietly widen.
	// -----------------------------------------------------------------------
	test('every non-error master key is translated in every catalog', () => {
		const nonError = Object.keys(loadMaster()).filter((key) => !key.startsWith('error_'));
		const gaps: string[] = [];
		for (const catalog of loadCatalogs()) {
			if (catalog.lang === MASTER_SOURCE_LANG) continue; // sparse override by design
			const missing = nonError.filter((key) => catalog.map[key] === undefined);
			if (missing.length > 0) {
				const shown = missing.slice(0, 5).join(', ');
				gaps.push(
					`${catalog.lang}: ${missing.length} missing (${shown}${missing.length > 5 ? ', …' : ''})`,
				);
			}
		}
		expect(
			gaps,
			'a UI string ships with its translations — `bun run scripts/labels_fill.ts --lang <code>` lists the backlog',
		).toEqual([]);
	});

	test('the only translation-coverage exemption is the error registry', () => {
		// If this ever reaches zero the exemption above is dead and should go;
		// if some OTHER prefix needs exempting it must be added deliberately
		// here, not by widening the filter in the test above.
		const exempt = Object.keys(loadMaster()).filter((key) => key.startsWith('error_'));
		expect(exempt.length).toBeGreaterThan(0);
	});
});
