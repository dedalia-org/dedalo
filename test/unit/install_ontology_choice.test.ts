/**
 * INSTALL ONTOLOGY CHOICE — the pure half of the installer's domain-ontology
 * door (src/core/install/ontology_choice.ts; installer unification A4/A5/A6).
 *
 * WHAT IS MEASURED (outcomes over built catalogs — zzoc scratch TLDs, never a
 * real domain ontology's structure):
 *  - the answer: default / explicit / core dropped with a note / none and
 *    non-TLD refused;
 *  - the closure over DECLARED dependencies: deps-first post-order,
 *    transitivity, cycles tolerated, core and the engine-owned TLD never
 *    followed, an undeclared entry warned (installed alone), a missing
 *    dependency and an unknown TLD refused with their exact texts;
 *  - precedence local > vendored > server (and the merge is idempotent);
 *  - the ONE view (describeOntologyCatalog): fixed TLDs excluded, default
 *    first, note keys, also_installs;
 *  - ACTIVE_ONTOLOGY_TLDS ↔ request round trip (the wizard path) — an optional
 *    dependency the list lacks was declined, a mandatory one refuses;
 *  - hierarchy60 OBJECTS (2026-10-10): mandatory always followed, optional
 *    pre-ticked and declinable (declined_dependencies), an unoffered optional
 *    ontology warned and an unoffered mandatory one refused; `main: hierarchy1`
 *    into the thesaurus set (core lg never, mandatory wins, a TLD declared under
 *    both mains lands in both sets, a self-declared thesaurus kept); a
 *    THESAURUS NEVER BLOCKS (owner decision 2026-10-10): a mandatory one is
 *    pre-ticked AND declinable — declining it is a WARNING naming dependant +
 *    dependency + where to install it later; one with no hierarchy.json entry
 *    is a warning, mandatory or not (an entry WITHOUT data files is
 *    installable: an empty thesaurus); the wizard step's check
 *    (unmetHierarchyDependencies) adds nothing and refuses nothing;
 *  - the vendored catalog is exactly `oh`, its declared dependencies are the
 *    vendored ontology.json entry's (never hard-coded), and the offline default
 *    request installs it alone.
 * Hermetic: no database, no network.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	activeOntologyTldsOf,
	closeOntologyChoice,
	closeThesaurusChoice,
	collectHierarchyDependencies,
	DEFAULT_DOMAIN_ONTOLOGIES,
	declinePolicy,
	defaultOfflineOntologyRequest,
	describeOntologyCatalog,
	hierarchyDependencyPlan,
	listedPolicy,
	mergeHierarchyDependencyLists,
	mergeOntologyCatalogs,
	normalizeDeclinedDependencies,
	normalizeOntologyChoice,
	type OntologyCatalog,
	type OntologyCatalogEntry,
	type OntologyOrigin,
	offeredHierarchyTlds,
	ontologyCatalogNeeded,
	ontologyInstallRequest,
	ontologyRequestFromActive,
	recommendedThesaurusWarning,
	THESAURUS_INSTALL_LATER,
	unmetHierarchyDependencies,
	VENDORED_DOMAIN_TLDS,
	vendoredCoreDeclarers,
	vendoredInfoFrom,
	vendoredOntologyCatalog,
} from '../../src/core/install/ontology_choice.ts';
import { VENDORED_ONTOLOGY_DIR } from '../../src/core/install/paths.ts';
import { CORE_ONTOLOGY_TLDS } from '../../src/core/ontology/core_tlds.ts';
import { ENGINE_TLD } from '../../src/core/ontology/engine_ontology.ts';
import { serializeHierarchyManifest } from '../../src/core/ontology/hierarchy_manifest_format.ts';
import {
	normalizeOntologyDependencies,
	type OntologyDependency,
} from '../../src/core/ontology/ontology_dependencies.ts';
import { scratchHierarchyEntry } from '../../src/core/test_data/hierarchy_entry_fixture.ts';

const SERVER = {
	kind: 'server' as const,
	server: { name: 'zzoc stand-in', url: 'http://127.0.0.1:1/api', code: 'c' },
};
const LABEL = "the ontology server 'zzoc stand-in'";

function entry(
	tld: string,
	dependencies: string[] | null,
	origin: OntologyOrigin = 'server',
	typologyName: string | null = 'Catalog',
): OntologyCatalogEntry {
	return {
		tld,
		name: `${tld} name`,
		name_data: null,
		typology_id: 8,
		typology_name: typologyName,
		// declared ONTOLOGY dependencies (main ontology35, mandatory)
		dependencies:
			dependencies === null
				? null
				: dependencies.map((dependency) => ({
						tld: dependency,
						main: 'ontology35' as const,
						mandatory: true,
					})),
		origin,
		file: `http://127.0.0.1:1/files/${tld}.copy.gz`,
	};
}

/** One declared dependency (hierarchy60 item). */
function dep(
	tld: string,
	main: OntologyDependency['main'],
	mandatory: boolean,
): OntologyDependency {
	return { tld, main, mandatory };
}

/** An entry declaring hierarchy60 OBJECTS verbatim. */
function declaring(tld: string, dependencies: OntologyDependency[] | null): OntologyCatalogEntry {
	return { ...entry(tld, []), dependencies };
}

function catalog(
	entries: OntologyCatalogEntry[],
	extra: Partial<OntologyCatalog> = {},
): OntologyCatalog {
	return { source: SERVER, entries, matrixDd: null, warnings: [], ...extra };
}

const CHAIN = catalog([
	entry('zzoca', ['dd', 'zzocb', 'zzoca']),
	entry('zzocb', ['zzocc', 'rsc']),
	entry('zzocc', []),
	entry('zzocx', ['zzocy']),
	entry('zzocy', ['zzocx', ENGINE_TLD]),
	entry('zzocu', null),
	entry('zzocm', ['zzocmissing']),
]);

describe('the answer (normalizeOntologyChoice)', () => {
	test('absent / default → the default set; explicit lists normalized', () => {
		expect(DEFAULT_DOMAIN_ONTOLOGIES).toEqual(['oh']);
		expect(normalizeOntologyChoice(undefined).ontologies).toEqual(['oh']);
		expect(normalizeOntologyChoice('default').ontologies).toEqual(['oh']);
		expect(normalizeOntologyChoice(' oh, TCH ,oh').ontologies).toEqual(['oh', 'tch']);
		expect(normalizeOntologyChoice(['zzocb', 'zzoca']).ontologies).toEqual(['zzocb', 'zzoca']);
	});

	test('a core TLD is dropped with a note; none / empty / only-core refused', () => {
		const withCore = normalizeOntologyChoice('dd,oh');
		expect(withCore.ontologies).toEqual(['oh']);
		expect(withCore.notes).toEqual([
			'dd is a core ontology (always installed) — dropped from the list',
		]);
		const none = 'at least one domain ontology is required (the default is oh)';
		for (const value of ['none', '', [], 'dd']) {
			expect(normalizeOntologyChoice(value).errors, JSON.stringify(value)).toEqual([none]);
		}
		expect(normalizeOntologyChoice('o-h').errors).toEqual(["ontologies: 'o-h' is not a TLD"]);
	});
});

describe('the closure (closeOntologyChoice)', () => {
	test('deps first, transitive, core + self + engine-owned never followed', () => {
		const closure = closeOntologyChoice(['zzoca'], CHAIN);
		// floor: the walk really visited the chain (the empty-list verdicts below are not vacuous)
		expect(closure.order.length).toBeGreaterThan(2);
		expect(closure.order).toEqual(['zzocc', 'zzocb', 'zzoca']);
		expect(closure.notes).toEqual(['zzoca also installs: zzocc, zzocb']);
		expect(closure.errors).toEqual([]);
		expect(closure.warnings).toEqual([]);
	});

	test('a cycle is tolerated (first finish wins), the engine-owned TLD skipped', () => {
		const closure = closeOntologyChoice(['zzocx'], CHAIN);
		expect(closure.order).toEqual(['zzocy', 'zzocx']);
		expect(closure.errors).toEqual([]);
	});

	test('undeclared → installed alone with the loud warning', () => {
		const closure = closeOntologyChoice(['zzocu'], CHAIN);
		expect(closure.order).toEqual(['zzocu']);
		expect(closure.warnings).toEqual([
			"the ontology source declares no dependencies for 'zzocu' (an older ontology server) — 'zzocu' is installed alone; anything it references in other ontologies stays unresolved",
		]);
	});

	test('a missing dependency and an unknown TLD are errors, named with the source', () => {
		expect(closeOntologyChoice(['zzocm'], CHAIN).errors).toEqual([
			`'zzocmissing', declared as a dependency of 'zzocm', is not offered by ${LABEL}`,
		]);
		expect(closeOntologyChoice(['zzocq'], CHAIN).errors).toEqual([
			`unknown ontology 'zzocq' — not offered by ${LABEL}`,
		]);
		const offline = closeOntologyChoice(['tch'], vendoredOntologyCatalog());
		expect(offline.errors).toEqual([
			"unknown ontology 'tch' — not offered by the built-in set (air-gapped: only oh is available offline)",
		]);
	});

	test('a shared dependency is installed once, before both', () => {
		const shared = catalog([
			entry('zzocp', ['zzocs']),
			entry('zzocr', ['zzocs']),
			entry('zzocs', []),
		]);
		expect(closeOntologyChoice(['zzocp', 'zzocr'], shared).order).toEqual([
			'zzocs',
			'zzocp',
			'zzocr',
		]);
	});
});

describe('precedence and the merge', () => {
	test('local > vendored > server, per TLD; idempotent', () => {
		const vendored = catalog([entry('oh', ['dd'], 'vendored')], { source: { kind: 'none' } });
		const server = catalog([entry('oh', ['dd', 'zzocb'], 'server'), entry('zzocb', [], 'server')]);
		const merged = mergeOntologyCatalogs(server, vendored);
		expect(merged.entries.find((item) => item.tld === 'oh')?.origin).toBe('vendored');
		expect(merged.entries.find((item) => item.tld === 'zzocb')?.origin).toBe('server');
		expect(merged.source).toEqual(SERVER);
		expect(mergeOntologyCatalogs(merged, vendored)).toEqual(merged);
		const local = catalog([entry('oh', [], 'local')], { source: { kind: 'local', path: '/x' } });
		expect(mergeOntologyCatalogs(local, vendored).entries[0]?.origin).toBe('local');
		expect(mergeOntologyCatalogs(undefined, vendored)).toBe(vendored);
	});

	test('the catalog is needed for a local source or a non-vendored TLD — never offline', () => {
		expect(ontologyCatalogNeeded(['oh'], SERVER)).toBe(false);
		expect(ontologyCatalogNeeded(['oh', 'tch'], SERVER)).toBe(true);
		expect(ontologyCatalogNeeded(['oh'], { kind: 'local', path: '/x' })).toBe(true);
		expect(ontologyCatalogNeeded(['tch'], { kind: 'none' })).toBe(false);
	});
});

describe('the one view (describeOntologyCatalog)', () => {
	test('fixed TLDs excluded, default first, then typology, then tld; notes and also_installs', () => {
		const view = describeOntologyCatalog(
			catalog([
				entry('dd', null),
				entry(ENGINE_TLD, null),
				entry('zzocz', [], 'server', 'Alpha'),
				entry('tch', ['zzocz'], 'server', 'Catalog'),
				entry('oh', CORE_ONTOLOGY_TLDS.slice(), 'vendored', 'Catalog'),
				entry('zzock', null, 'server', null),
			]),
		);
		expect(view.entries.map((item) => item.tld)).toEqual(['oh', 'zzocz', 'tch', 'zzock']);
		expect(view.default).toEqual(['oh']);
		expect(view.core).toEqual([...CORE_ONTOLOGY_TLDS]);
		const byTld = new Map(view.entries.map((item) => [item.tld, item]));
		expect(byTld.get('oh')?.is_default).toBe(true);
		expect(byTld.get('oh')?.note_key).toBe('installation_ontology_note_oh');
		expect(byTld.get('tch')?.note_key).toBe('installation_ontology_note_tch');
		expect(byTld.get('tch')?.is_default).toBe(false);
		expect(byTld.get('tch')?.also_installs).toEqual(['zzocz']);
		expect(byTld.get('zzock')?.dependencies).toBeNull();
		expect(view.source).toEqual({
			kind: 'server',
			server: { name: 'zzoc stand-in', url: SERVER.server.url },
		});
	});
});

describe('the request and ACTIVE_ONTOLOGY_TLDS', () => {
	test('ACTIVE = core + install order, and it round-trips to the same request', () => {
		const order = closeOntologyChoice(['zzoca'], CHAIN).order;
		const active = activeOntologyTldsOf(order);
		expect(active).toEqual([...CORE_ONTOLOGY_TLDS, 'zzocc', 'zzocb', 'zzoca']);
		const back = ontologyRequestFromActive(active, CHAIN);
		expect(back.errors).toEqual([]);
		expect(back.request).toEqual(ontologyInstallRequest(order, CHAIN));
	});

	test('an ACTIVE list missing a declared dependency is refused, never extended', () => {
		const back = ontologyRequestFromActive([...CORE_ONTOLOGY_TLDS, 'zzoca'], CHAIN);
		expect(back.request).toBeNull();
		expect(back.errors[0]).toContain(
			'ACTIVE_ONTOLOGY_TLDS lacks zzocc, zzocb, declared as mandatory dependencies',
		);
		expect(ontologyRequestFromActive([...CORE_ONTOLOGY_TLDS], CHAIN).errors).toEqual([
			'at least one domain ontology is required (the default is oh)',
		]);
	});

	test('matrix_dd travels only with an item of its own origin', () => {
		const withLists = catalog([entry('zzocc', []), entry('oh', [], 'vendored')], {
			matrixDd: { origin: 'server', file: 'http://127.0.0.1:1/files/matrix_dd.copy.gz' },
		});
		expect(ontologyInstallRequest(['zzocc'], withLists).matrixDd?.origin).toBe('server');
		expect(ontologyInstallRequest(['oh'], withLists).matrixDd).toBeNull();
	});
});

describe('the vendored catalog', () => {
	test('exactly oh, from its one file, its dependencies the vendored ontology.json entry', () => {
		expect([...VENDORED_DOMAIN_TLDS]).toEqual(['oh']);
		const vendored = vendoredOntologyCatalog();
		expect(vendored.entries.length).toBeGreaterThan(0);
		expect(vendored.warnings).toEqual([]);
		expect(vendored.entries.map((item) => item.tld)).toEqual(['oh']);
		const oh = vendored.entries[0] as OntologyCatalogEntry;
		expect(oh.origin).toBe('vendored');
		expect(existsSync(oh.file)).toBe(true);
		expect(oh.file.endsWith('/oh.copy.gz')).toBe(true);
		expect(oh.name).not.toBe('oh'); // the metadata really came from the vendored ontology.json
		// The declaration is the vendored entry's, through THE normalizer — never
		// a list the installer carries (absent there = null = not declared).
		const info = JSON.parse(readFileSync(join(VENDORED_ONTOLOGY_DIR, 'ontology.json'), 'utf8')) as {
			active_ontologies: { tld: string; dependencies?: unknown }[];
		};
		const raw = info.active_ontologies.find((item) => item.tld === 'oh');
		expect(raw).toBeDefined();
		expect(oh.dependencies).toEqual(normalizeOntologyDependencies('oh', raw?.dependencies, []));
	});

	test('a DECLARING vendored release: oh and the core entries carry it, normalized, into the closure and the thesaurus plan', () => {
		// The vendored 7.0 release predates hierarchy60 (null above): feed the SAME
		// reader a release that declares, so "read, never hard-coded" is measured.
		const [vendoredThesaurus] = [...offeredHierarchyTlds()].sort();
		expect(vendoredThesaurus).toBeDefined();
		const thesaurus = vendoredThesaurus as string;
		const info = vendoredInfoFrom({
			active_ontologies: [
				{
					tld: 'oh',
					name: 'Oral history',
					dependencies: [
						{ tld: ' ZZVDA ', main: 'ontology35', mandatory: false },
						{ tld: thesaurus, main: 'hierarchy1', mandatory: true },
						{ tld: 'zzvdo', main: 'hierarchy1', mandatory: false },
						{ tld: 'oh', main: 'ontology35', mandatory: true }, // self → dropped, warned
					],
				},
				{ tld: 'oh', dependencies: [] }, // a later duplicate never wins
				{ tld: 'dd', dependencies: [{ tld: 'zzvdc', main: 'hierarchy1', mandatory: true }] },
			],
		});
		const vendored = vendoredOntologyCatalog(info);
		const oh = vendored.entries[0] as OntologyCatalogEntry;
		expect(oh.name).toBe('Oral history');
		expect(oh.dependencies).toEqual([
			dep('zzvda', 'ontology35', false),
			dep(thesaurus, 'hierarchy1', true),
			dep('zzvdo', 'hierarchy1', false),
		]);
		expect(vendored.warnings).toHaveLength(1);
		expect(vendored.warnings[0]).toContain('the built-in ontology.json');
		// → the closure: the optional ontology is not offered (warned), the thesauri collected
		const closure = closeOntologyChoice(['oh'], vendored);
		expect(closure.order).toEqual(['oh']);
		expect(closure.errors).toEqual([]);
		expect(closure.warnings.join('\n')).toContain(
			"'zzvda', declared as an optional dependency of 'oh'",
		);
		expect(closure.hierarchies).toEqual([
			{ tld: thesaurus, mandatory: true, dependants: ['oh'] },
			{ tld: 'zzvdo', mandatory: false, dependants: ['oh'] },
		]);
		// → the core declarers (what the seed's core rows hold) and the plan
		const warnings: string[] = [];
		const core = vendoredCoreDeclarers(warnings, info);
		expect(core.find((item) => item.tld === 'dd')?.dependencies).toEqual([
			dep('zzvdc', 'hierarchy1', true),
		]);
		expect(warnings).toEqual([]);
		const collected = collectHierarchyDependencies([...core, oh]);
		const plan = hierarchyDependencyPlan(collected.dependencies);
		expect(plan.install).toEqual([thesaurus]);
		expect(plan.warnings.join('\n')).toContain("'zzvdo'");
		// a mandatory thesaurus with no entry is a WARNING (strongly recommended), never an error
		expect(plan).not.toHaveProperty('errors');
		expect(plan.warnings).toContain(recommendedThesaurusWarning('zzvdc', ['dd'], 'no_entry'));
	});

	test('the offline default request installs the vendored oh alone', () => {
		const request = defaultOfflineOntologyRequest();
		expect(request.items.map((item) => [item.tld, item.origin])).toEqual([['oh', 'vendored']]);
		expect(request.matrixDd).toBeNull();
		expect(request.source).toEqual({ kind: 'none' });
	});
});

// ── hierarchy60 objects: mandatory / optional / main ─────────────────────────

/**
 * zzod* scratch TLDs. zzoda declares: zzodb ontology (mandatory), zzodc
 * ontology (optional), zzodh thesaurus (mandatory), zzodt under BOTH mains
 * (optional), its own thesaurus (self, hierarchy1), lg (core hierarchy) and an
 * unoffered optional ontology zzodq. zzodb declares zzodh optional (zzoda's
 * mandatory wins) and the unoffered optional thesaurus zzodv.
 */
const DECLARED = catalog([
	declaring('zzoda', [
		dep('zzodb', 'ontology35', true),
		dep('zzodc', 'ontology35', false),
		dep('zzodh', 'hierarchy1', true),
		dep('zzodt', 'ontology35', false),
		dep('zzodt', 'hierarchy1', false),
		dep('zzoda', 'hierarchy1', false),
		dep('lg', 'hierarchy1', true),
		dep('zzodq', 'ontology35', false),
	]),
	declaring('zzodb', [dep('zzodh', 'hierarchy1', false), dep('zzodv', 'hierarchy1', false)]),
	declaring('zzodc', []),
	declaring('zzodt', []),
	declaring('zzodm', [dep('zzodmissing', 'ontology35', true)]),
]);

describe('the closure over hierarchy60 objects', () => {
	test('ontology35 → the order (mandatory + accepted optional, deps first); hierarchy1 → the thesauri', () => {
		const closure = closeOntologyChoice(['zzoda'], DECLARED);
		expect(closure.order).toEqual(['zzodb', 'zzodc', 'zzodt', 'zzoda']);
		expect(closure.errors).toEqual([]);
		expect(closure.warnings).toEqual([
			`'zzodq', declared as an optional dependency of 'zzoda', is not offered by ${LABEL} — skipped`,
		]);
		// zzodt declared twice (both mains) lands in BOTH sets; the self-declared
		// thesaurus is kept; lg (core) never listed; zzoda's mandatory zzodh wins
		// over zzodb's optional one, both dependants named, in declaration order.
		expect(closure.hierarchies).toEqual([
			{ tld: 'zzodh', mandatory: true, dependants: ['zzodb', 'zzoda'] },
			{ tld: 'zzodv', mandatory: false, dependants: ['zzodb'] },
			{ tld: 'zzodt', mandatory: false, dependants: ['zzoda'] },
			{ tld: 'zzoda', mandatory: false, dependants: ['zzoda'] },
		]);
	});

	test('declined by TLD or TLD:main: a mandatory ONTOLOGY never; ANY thesaurus — a mandatory one with a warning', () => {
		const byTld = closeOntologyChoice(
			['zzoda'],
			DECLARED,
			declinePolicy(['zzodc', 'zzodt', 'zzodb', 'zzodh']),
		);
		// zzodb is a mandatory ONTOLOGY: declining it changes nothing (the ontology law)
		expect(byTld.order).toEqual(['zzodb', 'zzoda']);
		expect(byTld.errors).toEqual([]);
		// zzodh is a mandatory THESAURUS: declined — left out, never forced in
		expect(byTld.hierarchies.map((item) => [item.tld, item.mandatory, item.dependants])).toEqual([
			['zzodv', false, ['zzodb']],
			['zzoda', false, ['zzoda']],
		]);
		// ONE warning naming dependency + its mandatory dependant + where to install it later
		const recommended = byTld.warnings.filter((line) => line.includes("'zzodh'"));
		expect(recommended).toEqual([
			`the thesaurus 'zzodh' (declared mandatory by 'zzoda') is declined — not installed; it is strongly recommended and can be installed later from ${THESAURUS_INSTALL_LATER}`,
		]);
		expect(THESAURUS_INSTALL_LATER).toBe('Maintenance › Install hierarchies');
		expect(byTld.notes.filter((note) => note.includes("'zzodh'"))).toEqual([]);
		expect(byTld.notes).toContain(
			"the ontology 'zzodc' (an optional dependency of 'zzoda') is declined — not installed",
		);
		expect(byTld.notes).toContain(
			"the thesaurus 'zzodt' (an optional dependency of 'zzoda') is declined — not installed",
		);
		const byMain = closeOntologyChoice(['zzoda'], DECLARED, declinePolicy(['zzodt:hierarchy1']));
		expect(byMain.order).toContain('zzodt'); // its ONTOLOGY is still installed
		expect(byMain.hierarchies.map((item) => item.tld)).not.toContain('zzodt');
		// a mandatory thesaurus declined by TLD:main too
		const mandatoryByMain = closeOntologyChoice(
			['zzoda'],
			DECLARED,
			declinePolicy(['zzodh:hierarchy1']),
		);
		expect(mandatoryByMain.hierarchies.map((item) => item.tld)).not.toContain('zzodh');
		expect(mandatoryByMain.warnings.some((line) => line.includes("'zzodh'"))).toBe(true);
		// not declined (the default): pre-ticked, no warning
		const ticked = closeOntologyChoice(['zzoda'], DECLARED);
		expect(ticked.hierarchies.map((item) => item.tld)).toContain('zzodh');
		expect(ticked.warnings.some((line) => line.includes("'zzodh'"))).toBe(false);
	});

	test('a declined thesaurus the answer installs anyway is never warned "declined"', () => {
		const closure = closeOntologyChoice(['zzoda'], DECLARED, declinePolicy(['zzodh', 'zzodt']), {
			chosenThesauri: ['zzodh', 'zzodt'],
		});
		expect(closure.warnings.some((line) => line.includes("'zzodh'"))).toBe(false);
		expect(closure.notes.some((line) => line.includes("the thesaurus 'zzodt'"))).toBe(false);
		// its ONTOLOGY half is really declined (and noted) — the answer only installs the thesaurus
		expect(closure.notes.some((line) => line.includes("the ontology 'zzodt'"))).toBe(true);
	});

	test('core declarers join the thesaurus set (ONE collection — mandatory wins)', () => {
		const closure = closeOntologyChoice(
			['zzodb'],
			DECLARED,
			{},
			{
				coreDeclarers: [{ tld: 'dd', dependencies: [dep('zzodv', 'hierarchy1', true)] }],
			},
		);
		expect(closure.hierarchies).toEqual([
			{ tld: 'zzodv', mandatory: true, dependants: ['dd', 'zzodb'] },
			{ tld: 'zzodh', mandatory: false, dependants: ['zzodb'] },
		]);
	});

	test('a FIXED (core / engine-owned) optional dependency is never declined nor noted', () => {
		// The seed always installs core: declining it changes nothing, so no
		// "declined — not installed" note may claim otherwise (by token, or by an
		// ACTIVE list that — rightly — never lists core).
		const fixed = catalog([
			declaring('zzodf', [
				dep('rsc', 'ontology35', false),
				dep(ENGINE_TLD, 'ontology35', false),
				dep('lg', 'hierarchy1', false),
				dep('zzodc', 'ontology35', false),
			]),
			declaring('zzodc', []),
		]);
		const declined = closeOntologyChoice(
			['zzodf'],
			fixed,
			declinePolicy(['rsc', ENGINE_TLD, 'lg', 'zzodc']),
		);
		expect(declined.order).toEqual(['zzodf']);
		expect(declined.hierarchies).toEqual([]);
		expect(declined.notes).toEqual([
			"the ontology 'zzodc' (an optional dependency of 'zzodf') is declined — not installed",
		]);
		// the written-list policy (ACTIVE never carries core) declines nothing fixed
		const listed = closeOntologyChoice(['zzodf'], fixed, listedPolicy(['zzodf']));
		expect(listed.errors).toEqual([]);
		expect(listed.notes.filter((note) => /'(rsc|lg|ddengine)'/.test(note))).toEqual([]);
		expect(ontologyRequestFromActive([...CORE_ONTOLOGY_TLDS, 'zzodf'], fixed).errors).toEqual([]);
	});

	test('a mandatory dependency the source does not offer refuses', () => {
		expect(closeOntologyChoice(['zzodm'], DECLARED).errors).toEqual([
			`'zzodmissing', declared as a dependency of 'zzodm', is not offered by ${LABEL}`,
		]);
	});

	test('the written ACTIVE list: an optional dependency it lacks was declined, a mandatory one refuses', () => {
		const declined = ontologyRequestFromActive([...CORE_ONTOLOGY_TLDS, 'zzodb', 'zzoda'], DECLARED);
		expect(declined.errors).toEqual([]);
		expect(declined.request?.items.map((item) => item.tld)).toEqual(['zzodb', 'zzoda']);
		const full = ontologyRequestFromActive(
			[...CORE_ONTOLOGY_TLDS, 'zzodb', 'zzodc', 'zzodt', 'zzoda'],
			DECLARED,
		);
		expect(full.request?.items.map((item) => item.tld)).toEqual([
			'zzodb',
			'zzodc',
			'zzodt',
			'zzoda',
		]);
		const lacking = ontologyRequestFromActive([...CORE_ONTOLOGY_TLDS, 'zzoda'], DECLARED);
		expect(lacking.request).toBeNull();
		expect(lacking.errors[0]).toContain('ACTIVE_ONTOLOGY_TLDS lacks zzodb');
	});

	test('the view carries the transitive ontologies and the declared thesauri', () => {
		const view = describeOntologyCatalog(DECLARED);
		const zzoda = view.entries.find((item) => item.tld === 'zzoda');
		expect(zzoda?.also_installs).toEqual(['zzodb', 'zzodc', 'zzodt']);
		expect(zzoda?.hierarchy_dependencies.map((item) => [item.tld, item.mandatory])).toEqual([
			['zzodh', true],
			['zzodv', false],
			['zzodt', false],
			['zzoda', false],
		]);
		expect(zzoda?.dependencies).toHaveLength(8);
	});

	test('a declined optional dependency never makes the plan fetch a catalog', () => {
		const vendoredOnly: OntologyCatalog = vendoredOntologyCatalog();
		expect(vendoredOnly.entries.length).toBe(1);
		expect(ontologyCatalogNeeded(['oh'], SERVER, declinePolicy(['zzodc']))).toBe(false);
	});
});

describe('the declined_dependencies answer', () => {
	test('TLD or TLD:main, lowercased, de-duplicated; malformed refused; none/absent = []', () => {
		expect(normalizeDeclinedDependencies(' ZZODC, zzodt:hierarchy1,zzodc ')).toEqual({
			declined: ['zzodc', 'zzodt:hierarchy1'],
			errors: [],
		});
		for (const value of [undefined, null, '', 'none']) {
			expect(normalizeDeclinedDependencies(value)).toEqual({ declined: [], errors: [] });
		}
		expect(normalizeDeclinedDependencies(['zz-x', 'zzodt:section', 'a:b:c']).errors).toEqual([
			"declined_dependencies: 'zz-x' is not a TLD or <tld>:ontology35|hierarchy1",
			"declined_dependencies: 'zzodt:section' is not a TLD or <tld>:ontology35|hierarchy1",
			"declined_dependencies: 'a:b:c' is not a TLD or <tld>:ontology35|hierarchy1",
		]);
	});
});

describe('the thesaurus set → install_hierarchies', () => {
	// A real VENDORED thesaurus, read at run time (installer data, not a record).
	const vendored = [...offeredHierarchyTlds()][0] as string;
	const declared = collectHierarchyDependencies([
		{ tld: 'zzoda', dependencies: [dep(vendored, 'hierarchy1', true)] },
		{ tld: 'zzodb', dependencies: [dep('zzodw', 'hierarchy1', false)] },
		{ tld: 'zzodc', dependencies: [dep('zzodx', 'hierarchy1', true)] },
	]).dependencies;

	test('an entry WITHOUT data files is installable (2026-10-10 rule)', () => {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo-ontology-choice-'));
		try {
			const manifest = {
				version: 'scratch',
				date: 'scratch',
				entity_id: null,
				entity: null,
				entity_label: null,
				host: null,
				typologies: [{ typology_id: 2, name: 'Toponymy', name_data: [] }],
				active_hierarchies: [
					scratchHierarchyEntry({ tld: 'zzode', name: 'ZZ empty', langSectionId: 1 }),
				],
			};
			writeFileSync(join(dir, 'hierarchy.json'), serializeHierarchyManifest(manifest));
			const offered = offeredHierarchyTlds(dir);
			expect([...offered]).toEqual(['zzode']);
			const plan = hierarchyDependencyPlan(
				collectHierarchyDependencies([
					{ tld: 'zzoda', dependencies: [dep('zzode', 'hierarchy1', true)] },
				]).dependencies,
				offered,
			);
			expect(plan).toEqual({ install: ['zzode'], warnings: [] });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('listed → installed; no entry → a warning + skipped, mandatory or not (never an error)', () => {
		expect(vendored).toMatch(/^[a-z]+$/);
		const plan = hierarchyDependencyPlan(declared);
		expect(plan.install).toEqual([vendored]);
		expect(plan.warnings).toEqual([
			"the thesaurus 'zzodw', an optional dependency of 'zzodb', has no entry in hierarchy.json — skipped",
			`the thesaurus 'zzodx' (declared mandatory by 'zzodc') has no entry in hierarchy.json — skipped; it is strongly recommended and can be installed later from ${THESAURUS_INSTALL_LATER}`,
		]);
		expect(plan).not.toHaveProperty('errors');
	});

	test('the wizard step: the posted list is the answer — nothing added, a mandatory one left out warned', () => {
		const offered = new Set([vendored, 'zzodw']);
		const optionalOnly = collectHierarchyDependencies([
			{ tld: 'zzodb', dependencies: [dep('zzodw', 'hierarchy1', false)] },
		]).dependencies;
		// an optional one left out: silent (the posted list answered it)
		expect(unmetHierarchyDependencies([], optionalOnly, offered)).toEqual({ warnings: [] });
		// a mandatory one ticked: nothing to say
		expect(unmetHierarchyDependencies([vendored], declared.slice(0, 1), offered)).toEqual({
			warnings: [],
		});
		// a mandatory one unticked (declined): a warning, never added
		expect(unmetHierarchyDependencies(['zzodw'], declared.slice(0, 1), offered)).toEqual({
			warnings: [recommendedThesaurusWarning(vendored, ['zzoda'], 'declined')],
		});
		// a mandatory one with no entry: the no-entry warning, never a refusal
		expect(unmetHierarchyDependencies([vendored], declared, offered)).toEqual({
			warnings: [recommendedThesaurusWarning('zzodx', ['zzodc'], 'no_entry')],
		});
	});
});

describe('the thesauri a THESAURUS declares (closeThesaurusChoice)', () => {
	// hierarchy.json entries as declarers: zzica needs zzicb (mandatory) and zzicc
	// (optional); zzicb needs zzicd (mandatory, TRANSITIVE); zzice declares an ontology.
	const h = (tld: string, mandatory: boolean) => ({ tld, main: 'hierarchy1' as const, mandatory });
	const o = (tld: string, mandatory: boolean) => ({ tld, main: 'ontology35' as const, mandatory });
	const entries = [
		{ tld: 'zzica', dependencies: [h('zzicb', true), h('zzicc', false), h('lg', true)] },
		{ tld: 'zzicb', dependencies: [h('zzicd', true)] },
		{ tld: 'zzicc', dependencies: null },
		{ tld: 'zzicd', dependencies: [] },
		{ tld: 'zzice', dependencies: [o('zzicont', true), o('zzopt', false), o('dd', true)] },
		{ tld: 'zzicf', dependencies: [h('zzmissing', true), h('zzgone', false)] },
	];
	const none = new Set<string>();

	test('a mandatory dependency is added TRANSITIVELY, an optional one pre-ticked, core never', () => {
		const closure = closeThesaurusChoice(['zzica'], entries, none);
		expect(closure.hierarchies).toEqual(['zzica', 'zzicb', 'zzicc', 'zzicd']);
		expect(closure.errors).toEqual([]);
		expect(closure.warnings).toEqual([]);
		expect(closure.notes).toEqual([
			"the thesaurus 'zzicb' is a mandatory dependency of 'zzica' — installed",
			"the thesaurus 'zzicc' is an optional dependency of 'zzica' — installed",
			"the thesaurus 'zzicd' is a mandatory dependency of 'zzicb' — installed",
		]);
		expect(closure.dependencies.map((item) => [item.tld, item.mandatory])).toEqual([
			['zzicb', true],
			['zzicc', false],
			['zzicd', true],
		]);
	});

	test('declined: an optional one stays out silently, a MANDATORY one stays out with a warning — never forced', () => {
		const declined = closeThesaurusChoice(['zzica'], entries, none, {
			accept: () => false,
		});
		expect(declined.hierarchies).toEqual(['zzica']);
		expect(declined.errors).toEqual([]);
		expect(declined.notes).toEqual([]);
		expect(declined.warnings).toEqual([
			recommendedThesaurusWarning('zzicb', ['zzica'], 'declined'),
		]);
		// declining only zzicd: zzicb (mandatory) is pre-ticked in, its zzicd declined + warned
		const deep = closeThesaurusChoice(['zzica'], entries, none, declinePolicy(['zzicd']));
		expect(deep.hierarchies).toEqual(['zzica', 'zzicb', 'zzicc']);
		expect(deep.warnings).toEqual([recommendedThesaurusWarning('zzicd', ['zzicb'], 'declined')]);
	});

	test('a dependency with no entry → a warning, mandatory or not (THE entry rule) — never an error', () => {
		const closure = closeThesaurusChoice(['zzicf'], entries, none);
		expect(closure.hierarchies).toEqual(['zzicf']);
		expect(closure.errors).toEqual([]);
		expect(closure.warnings).toEqual([
			recommendedThesaurusWarning('zzmissing', ['zzicf'], 'no_entry'),
			"the thesaurus 'zzgone', an optional dependency of 'zzicf', has no entry in hierarchy.json — skipped",
		]);
	});

	test('a declared ONTOLOGY must be part of the install (core always is)', () => {
		const missing = closeThesaurusChoice(['zzice'], entries, none);
		expect(missing.errors).toEqual([
			"the ontology 'zzicont', a mandatory dependency of the thesaurus 'zzice', is not part of this install — add it to the ontologies",
		]);
		expect(missing.warnings).toEqual([
			"the ontology 'zzopt', an optional dependency of the thesaurus 'zzice', is not part of this install — skipped",
		]);
		const installed = closeThesaurusChoice(['zzice'], entries, new Set(['zzicont', 'zzopt']));
		expect(installed.errors).toEqual([]);
		expect(installed.warnings).toEqual([]);
	});

	test('an unlisted chosen tld declares nothing (its own refusal is the importer’s)', () => {
		expect(closeThesaurusChoice(['zzunknown'], entries, none)).toEqual({
			hierarchies: ['zzunknown'],
			dependencies: [],
			notes: [],
			warnings: [],
			errors: [],
		});
	});

	test('mergeHierarchyDependencyLists: per tld, mandatory wins, dependants accumulate', () => {
		expect(
			mergeHierarchyDependencyLists(
				[{ tld: 'zzicb', mandatory: false, dependants: ['oh'] }],
				[
					{ tld: 'zzicb', mandatory: true, dependants: ['zzica'] },
					{ tld: 'zzicc', mandatory: false, dependants: ['zzica'] },
				],
			),
		).toEqual([
			{ tld: 'zzicb', mandatory: true, dependants: ['oh', 'zzica'] },
			{ tld: 'zzicc', mandatory: false, dependants: ['zzica'] },
		]);
	});
});
