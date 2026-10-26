/**
 * TRIPWIRE — an authorization decision may not be gated by a source substring
 * (S-2 clause 4 / P0-15; the SEC-01 lesson, GATE-24, P2-19 residue).
 *
 * Export Gate B — the one check between an authenticated non-admin and the
 * dd133 password hashes — had exactly ONE assertion in the whole tree:
 * `src.includes('getPermissions(context.principal, seg.section_tipo, …)')`.
 * That line stayed green through `< 1` → `< 0`, an `if (false)` around the
 * loop, and `throw` → `continue`, because a substring sees the spelling of a
 * call and nothing of the guard, the comparison or the refusal. The decision
 * was neutered and the gate said PASS.
 *
 * THE RULE, PER SYMBOL. A test file that pins an authorization symbol as a
 * source substring — a literal holding `getPermissions(`, `isRecordInScope\(`,
 * `getPermissions\s*\(`, `principal.isGlobalAdmin` … used as a NEEDLE: an
 * argument of `includes` / `indexOf` / `toContain` / `toMatch` / `split` /
 * `replace` / `matchAll` …, the receiver of `/re/.test(src)` / `.exec(src)` /
 * `new RegExp(s).test(src)`, an argument of a local `has(src, needle)` helper,
 * or hoisted into a constant / array / object property / for…of — must ALSO
 * drive THAT symbol in the same file: a real call of it through a real
 * import, or — for the role-flag member — a principal-driven refusal. A pin
 * whose symbol has no such leg is admitted ONLY through the ENUMERATED map
 * below, which names, PER SYMBOL, the behavioural twin that drives it. The map
 * is LIVE in both directions: the twin must exist, must carry a leg for that
 * symbol, must still hold the case it is credited with; and the exempted file's
 * uncovered symbols must be EXACTLY the map's keys, else the entry is stale.
 *
 * WHY PER SYMBOL. The first cut credited a whole file for one real call:
 * `security_audit_2026_07_23_tripwire` drives `scopeInverseReferenceHits` as a
 * global admin, and that licensed its substring pin of AUTHZ-06's per-user
 * project narrowing — measured: `|| true` on that filter (every non-admin sees
 * every tenant's projects) stayed green suite-wide. The alibi shape is planted
 * below as a control.
 *
 * WHY THE MAP IS SHRINK-ONLY. A pinned call-site shape next to a behavioural
 * twin is legitimate (it says WHERE the decision sits; the twin says THAT it
 * decides). But "a twin exists somewhere" is exactly what Gate B's substring
 * could have claimed, so no pin gets a twin implicitly: every entry names its
 * twin and the case, and the ceilings only fall.
 *
 * THE CLASSIFIER is `scripts/lib/authz_substring_census.ts` — pure over
 * (file, source), so every offender and twin below is PLANTED, never
 * borrowed from the tree. Symbols are DERIVED from the authorization modules'
 * exports plus the functions in src/ and tools/ that wrap them; the seven
 * canonical names are asserted as a floor so a broken derivation is red.
 *
 * HERMETIC: filesystem reads of tracked source only.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	authzSubstringCensus,
	classifyAuthzFile,
	deriveAuthzSymbols,
	deriveCoreSymbols,
	deriveWrapperGraph,
	deriveWrapperSymbols,
	legFor,
	ROLE_FLAG_MEMBER,
	substringOnlyFiles,
} from '../../scripts/lib/authz_substring_census.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** The names a broken derivation would lose first — the ones the audit named. */
const CANONICAL_DECISIONS = [
	'getPermissions',
	'ddoIsAuthorized',
	'principalCanAccessRecord',
	'isRecordInScope',
	'assertRecordWriteTarget',
	'resolveOwnUserRecordPermission',
	'getRecordComponentPermission',
];

interface Twin {
	/** repo-relative path of the behavioural gate */
	file: string;
	/** a test NAME in that file — the case the exemption is credited with */
	case: string;
	/** which of the exempted file's pins of this symbol the twin carries (the location) */
	covers: string;
}

interface Exemption {
	reason: string;
	/** uncovered symbol → the twins that drive it (one credited case each) */
	pins: Record<string, Twin[]>;
}

/**
 * ENUMERATED, SHRINK-ONLY. Every entry: the substring-only file → for EACH of
 * its uncovered symbols, the twins that drive that decision, one case each.
 * Add nothing here — write the behavioural twin and, if the pin is worth
 * keeping as a location marker, add the entry WITH the twin; a twin that does
 * not yet exist is not an entry.
 */
const EXEMPTIONS: Record<string, Exemption> = {
	'test/unit/human_write_scope_tripwire.test.ts': {
		reason:
			'Pins WHERE two tool write doors decide (TOOLS-01/02); each decision is driven behaviourally by the named twin. The TOOLS-05/06 pins are GONE (closure Step 3): both decisions moved into the write door and are driven by write_door_native / tool_transcription_gate_native.',
		pins: {
			principalCanAccessRecord: [
				{
					file: 'test/unit/tool_propagate_component_data_drive.test.ts',
					case: 'the imperative tipo-pair gate refuses a non-admin and writes NOTHING',
					covers:
						'TOOLS-01 — propagate_component_data refuses a write target the principal cannot reach (principalCanAccessRecord per row)',
				},
			],
			getRecordComponentPermission: [
				{
					file: 'test/unit/dd128_write_census_tripwire.test.ts',
					case: 'tool_propagate_component_data REFUSES a self-targeted dd1725 write',
					covers:
						'TOOLS-01 — the per-row write permission resolves through the RECORD-addressed resolver, driven with a resolved non-admin',
				},
			],
			getPermissions: [
				{
					file: 'test/unit/export_gate_b_native.test.ts',
					case: 'an unauthorized ddo segment is REFUSED',
					covers: 'TOOLS-02 — export Gate A+B (getPermissions per SQO section and per ddo segment)',
				},
				{
					file: 'test/unit/tool_propagate_component_data_drive.test.ts',
					case: 'the imperative tipo-pair gate refuses a non-admin and writes NOTHING',
					covers:
						'TOOLS-01 — the per-row getPermissions(principal, row.section_tipo, componentTipo)',
				},
			],
		},
	},
	'test/unit/diffusion_scope_tripwire.test.ts': {
		reason:
			'DIFF-B pins WHERE the diffuse action strips skip_publication_state_check and clamps levels; the twin drives both with a resolved non-admin and a resolved global admin and reads the stored job spec.',
		pins: {
			[ROLE_FLAG_MEMBER]: [
				{
					file: 'test/unit/diffusion_diffuse_scope_native.test.ts',
					case: "a non-admin's skip_publication_state_check VANISHES from the stored spec",
					covers: 'DIFF-B — principal.isGlobalAdmin gates the bypass; levels clamped for everyone',
				},
			],
		},
	},
	'test/unit/security_audit_2026_07_23_tripwire.test.ts': {
		reason:
			"AUTHZ-05 pins WHERE the inverse-reference scan is scoped (record_scope + the related-count door, and the door registry's scope call — scopeInverseReferenceHits / scopeRecordHits / the set-shaped anyRowInScope and rowScopeFor) and AUTHZ-06 WHERE the get_data facade self-gates; the file itself drives scopeInverseReferenceHits only as a global admin. The isRecordInScope pin is GONE (PERF-01): the projects leg is pinned as the SHARED PREDICATE (one buildSearchSql site, both doors routed through it), its behavioural twin count_native.test.ts. The AUTHZ-06 datalist pins (getUserProjects, the admin ternary) are GONE (READ-1): filter_projects_scope_native / filter_projects_membership_native hold the narrowing as outcomes.",
		pins: {
			getPermissions: [
				{
					file: 'test/unit/indexation_grid_tc_native.test.ts',
					case: 'a caller with no read grant on the section loses its rows',
					covers:
						'AUTHZ-05 — the section-read half of scopeInverseReferenceHits (getPermissions(principal, hit.section_tipo, hit.section_tipo)), driven through the indexation grid with a level-0 caller',
				},
			],
			rowScopeFor: [
				{
					file: 'test/unit/related_scope_equivalence_native.test.ts',
					case: 'D1: count == the full paged walk == the probe boundary, and the walk is exactly the in-scope referrers',
					covers:
						"AUTHZ-05 / D1 — the related count, page and probe are scoped by rowScopeFor(principal) (the door registry's set-shaped scope call): driven for a non-admin with partial project scope and an unreadable referencing section — count == walk == probe, nothing out of scope leaks",
				},
			],
			anyRowInScope: [
				{
					file: 'test/unit/client_page_doors_native.test.ts',
					case: 'the SET-SHAPED scope (anyRowInScope) answers record by record exactly what the hit-list scope answers',
					covers:
						"AUTHZ-05 — the door registry accepts anyRowInScope as a door's scope call: it is driven for a reader and an admin over records each half of the rule (projects, section grant, dd478) decides, and must equal scopeInverseReferenceHits cell for cell",
				},
			],
			getRecordComponentPermission: [
				{
					file: 'test/unit/filter_projects_scope_native.test.ts',
					case: 'get_data of a component the reader holds level 0 on answers the EMPTY shell',
					covers:
						'AUTHZ-06 — the component get_data facade self-gates on getRecordComponentPermission(principal, source.section_tipo, source.tipo, source.section_id) (record-scoped since the dd128 own-record rules)',
				},
			],
		},
	},
	'test/unit/indexation_grid_tc_native.test.ts': {
		reason:
			'Pins that the indexation grid DELEGATES to scopeInverseReferenceHits (AUTHZ-05, no private copy of the rule); the same file drives the grid scoping with a level-0 caller and a global admin.',
		pins: {
			scopeInverseReferenceHits: [
				{
					file: 'test/unit/indexation_grid_tc_native.test.ts',
					case: 'a caller with no read grant on the section loses its rows',
					covers:
						'scopeIndexationGroups (which calls scopeInverseReferenceHits directly) drops the section the caller cannot read and leaves the admin unscoped',
				},
			],
		},
	},
};

/**
 * The map only falls: an entry removed lowers these; an entry added is refused.
 * (16 = the 14 of the argument-only census + the two pins the receiver/split
 * shapes made visible — human_write_scope's scopeIfRecordTargeted and dd128's
 * isRecordInScope — counted the day the census learned to see them.)
 */
const EXEMPTION_FILE_CEILING = 4;
const EXEMPTION_PIN_CEILING = 10;

// --- planted material (never borrowed from the tree) --------------------------

/** The four direct pin shapes, no leg at all. */
const OFFENDER = {
	file: 'test/unit/zz_planted_offender.test.ts',
	source: `
import { readFileSync } from 'node:fs';
const src = readFileSync('x.ts', 'utf8');
test('pins the call', () => {
	expect(src.includes('getPermissions(principal, sectionTipo, componentTipo)')).toBe(true);
	expect(src).toContain(
		'isRecordInScope(sectionTipo, sectionId, principal)',
	);
	// The EXACT Gate-B pin of SEC-01, in regex form: the paren is escaped.
	expect(src).toMatch(/getPermissions\\(context\\.principal, seg\\.section_tipo/);
	expect(src).toMatch(/if \\(principal\\.isGlobalAdmin\\)/);
});
`,
};

/** Needles that never sit next to the assertion: hoisted, arrayed, RegExp-built; async fs. */
const HOISTED = {
	file: 'test/unit/zz_planted_hoisted.test.ts',
	source: `
import { readFile } from 'node:fs/promises';
const NEEDLE = 'getPermissions(context.principal, seg.section_tipo, seg.component_tipo)';
const NEEDLES: string[] = [
	'isRecordInScope(sectionTipo, sectionId, principal)',
	'principalCanAccessRecord(row.section_tipo, row.section_id, principal)',
];
const GUARD = 'if \\\\(principal\\\\.isGlobalAdmin\\\\)';
test('pins through constants', async () => {
	const src = await readFile('x.ts', 'utf8');
	expect(src.includes(NEEDLE)).toBe(true);
	for (const needle of NEEDLES) expect(src).toContain(needle);
	expect(src).toMatch(new RegExp(GUARD));
	expect(src).toMatch(new RegExp('ddoIsAuthorized\\\\(principal'));
});
`,
};

/** The security_audit shape: one real call of an UNRELATED symbol next to a pin. */
const ALIBI = {
	file: 'test/unit/zz_planted_alibi.test.ts',
	source: `
import { readFileSync } from 'node:fs';
import { scopeInverseReferenceHits } from '../../src/core/security/record_scope.ts';
const src = readFileSync('x.ts', 'utf8');
test('drives one decision, pins another', async () => {
	const admin = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
	expect(await scopeInverseReferenceHits([], admin)).toEqual([]);
	expect(src).toContain('scopeInverseReferenceHits(hits, principal)');
	expect(src).toContain('getUserProjects(principal.userId)');
});
`,
};

/** The ALIBI file with the pin's OWN symbol driven instead. */
const ALIBI_COVERED = {
	file: 'test/unit/zz_planted_alibi_covered.test.ts',
	source: `
import { readFileSync } from 'node:fs';
import { getUserProjects } from '../../src/core/security/permissions.ts';
const src = readFileSync('x.ts', 'utf8');
test('drives the pinned decision', async () => {
	const admin = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
	expect(await getUserProjects(admin.userId)).toEqual([]);
	expect(src).toContain('scopeInverseReferenceHits(hits, principal)');
	expect(src).toContain('getUserProjects(principal.userId)');
});
`,
};

/**
 * The literal as the RECEIVER: `/re/.test(src)`, `/re/.exec(src)`,
 * `new RegExp(s).test(src)`, a hoisted regex `RE.exec(src)` — the idiomatic
 * regex assertion, where nothing precedes the literal. Includes the EXACT
 * SEC-01 Gate-B pin and regex whitespace between name and paren.
 */
const RECEIVER = {
	file: 'test/unit/zz_planted_receiver.test.ts',
	source: `
import { readFileSync } from 'node:fs';
const src = readFileSync('x.ts', 'utf8');
const RE = /assertRecordWriteTarget\\(/;
test('regex receivers', () => {
	expect(/getPermissions\\(context\\.principal, seg\\.section_tipo, seg\\.component_tipo\\)/.test(src)).toBe(true);
	expect(new RegExp('if \\\\(!principal\\\\.isGlobalAdmin\\\\)', 's').test(src)).toBe(true);
	expect(/isRecordInScope\\s*\\(sectionTipo/.exec(src)).not.toBeNull();
	expect(RE.exec(src)?.[0]).toBeDefined();
	const inlined = /if\\s*\\(!principal\\.isGlobalAdmin\\)\\s*\\{[\\s\\S]{0,400}?ddoIsAuthorized\\(/.exec(src);
	expect(inlined).toBeNull();
});
`,
};

/** Counting / rewriting haystack methods: split, matchAll, replace (second argument too). */
const SPLIT_EXEC = {
	file: 'test/unit/zz_planted_split.test.ts',
	source: `
import { readFileSync } from 'node:fs';
const src = readFileSync('x.ts', 'utf8');
test('counts and rewrites', () => {
	expect(src.split('return authorizeSectionTarget(principal, raw, options)').length - 1).toBe(2);
	expect([...src.matchAll(/principalCanAccessRecord\\(/g)].length).toBe(3);
	expect(src.replace('if (principal.isGlobalAdmin)', 'X')).not.toBe(src);
	expect(src.replace(/x/g, 'gateRecord(mediaDdo, ctx, 1)')).toBeDefined();
});
`,
};

/** Needles reached through an object property and a local helper. */
const OBJECT_AND_HELPER = {
	file: 'test/unit/zz_planted_object_helper.test.ts',
	source: `
import { readFileSync } from 'node:fs';
const src = readFileSync('x.ts', 'utf8');
const PINS = {
	gateB: 'getPermissions(context.principal, seg.section_tipo, seg.component_tipo)',
	guard: /principal\\.isGlobalAdmin/,
};
function has(haystack: string, needle: string): boolean {
	return haystack.includes(needle);
}
const count = (haystack: string, re: RegExp) => [...haystack.matchAll(re)].length;
const hasAll = (haystack: string, ...needles: string[]) => needles.every((n) => has(haystack, n));
test('object and helper needles', () => {
	expect(src.includes(PINS.gateB)).toBe(true);
	expect(PINS.guard.test(src)).toBe(true);
	expect(has(src, 'isRecordInScope(sectionTipo, sectionId, principal)')).toBe(true);
	expect(count(src, /authorizeRecordAccess\\(/g)).toBe(4);
	expect(hasAll(src, 'x', 'ddoIsAuthorized(principal, sectionTipo, tipo)')).toBe(true);
});
`,
};

/** Imports the decision, pins it, never CALLS it — an import is not a leg. */
const IMPORT_NO_CALL = {
	file: 'test/unit/zz_planted_import_no_call.test.ts',
	source: `
import { readFileSync } from 'node:fs';
import { getPermissions } from '../../src/core/security/permissions.ts';
const src = readFileSync('x.ts', 'utf8');
// getPermissions(principal, s, c) is what the loop must call
test('imports and pins, never drives', () => {
	expect(typeof getPermissions).toBe('function');
	expect(src.includes('getPermissions(principal, sectionTipo, componentTipo)')).toBe(true);
});
`,
};

const TWIN_BY_CALL = {
	file: 'test/unit/zz_planted_twin_call.test.ts',
	source: `
import { readFileSync } from 'node:fs';
import { getPermissions } from '../../src/core/security/permissions.ts';
const src = readFileSync('x.ts', 'utf8');
test('pins AND drives', async () => {
	expect(src.includes('getPermissions(principal, sectionTipo, componentTipo)')).toBe(true);
	expect(await getPermissions(reader, 'test3', 'test91')).toBe(0);
});
`,
};

/** A refusal covers the role-flag pin in-file — and NOT a function-symbol pin. */
const TWIN_BY_REFUSAL = {
	file: 'test/unit/zz_planted_twin_refusal.test.ts',
	source: `
import { readFileSync } from 'node:fs';
import { refusalOf } from '../helpers/refusal.ts';
const src = readFileSync('x.ts', 'utf8');
test('pins AND refuses', async () => {
	expect(src.includes('principal.isGlobalAdmin')).toBe(true);
	expect(src.includes('getPermissions(principal, s, c)')).toBe(true);
	expect((await refusalOf(handler({ principal: reader }))).code).toBe('perm.denied');
});
`,
};

/** A same-named LOCAL function is not a real call of the decision. */
const LOCAL_FAKE = {
	file: 'test/unit/zz_planted_local_fake.test.ts',
	source: `
import { readFileSync } from 'node:fs';
async function getPermissions(): Promise<number> { return 0; }
const src = readFileSync('x.ts', 'utf8');
test('pins and calls a look-alike', async () => {
	expect(src.includes('getPermissions(principal, sectionTipo, componentTipo)')).toBe(true);
	expect(await getPermissions()).toBe(0);
});
`,
};

/** A principal FIXTURE (object-literal key) is data, not a decision. */
const FIXTURE_ONLY = {
	file: 'test/unit/zz_planted_fixture.test.ts',
	source: `
import { readFileSync } from 'node:fs';
const src = readFileSync('x.ts', 'utf8');
test('a principal literal', () => {
	expect(src.includes('isGlobalAdmin: true')).toBe(true);
	expect(src).toContain('{ userId: 7, isGlobalAdmin: false, isDeveloper: false }');
	expect(src).toMatch(/\\{ userId: 7, isGlobalAdmin: false \\}/);
});
`,
};

/** A mention in prose, a comment, or a constant nothing asserts is not a pin. */
const PROSE_ONLY = {
	file: 'test/unit/zz_planted_prose.test.ts',
	source: `
import { readFileSync } from 'node:fs';
// the write loop must call getPermissions( before it writes
const src = readFileSync('x.ts', 'utf8');
const UNUSED = 'isRecordInScope(sectionTipo, sectionId, principal)';
test('names the symbol without pinning it', () => {
	// expect(src.includes('getPermissions(principal, s, c)')).toBe(true);
	/* expect(src).toContain('isRecordInScope(s, id, principal)'); */
	const note = 'see getPermissions( in the loop';
	expect(src.length).toBeGreaterThan(0);
	expect(note).toBeDefined();
	expect(UNUSED.length).toBeGreaterThan(0);
});
`,
};

const shapes = (report: { sites: { method: string; symbol: string; via?: string }[] }) =>
	report.sites.map((site) => `${site.method}:${site.symbol}${site.via ? `@${site.via}` : ''}`);

describe('an authorization decision may not be gated by a source substring', () => {
	const symbols = deriveAuthzSymbols(REPO_ROOT);
	const { scanned, reports } = authzSubstringCensus(REPO_ROOT, symbols);
	const offenders = substringOnlyFiles(reports);
	const uncoveredByFile = new Map(
		offenders.map((report) => [report.file, new Set(report.uncovered.map((s) => s.symbol))]),
	);

	test('the symbol set is DERIVED and holds the canonical decisions (floor)', () => {
		for (const name of CANONICAL_DECISIONS) {
			expect(symbols.core, `${name} must be derived from the authorization modules`).toContain(
				name,
			);
		}
		// Cache plumbing exported next to the decisions is not a decision.
		expect(symbols.core.some((name) => /^clear|^invalidate|Cache/.test(name))).toBe(false);
		// The wrapper hop reaches into the tree (a tool-local gate helper is a decision too).
		expect(symbols.wrappers.length).toBeGreaterThan(0);
		// And the edges are recorded: every wrapper calls at least one known symbol.
		const called = new Set(Object.values(symbols.callers).flat());
		for (const wrapper of symbols.wrappers) expect(called.has(wrapper)).toBe(true);
	});

	test('wrapper derivation follows calls to a fixpoint, gated by the authorization vocabulary, with edges', () => {
		const core = deriveCoreSymbols([
			{
				file: 'm.ts',
				source:
					'export async function decideX(a: number): Promise<number> { return a; }\nexport function clearDecideXCache(): void {}\n',
			},
		]);
		expect(core).toEqual(['decideX']);
		const files = [
			{
				file: 'w.ts',
				source: [
					'async function gateThing(ctx: unknown): Promise<void> {',
					'	const level = await decideX(1);',
					'	if (level < 1) throw new Error("no");',
					'}',
					'async function gateThingWrite(ctx: unknown): Promise<void> {',
					'	await gateThing(ctx); // second hop',
					'}',
					'async function readThing(ctx: unknown): Promise<void> {',
					'	await decideX(2); // calls a decision but is not named as one',
					'}',
					'// prose: gateProse( decideX( is not a declaration',
					'function assertUnrelated(): void {',
					'	const s = "decideX(" ; // a string, not a call',
					'}',
					'function assertCommented(): void {',
					'	// decideX(1) — a comment, not a call',
					'}',
				].join('\n'),
			},
		];
		expect(deriveWrapperSymbols(files, core)).toEqual(['gateThing', 'gateThingWrite']);
		const graph = deriveWrapperGraph(files, core);
		expect(graph.callers).toEqual({ decideX: ['gateThing'], gateThing: ['gateThingWrite'] });
	});

	test('a principal fixture literal and a prose mention are NOT sites (specificity controls)', () => {
		expect(classifyAuthzFile(FIXTURE_ONLY, symbols).sites).toEqual([]);
		expect(classifyAuthzFile(PROSE_ONLY, symbols).sites).toEqual([]);
	});

	test('the planted offender is classified substring-only on every symbol (positive control)', () => {
		const report = classifyAuthzFile(OFFENDER, symbols);
		expect(shapes(report)).toEqual([
			'includes:getPermissions',
			'toContain:isRecordInScope',
			'toMatch:getPermissions',
			'toMatch:.isGlobalAdmin',
		]);
		// The multi-line `toContain(\n  '…'\n)` shape is a site too (line of the literal).
		expect(report.sites[1]?.line).toBe(7);
		expect(report.legs).toEqual({});
		expect(report.uncovered).toEqual(report.sites);
		expect(substringOnlyFiles([report]).map((r) => r.file)).toEqual([OFFENDER.file]);
	});

	test('a needle hoisted into a constant, an array, or new RegExp — fetched by any fs door — is a site', () => {
		const report = classifyAuthzFile(HOISTED, symbols);
		expect(shapes(report)).toEqual([
			'includes:getPermissions@NEEDLE',
			'toContain:isRecordInScope@NEEDLES',
			'toContain:principalCanAccessRecord@NEEDLES',
			'toMatch:.isGlobalAdmin@GUARD',
			'toMatch:ddoIsAuthorized',
		]);
		expect(report.uncovered.length).toBe(5);
	});

	test('a literal that is the RECEIVER of .test/.exec — regex, new RegExp, hoisted — is a site; \\s* between name and paren too', () => {
		const report = classifyAuthzFile(RECEIVER, symbols);
		expect(shapes(report)).toEqual([
			'exec:assertRecordWriteTarget@RE',
			'test:getPermissions',
			'test:.isGlobalAdmin',
			'exec:isRecordInScope',
			'exec:.isGlobalAdmin',
			'exec:ddoIsAuthorized',
		]);
		// One literal, two symbols: both are sites (the SEC-05 pin shape).
		expect(report.sites.filter((s) => s.line === 10).map((s) => s.symbol)).toEqual([
			ROLE_FLAG_MEMBER,
			'ddoIsAuthorized',
		]);
		expect(report.uncovered.length).toBe(6);
	});

	test('split / matchAll / replace (either argument) are haystack assertions', () => {
		const report = classifyAuthzFile(SPLIT_EXEC, symbols);
		expect(shapes(report)).toEqual([
			'split:authorizeSectionTarget',
			'matchAll:principalCanAccessRecord',
			'replace:.isGlobalAdmin',
			'replace:gateRecord',
		]);
		expect(report.uncovered.length).toBe(4);
	});

	test('a needle behind an object property, a local helper, a helper-of-helper, or an arrow helper is a site', () => {
		const report = classifyAuthzFile(OBJECT_AND_HELPER, symbols);
		expect(shapes(report)).toEqual([
			'includes:getPermissions@PINS',
			'includes:.isGlobalAdmin@PINS',
			'has:isRecordInScope',
			'count:authorizeRecordAccess',
			'hasAll:ddoIsAuthorized',
		]);
		expect(report.uncovered.length).toBe(5);
	});

	test('an import of the decision without a call of it is NOT a leg (a mention in prose is not a call)', () => {
		const report = classifyAuthzFile(IMPORT_NO_CALL, symbols);
		expect(shapes(report)).toEqual(['includes:getPermissions']);
		expect(report.legs).toEqual({});
		expect(report.uncovered.length).toBe(1);
	});

	test('the ALIBI shape — one real call of an unrelated symbol — does not cover the pin (per-symbol leg)', () => {
		const report = classifyAuthzFile(ALIBI, symbols);
		expect(shapes(report)).toEqual([
			'toContain:scopeInverseReferenceHits',
			'toContain:getUserProjects',
		]);
		// The driven symbol is covered; the other pin is NOT covered by it.
		expect(report.legs).toEqual({
			scopeInverseReferenceHits: 'import + call of scopeInverseReferenceHits',
		});
		expect(report.uncovered.map((s) => s.symbol)).toEqual(['getUserProjects']);
		// The same file with the pin's OWN symbol driven is covered.
		const covered = classifyAuthzFile(ALIBI_COVERED, symbols);
		expect(covered.legs).toEqual({ getUserProjects: 'import + call of getUserProjects' });
		expect(covered.uncovered.map((s) => s.symbol)).toEqual(['scopeInverseReferenceHits']);
	});

	test('a planted twin with an import + real call has the leg; a refusal covers ONLY the role flag in-file', () => {
		const byCall = classifyAuthzFile(TWIN_BY_CALL, symbols);
		expect(byCall.sites.length).toBe(1);
		expect(byCall.legs).toEqual({ getPermissions: 'import + call of getPermissions' });
		expect(byCall.uncovered).toEqual([]);
		const byRefusal = classifyAuthzFile(TWIN_BY_REFUSAL, symbols);
		expect(shapes(byRefusal)).toEqual(['includes:.isGlobalAdmin', 'includes:getPermissions']);
		expect(byRefusal.legs).toEqual({ [ROLE_FLAG_MEMBER]: 'refusalOf(' });
		expect(byRefusal.uncovered.map((s) => s.symbol)).toEqual(['getPermissions']);
		// A local look-alike is not an import of the decision.
		const fake = classifyAuthzFile(LOCAL_FAKE, symbols);
		expect(fake.legs).toEqual({});
		expect(fake.uncovered.length).toBe(1);
		expect(substringOnlyFiles([byCall, byRefusal, fake]).map((r) => r.file)).toEqual([
			TWIN_BY_REFUSAL.file,
			LOCAL_FAKE.file,
		]);
	});

	test('a NAMED twin may drive the symbol through a direct-caller wrapper or a refusal; an unnamed file may not', () => {
		const graph = deriveWrapperGraph(
			[
				{
					file: 'w.ts',
					source:
						'export async function gateThing(ctx: unknown): Promise<void> {\n\tawait decideX(1);\n}\n',
				},
			],
			['decideX'],
		);
		const synthetic = { core: ['decideX'], ...graph };
		const viaWrapper = `import { gateThing } from '../../src/w.ts';\ntest('x', async () => { await gateThing(1); });\n`;
		expect(legFor(viaWrapper, 'decideX', synthetic, { named: true })).toBe(
			'import + call of gateThing (calls decideX)',
		);
		expect(legFor(viaWrapper, 'decideX', synthetic, { named: false })).toBeNull();
		const viaRefusal = `const user = { userId: 3, isGlobalAdmin: false, isDeveloper: false };\ntest('x', async () => { await expect(door(user)).rejects.toThrow(); });\n`;
		expect(legFor(viaRefusal, 'decideX', synthetic, { named: true })).toBe(
			'non-admin literal + rejects.toThrow(',
		);
		expect(legFor(viaRefusal, 'decideX', synthetic, { named: false })).toBeNull();
		// Half a refusal shape is no refusal: the literal alone, the rejection alone.
		expect(
			legFor(
				viaRefusal.replace('isGlobalAdmin: false', 'isGlobalAdmin: true'),
				'decideX',
				synthetic,
				{ named: true },
			),
		).toBeNull();
		expect(
			legFor(viaRefusal.replace('.rejects.toThrow()', '.resolves.toBe(1)'), 'decideX', synthetic, {
				named: true,
			}),
		).toBeNull();
	});

	test('the census is TOTAL over test/unit (floor)', () => {
		expect(scanned.length).toBeGreaterThan(600);
		const sites = reports.reduce((n, report) => n + report.sites.length, 0);
		// The tree does pin call-site shapes (the exempted files alone hold several);
		// a scan that finds none has stopped reading.
		expect(sites).toBeGreaterThanOrEqual(5);
		expect(reports.length).toBeGreaterThanOrEqual(1);
	});

	test('no substring-only authorization pin outside the enumerated map (per file, per symbol)', () => {
		const unexempted: string[] = [];
		for (const report of offenders) {
			const exemption = EXEMPTIONS[report.file];
			for (const site of report.uncovered) {
				if (exemption !== undefined && site.symbol in exemption.pins) continue;
				unexempted.push(
					`${report.file}: L${site.line} ${site.method}(${site.symbol})${site.via ? ` via ${site.via}` : ''}`,
				);
			}
		}
		expect(
			unexempted,
			'These files assert an authorization decision ONLY as a source substring. A ' +
				'substring survives every neutering of the decision (SEC-01: `< 1` → `< 0`, ' +
				'`if (false)`, `throw` → `continue` all stayed green). Drive the decision: a real ' +
				'principal through the real door, asserting the refusal or the permitted result — ' +
				'for THAT symbol; a real call of some other decision in the file is an alibi, not a leg. ' +
				'If the pin is worth keeping as a location marker, write the behavioural twin ' +
				'FIRST and name it in EXEMPTIONS under the symbol — never the other way round.',
		).toEqual([]);
	});

	test('the exemption map is shrink-only (files and pins)', () => {
		expect(Object.keys(EXEMPTIONS).length).toBeLessThanOrEqual(EXEMPTION_FILE_CEILING);
		const pins = Object.values(EXEMPTIONS).reduce((n, e) => n + Object.keys(e.pins).length, 0);
		expect(pins).toBeLessThanOrEqual(EXEMPTION_PIN_CEILING);
	});

	test('every exemption is LIVE: the file is still substring-only on EXACTLY the listed symbols', () => {
		for (const [file, exemption] of Object.entries(EXEMPTIONS)) {
			expect(existsSync(join(REPO_ROOT, file)), `${file} no longer exists — drop the entry`).toBe(
				true,
			);
			const uncovered = [...(uncoveredByFile.get(file) ?? [])].sort();
			expect(
				uncovered,
				`${file}: its uncovered symbols and the entry's pins differ — a listed symbol that is now driven in-file (or no longer pinned) is a STALE entry; drop it and lower the ceilings`,
			).toEqual(Object.keys(exemption.pins).sort());
		}
	});

	test('every named twin exists, carries a leg FOR THAT SYMBOL, and still holds the credited case', () => {
		for (const [file, exemption] of Object.entries(EXEMPTIONS)) {
			expect(exemption.reason.length).toBeGreaterThan(20);
			for (const [symbol, twins] of Object.entries(exemption.pins)) {
				expect(twins.length).toBeGreaterThan(0);
				for (const twin of twins) {
					const path = join(REPO_ROOT, twin.file);
					expect(existsSync(path), `${file}: twin ${twin.file} does not exist`).toBe(true);
					const source = readFileSync(path, 'utf8');
					expect(
						legFor(source, symbol, symbols, { named: true }),
						`${file}: twin ${twin.file} does not drive ${symbol} (no import+call of it or of a direct caller, no principal-driven refusal) — it cannot cover that pin`,
					).not.toBeNull();
					expect(
						source.includes(twin.case),
						`${file}: twin ${twin.file} no longer holds the case "${twin.case}" it is credited with (${twin.covers})`,
					).toBe(true);
					expect(twin.covers.length).toBeGreaterThan(10);
				}
			}
		}
	});
});
