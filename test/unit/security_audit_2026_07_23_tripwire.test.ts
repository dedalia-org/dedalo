/**
 * Regression gates for the 2026-07-23 security audit
 * (audits/2026-07-23_security/) — the findings whose behavioural proof needs a
 * live profile/relation fixture are pinned HERE as a mix of pure-behaviour
 * assertions and source-invariant scans, so the fix cannot be silently reverted.
 *
 * Behavioural gates that DO have a home in an existing suite live there instead:
 *   - AUTH-05 (per-request maintenance) + API-01 (inherited-key action) →
 *     security_fail_closed.test.ts
 *   - MEDIA-05 (bare/ancestor public quality) → media_protection_tripwire.test.ts
 *   - RAG-01 record-level DoD (denied user gets nothing) → rag_pipeline.test.ts
 *
 * What is scanned here (the per-component / per-record narrowing whose full
 * behavioural proof would need a bespoke partial-grant profile or a cross-project
 * relation fixture): the invariant must be PRESENT in the source. A source scan
 * is a weaker gate than a live exploit, but it is deterministic and credless, and
 * it catches the one regression that matters — the security line being deleted.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule). Install tipos
// were replaced by their twins from src/core/test_data/test_tld_tipo_map.json; the
// seed-shipped ones (rsc/dd/hierarchy/ontology/lg) have no twin and stay, because they
// ship with every installation.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contributorComponentTipos } from '../../src/ai/rag/retrieval.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { scopeInverseReferenceHits } from '../../src/core/security/record_scope.ts';
import { WRITE_PATH_CORPUS_FLOOR, writePathSourceFiles } from '../helpers/write_path_corpus.ts';

/** Seed-shipped tipo, spelled so the census sees a reference, not a binding. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

// Generic-TLD migration 2026-08-20 (AGENTS.md hard rule). The `rsc`/`oh` tipos this
// gate names are SEED-SHIPPED ontology — they exist on every installation, so they are
// generic already and stay. They are spelled through `seed()` so the census can tell an
// install BINDING from a seed reference, and so the intent is explicit at each site.

const ROOT = join(import.meta.dir, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

describe('RAG-01: rag:<group> chunks gate at COMPONENT level', () => {
	test('contributorComponentTipos extracts the host-section component tipos from chunk_meta', () => {
		const meta = {
			contributors: [
				{ componentTipo: 'test52', sectionTipos: ['test3'] },
				{ componentTipo: 'test17', sectionTipos: ['test3'] },
			],
		};
		expect(contributorComponentTipos(meta)).toEqual(['test52', 'test17']);
		// Robust to the pre-group / malformed shapes.
		expect(contributorComponentTipos(null)).toEqual([]);
		expect(contributorComponentTipos({})).toEqual([]);
		expect(contributorComponentTipos({ contributors: 'nope' })).toEqual([]);
		expect(contributorComponentTipos({ contributors: [{ sectionTipos: ['x1'] }] })).toEqual([]);
	});

	test('aclGate requires EVERY contributing component and fails closed on empty (source invariant)', () => {
		const src = read('src/ai/rag/retrieval.ts');
		// A group chunk gates via the contributor components, not the bare section.
		expect(src).toContain('contributorComponentTipos(candidate.chunkMeta)');
		// Empty contributor set on a group chunk is anomalous → dropped.
		expect(src).toMatch(/isGroupChunk && gateTipos\.length === 0[\s\S]{0,40}continue/);
		// Section read grant is still required beside the components.
		expect(src).toContain('[candidate.sectionTipo, ...gateTipos]');
	});
});

describe('AUTHZ-05: inverse-reference scan is principal-scoped at the user-facing doors', () => {
	test('scopeInverseReferenceHits leaves a global admin unscoped (no accidental over-filter)', async () => {
		const admin: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
		const hits = [
			{ section_tipo: 'test6813', section_id: 5 },
			{ section_tipo: seed('rsc', 170), section_id: 9 },
		];
		expect(await scopeInverseReferenceHits(hits, admin)).toEqual(hits);
	});

	test('the relation-list panel + its paginator count thread the caller principal (source invariant)', () => {
		// The scan primitive stays principal-free (shared by system paths); the
		// USER-FACING doors scope its output.
		const recordScope = read('src/core/security/record_scope.ts');
		expect(recordScope).toContain('export async function scopeInverseReferenceHits');
		// The non-admin branch checks BOTH the section read grant and the projects filter.
		expect(recordScope).toContain('getPermissions(principal, hit.section_tipo, hit.section_tipo)');
		// The projects half — pinned as the SHARED PREDICATE, not as a call
		// spelling. The old pin was the literal `isRecordInScope(hit.section_tipo,
		// hit.section_id, principal)`, which said nothing about the rule and broke
		// the day the door stopped asking per hit (PERF-01: one statement per
		// section-chunk instead of one per candidate). What must hold is the
		// invariant the module's own docblock states — the boundary is decided in
		// ONE place — so that is what is measured: exactly one buildSearchSql call
		// site in this file, inside one helper, and BOTH doors (the single-record
		// one and the hit-list one) route through that helper.
		const predicateSites = recordScope.match(/buildSearchSql\(/g) ?? [];
		expect(
			predicateSites,
			'record_scope.ts must state the scope predicate exactly once: 0 = the projects leg left the module, >1 = a second ACL free to drift from the list path',
		).toHaveLength(1);
		const beforePredicate = recordScope.slice(0, recordScope.indexOf('buildSearchSql('));
		const enclosing = [...beforePredicate.matchAll(/function (\w+)\(/g)].pop();
		const predicateName = enclosing?.[1];
		expect(predicateName, 'the buildSearchSql call must sit inside a named function').toBeDefined();
		/** A top-level function body: from its declaration to the next column-0 `}`. */
		const bodyOf = (name: string): string => {
			// No trailing `(`: a generic door declares its type parameter first.
			const start = recordScope.indexOf(`function ${name}`);
			expect(start, `record_scope.ts must still declare ${name}`).toBeGreaterThan(-1);
			const end = recordScope.indexOf('\n}', start);
			return recordScope.slice(start, end === -1 ? undefined : end);
		};
		expect(
			bodyOf('isRecordInScope'),
			'the single-record door must ask the one predicate',
		).toContain(`${predicateName}(`);
		expect(
			bodyOf('scopeInverseReferenceHits'),
			'the hit-list door must ask the SAME predicate — a private copy of the projects rule is the drift this module refuses',
		).toContain(`${predicateName}(`);

		// The panel data path passes the principal into buildRelationList.
		const readFacade = read('src/core/section/read_facade.ts');
		expect(readFacade).toMatch(/buildRelationList\([\s\S]*?principal,[\s\S]*?\)/);

		// The mode='related' count is the related search's own SCOPED question
		// (D1): countInverseReferences with the caller's rowScopeFor, for every
		// principal (the predicate leaves a global admin unscoped). The outcome —
		// count == paged walk == probe, bounded — is related_scope_equivalence_native.
		const coreApi = read('src/core/api/handlers/dd_core_api.ts');
		expect(coreApi).toMatch(
			/countInverseReferences\(locators[\s\S]{0,160}scope: rowScopeFor\(principal\)/,
		);
		expect(coreApi).not.toContain('findInverseReferences(');
	});

	/**
	 * THE DOOR REGISTRY — and why it is DISCOVERED, not listed.
	 *
	 * The two assertions above name two doors by hand, and a hand-list of security
	 * doors rots silently. It already did, twice: `tool_posterframe` was wired in by
	 * the 2026-07-28 TOOLS-08 pass calling itself "the THIRD door", and the thesaurus
	 * indexation grid was found in the 2026-08 test6813 beta audit (§5.4) re-implementing
	 * the rule privately with the PROJECTS half alone. Neither ever appeared here.
	 * A registry that a new door does not have to join is not a registry.
	 *
	 * So this test ENUMERATES the callers instead: every hand-written module under
	 * src/ and tools/ that reaches for the unscoped inverse scan
	 * (`findInverseReferences` / `findInverseReferenceLocators`, and — D1,
	 * 2026-10-21 — its count and past-the-page probe, `countInverseReferences` /
	 * `anyInverseReferencePast`, which answer existence too) must be classified
	 * below, and a caller that is not classified FAILS — loudly, with the path, so
	 * the author has to answer "is this a user-facing door?" before it lands.
	 *
	 * The three kinds, and what each one CLAIMS:
	 *   'door'   — reached with a REQUEST principal and emits the hits (their
	 *              existence, labels, counts or content) back to that caller.
	 *              ⇒ the source MUST call scopeInverseReferenceHits / scopeRecordHits,
	 *              or a SET-SHAPED twin that asks the question in SQL —
	 *              anyRowInScope, or rowScopeFor handed to the sink's `scope`
	 *              (D1: the related count, page and probe); their record-by-record
	 *              equality with the hit-list door is an outcome leg of
	 *              client_page_doors_native, and count == walk == probe is
	 *              related_scope_equivalence_native.
	 *   'system' — no request principal in the path, or the walk must see EVERY
	 *              reference to be correct (integrity rewrites, propagation).
	 *              ⇒ the source MUST NOT scope; the reason is recorded.
	 *   'open'   — an emission path that has NOT been reviewed as a door by the
	 *              AUTHZ-05 passes. This is an honest "unknown", NOT a safety
	 *              claim, and it must name where it is being tracked (`raised`).
	 *              Zero is the target; the gate keeps the count visible instead of
	 *              letting an unreviewed path pass as if it had been cleared.
	 */
	const SCOPE_CALL =
		/scope(InverseReferenceHits|RecordHits)\s*\(|anyRowInScope\s*\(|rowScopeFor\s*\(/;
	/** The sink's question names: the scan, its count, its past-the-page probe. */
	const INVERSE_SCAN_NAME = /(find|count|any)InverseReference/;

	type DoorKind = 'door' | 'system' | 'open';
	interface DoorEntry {
		kind: DoorKind;
		why: string;
		/** Required for 'open': where the unreviewed path is tracked. */
		raised?: string;
	}

	const INVERSE_SCAN_CALLERS: Record<string, DoorEntry> = {
		// ── the scan itself + the one implementation of the rule ────────────────
		'src/core/search/search_related.ts': {
			kind: 'system',
			why: 'the primitive: unscoped by design, principal-free, shared by every path below',
		},
		'src/core/security/record_scope.ts': {
			kind: 'system',
			why: 'the boundary itself (scopeInverseReferenceHits, scopedRows / rowScopeFor); names the scan in prose only',
		},

		// ── user-facing doors: must scope ───────────────────────────────────────
		'src/core/resolve/relation_list.ts': {
			kind: 'door',
			why: 'the relation-list panel: emits the owning records of a host record',
		},
		'src/core/resolve/related_sections.ts': {
			kind: 'door',
			why: 'the related-sections tab: emits which sections reference the host record',
		},
		'src/core/api/handlers/dd_core_api.ts': {
			kind: 'door',
			why: "mode='related' paginator: the total is an existence count — countInverseReferences scoped by rowScopeFor (D1)",
		},
		'src/core/components/component_inverse/emit.ts': {
			kind: 'door',
			why: "component_inverse's emitted backlinks (tool_cataloging's 'used' marker, the component's list/edit views): the owners of a host record go back to the requester, so they are scoped by scopeInverseReferenceHits",
		},
		'src/core/section/indexation_grid.ts': {
			kind: 'door',
			why: 'the thesaurus indexation grid (2026-08 test6813 beta §5.4); the read-grant half of its scoping diverges from PHP — WC-2026-08-09-indexation-grid-read-grant-scope',
		},
		'src/core/section/read_facade.ts': {
			kind: 'door',
			why: "the 'defaulted' search.page_clamped probe of get_relation_list / related_search (READ-4): whether ANY record past the page is the caller's decides a notice the caller sees, so the probe (anyInverseReferencePast) is asked of the caller's SCOPED set through rowScopeFor (D1) — an unscoped probe is an existence/count oracle",
		},
		'tools/tool_posterframe/server/index.ts': {
			kind: 'door',
			why: 'get_ar_identifying_image: descriptors of the records referencing the target (TOOLS-08, 2026-07-28 audit)',
		},

		// NOT LISTED, and deliberately: src/core/search/builders/builder_relation_index.ts
		// was a 'system' row here while it materialised the dd96 inverse scan in
		// JS. It no longer calls the scan at all — it emits ONE uncorrelated
		// semi-join over matrix_relation_index (audit PERF-05) — so a row for it
		// would be exactly the stale entry the census below refuses. The predicate
		// is still unscoped by design; that reasoning now lives in the builder's
		// own header, where the code is.
		// ── system paths: must NOT scope ────────────────────────────────────────
		'src/core/section/record/delete_record.ts': {
			kind: 'system',
			why: 'integrity rewrite: EVERY referencing record must be cleaned, or the delete leaves dangling locators behind for the references the actor could not see',
		},
		'src/core/section/record/external_laws/inverse_search.ts': {
			kind: 'system',
			why: 'the inverse-reference law (moved out of observers.ts 2026-10-30; propagation runs under the system identity): a mirror computed for one actor would be truncated to that actor’s grants and stored for everyone',
		},
		'src/core/section/record/external_laws/resolvers.ts': {
			kind: 'system',
			why: 'observer TARGET resolution (inverse resolver through the law pointer): which records hold the mirror is an integrity question, never scoped to the saving actor',
		},
		'src/diffusion/resolve/resolver.ts': {
			kind: 'system',
			why: 'diffusion publishes with no request principal; its own gate is the publication config, not the operator’s grants',
		},
		'src/core/relations/children.ts': {
			kind: 'system',
			why: 'same-section descendants of an already-resolved host record; also driven by principal-free paths (tree build, diffusion), and dropping an intermediate would orphan its subtree rather than hide it',
		},
		'tools/tool_time_machine/server/bulk_revert_records.ts': {
			kind: 'system',
			why: 'the bulk revert’s D2 safety check (isReferenced, inside the delete’s transaction): a born record is deleted only when NOTHING links to it — a link the reverting operator cannot see still makes the delete unsafe, so the check must see every one; the hits never leave the check (only the yes/no decides keep-or-delete)',
		},
		'src/core/relations/descendant_walk.ts': {
			kind: 'system',
			why: 'the PERF-6 subtree edge fetch: the children engine’s inverse walk in ONE recursive statement over matrix_relation_index (it names the scan it replaces); principal-free for the same reason as children.ts — dropping an intermediate would orphan its subtree rather than hide it',
		},
		'src/core/relations/related.ts': {
			kind: 'system',
			why: 'component_relation_related’s same-section back-reference graph (PHP get_references): principal-free by signature, and the traversal is a closure whose result changes shape if nodes are removed mid-walk',
		},

		// ── not yet reviewed as a door ──────────────────────────────────────────
		'src/core/ts_object/ts_object.ts': {
			kind: 'open',
			why: 'the thesaurus node’s indexation count (getCountDataGroupBy → countInverseReferences, groupBy section_tipo): a per-section TOTAL of the records pointing at the term, emitted to whoever browses the tree, with no principal in the path. The sink now takes a scope (D1) — whether this count is a door that must pass rowScopeFor has not been reviewed.',
			raised: 'W5 lane 1 (D1 census widening, 2026-10-22) — integrator request',
		},
		'src/core/relations/models/relation_index.ts': {
			kind: 'open',
			why: 'emits the records POINTING AT the host, across config.targetSections, plus their related_list child components — the same shape as the indexation grid, with no principal anywhere in the path. Whether the upstream component gate (read_facade ddoIsAuthorized) is sufficient here has not been established by either AUTHZ-05 pass.',
			raised: 'WS-G1 handoff, 2026-08-09 remediation wave (audits/2026-08_oh1_beta)',
		},
	};

	test('every caller of the unscoped inverse scan is classified (door registry)', () => {
		// The corpus is the shared write-path lister (src/ + tools/ + scripts/) —
		// the roots are registered in census_derivation_tripwire, not chosen here.
		const corpus = writePathSourceFiles();
		expect(corpus.length).toBeGreaterThan(WRITE_PATH_CORPUS_FLOOR);
		const found = new Set<string>();
		for (const path of corpus) {
			if (INVERSE_SCAN_NAME.test(read(path))) found.add(path);
		}
		// The registry is the walk's own result, floored: an emptied corpus finds
		// no caller and would otherwise pass with every entry 'stale'.
		expect(found.size).toBeGreaterThan(10);

		const unclassified = [...found].filter((p) => INVERSE_SCAN_CALLERS[p] === undefined).sort();
		expect(
			unclassified,
			`NEW caller(s) of the unscoped inverse scan. Classify each in INVERSE_SCAN_CALLERS: 'door' (a request principal reaches it and the hits go back to that caller ⇒ scope through scopeInverseReferenceHits) or 'system' (principal-free / integrity walk ⇒ say why it must see everything).`,
		).toEqual([]);

		const stale = Object.keys(INVERSE_SCAN_CALLERS)
			.filter((p) => !found.has(p))
			.sort();
		expect(stale, 'registry entries for files that no longer use the inverse scan').toEqual([]);
	});

	test('every registered DOOR scopes, and every SYSTEM path is unscoped on purpose', () => {
		for (const [path, entry] of Object.entries(INVERSE_SCAN_CALLERS)) {
			const src = read(path);
			if (entry.kind === 'door') {
				expect(SCOPE_CALL.test(src), `${path} is a registered AUTHZ-05 door and must scope`).toBe(
					true,
				);
			}
			// A reason is mandatory in every direction: the registry is only worth
			// as much as the sentence that says why the row is what it is.
			expect(entry.why.length, `${path} needs a reason`).toBeGreaterThan(30);
			if (entry.kind === 'open') {
				expect(entry.raised ?? '', `${path} is 'open' and must name where it is tracked`).not.toBe(
					'',
				);
			}
		}
		// record_scope.ts is the only 'system' entry allowed to contain the call —
		// it IS the call. A system path that started scoping is a door in disguise.
		for (const [path, entry] of Object.entries(INVERSE_SCAN_CALLERS)) {
			if (entry.kind !== 'system' || path === 'src/core/security/record_scope.ts') continue;
			expect(SCOPE_CALL.test(read(path)), `${path} is registered 'system' but scopes`).toBe(false);
		}
	});
});

describe('AUTHZ-04: single-session policy is wired into login (opt-in)', () => {
	test('login evicts other sessions when DEDALO_SINGLE_SESSION is on (source invariant)', () => {
		const auth = read('src/core/security/auth.ts');
		// The flag gates the eviction, and it keeps the token just minted.
		//
		// endUserSessions, not destroyUserSessions, since 2026-08-24: an evicted session
		// must lose its MEDIA marker too. Evicting the token while leaving the stolen
		// media cookie working is precisely the window this policy exists to close, and
		// the media credential used to be install-global and unrevokable — so the
		// distinction is the fix, not a rename.
		expect(auth).toMatch(/config\.features\.singleSession[\s\S]{0,400}endUserSessions/);
		expect(auth).toContain('endUserSessions(user.section_id, sessionToken)');
		// And the bare destroy must not come back: it would silently drop the media half.
		expect(auth).not.toMatch(/^\s*destroyUserSessions\(/m);
		// The config key is read into config.features.
		const cfg = read('src/config/config.ts');
		expect(cfg).toContain("singleSession: readString('DEDALO_SINGLE_SESSION') === 'true'");
	});
});

describe('AUTHZ-06: component_filter project datalist is narrowed per user', () => {
	// The per-user NARROWING itself is held by two outcome gates on the suite DB,
	// not here: filter_projects_scope_native (non-admin = exactly its dd170 set,
	// admin = the catalog, the datalist door, unanchored = []) and
	// filter_projects_membership_native (a membership change is followed). Both
	// are held by their registration: rows in engineering/TRIPWIRES.md and
	// scripts/verify.ts TRIPWIRES (ci_workflow_tripwire keeps the two equal and
	// every listed file on disk). A pointer that greps their test titles here
	// would be a spelling pin, red on a rename, green on a gutted leg.

	test('the component get_data facade self-gates at the component level (defense-in-depth)', () => {
		// Belt-and-braces with the handler's Gate A: the get_data facade must not
		// emit a component's data/datalist for a caller who holds level 0 on it,
		// independent of any upstream gate (esp. the synthetic search_<n> path).
		const readFacade = read('src/core/section/read_facade.ts');
		// Record-scoped since 2026-10-24 (tool_user_admin's dd128 own-record rules):
		// the same component grant, judged with the addressed record in hand.
		expect(readFacade).toMatch(
			/getRecordComponentPermission\(\s*principal,\s*source\.section_tipo,\s*source\.tipo,\s*source\.section_id,?\s*\)/,
		);
		expect(readFacade).toMatch(/if \(level < 1\) \{\s*return emptyShell\(\);/);
	});
});
