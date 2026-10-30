/**
 * THE OBLIGATION LEDGER — every chokepoint write carries its own observer and
 * relation_search obligations (CLOSURE_PLAN Step 2: CORE-1, CORE-2 residual).
 *
 * The finding (audit 2026-09-26): the post-write obligations that are NOT in
 * `afterRecordWrite` — the observer cascade (needs the BEFORE-image: a removed
 * locator's mirror must drop the record) and the `_hi` ancestor index — were
 * calls each door REMEMBERED. The time machine's whole-record doors
 * (`restoreSectionRow`, `restoreAbsentSectionRow`, the bulk revert's
 * `restoreDeletedRecord`) forgot the observer leg, so an undeleted referencer
 * is missing from every mirror it feeds until a reconcile; a restored term
 * brings its mirror slot back VERBATIM (a phantom referencer); and the observer
 * recompute itself writes an `_hi` mirror without its ancestor index, so a
 * broader-term search misses it.
 *
 * WHAT IS ASSERTED — OUTCOMES on the lane suite DB, never spellings:
 *   1   restore over a live row: the restored value's mirror lists the record,
 *       the REPLACED value's mirror drops it (the before-image leg), a MIRROR
 *       history row is written, and relation_search equals a normal save's.
 *   1b  restore of a snapshot without the indexer key: the key AND its index
 *       go, and the mirror drops the record (before ∪ after, not after-only).
 *   2   true undelete through apply_value: the mirror lists the record again.
 *   2b  undelete of a deleted TERM: its mirror is the recompute truth, never
 *       the snapshot's phantom referencer.
 *   3   the bulk revert's cascade undelete: the mirror lists the record again.
 *   4   CORE-2: the observer recompute writes an `_hi` mirror WITH its
 *       ancestor index (literal chain), through the save and the reconcile;
 *       a dry run writes nothing; a dropped reference drops the index key.
 *       4b: a legacy mirror (value right, index missing) is re-indexed by the
 *       reconcile — and NOT by an interactive no-drift recompute, which never
 *       pays the chain walk under its row lock.
 *   5a  a write in a transaction that rolls back propagates nothing.
 *   5b  a write inside an ambient transaction propagates AFTER COMMIT, never
 *       inside it (B6: recomputes run on committed state, post-commit).
 *   5c  a savepoint rollback discards exactly its own obligations.
 *   5d  an obligation queued with no ambient transaction drains inline (the
 *       covered-slot recompute entry, called bare — a save always opens its own
 *       transaction, and 7a/7b reach the branch through create/duplicate).
 *   6   the interactive save still returns its same-record observer data.
 *   7a  a CREATE whose relation default targets an observed term is mirrored
 *       (the create's birth declaration); 7b a DUPLICATE is mirrored (the
 *       duplicate's); 7c a duplicate stores no `_hi` index for the covered
 *       mirror it does not copy (the birth-columns law).
 *   8   a record DELETE propagates its death — held through a relay → info
 *       observer, whose stored value names no locator the delete's inverse
 *       strip could clean instead.
 *   9   a whole-record REPLACE over a live term keeps the LIVE mirror inside
 *       the transaction (never empty, never the snapshot's phantom) and
 *       converges on truth after COMMIT — the live value planted to DIFFER from
 *       truth, so the convergence is measured, not the live value again.
 *   10  the bulk revert's SOFT-cascade restore of a wiped term: its source keys
 *       come back, its mirror is recomputed (never the snapshot's copy); 10b a
 *       mirror recomputed after the wipe is never judged a write since.
 *   11  a revert that undeleted a term and its referencer: the undelete is
 *       VERBATIM (the term's recompute does not stamp it), and reverting the
 *       revert deletes both — a mirror is neither a foreign value nor a link.
 *   10c a soft-cascade restore whose run owns the record's stamps: the
 *       covered-slot recompute leaves them too (the posture carries).
 *   10d a soft-cascade restore whose snapshot mirror is EMPTY while truth has a
 *       referencer: the whole-section recompute lists it (no key comes back to
 *       request it).
 *   11c a term and its referencer undeleted in ONE transaction: the verbatim
 *       mark is on the transaction's shared guard at ENQUEUE, so the
 *       referencer's drain (queued first) leaves the term's stamps; one write.
 *   11d a mirror host and its referencer undeleted in ONE transaction, the
 *       referencer first: its propagation recomputes the mirror with NO drift
 *       (no hop), and the host's covered-slot recompute still HOPS — a live
 *       observer of the mirror learns the host back.
 *   7d  a CREATE: an `_hi` default is indexed by its literal chain and a
 *       covered slot's dato_default is never stored (the birth-column law).
 *   12  a pure INSERT (the atomic-append entry): mirrored, history written,
 *       indexed exactly like the set_data twin — onto a held key and an empty one.
 *   13  the REMOVAL law at all three removal doors: a stale index planted on a
 *       NON-`_hi` relation key is re-derived by the portal delete, the record
 *       delete's inverse strip and the data wipe.
 *   14  apply_value of a mirror's history row: the restore lands, and the
 *       mirror converges on the recompute truth after COMMIT (the component
 *       restore requests the slot's recompute), never the phantom.
 *   14b the bulk revert of a run that wrote a MIRROR key converges on truth
 *       (A14b); 14c with the run owning the host's stamps, the recompute leaves
 *       them; 14d a mirror OBSERVED in turn (depth 2): a referencer that leaves
 *       drops out of its back-mirror (the recompute's hop carries what it
 *       dropped), and a restored mirror's past value is never propagated.
 *   14e a bulk revert of a COMPOSED unit whose main is a covered mirror with a
 *       dataframe slot: converges on truth, never propagated, the kept item
 *       keeps its frame (the composed write is the COMPONENT-RESTORE entry).
 *   4c  a DEGRADED-SEED legacy `_hi` mirror (drops withheld, index missing): the
 *       reconcile re-indexes the value as stored; a dry run writes nothing.
 *   16a the component restore of a covered slot on a VIRTUAL section that has a
 *       component of its own is recomputed; 16c one on a section that does not
 *       declare the slot at all is too (the entry queues exactly what it wrote);
 *   16b the whole-section recompute on that virtual section lists the real
 *       section's mirror, and the wipe empties the same slot (ONE census —
 *       section/record/declared_components.ts); 16d likewise a mirror declared
 *       under a NESTED section node (the census crosses nested sections).
 *   16e a COPY-LAW slot is covered too (2026-10-30 external-value law
 *       registry): the component restore of an `observed_data` slot (S7 —
 *       test6380, the svg-tag locators of the test6263 legend text) converges
 *       on the text's tags, never the restored past derivation.
 *   17  THE COVERED UNIT — a mirror and the frames that pair with its items
 *       (`id_key → id`) move together: 17a an undelete keeps every frame on
 *       its referencer (the snapshot unit stands, ids kept), never propagates
 *       the snapshot's phantom, and the recompute HOPS even when it writes
 *       nothing; 17b the soft-cascade restore likewise; 17c a replace keeps the
 *       LIVE unit (mirror and frames); 17d a duplicate stores neither, and
 *       re-mints no frame target for them; 17e a soft-cascade restore whose
 *       snapshot mirror lists a referencer that LEFT while the host was wiped
 *       never propagates it (the departed link's back-mirror stays empty).
 *   15a a hook call with no observer declaration is a typed refusal naming
 *       its door; 15b an obligation queued by a leaked continuation is refused,
 *       never dropped; 15c a registry rebuilt cold inside a transaction is
 *       warmed after COMMIT.
 *
 * ORACLES: relation_search is compared with what a normal saveComponentData of
 * the same value writes on a twin record; the recompute is compared with the
 * fixture's literal chain. Every record is created at runtime.
 *
 * SITUATION: the `zzot` observer term fixture (test/helpers/observer_term_seed.ts)
 * plus two own terms (9: 9→2→1, and 11: 11→2→1, the 2b victim), and the
 * `zzoh` `_hi`-observer fixture (test/helpers/observer_hi_seed.ts). Both are
 * dropped whole in afterAll with the residue asserted 0.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { isInTransaction, sql, withTransaction } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { deletePortalLocator } from '../../src/core/relations/save.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import {
	deleteSectionData,
	deleteSectionRecord,
} from '../../src/core/section/record/delete_record.ts';
import { duplicateSectionRecord } from '../../src/core/section/record/duplicate_record.ts';
import { reconcileObserverMirrors } from '../../src/core/section/record/observer_reconcile.ts';
import {
	clearObserverSubscriptionRegistry,
	getSubscriptionRegistry,
} from '../../src/core/section/record/observer_subscriptions.ts';
import { isCoveredObserverTipo } from '../../src/core/section/record/observers.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { enqueueObservedChange } from '../../src/core/section_record/obligation_ledger.ts';
import {
	afterRecordWrite,
	persistRestoredKeys,
	requestCoveredSlotRecompute,
} from '../../src/core/section_record/record_write.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { ensureSituation, situation } from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import {
	keyAddress,
	type RecordMarker,
} from '../../tools/tool_time_machine/server/bulk_revert_plan.ts';
import {
	deleteBornRecords,
	undeleteCascadeRecord,
} from '../../tools/tool_time_machine/server/bulk_revert_records.ts';
import {
	restoreSection,
	toolTimeMachineApplyValue,
} from '../../tools/tool_time_machine/server/tool_time_machine.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';
import {
	B1,
	dropObserverHi,
	ensureObserverHi,
	HI_INFO,
	HI_OBSERVER,
	HOST_B,
	PORTAL,
	TERM_A,
} from '../helpers/observer_hi_seed.ts';
import {
	dropObserverTerm,
	ensureObserverTerm,
	INDEXER,
	MIRROR,
	OBSERVER_TERM_SITUATION,
	PARENT,
	REF_SECTION,
	TERM_SECTION,
} from '../helpers/observer_term_seed.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const TABLE = 'matrix_test';
const USER_ID = -1;
/** The fixture's anchor term (chain 58 → 8 → 2 → 1). */
const T58 = 58;
/** Own term, chain 9 → 2 → 1 (a DIFFERENT chain from 58's). */
const T9 = 9;
/** Own term, chain 11 → 2 → 1 — the case-2b victim (deleted and undeleted). */
const T11 = 11;
/** Own term — case 10's soft-cascade (wiped, then restored) victim. */
const T12 = 12;
/** Own term — case 9's whole-record replace victim. */
const T13 = 13;
/** Own term — case 11's undeleted (and then re-deleted) victim. */
const T14 = 14;
/** Own term — case 10b's soft-cascade victim (a referencer moved on after the wipe). */
const T15 = 15;
/** Own term — case 11c's victim (term + referencer undeleted in ONE transaction). */
const T16 = 16;
/** Own term — case 10c's soft-cascade victim (a restore whose run owns the stamps). */
const T17 = 17;

/**
 * A RELAY observer of INDEXER on the term (no perform, no filter — the D1 trigger
 * relay: it writes nothing, it re-enters propagation at the term) and a
 * same-record component_info observing the relay: an INDEXER change reaching a
 * term leaves a RELAY_INFO history row there. Its stored value names NO locator,
 * so only a propagation can produce that row (case 8).
 */
const RELAY = 'zzot8';
const RELAY_INFO = 'zzot9';
/**
 * A section whose relation component has a `dato_default` onto term 9, observed
 * by DEF_MIRROR on the term: a record CREATED there is a new referencer (7a).
 */
const DEF_SECTION = 'zzot10';
const DEF_REL = 'zzot11';
const DEF_MIRROR = 'zzot12';
/**
 * Case 7d: a section whose `_hi` relation has a `dato_default` onto term 9 (a
 * known chain, 9 → 2 → 1), and which declares a COVERED observer slot carrying a
 * `dato_default` of its own (a phantom referencer). The slot observes a
 * component nothing ever saves, so only the birth law decides what it stores.
 */
const BIRTH_SECTION = 'zzot13';
const BIRTH_HI = 'zzot14';
const BIRTH_MIRROR = 'zzot15';
const BIRTH_SOURCE = 'zzot16';

/**
 * Cases 14b–14d: a DEPTH-2 observer edge on runtime records, isolated from the
 * term fixture. LINK (on LINK_SECTION) points at HUB records; HUB_MIRROR (on
 * HUB_SECTION) is the covered mirror "the links that point at me"; BACK (on
 * LINK_SECTION) is a covered observer OF the mirror: "the hubs whose mirror
 * lists me". A mirror is itself observed — the measured graph has such edges.
 */
const LINK_SECTION = 'zzot17';
const LINK = 'zzot18';
const HUB_SECTION = 'zzot19';
const HUB_MIRROR = 'zzot20';
const BACK = 'zzot21';
/**
 * Case 4c: a DEGRADED-SEED `_hi` mirror. DEG_HI (on DEG_HOST) lists the terms
 * whose DEG_PORTAL points at the host; its `data_from_field` names a peer with
 * NO ontology node (DEG_MISSING_PEER, never created), so every recompute of it
 * is a degraded seed that withholds its drops.
 */
const DEG_HOST = 'zzot22';
const DEG_PORTAL = 'zzot23';
const DEG_HI = 'zzot24';
const DEG_MISSING_PEER = 'zzot99';

/**
 * Cases 14e and 17a–d: the COVERED UNIT — a mirror WITH a dataframe slot. The
 * same depth-2 shape as 14b–d on its own sections (so 14b–d keep testing the
 * plain key write): LINKF (on LINKF_SECTION) points at hubs; HUBF_MIRROR (on
 * HUBF_SECTION) is the covered mirror, observed in turn by BACKF; HUBF_FRAME is
 * a `component_dataframe` slot of HUBF_MIRROR (its ontology child — a declared
 * slot), whose frames pair a mirror ITEM (`id_key → id`) with a RATE record. A
 * frame is curator data on a derived item: what it pairs with is the assertion.
 */
const LINKF_SECTION = 'zzot25';
const LINKF = 'zzot26';
const HUBF_SECTION = 'zzot27';
const HUBF_MIRROR = 'zzot28';
const HUBF_FRAME = 'zzot29';
const BACKF = 'zzot30';
const RATE_SECTION = 'zzot31';
/**
 * Cases 16a/16b: a VIRTUAL section of HUB_SECTION (its `relations` name the
 * real section) that declares a component of its OWN — its records store the
 * real section's HUB_MIRROR, which the old census (own subtree, real section
 * only when the own one held no component) never listed.
 */
const VIRT = 'zzot32';
const VIRT_OWN = 'zzot33';
/**
 * Case 16d: a covered mirror DECLARED UNDER A NESTED SECTION NODE. NEST_SECTION's
 * own child NESTED is a `section` node (a nested section/area grouper), and the
 * mirror NEST_MIRROR sits under it — only a census that CROSSES nested sections
 * lists it. It observes NLINK (on NLINK_SECTION), reverse-only (no `observers`
 * on NLINK: nothing propagates to it — only the census-driven recompute can).
 */
const NEST_SECTION = 'zzot34';
const NESTED = 'zzot35';
const NEST_MIRROR = 'zzot36';
const NLINK_SECTION = 'zzot37';
const NLINK = 'zzot38';

/** Sections whose records this file creates at runtime (swept in afterAll). */
const RUNTIME_SECTIONS = [
	DEF_SECTION,
	BIRTH_SECTION,
	LINK_SECTION,
	HUB_SECTION,
	DEG_HOST,
	LINKF_SECTION,
	HUBF_SECTION,
	RATE_SECTION,
	VIRT,
	NEST_SECTION,
	NLINK_SECTION,
];

/** dd800 run records this file mints (case 3), swept in afterAll. */
const runs: number[] = [];
let bulkTable = '';

/** A covered set_dato_external observe entry on `observed` (the fixture's one shape). */
function externalObserve(observed: string) {
	return {
		component_tipo: observed,
		server: {
			config: { use_self_section: false, use_observable_dato: true },
			perform: {
				function: 'set_dato_external',
				params: { save: true, changed: false, current_dato: false, references_limit: 0 },
			},
		},
	};
}

/** The own terms, as records of the fixture's term section. */
const OWN_TERMS = situation({
	tld: OBSERVER_TERM_SITUATION.tld,
	name: 'obligation ledger own terms',
	nodes: [
		{
			tipo: RELAY,
			model: 'component_autocomplete',
			parent: TERM_SECTION,
			properties: {
				observe: [{ component_tipo: INDEXER, server: { config: { use_observable_dato: true } } }],
			},
		},
		{
			tipo: RELAY_INFO,
			model: 'component_info',
			parent: TERM_SECTION,
			properties: { observe: [{ component_tipo: RELAY, server: { filter: false } }] },
		},
		{ tipo: DEF_SECTION, model: 'section', parent: 'dd14' },
		{
			tipo: DEF_REL,
			model: 'component_autocomplete',
			parent: DEF_SECTION,
			properties: {
				config_relation: { relation_type: 'dd151' },
				dato_default: [{ section_tipo: TERM_SECTION, section_id: 9 }],
				observers: [{ section_tipo: TERM_SECTION, component_tipo: DEF_MIRROR }],
			},
		},
		{
			tipo: DEF_MIRROR,
			model: 'component_autocomplete',
			parent: TERM_SECTION,
			properties: {
				source: {
					mode: 'external',
					section_to_search: [DEF_SECTION],
					component_to_search: [DEF_REL],
				},
				observe: [
					{
						component_tipo: DEF_REL,
						server: {
							config: { use_self_section: false, use_observable_dato: true },
							perform: {
								function: 'set_dato_external',
								params: { save: true, changed: false, current_dato: false, references_limit: 0 },
							},
						},
					},
				],
			},
		},
		{ tipo: BIRTH_SECTION, model: 'section', parent: 'dd14' },
		{
			tipo: BIRTH_HI,
			model: 'component_autocomplete_hi',
			parent: BIRTH_SECTION,
			properties: {
				config_relation: { relation_type: 'dd151' },
				dato_default: [{ section_tipo: TERM_SECTION, section_id: 9 }],
			},
		},
		{ tipo: BIRTH_SOURCE, model: 'component_autocomplete', parent: BIRTH_SECTION },
		{
			tipo: BIRTH_MIRROR,
			model: 'component_autocomplete',
			parent: BIRTH_SECTION,
			properties: {
				dato_default: [{ section_tipo: BIRTH_SECTION, section_id: 999_999 }],
				source: {
					mode: 'external',
					section_to_search: [BIRTH_SECTION],
					component_to_search: [BIRTH_SOURCE],
				},
				observe: [
					{
						component_tipo: BIRTH_SOURCE,
						server: {
							config: { use_self_section: false, use_observable_dato: true },
							perform: {
								function: 'set_dato_external',
								params: { save: true, changed: false, current_dato: false, references_limit: 0 },
							},
						},
					},
				],
			},
		},
		{ tipo: LINK_SECTION, model: 'section', parent: 'dd14' },
		{
			tipo: LINK,
			model: 'component_autocomplete',
			parent: LINK_SECTION,
			properties: {
				config_relation: { relation_type: 'dd151' },
				observers: [{ section_tipo: HUB_SECTION, component_tipo: HUB_MIRROR }],
			},
		},
		{ tipo: HUB_SECTION, model: 'section', parent: 'dd14' },
		{
			tipo: HUB_MIRROR,
			model: 'component_autocomplete',
			parent: HUB_SECTION,
			properties: {
				observers: [{ section_tipo: LINK_SECTION, component_tipo: BACK }],
				source: {
					mode: 'external',
					section_to_search: [LINK_SECTION],
					component_to_search: [LINK],
				},
				observe: [externalObserve(LINK)],
			},
		},
		{
			tipo: BACK,
			model: 'component_autocomplete',
			parent: LINK_SECTION,
			properties: {
				source: {
					mode: 'external',
					section_to_search: [HUB_SECTION],
					component_to_search: [HUB_MIRROR],
				},
				observe: [externalObserve(HUB_MIRROR)],
			},
		},
		{ tipo: LINKF_SECTION, model: 'section', parent: 'dd14' },
		{
			tipo: LINKF,
			model: 'component_autocomplete',
			parent: LINKF_SECTION,
			properties: {
				config_relation: { relation_type: 'dd151' },
				observers: [{ section_tipo: HUBF_SECTION, component_tipo: HUBF_MIRROR }],
			},
		},
		{ tipo: HUBF_SECTION, model: 'section', parent: 'dd14' },
		{
			tipo: HUBF_MIRROR,
			model: 'component_autocomplete',
			parent: HUBF_SECTION,
			properties: {
				observers: [{ section_tipo: LINKF_SECTION, component_tipo: BACKF }],
				source: {
					mode: 'external',
					section_to_search: [LINKF_SECTION],
					component_to_search: [LINKF],
				},
				observe: [externalObserve(LINKF)],
			},
		},
		{ tipo: HUBF_FRAME, model: 'component_dataframe', parent: HUBF_MIRROR },
		{
			tipo: BACKF,
			model: 'component_autocomplete',
			parent: LINKF_SECTION,
			properties: {
				source: {
					mode: 'external',
					section_to_search: [HUBF_SECTION],
					component_to_search: [HUBF_MIRROR],
				},
				observe: [externalObserve(HUBF_MIRROR)],
			},
		},
		{ tipo: RATE_SECTION, model: 'section', parent: 'dd14' },
		{
			tipo: VIRT,
			model: 'section',
			parent: 'dd14',
			// matrix_test (the scratch table — situation.ts MATRIX_TEST_TABLE_TIPO), then the REAL section
			relations: [{ tipo: 'test24' }, { tipo: HUB_SECTION }],
		},
		{ tipo: VIRT_OWN, model: 'component_input_text', parent: VIRT },
		{ tipo: NEST_SECTION, model: 'section', parent: 'dd14' },
		{ tipo: NESTED, model: 'section', parent: NEST_SECTION },
		{
			tipo: NEST_MIRROR,
			model: 'component_autocomplete',
			parent: NESTED,
			properties: {
				source: {
					mode: 'external',
					section_to_search: [NLINK_SECTION],
					component_to_search: [NLINK],
				},
				observe: [externalObserve(NLINK)],
			},
		},
		{ tipo: NLINK_SECTION, model: 'section', parent: 'dd14' },
		{
			tipo: NLINK,
			model: 'component_autocomplete',
			parent: NLINK_SECTION,
			properties: { config_relation: { relation_type: 'dd151' } },
		},
		{ tipo: DEG_HOST, model: 'section', parent: 'dd14' },
		{
			tipo: DEG_PORTAL,
			model: 'component_autocomplete',
			parent: TERM_SECTION,
			properties: { config_relation: { relation_type: 'dd151' } },
		},
		{
			tipo: DEG_HI,
			model: 'component_autocomplete_hi',
			parent: DEG_HOST,
			properties: {
				source: {
					mode: 'external',
					section_to_search: [TERM_SECTION],
					component_to_search: [DEG_PORTAL],
					data_from_field: [DEG_MISSING_PEER],
				},
				observe: [externalObserve(DEG_PORTAL)],
			},
		},
	],
	records: [T9, T11, T12, T13, T14, T15, T16, T17].map((id) => ({
		section_tipo: TERM_SECTION,
		section_id: id,
		columns: {
			relation: {
				[PARENT]: [
					{
						id: 1,
						type: 'dd47',
						section_id: 2,
						section_tipo: TERM_SECTION,
						from_component_tipo: PARENT,
					},
				],
			},
		},
	})),
});

const indexerLocator = (term: number) => ({
	type: 'dd96',
	section_tipo: TERM_SECTION,
	section_id: term,
	from_component_tipo: INDEXER,
});

async function newRef(): Promise<number> {
	return createSectionRecord(REF_SECTION, USER_ID);
}

async function saveIndexer(sectionId: number, terms: number[]): Promise<void> {
	const result = await saveComponentData({
		componentTipo: INDEXER,
		sectionTipo: REF_SECTION,
		sectionId,
		lang: 'lg-nolan',
		userId: USER_ID,
		changedData: [{ action: 'set_data', id: null, value: terms.map(indexerLocator) }] as never,
	});
	expect(result.ok, result.message).toBe(true);
}

/** One jsonb key of one record (`undefined` = key or row absent). */
async function keyOf(
	sectionTipo: string,
	sectionId: number,
	column: 'relation' | 'relation_search',
	key: string,
): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT "${column}"->$3 AS value FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId, key],
	)) as { value: unknown }[];
	const value = rows[0]?.value;
	return value === null ? undefined : value;
}

/** The referencer ids a term's MIRROR (or another covered slot) lists. */
async function mirrorOf(
	term: number,
	slot: string = MIRROR,
	referencer: string = REF_SECTION,
): Promise<number[]> {
	const bag = await keyOf(TERM_SECTION, term, 'relation', slot);
	return (Array.isArray(bag) ? bag : [])
		.filter((entry) => (entry as { section_tipo?: unknown }).section_tipo === referencer)
		.map((entry) => Number((entry as { section_id: unknown }).section_id))
		.sort((a, b) => a - b);
}

/** History rows of one component on one record. */
async function historyRows(sectionTipo: string, sectionId: number, tipo: string): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3`,
		[sectionTipo, sectionId, tipo],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

/**
 * PLANT a drift, as a door that forgot its obligation would leave it: remove
 * one referencer from a term's mirror WITHOUT propagating (raw SQL on the lane
 * suite DB). A recompute of that term — from ANY entry — repairs it, so a drift
 * still standing afterwards proves no entry recomputed the term.
 */
async function plantMirrorDrift(term: number, referencer: number): Promise<void> {
	await sql.unsafe(
		`UPDATE "${TABLE}" SET relation = jsonb_set(relation, ARRAY[$3::text],
		   COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(relation->$3) e
		              WHERE NOT (e->>'section_tipo' = $4 AND (e->>'section_id')::int = $5)), '[]'::jsonb))
		  WHERE section_tipo = $1 AND section_id = $2`,
		[TERM_SECTION, term, MIRROR, REF_SECTION, referencer],
	);
}

/**
 * PLANT a referencer the mirror does not know: an INDEXER locator onto `term`
 * written raw (no door, so nothing propagates). Only a recompute of the term's
 * mirror — from truth — can list it.
 */
async function plantUnseenReferencer(referencer: number, term: number): Promise<void> {
	await sql.unsafe(
		`UPDATE "${TABLE}" SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($3::text, jsonb_build_array(jsonb_build_object('id', 1, 'type', 'dd96', 'section_tipo', $4::text, 'section_id', $5::int, 'from_component_tipo', $3::text)))
		  WHERE section_tipo = $1 AND section_id = $2`,
		[REF_SECTION, referencer, INDEXER, TERM_SECTION, term],
	);
}

/** Repair a term's mirror through the reconcile (the documented repair door). */
async function reconcileTerm(term: number): Promise<void> {
	await reconcileObserverMirrors({
		apply: true,
		onlyObserver: MIRROR,
		onlySection: TERM_SECTION,
		onlyId: term,
	});
}

/** The undo-log rows of a run with one role (3 birth, 4 cascade delete), as markers. */
async function markersOf(run: number, role: 3 | 4): Promise<RecordMarker[]> {
	const rows = (await sql.unsafe(
		`SELECT id, section_id, section_tipo, tipo, lang, data, data IS NULL AS data_absent, tm_role
		   FROM matrix_time_machine WHERE bulk_process_id = $1 AND tm_role = $2 ORDER BY id`,
		[run, role],
	)) as RecordMarker['row'][];
	return rows.map((row) => ({
		sectionTipo: row.section_tipo,
		sectionId: Number(row.section_id),
		row: { ...row, id: Number(row.id), section_id: Number(row.section_id) },
	}));
}

/** A cascade marker for a whole-record TM row (the shape case 3 builds). */
function markerFor(
	sectionTipo: string,
	sectionId: number,
	row: { id: number; data: unknown },
): RecordMarker {
	return {
		sectionTipo,
		sectionId,
		row: {
			id: row.id,
			section_id: sectionId,
			section_tipo: sectionTipo,
			tipo: sectionTipo,
			lang: 'lg-nolan',
			data: row.data,
			data_absent: false,
			tm_role: 4,
		},
	};
}

const newHub = (): Promise<number> => createSectionRecord(HUB_SECTION, USER_ID);

/** A fresh dd800 run record (swept in afterAll). */
async function newRun(): Promise<number> {
	const run = await createSectionRecord('dd800', USER_ID);
	runs.push(run);
	return run;
}

/** The record's modified stamps (dd197 user locator, dd201 date) as stored. */
async function modifiedStamps(sectionTipo: string, sectionId: number): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT relation->'dd197' AS who, date->'dd201' AS "when" FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId],
	)) as { who: unknown; when: unknown }[];
	return rows[0] ?? null;
}

/** History rows of MIRROR on one term. */
async function mirrorHistoryRows(term: number): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3`,
		[TERM_SECTION, term, MIRROR],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

/** What a NORMAL save of `terms` indexes — the oracle, measured on a fresh twin. */
async function indexOfNormalSave(terms: number[]): Promise<unknown> {
	const twin = await newRef();
	await saveIndexer(twin, terms);
	return keyOf(REF_SECTION, twin, 'relation_search', INDEXER);
}

/** The newest whole-record (tipo = section) TM row of a record. */
async function wholeRecordRow(
	sectionTipo: string,
	sectionId: number,
): Promise<{ id: number; data: unknown }> {
	const rows = (await sql.unsafe(
		`SELECT id, data FROM matrix_time_machine
		  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $1
		  ORDER BY id DESC LIMIT 1`,
		[sectionTipo, sectionId],
	)) as { id: number; data: unknown }[];
	const row = rows[0];
	if (row === undefined) throw new Error(`no whole-record TM row for ${sectionTipo}/${sectionId}`);
	return { id: Number(row.id), data: row.data };
}

async function applyValue(options: Record<string, unknown>): Promise<void> {
	const response = await toolTimeMachineApplyValue({
		principal: await resolvePrincipal(USER_ID),
		userId: USER_ID,
		options,
		background: false,
	} as never);
	expect(response.ok).toBe(true);
}

/** The ids of `of`-section records one slot of one record lists (stored order). */
async function listedIn(
	sectionTipo: string,
	sectionId: number,
	slot: string,
	of: string,
): Promise<number[]> {
	const bag = await keyOf(sectionTipo, sectionId, 'relation', slot);
	return (Array.isArray(bag) ? bag : [])
		.filter((entry) => (entry as { section_tipo?: unknown }).section_tipo === of)
		.map((entry) => Number((entry as { section_id: unknown }).section_id));
}

const hubMirrorOf = (hub: number) => listedIn(HUB_SECTION, hub, HUB_MIRROR, LINK_SECTION);
const backOf = (link: number) => listedIn(LINK_SECTION, link, BACK, HUB_SECTION);

async function saveOn(
	sectionTipo: string,
	sectionId: number,
	componentTipo: string,
	value: unknown[],
	extra: { bulk?: number; skipModifiedStamp?: boolean } = {},
): Promise<void> {
	const result = await saveComponentData({
		componentTipo,
		sectionTipo,
		sectionId,
		lang: 'lg-nolan',
		userId: USER_ID,
		bulkProcessId: extra.bulk ?? null,
		...(extra.skipModifiedStamp === true ? { skipModifiedStamp: true } : {}),
		changedData: [{ action: 'set_data', id: null, value }] as never,
	});
	expect(result.ok, result.message).toBe(true);
}

/** Point a LINK record at hubs (a normal save: the depth-2 cascade runs). */
async function saveLink(link: number, hubs: number[]): Promise<void> {
	await saveOn(
		LINK_SECTION,
		link,
		LINK,
		hubs.map((hub) => ({
			type: 'dd151',
			section_tipo: HUB_SECTION,
			section_id: hub,
			from_component_tipo: LINK,
		})),
	);
}

/** A curator (or bulk run) save of the hub's MIRROR itself — an ordinary save. */
async function saveHubMirror(
	hub: number,
	links: number[],
	extra: { bulk?: number; skipModifiedStamp?: boolean } = {},
): Promise<void> {
	await saveOn(
		HUB_SECTION,
		hub,
		HUB_MIRROR,
		links.map((link) => ({
			type: 'dd151',
			section_tipo: LINK_SECTION,
			section_id: link,
			from_component_tipo: HUB_MIRROR,
		})),
		extra,
	);
}

/** Revert a run through the tool's own action (the whole orchestrator). */
async function bulkRevert(run: number): Promise<{ counter: number; skipped: unknown[] }> {
	const response = await toolTimeMachineBulkRevert({
		principal: await resolvePrincipal(USER_ID),
		userId: USER_ID,
		options: { bulk_process_id: run },
		background: false,
	} as never);
	expect(response.ok).toBe(true);
	const data = response.data as { counter: number; skipped: unknown[]; bulk_process_id: number };
	runs.push(data.bulk_process_id);
	return data;
}

// --- the covered UNIT fixture (14e, 17a–d) ------------------------------------

const newLinkF = (): Promise<number> => createSectionRecord(LINKF_SECTION, USER_ID);
const hubFMirrorOf = (hub: number) => listedIn(HUBF_SECTION, hub, HUBF_MIRROR, LINKF_SECTION);
const backFOf = (link: number) => listedIn(LINKF_SECTION, link, BACKF, HUBF_SECTION);

/** Point a LINKF record at hubs (a normal save: the depth-2 cascade runs). */
async function saveLinkF(link: number, hubs: number[]): Promise<void> {
	await saveOn(
		LINKF_SECTION,
		link,
		LINKF,
		hubs.map((hub) => ({
			type: 'dd151',
			section_tipo: HUBF_SECTION,
			section_id: hub,
			from_component_tipo: LINKF,
		})),
	);
}

/**
 * PLANT one locator raw (no door, so nothing propagates): `holder`'s
 * `componentTipo` := [a locator onto target]. A situation a door cannot build —
 * a referencer pointing at a record that is gone, or at a virtual section's
 * record before any mirror knows it.
 */
async function plantLocator(
	holder: { sectionTipo: string; sectionId: number; componentTipo: string },
	target: { sectionTipo: string; sectionId: number },
): Promise<void> {
	await sql.unsafe(
		`UPDATE "${TABLE}" SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($3::text, jsonb_build_array(jsonb_build_object('id', 1, 'type', 'dd151', 'section_tipo', $4::text, 'section_id', $5::int, 'from_component_tipo', $3::text)))
		  WHERE section_tipo = $1 AND section_id = $2`,
		[
			holder.sectionTipo,
			holder.sectionId,
			holder.componentTipo,
			target.sectionTipo,
			target.sectionId,
		],
	);
}

/** A frame of HUBF_FRAME pairing the mirror item `idKey` with a RATE record. */
const rateFrame = (idKey: number, rate: number) => ({
	type: 'dd490',
	id_key: idKey,
	section_tipo: RATE_SECTION,
	section_id: rate,
	from_component_tipo: HUBF_FRAME,
	main_component_tipo: HUBF_MIRROR,
});

/** SET a hub's frame slot raw (curator data a door would have written; nothing to propagate). */
async function plantFrames(hub: number, frames: readonly unknown[]): Promise<void> {
	await sql.unsafe(
		`UPDATE "${TABLE}" SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
		  WHERE section_tipo = $1 AND section_id = $2`,
		[HUBF_SECTION, hub, HUBF_FRAME, JSON.stringify(frames)],
	);
}

/** The hub's mirror items as stored: `{ id, link }` in stored order. */
async function hubFItems(hub: number): Promise<{ id: number; link: number }[]> {
	const bag = await keyOf(HUBF_SECTION, hub, 'relation', HUBF_MIRROR);
	return (Array.isArray(bag) ? bag : []).map((entry) => ({
		id: Number((entry as { id: unknown }).id),
		link: Number((entry as { section_id: unknown }).section_id),
	}));
}

/**
 * WHAT EACH FRAME PAIRS WITH — the assertion of the unit law: `link->rate` for a
 * frame whose `id_key` names a mirror item, `orphan#<id_key>->rate` for one that
 * names none. Sorted.
 */
async function framePairing(sectionTipo: string, record: number): Promise<string[]> {
	const items = new Map<string, number>();
	const bag = await keyOf(sectionTipo, record, 'relation', HUBF_MIRROR);
	for (const entry of Array.isArray(bag) ? bag : []) {
		const item = entry as { id: unknown; section_id: unknown };
		items.set(String(item.id), Number(item.section_id));
	}
	const frames = await keyOf(sectionTipo, record, 'relation', HUBF_FRAME);
	return (Array.isArray(frames) ? frames : [])
		.map((entry) => {
			const frame = entry as { id_key: unknown; section_id: unknown };
			const link = items.get(String(frame.id_key));
			const rate = Number(frame.section_id);
			return link === undefined ? `orphan#${String(frame.id_key)}->${rate}` : `${link}->${rate}`;
		})
		.sort();
}

/**
 * A hub whose mirror lists `second` with item id 1 and `first` with item id 2 —
 * ids NOT in section_id order (`first` < `second`), so a recompute that minted
 * fresh ids into an empty mirror (1..N in reference order) would swap them — and
 * a frame on each item pairing it with its own RATE record.
 */
async function framedHub(): Promise<{
	hub: number;
	first: number;
	second: number;
	rateFirst: number;
	rateSecond: number;
	pairing: string[];
}> {
	const hub = await createSectionRecord(HUBF_SECTION, USER_ID);
	const first = await newLinkF();
	const second = await newLinkF();
	await saveLinkF(second, [hub]);
	await saveLinkF(first, [hub]);
	const items = await hubFItems(hub);
	const idOf = (link: number): number => items.find((item) => item.link === link)?.id ?? -1;
	// FLOOR: the ids are out of section order — else a fresh mint would pair right by accident.
	expect(first).toBeLessThan(second);
	expect(idOf(second)).toBeLessThan(idOf(first));
	const rateFirst = await createSectionRecord(RATE_SECTION, USER_ID);
	const rateSecond = await createSectionRecord(RATE_SECTION, USER_ID);
	await plantFrames(hub, [rateFrame(idOf(first), rateFirst), rateFrame(idOf(second), rateSecond)]);
	const pairing = [`${first}->${rateFirst}`, `${second}->${rateSecond}`].sort();
	expect(await framePairing(HUBF_SECTION, hub)).toEqual(pairing); // FLOOR
	// FLOOR: the depth-2 edge runs — both links' back-mirrors list the hub.
	expect(await backFOf(first)).toEqual([hub]);
	expect(await backFOf(second)).toEqual([hub]);
	return { hub, first, second, rateFirst, rateSecond, pairing };
}

/** The RATE records that exist (a re-minted frame target would add one). */
async function rateRecords(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM "${TABLE}" WHERE section_tipo = $1`,
		[RATE_SECTION],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

/** The ancestor set of a relation_search value, as `section_tipo|section_id`. */
const ancestorSet = (index: unknown): string[] =>
	(Array.isArray(index) ? index : [])
		.map((entry) => {
			const e = entry as { section_tipo: unknown; section_id: unknown };
			return `${String(e.section_tipo)}|${Number(e.section_id)}`;
		})
		.sort();

async function sweepActivity(): Promise<void> {
	for (const tipo of [REF_SECTION, TERM_SECTION, TERM_A, HOST_B, ...RUNTIME_SECTIONS]) {
		await sql.unsafe(
			`DELETE FROM matrix_activity WHERE section_tipo = 'dd542' AND string->'dd546'->0->>'value' = $1`,
			[tipo],
		);
	}
}

beforeAll(async () => {
	await assertTestDatabase('obligation_ledger_native');
	await ensureObserverTerm();
	await ensureSituation(OWN_TERMS);
	await ensureObserverHi();
	expect(await getMatrixTableFromTipo(REF_SECTION)).toBe(TABLE);
	expect(await getMatrixTableFromTipo(TERM_SECTION)).toBe(TABLE);
	expect(await getMatrixTableFromTipo(HOST_B)).toBe(TABLE);
	for (const runtime of RUNTIME_SECTIONS) {
		expect(await getMatrixTableFromTipo(runtime)).toBe(TABLE);
	}
	bulkTable = (await getMatrixTableFromTipo('dd800')) as string;
	// STRUCTURE FLOOR: the save door propagates on this edge and indexes the
	// chain — else every "restore propagates" assertion below is vacuous.
	const probe = await newRef();
	await saveIndexer(probe, [T58]);
	expect(await mirrorOf(T58), 'the SAVE door does not propagate on the fixture edge').toContain(
		probe,
	);
	expect(ancestorSet(await keyOf(REF_SECTION, probe, 'relation_search', INDEXER))).toEqual(
		[`${TERM_SECTION}|1`, `${TERM_SECTION}|2`, `${TERM_SECTION}|8`].sort(),
	);
	expect(ancestorSet(await indexOfNormalSave([T9]))).toEqual(
		[`${TERM_SECTION}|1`, `${TERM_SECTION}|2`].sort(),
	);
}, 120_000);

afterAll(async () => {
	// The runtime sections' rows (7a, 7d, 14b–d, 4c) belong to no section of the base
	// fixture, so its drop would not sweep them.
	for (const runtime of RUNTIME_SECTIONS) {
		await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1`, [runtime]);
		await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [runtime]);
		await sql.unsafe('DELETE FROM matrix_counter WHERE tipo = $1', [runtime]);
		await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [runtime]);
	}
	for (const id of runs) {
		await sql.unsafe(
			`DELETE FROM "${bulkTable}" WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
			[id],
		);
	}
	for (const tipo of [REF_SECTION, TERM_SECTION, TERM_A, HOST_B]) {
		await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [tipo]);
	}
	await sweepActivity();
	// the dd800 runs this file minted (newRun, bulkRevert) log a 'NEW' activity row each
	await sweepActivityRows('dd800', runs);
	expect(await countActivityRows('dd800', runs), 'dd800 activity residue').toBe(0);
	expect(await dropObserverHi(), 'zzoh residue after drop').toBe(0);
	expect(await dropObserverTerm(), 'zzot residue after drop').toBe(0);
}, 120_000);

// ---------------------------------------------------------------------------
// CORE-1 — the whole-record restore doors carry the observer leg
// ---------------------------------------------------------------------------

describe('CORE-1: restore and undelete propagate to observers', () => {
	test('1: restore over a LIVE row — the restored value is mirrored, the replaced one dropped, history written, index = a normal save', async () => {
		const expected = await indexOfNormalSave([T58]);
		const r = await newRef();
		await saveIndexer(r, [T58]);
		const snapshot = (await readMatrixRecord(TABLE, REF_SECTION, r))?.columns;
		expect(snapshot).toBeDefined();
		await saveIndexer(r, [T9]);
		// FLOOR: the save moved r from 58's mirror to 9's.
		expect(await mirrorOf(T9)).toContain(r);
		expect(await mirrorOf(T58)).not.toContain(r);
		const historyBefore = await mirrorHistoryRows(T58);

		await restoreSection(snapshot, 0, REF_SECTION, r, USER_ID);

		expect(
			await keyOf(REF_SECTION, r, 'relation', INDEXER),
			'the restore did not write the snapshot value — re-read this gate',
		).toEqual([expect.objectContaining({ section_id: T58 })]);
		expect(
			await mirrorOf(T58),
			'restoreSection wrote the indexer back but 58’s mirror never learned — the restore door has no observer leg (CORE-1)',
		).toContain(r);
		expect(
			await mirrorOf(T9),
			'the REPLACED value’s mirror still lists r — the before-image (removed set) was not propagated',
		).not.toContain(r);
		expect(
			await mirrorHistoryRows(T58),
			'the recompute a restore triggers writes no MIRROR history row',
		).toBeGreaterThan(historyBefore);
		expect(await keyOf(REF_SECTION, r, 'relation_search', INDEXER)).toEqual(expected);
	}, 60_000);

	test('1 (component branch, regression leg): apply_value of the indexer key propagates both halves', async () => {
		const r = await newRef();
		await saveIndexer(r, [T58]);
		const [row] = (await sql.unsafe(
			`SELECT id FROM matrix_time_machine
			  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 ORDER BY id DESC LIMIT 1`,
			[REF_SECTION, r, INDEXER],
		)) as { id: number }[];
		await saveIndexer(r, [T9]);
		await applyValue({
			section_tipo: REF_SECTION,
			section_id: r,
			tipo: INDEXER,
			lang: 'lg-nolan',
			matrix_id: Number(row?.id),
		});
		expect(await mirrorOf(T58)).toContain(r);
		expect(await mirrorOf(T9)).not.toContain(r);
	}, 60_000);

	test('1b: restore of a snapshot WITHOUT the indexer key — the key, its index and the mirror entry all go', async () => {
		const r = await newRef();
		const columns = (await readMatrixRecord(TABLE, REF_SECTION, r))?.columns as
			| Record<string, unknown>
			| undefined;
		expect(columns).toBeDefined();
		// A snapshot taken BEFORE the index column existed (PHP-era and pre-P1-7
		// history carry no `relation_search`): the restore cannot lean on the
		// snapshot's own index column to clear the key — it must derive the
		// index from before ∪ after.
		const snapshot = Object.fromEntries(
			Object.entries(columns ?? {}).filter(([column]) => column !== 'relation_search'),
		);
		await saveIndexer(r, [T58]);
		// FLOOR: the key, its index and the mirror entry exist before the restore.
		expect((await keyOf(REF_SECTION, r, 'relation_search', INDEXER)) ?? []).not.toEqual([]);
		expect(await mirrorOf(T58)).toContain(r);

		await restoreSection(snapshot, 0, REF_SECTION, r, USER_ID);

		expect(await keyOf(REF_SECTION, r, 'relation', INDEXER)).toBeUndefined();
		expect(
			await keyOf(REF_SECTION, r, 'relation_search', INDEXER),
			'the restore dropped the indexer key but left its ancestor index standing — the index law iterated the AFTER keys only',
		).toBeUndefined();
		expect(
			await mirrorOf(T58),
			'58’s mirror still lists a record that no longer references it',
		).not.toContain(r);
	}, 60_000);

	test('2: true UNDELETE through apply_value (the delete’s TM row) — the mirror lists the record again', async () => {
		const r = await newRef();
		await saveIndexer(r, [T58]);
		await deleteSectionRecord(REF_SECTION, r, USER_ID);
		// FLOOR: the delete's own propagation dropped r.
		expect(await mirrorOf(T58)).not.toContain(r);
		const row = await wholeRecordRow(REF_SECTION, r);

		await applyValue({
			section_tipo: REF_SECTION,
			section_id: r,
			tipo: REF_SECTION,
			lang: 'lg-nolan',
			matrix_id: row.id,
		});

		expect(await keyOf(REF_SECTION, r, 'relation', INDEXER)).toEqual([
			expect.objectContaining({ section_id: T58 }),
		]);
		expect(
			await mirrorOf(T58),
			'the record is back and references 58, but 58’s mirror does not list it — the undelete has no observer leg (CORE-1)',
		).toContain(r);
	}, 60_000);

	test('3: the bulk revert’s cascade UNDELETE (restoreDeletedRecord) — the mirror lists the record again', async () => {
		const r = await newRef();
		await saveIndexer(r, [T58]);
		await deleteSectionRecord(REF_SECTION, r, USER_ID);
		expect(await mirrorOf(T58)).not.toContain(r);
		const row = await wholeRecordRow(REF_SECTION, r);
		const run = await createSectionRecord('dd800', USER_ID);
		runs.push(run);

		const outcome = await undeleteCascadeRecord(
			{
				sectionTipo: REF_SECTION,
				sectionId: r,
				row: {
					id: row.id,
					section_id: r,
					section_tipo: REF_SECTION,
					tipo: REF_SECTION,
					lang: 'lg-nolan',
					data: row.data,
					data_absent: false,
					tm_role: 4,
				},
			},
			{ principal: await resolvePrincipal(USER_ID), userId: USER_ID, newBulkId: run },
		);
		expect(outcome.kind).toBe('done');
		expect(await keyOf(REF_SECTION, r, 'relation', INDEXER)).toEqual([
			expect.objectContaining({ section_id: T58 }),
		]);
		expect(
			await mirrorOf(T58),
			'the bulk undelete put r back, but 58’s mirror does not list it (CORE-1)',
		).toContain(r);
	}, 60_000);

	test('2b: undelete of a deleted TERM — its mirror is the recompute truth: never the snapshot’s phantom, never left empty', async () => {
		const phantom = await newRef();
		await saveIndexer(phantom, [T11]);
		expect(await mirrorOf(T11)).toContain(phantom);
		await deleteSectionRecord(TERM_SECTION, T11, USER_ID);
		// FLOOR: the inverse sweep removed the referencer's locator onto the deleted term.
		expect(
			((await keyOf(REF_SECTION, phantom, 'relation', INDEXER)) as unknown[] | undefined) ?? [],
		).toEqual([]);
		const row = await wholeRecordRow(TERM_SECTION, T11);
		// the snapshot DOES carry the phantom — else the assertion below is vacuous
		expect(JSON.stringify((row.data as Record<string, unknown>).relation ?? {})).toContain(MIRROR);
		// A LIVE referencer the undeleted term must list: a dangling INDEXER locator
		// planted while the term is gone (raw SQL — no door writes a locator onto a
		// missing record). Its only way into the mirror is the birth's
		// SELF-RECOMPUTE of the covered slot: nothing propagates a raw write, and
		// the term's own birth edges (PARENT) are observed by nobody.
		const live = await newRef();
		await plantUnseenReferencer(live, T11);

		await applyValue({
			section_tipo: TERM_SECTION,
			section_id: T11,
			tipo: TERM_SECTION,
			lang: 'lg-nolan',
			matrix_id: row.id,
		});

		expect(await readMatrixRecord(TABLE, TERM_SECTION, T11)).not.toBeNull();
		expect(
			await mirrorOf(T11),
			'the undeleted term’s mirror is not the recompute truth — the snapshot’s phantom came back VERBATIM, or the birth never recomputed its covered slot (a skipped selfRecompute leaves it empty)',
		).toEqual([live]);
	}, 60_000);

	test('9: a whole-record REPLACE over a live term keeps the LIVE mirror inside the transaction, and converges on truth after COMMIT', async () => {
		const gone = await newRef();
		await saveIndexer(gone, [T13]);
		const snapshot = (await readMatrixRecord(TABLE, TERM_SECTION, T13))?.columns;
		expect(snapshot).toBeDefined();
		expect(JSON.stringify(snapshot?.relation ?? {})).toContain(MIRROR); // the phantom is in it
		await saveIndexer(gone, []);
		const live = await newRef();
		await saveIndexer(live, [T13]);
		// The LIVE value must differ from TRUTH, or "converges after COMMIT" is the
		// in-transaction value again and holds nothing: a second referencer the
		// mirror does not know (planted raw — only a recompute can list it).
		const unseen = await newRef();
		await plantUnseenReferencer(unseen, T13);
		// FLOOR: the live mirror is [live]; truth is [live, unseen]; the snapshot's is [gone].
		expect(await mirrorOf(T13)).toEqual([live]);

		let inside: number[] = [];
		await withTransaction(async () => {
			await restoreSection(snapshot, 0, TERM_SECTION, T13, USER_ID);
			// The ledger defers the recompute to COMMIT: what a read sees NOW is what
			// the replace itself wrote into the slot.
			inside = await mirrorOf(T13);
		});
		expect(
			inside,
			'between the replace and its COMMIT the covered slot was not the LIVE value — it was emptied (the slot deleted), written back from the snapshot (a phantom), or recomputed inside the transaction',
		).toEqual([live]);
		expect(
			await mirrorOf(T13),
			'after COMMIT the mirror is not the recompute truth — the replace never requested its covered slot’s recompute (persistRecordColumns’ replace declaration lost its selfRecompute)',
		).toEqual([live, unseen].sort((a, b) => a - b));
	}, 60_000);
});

// ---------------------------------------------------------------------------
// the doors that declare their own observed change: create, duplicate, delete
// ---------------------------------------------------------------------------

describe('the INSERT and DELETE doors declare their change (birth, death)', () => {
	test('7a: a CREATE whose relation default targets an observed term — the term’s mirror lists the new record', async () => {
		const born = await createSectionRecord(DEF_SECTION, USER_ID);
		// FLOOR: the default landed (else the create declared nothing to observe).
		expect(await keyOf(DEF_SECTION, born, 'relation', DEF_REL)).toEqual([
			expect.objectContaining({ section_tipo: TERM_SECTION, section_id: T9 }),
		]);
		expect(
			await mirrorOf(T9, DEF_MIRROR, DEF_SECTION),
			'the created record points at term 9 by its default, but 9’s mirror does not list it — the create declared no BIRTH to the ledger',
		).toContain(born);
	}, 60_000);

	test('7b: a DUPLICATE of a referencer — the term’s mirror lists the clone', async () => {
		const r = await newRef();
		await saveIndexer(r, [T58]);
		const clone = await duplicateSectionRecord(REF_SECTION, r, USER_ID);
		expect(await keyOf(REF_SECTION, clone, 'relation', INDEXER)).toEqual([
			expect.objectContaining({ section_id: T58 }),
		]);
		expect(
			await mirrorOf(T58),
			'the clone references 58, but 58’s mirror does not list it — the duplicate declared no BIRTH to the ledger',
		).toContain(clone);
	}, 60_000);

	test('7d: a CREATE stores the birth-column law — an `_hi` default indexed by its literal chain, a covered slot’s default NEVER stored', async () => {
		const born = await createSectionRecord(BIRTH_SECTION, USER_ID);
		// FLOOR: the `_hi` default landed (else there is nothing to index).
		expect(await keyOf(BIRTH_SECTION, born, 'relation', BIRTH_HI)).toEqual([
			expect.objectContaining({ section_tipo: TERM_SECTION, section_id: T9 }),
		]);
		expect(
			ancestorSet(await keyOf(BIRTH_SECTION, born, 'relation_search', BIRTH_HI)),
			'the created record’s `_hi` default carries no (or a wrong) ancestor index — a broader-term search misses it (the create skipped the birth-column law)',
		).toEqual([`${TERM_SECTION}|1`, `${TERM_SECTION}|2`].sort());
		expect(
			(await keyOf(BIRTH_SECTION, born, 'relation', BIRTH_MIRROR)) ?? [],
			'the create STORED a covered observer slot’s dato_default — a phantom referencer no record holds (a mirror is derived state: a birth stores none and recomputes it)',
		).toEqual([]);
	}, 60_000);

	test('8: a record DELETE propagates its death — the relay observer of the deleted edge fires at the term', async () => {
		const r = await newRef();
		const before = await historyRows(TERM_SECTION, T58, RELAY_INFO);
		await saveIndexer(r, [T58]);
		const afterSave = await historyRows(TERM_SECTION, T58, RELAY_INFO);
		// FLOOR: the relay edge is live (a save reaches the info observer at 58).
		expect(afterSave, 'the relay → info edge never fired — re-read this gate').toBeGreaterThan(
			before,
		);
		await deleteSectionRecord(REF_SECTION, r, USER_ID);
		expect(
			await historyRows(TERM_SECTION, T58, RELAY_INFO),
			'deleting r fired nothing at 58: the delete’s DEATH was not declared to the ledger (the inverse strip cleans locator mirrors, never an observer whose value names no locator)',
		).toBeGreaterThan(afterSave);
	}, 60_000);
});

// ---------------------------------------------------------------------------
// the APPEND branch and the REMOVAL law — two chokepoint entries no set_data
// save takes, each carrying its own obligations
// ---------------------------------------------------------------------------

describe('the APPEND entry (a pure insert) and the REMOVAL entry carry their own obligations', () => {
	async function insertIndexer(sectionId: number, term: number): Promise<void> {
		const result = await saveComponentData({
			componentTipo: INDEXER,
			sectionTipo: REF_SECTION,
			sectionId,
			lang: 'lg-nolan',
			userId: USER_ID,
			changedData: [{ action: 'insert', id: null, value: indexerLocator(term) }] as never,
		});
		expect(result.ok, result.message).toBe(true);
	}

	test('12: a pure INSERT (saveComponentData’s atomic-append branch) — mirrored, history written, indexed exactly like the set_data twin', async () => {
		// (a) onto a key that already holds an item: the append EXTENDS it.
		const r = await newRef();
		await saveIndexer(r, [T9]);
		const historyBefore = await mirrorHistoryRows(T58);
		await insertIndexer(r, T58);
		expect(await keyOf(REF_SECTION, r, 'relation', INDEXER)).toEqual([
			expect.objectContaining({ section_id: T9 }),
			expect.objectContaining({ section_id: T58 }),
		]);
		expect(
			await mirrorOf(T58),
			'an INSERT of r→58 never reached 58’s mirror — the append entry declared no observed change',
		).toContain(r);
		expect(
			await mirrorHistoryRows(T58),
			'the append’s recompute wrote no MIRROR history row',
		).toBeGreaterThan(historyBefore);
		expect(
			ancestorSet(await keyOf(REF_SECTION, r, 'relation_search', INDEXER)),
			'the append left the `_hi` index of the value BEFORE it — a broader-term search misses the appended term (the append entry derived no relation_search)',
		).toEqual(ancestorSet(await indexOfNormalSave([T9, T58])));
		// (b) onto an EMPTY key (the first-grant shape: the append is the whole value).
		const first = await newRef();
		await insertIndexer(first, T58);
		expect(await mirrorOf(T58)).toContain(first);
		expect(ancestorSet(await keyOf(REF_SECTION, first, 'relation_search', INDEXER))).toEqual(
			ancestorSet(await indexOfNormalSave([T58])),
		);
	}, 90_000);

	/**
	 * A STALE ancestor index planted on a NON-`_hi` relation key (DEF_REL is a plain
	 * component_autocomplete: the save law keeps no index for it, so nothing but the
	 * removal law can rewrite what is planted here).
	 */
	async function plantStaleIndex(holder: number): Promise<void> {
		await sql.unsafe(
			`UPDATE "${TABLE}" SET relation_search = COALESCE(relation_search, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
			  WHERE section_tipo = $1 AND section_id = $2`,
			[
				DEF_SECTION,
				holder,
				DEF_REL,
				JSON.stringify([
					{
						type: 'dd151',
						section_tipo: TERM_SECTION,
						section_id: 424_242,
						from_component_tipo: DEF_REL,
					},
				]),
			],
		);
		expect(ancestorSet(await keyOf(DEF_SECTION, holder, 'relation_search', DEF_REL))).toEqual([
			`${TERM_SECTION}|424242`,
		]); // FLOOR
	}

	async function holderWith(terms: number[]): Promise<number> {
		const holder = await createSectionRecord(DEF_SECTION, USER_ID);
		const result = await saveComponentData({
			componentTipo: DEF_REL,
			sectionTipo: DEF_SECTION,
			sectionId: holder,
			lang: 'lg-nolan',
			userId: USER_ID,
			changedData: [
				{
					action: 'set_data',
					id: null,
					value: terms.map((term) => ({
						type: 'dd151',
						section_tipo: TERM_SECTION,
						section_id: term,
						from_component_tipo: DEF_REL,
					})),
				},
			] as never,
		});
		expect(result.ok, result.message).toBe(true);
		// FLOOR: the SAVE law keeps no index for a plain autocomplete.
		expect(await keyOf(DEF_SECTION, holder, 'relation_search', DEF_REL)).toBeUndefined();
		return holder;
	}

	const T9_CHAIN = [`${TERM_SECTION}|1`, `${TERM_SECTION}|2`].sort();

	test('13: the REMOVAL law re-indexes EVERY relation key at all three removal doors — the portal delete, the record delete’s inverse strip, the data wipe', async () => {
		// (a) deletePortalLocator
		const a = await holderWith([T9, T58]);
		await plantStaleIndex(a);
		const removal = await deletePortalLocator(
			await resolvePrincipal(USER_ID),
			{ tipo: DEF_REL, section_tipo: DEF_SECTION, section_id: a },
			{
				locator: { section_tipo: TERM_SECTION, section_id: T58 },
				ar_properties: ['section_tipo', 'section_id'],
			},
		);
		expect(removal.removed).toBe(1);
		expect(
			ancestorSet(await keyOf(DEF_SECTION, a, 'relation_search', DEF_REL)),
			'the portal delete left a stale ancestor index on a non-`_hi` relation key — the REMOVAL law (P1-7: every relation key re-indexed) did not apply',
		).toEqual(T9_CHAIN);

		// (b) the record delete's inverse-reference strip
		const victim = await createSectionRecord(TERM_SECTION, USER_ID);
		const b = await holderWith([T9, victim]);
		await plantStaleIndex(b);
		await deleteSectionRecord(TERM_SECTION, victim, USER_ID);
		expect(await keyOf(DEF_SECTION, b, 'relation', DEF_REL)).toEqual([
			expect.objectContaining({ section_id: T9 }),
		]); // FLOOR: the strip rewrote the holder
		expect(
			ancestorSet(await keyOf(DEF_SECTION, b, 'relation_search', DEF_REL)),
			'the inverse strip left a stale ancestor index on a non-`_hi` relation key (the REMOVAL law)',
		).toEqual(T9_CHAIN);

		// (c) the data wipe: the emptied key's index goes with it
		const c = await holderWith([T9]);
		await plantStaleIndex(c);
		await deleteSectionData(DEF_SECTION, c, USER_ID);
		expect(await keyOf(DEF_SECTION, c, 'relation', DEF_REL)).toBeUndefined(); // FLOOR
		expect(
			await keyOf(DEF_SECTION, c, 'relation_search', DEF_REL),
			'the wipe emptied the relation key but left its ancestor index (the REMOVAL law: an empty derivation removes the key)',
		).toBeUndefined();
	}, 120_000);
});

// ---------------------------------------------------------------------------
// CORE-2 — the observer recompute writes an `_hi` mirror WITH its index
// ---------------------------------------------------------------------------

describe('CORE-2: the observer recompute indexes an _hi mirror by the save law', () => {
	/** a1 and a2: the literal chain of a3 in the zzoh fixture. */
	const A3_CHAIN = [`${TERM_A}|1`, `${TERM_A}|2`];

	async function savePortal(termId: number, targets: number[]): Promise<unknown[]> {
		const result = await saveComponentData({
			componentTipo: PORTAL,
			sectionTipo: TERM_A,
			sectionId: termId,
			lang: 'lg-nolan',
			userId: USER_ID,
			changedData: [
				{
					action: 'set_data',
					id: null,
					value: targets.map((target) => ({
						type: 'dd151',
						section_tipo: HOST_B,
						section_id: target,
						from_component_tipo: PORTAL,
					})),
				},
			] as never,
		});
		expect(result.ok, result.message).toBe(true);
		return (result as { observersData?: unknown[] }).observersData ?? [];
	}

	const observerIds = async (): Promise<number[]> =>
		(((await keyOf(HOST_B, B1, 'relation', HI_OBSERVER)) as unknown[] | undefined) ?? []).map(
			(entry) => Number((entry as { section_id: unknown }).section_id),
		);

	test('4: save → recompute writes O(b1)=[a3] AND relation_search[O] = a3’s chain; reconcile re-derives it; a dry run writes nothing; a drop removes the key', async () => {
		await savePortal(3, [B1]);
		expect(await observerIds(), 'the recompute did not run — re-read this gate').toEqual([3]);
		expect(
			ancestorSet(await keyOf(HOST_B, B1, 'relation_search', HI_OBSERVER)),
			'the observer recompute wrote an _hi mirror WITHOUT its ancestor index — a broader-term search cannot find b1 (CORE-2)',
		).toEqual(A3_CHAIN);

		// DRIFT: the mirror and its index lost (as an old door would leave them).
		await sql.unsafe(
			`UPDATE "${TABLE}" SET relation = relation - $3, relation_search = COALESCE(relation_search, '{}'::jsonb) - $3
			  WHERE section_tipo = $1 AND section_id = $2`,
			[HOST_B, B1, HI_OBSERVER],
		);
		const rowText = async (): Promise<string> =>
			(
				(await sql.unsafe(
					`SELECT (relation::text || '|' || COALESCE(relation_search::text, '')) AS t FROM "${TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
					[HOST_B, B1],
				)) as { t: string }[]
			)[0]?.t ?? '';
		const beforeDry = await rowText();
		const dry = await reconcileObserverMirrors({
			onlyObserver: HI_OBSERVER,
			onlySection: HOST_B,
			onlyId: B1,
		});
		expect(dry.drifted, 'the reconcile saw no drift — re-read this gate').toBe(1);
		expect(await rowText(), 'a DRY-RUN reconcile wrote to the row').toBe(beforeDry);

		await reconcileObserverMirrors({
			apply: true,
			onlyObserver: HI_OBSERVER,
			onlySection: HOST_B,
			onlyId: B1,
		});
		expect(await observerIds()).toEqual([3]);
		expect(
			ancestorSet(await keyOf(HOST_B, B1, 'relation_search', HI_OBSERVER)),
			'the reconcile repaired the _hi mirror without its ancestor index (CORE-2)',
		).toEqual(A3_CHAIN);

		await savePortal(3, []);
		expect(await observerIds()).toEqual([]);
		expect(
			await keyOf(HOST_B, B1, 'relation_search', HI_OBSERVER),
			'the mirror emptied but its ancestor index stayed',
		).toBeUndefined();
	}, 90_000);

	test('4b: a mirror whose VALUE is right but whose index is missing (written before CORE-2) — the reconcile re-indexes it; a dry run reports it and writes nothing', async () => {
		await savePortal(3, [B1]);
		expect(await observerIds()).toEqual([3]);
		// The pre-CORE-2 shape: the value stands, its ancestor index does not.
		await sql.unsafe(
			`UPDATE "${TABLE}" SET relation_search = COALESCE(relation_search, '{}'::jsonb) - $3
			  WHERE section_tipo = $1 AND section_id = $2`,
			[HOST_B, B1, HI_OBSERVER],
		);
		expect(await keyOf(HOST_B, B1, 'relation_search', HI_OBSERVER)).toBeUndefined(); // FLOOR
		// The INTERACTIVE cascade does not pay the chain walk under its row lock: a
		// propagation that recomputes b1 to the same value leaves the legacy index
		// to the reconcile (recomputeExternalRelation's repairIndex).
		await savePortal(3, [B1]);
		expect(await observerIds()).toEqual([3]);
		expect(
			await keyOf(HOST_B, B1, 'relation_search', HI_OBSERVER),
			'an interactive no-drift recompute walked the mirror’s thesaurus chains under its row lock to repair a legacy index — that sweep is the reconcile’s',
		).toBeUndefined();
		const scope = { onlyObserver: HI_OBSERVER, onlySection: HOST_B, onlyId: B1 };
		const dry = await reconcileObserverMirrors(scope);
		expect(dry.drifted, 'the value agrees — not a value drift').toBe(0);
		expect(dry.reindexed, 'the dry run did not see the missing index').toBe(1);
		expect(
			await keyOf(HOST_B, B1, 'relation_search', HI_OBSERVER),
			'a DRY-RUN reconcile wrote the index',
		).toBeUndefined();
		const applied = await reconcileObserverMirrors({ ...scope, apply: true });
		expect(applied.reindexed).toBe(1);
		expect(
			ancestorSet(await keyOf(HOST_B, B1, 'relation_search', HI_OBSERVER)),
			'the reconcile left an agreeing mirror without its ancestor index — no door repairs a pre-CORE-2 mirror',
		).toEqual(A3_CHAIN);
		expect(await observerIds()).toEqual([3]);
		// idempotent: a second sweep finds nothing
		expect((await reconcileObserverMirrors(scope)).reindexed).toBe(0);
		await savePortal(3, []);
	}, 90_000);

	test('4c: a DEGRADED-SEED legacy `_hi` mirror (its drops withheld, its index missing) — the reconcile re-indexes the value AS STORED; a dry run reports it and writes nothing', async () => {
		const host = await createSectionRecord(DEG_HOST, USER_ID);
		const locator = (term: number, id: number) => ({
			id,
			type: 'dd151',
			section_tipo: TERM_SECTION,
			section_id: term,
			from_component_tipo: DEG_HI,
		});
		// Raw (no door propagates): term 58 points at the host; the host's mirror
		// lists 58 AND 9 — 9 a stale entry the degraded seed may not drop — and
		// carries NO ancestor index (the pre-CORE-2 shape).
		await sql.unsafe(
			`UPDATE "${TABLE}" SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
			  WHERE section_tipo = $1 AND section_id = $2`,
			[
				TERM_SECTION,
				T58,
				DEG_PORTAL,
				JSON.stringify([
					{
						id: 1,
						type: 'dd151',
						section_tipo: DEG_HOST,
						section_id: host,
						from_component_tipo: DEG_PORTAL,
					},
				]),
			],
		);
		const stored = [locator(T58, 1), locator(T9, 2)];
		await sql.unsafe(
			`UPDATE "${TABLE}" SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($3::text, $4::text::jsonb)
			  WHERE section_tipo = $1 AND section_id = $2`,
			[DEG_HOST, host, DEG_HI, JSON.stringify(stored)],
		);
		// THE ORACLE: what a normal save of the same value indexes, on a twin host.
		const twin = await createSectionRecord(DEG_HOST, USER_ID);
		await saveOn(
			DEG_HOST,
			twin,
			DEG_HI,
			stored.map(({ id: _id, ...rest }) => rest),
		);
		const expected = ancestorSet(await keyOf(DEG_HOST, twin, 'relation_search', DEG_HI));
		expect(expected.length, 're-read this gate: the save law indexed nothing').toBeGreaterThan(0);
		expect(await keyOf(DEG_HOST, host, 'relation_search', DEG_HI)).toBeUndefined(); // FLOOR

		const scope = { onlyObserver: DEG_HI, onlySection: DEG_HOST, onlyId: host };
		const dry = await reconcileObserverMirrors(scope);
		expect(dry.degradedSeedRecords, 're-read this gate: the seed is not degraded').toBe(1);
		expect(
			dry.reindexed,
			'the dry run did not see the missing index of a mirror whose drops are WITHHELD — the index sweep only ran where the value agreed',
		).toBe(1);
		expect(await keyOf(DEG_HOST, host, 'relation_search', DEG_HI)).toBeUndefined();

		const applied = await reconcileObserverMirrors({ ...scope, apply: true });
		expect(applied.reindexed).toBe(1);
		expect(
			await listedIn(DEG_HOST, host, DEG_HI, TERM_SECTION),
			'the value moved — the withheld drop was applied',
		).toEqual([T58, T9]);
		expect(
			ancestorSet(await keyOf(DEG_HOST, host, 'relation_search', DEG_HI)),
			'the reconcile left a degraded-seed `_hi` mirror without its ancestor index — no later write re-indexes a value that cannot move',
		).toEqual(expected);
		expect((await reconcileObserverMirrors(scope)).reindexed, 'not idempotent').toBe(0);
		await sql.unsafe(
			`UPDATE "${TABLE}" SET relation = relation - $3 WHERE section_tipo = $1 AND section_id = $2`,
			[TERM_SECTION, T58, DEG_PORTAL],
		);
	}, 90_000);

	test('7c: a DUPLICATE of an `_hi` mirror host stores neither the mirror nor its index', async () => {
		await savePortal(3, [B1]);
		// FLOOR: the source holds the mirror AND its index.
		expect(await observerIds()).toEqual([3]);
		expect(ancestorSet(await keyOf(HOST_B, B1, 'relation_search', HI_OBSERVER))).toEqual(A3_CHAIN);
		const clone = await duplicateSectionRecord(HOST_B, B1, USER_ID);
		expect(await keyOf(HOST_B, clone, 'relation', HI_OBSERVER)).toBeUndefined();
		expect(
			await keyOf(HOST_B, clone, 'relation_search', HI_OBSERVER),
			'the clone carries an ancestor index for a mirror it does not hold — a broader-term search matches it for terms it never listed (the duplicate copied relation_search verbatim)',
		).toBeUndefined();
		await savePortal(3, []);
	}, 90_000);

	test('6: the interactive save still returns its same-record observer data (the receipt)', async () => {
		const observersData = await savePortal(2, [B1]);
		expect(
			observersData.some((item) => (item as { tipo?: unknown }).tipo === HI_INFO),
			'saveComponentData.observersData lost the same-record component_info item',
		).toBe(true);
		await savePortal(2, []);
	}, 60_000);
});

// ---------------------------------------------------------------------------
// B6 — the ledger drains post-commit, exactly per committed write
// ---------------------------------------------------------------------------

describe('B6: obligations drain after COMMIT, exactly for what committed', () => {
	test('5a: a write in a transaction that ROLLS BACK propagates nothing (no mirror entry, no recompute at all)', async () => {
		const legit = await newRef();
		await saveIndexer(legit, [T58]);
		expect(await mirrorOf(T58)).toContain(legit);
		// A drift ONLY a recompute of 58 would repair: if anything drains the
		// rolled-back write's entry, 58 is recomputed from truth and `legit` is back.
		await plantMirrorDrift(T58, legit);
		expect(await mirrorOf(T58)).not.toContain(legit); // FLOOR
		const r = await newRef();
		const historyBefore = await mirrorHistoryRows(T58);
		await expect(
			withTransaction(async () => {
				await saveIndexer(r, [T58]);
				throw new Error('obligation_ledger_native: injected rollback');
			}),
		).rejects.toThrow('injected rollback');
		expect(await keyOf(REF_SECTION, r, 'relation', INDEXER)).toBeUndefined();
		expect(await mirrorOf(T58)).not.toContain(r);
		expect(
			await mirrorOf(T58),
			'a ROLLED-BACK write’s obligation drained anyway — 58 was recomputed (the planted drift is repaired): the entry rides a lane that also runs on ROLLBACK',
		).not.toContain(legit);
		expect(await mirrorHistoryRows(T58)).toBe(historyBefore);
		await reconcileTerm(T58);
		expect(await mirrorOf(T58)).toContain(legit);
	}, 60_000);

	test('5b: a write inside an AMBIENT transaction propagates after COMMIT, never inside it', async () => {
		const r = await newRef();
		let insideMirror: number[] = [];
		await withTransaction(async () => {
			await saveIndexer(r, [T58]);
			insideMirror = await mirrorOf(T58);
		});
		expect(
			insideMirror,
			'the observer recompute ran INSIDE the caller’s transaction (B6): its row locks ride to the outer COMMIT and a recompute failure aborts the caller’s primary write',
		).not.toContain(r);
		expect(await mirrorOf(T58), 'the committed write never reached the mirror').toContain(r);
	}, 60_000);

	test('5c: a SAVEPOINT rollback discards exactly its own obligations', async () => {
		const legit = await newRef();
		await saveIndexer(legit, [T9]);
		expect(await mirrorOf(T9)).toContain(legit);
		// A drift ONLY a recompute of 9 would repair — and only the rolled-back
		// write names 9.
		await plantMirrorDrift(T9, legit);
		expect(await mirrorOf(T9)).not.toContain(legit); // FLOOR
		const r = await newRef();
		await withTransaction(async () => {
			await saveIndexer(r, [T58]);
			await sql.unsafe('SAVEPOINT obligation_ledger_sp');
			await saveIndexer(r, [T9]);
			await sql.unsafe('ROLLBACK TO SAVEPOINT obligation_ledger_sp');
		});
		expect(await keyOf(REF_SECTION, r, 'relation', INDEXER)).toEqual([
			expect.objectContaining({ section_id: T58 }),
		]);
		expect(
			await mirrorOf(T58),
			'the database holds r→58 but the mirror does not — a committed write’s obligation was lost (or coalesced away)',
		).toContain(r);
		expect(
			await mirrorOf(T9),
			'the write rolled back to the savepoint still drained — 9 was recomputed (the planted drift is repaired): its entry survived the savepoint rollback',
		).not.toContain(legit);
		expect(await mirrorOf(T9)).not.toContain(r);
		await reconcileTerm(T9);
		expect(await mirrorOf(T9)).toContain(legit);
	}, 60_000);

	test('5d: an obligation queued with NO ambient transaction drains INLINE — repaired when the call returns', async () => {
		// Not a save: saveComponentData wraps itself in a transaction (the commit
		// lane — 5b). The covered-slot recompute entry queues from wherever it is
		// called, so it reaches the ledger's no-transaction branch directly.
		const legit = await newRef();
		await saveIndexer(legit, [T58]);
		await plantMirrorDrift(T58, legit);
		expect(await mirrorOf(T58)).not.toContain(legit); // FLOOR
		expect(isInTransaction(), 're-read this gate: an ambient transaction').toBe(false);
		await requestCoveredSlotRecompute(
			{ table: TABLE, sectionTipo: TERM_SECTION, sectionId: T58 },
			{ userId: USER_ID },
			{ actor: USER_ID },
			[MIRROR],
		);
		expect(
			await mirrorOf(T58),
			'an obligation queued outside any transaction did not drain inline — the no-transaction branch lost it (or deferred it past the call)',
		).toContain(legit);
	}, 60_000);
});

// ---------------------------------------------------------------------------
// the bulk revert's record doors: the soft-cascade restore, the verbatim
// undelete, and D2 over a mirror
// ---------------------------------------------------------------------------

describe('the bulk revert keeps a mirror DERIVED', () => {
	/** Wipe a term under a fresh run and answer its role-4 marker. */
	async function wipeTerm(term: number): Promise<RecordMarker> {
		const run = await newRun();
		await deleteSectionData(TERM_SECTION, term, USER_ID, new Date(), { bulkProcessId: run });
		// FLOOR: the wipe emptied the term (its parent link included).
		expect(await keyOf(TERM_SECTION, term, 'relation', PARENT)).toBeUndefined();
		const [marker] = (await markersOf(run, 4)).filter(
			(candidate) => candidate.sectionTipo === TERM_SECTION && candidate.sectionId === term,
		);
		expect(marker, 'the wipe left no role-4 twin under the run').toBeDefined();
		return marker as RecordMarker;
	}

	const restoreWiped = async (marker: RecordMarker) =>
		undeleteCascadeRecord(marker, {
			principal: await resolvePrincipal(USER_ID),
			userId: USER_ID,
			newBulkId: await newRun(),
		});

	test('10: the SOFT-cascade restore of a wiped term — its keys come back and its mirror is RECOMPUTED, never the snapshot’s copy', async () => {
		const stays = await newRef();
		const leaves = await newRef();
		await saveIndexer(stays, [T12]);
		await saveIndexer(leaves, [T12]);
		expect(await mirrorOf(T12)).toEqual([stays, leaves].sort((a, b) => a - b));
		const marker = await wipeTerm(T12);
		expect(await mirrorOf(T12)).toEqual([]); // the wipe emptied the mirror too
		// A referencer leaves while the term is wiped, through a path that
		// propagates nothing (a raw write — the drift an old door leaves): the
		// mirror stays in its wiped state, and only a recompute can list `stays`.
		await sql.unsafe(
			`UPDATE "${TABLE}" SET relation = relation - $3 WHERE section_tipo = $1 AND section_id = $2`,
			[REF_SECTION, leaves, INDEXER],
		);

		expect((await restoreWiped(marker)).kind).toBe('done');
		expect(await keyOf(TERM_SECTION, T12, 'relation', PARENT)).toEqual([
			expect.objectContaining({ section_id: 2 }),
		]);
		expect(
			await mirrorOf(T12),
			'the restored term’s mirror is not the recompute truth — the snapshot’s copy was written back (the referencer that left is a phantom), or nothing recomputed it (still empty)',
		).toEqual([stays]);
	}, 90_000);

	test('10b: a referencer that moves on after the wipe does not make the restore a “write since” — the mirror is nobody’s write', async () => {
		const stays = await newRef();
		const leaves = await newRef();
		await saveIndexer(stays, [T15]);
		await saveIndexer(leaves, [T15]);
		const marker = await wipeTerm(T15);
		// Its save recomputes the wiped term's mirror: it lists `stays` alone — a
		// value neither the snapshot nor the wipe left.
		await saveIndexer(leaves, []);
		expect(await mirrorOf(T15)).toEqual([stays]);

		expect(
			(await restoreWiped(marker)).kind,
			'the restore judged the RECOMPUTED mirror a write since the wipe and kept the record wiped — a derived slot is nobody’s write',
		).toBe('done');
		expect(await keyOf(TERM_SECTION, T15, 'relation', PARENT)).toEqual([
			expect.objectContaining({ section_id: 2 }),
		]);
		expect(await mirrorOf(T15)).toEqual([stays]);
	}, 90_000);

	test('11: a revert that undeleted a term and its referencer — VERBATIM (the term’s recompute leaves its stamps), and reverting it deletes both', async () => {
		const r = await newRef();
		await saveIndexer(r, [T14]);
		await deleteSectionRecord(REF_SECTION, r, USER_ID);
		// The term's modified stamps become a SENTINEL no write of this run could
		// mint (a stamp minted "now" would equal one minted a second ago, and hide a
		// re-stamp): the snapshot carries it, a verbatim undelete must keep it.
		await sql.unsafe(
			`UPDATE "${TABLE}" SET date = jsonb_set(COALESCE(date, '{}'::jsonb), '{dd201}', '[{"id":1,"start":{"year":1901,"month":1,"day":1}}]'::jsonb)
			  WHERE section_tipo = $1 AND section_id = $2`,
			[TERM_SECTION, T14],
		);
		await deleteSectionRecord(TERM_SECTION, T14, USER_ID);
		const termRow = await wholeRecordRow(TERM_SECTION, T14);
		const refRow = await wholeRecordRow(REF_SECTION, r);
		const termColumns = termRow.data as Record<string, Record<string, unknown> | undefined>;
		const snapshotStamps = {
			who: termColumns.relation?.dd197 ?? null,
			when: termColumns.date?.dd201 ?? null,
		};
		expect(JSON.stringify(snapshotStamps.when)).toContain('1901'); // FLOOR: the sentinel is in the snapshot
		const revert = await newRun();
		const context = {
			principal: await resolvePrincipal(USER_ID),
			userId: USER_ID,
			newBulkId: revert,
		};
		// The referencer first: when the term comes back, ITS OWN birth's covered-slot
		// recompute is what lists r — the recompute a verbatim birth drives.
		expect((await undeleteCascadeRecord(markerFor(REF_SECTION, r, refRow), context)).kind).toBe(
			'done',
		);
		expect((await undeleteCascadeRecord(markerFor(TERM_SECTION, T14, termRow), context)).kind).toBe(
			'done',
		);
		// FLOOR: the term's mirror lists r again (the recompute wrote it).
		expect(await mirrorOf(T14)).toEqual([r]);
		expect(
			await modifiedStamps(TERM_SECTION, T14),
			'the VERBATIM undelete was re-stamped by the recompute it drove — the snapshot’s stamps (which a run may own) are gone, and a revert of the revert refuses them changed_since_run',
		).toEqual(snapshotStamps);

		// Reverting the revert: its birth markers, the TERM first.
		const births = await markersOf(revert, 3);
		const ordered = [
			...births.filter((marker) => marker.sectionTipo === TERM_SECTION),
			...births.filter((marker) => marker.sectionTipo === REF_SECTION),
		];
		expect(ordered.map((marker) => marker.sectionId)).toEqual([T14, r]);
		const outcomes = await deleteBornRecords(
			ordered,
			{ ...context, newBulkId: await newRun() },
			new Set(),
		);
		expect(
			[...outcomes.values()].map((outcome) => outcome.kind),
			'D2 kept a born record: its mirror was judged a FOREIGN value, or a mirror locator counted as a LINK (the term and its referencer then "reference" each other forever)',
		).toEqual(['done', 'done']);
		expect(await readMatrixRecord(TABLE, TERM_SECTION, T14)).toBeNull();
		expect(await readMatrixRecord(TABLE, REF_SECTION, r)).toBeNull();
	}, 120_000);

	test('11c: a term and its referencer undeleted in ONE transaction (a revert unit) — the term stays VERBATIM and its mirror is written ONCE', async () => {
		const r = await newRef();
		await saveIndexer(r, [T16]);
		await deleteSectionRecord(REF_SECTION, r, USER_ID);
		await sql.unsafe(
			`UPDATE "${TABLE}" SET date = jsonb_set(COALESCE(date, '{}'::jsonb), '{dd201}', '[{"id":1,"start":{"year":1902,"month":2,"day":2}}]'::jsonb)
			  WHERE section_tipo = $1 AND section_id = $2`,
			[TERM_SECTION, T16],
		);
		await deleteSectionRecord(TERM_SECTION, T16, USER_ID);
		const termRow = await wholeRecordRow(TERM_SECTION, T16);
		const refRow = await wholeRecordRow(REF_SECTION, r);
		const termColumns = termRow.data as Record<string, Record<string, unknown> | undefined>;
		const snapshotStamps = {
			who: termColumns.relation?.dd197 ?? null,
			when: termColumns.date?.dd201 ?? null,
		};
		expect(JSON.stringify(snapshotStamps.when)).toContain('1902'); // FLOOR: the sentinel
		const context = {
			principal: await resolvePrincipal(USER_ID),
			userId: USER_ID,
			newBulkId: await newRun(),
		};
		const historyBefore = await mirrorHistoryRows(T16);
		// The REFERENCER is queued FIRST: its birth's drain reaches the term's mirror
		// before the term's own entry drains — so the term's verbatim mark must be on
		// the transaction's SHARED guard from the moment its entry is QUEUED.
		await withTransaction(async () => {
			expect((await undeleteCascadeRecord(markerFor(REF_SECTION, r, refRow), context)).kind).toBe(
				'done',
			);
			expect(
				(await undeleteCascadeRecord(markerFor(TERM_SECTION, T16, termRow), context)).kind,
			).toBe('done');
		});
		expect(await mirrorOf(T16)).toEqual([r]); // FLOOR: the recompute ran after COMMIT
		expect(
			await modifiedStamps(TERM_SECTION, T16),
			'the verbatim undelete was re-stamped by the recompute its referencer’s entry drove (the mark was not on the shared guard when that entry drained)',
		).toEqual(snapshotStamps);
		expect(
			(await mirrorHistoryRows(T16)) - historyBefore,
			'the term’s mirror was written more (or less) than once for one operation',
		).toBe(1);
	}, 120_000);

	test('10c: a soft-cascade restore whose run OWNS the term’s stamps — the covered-slot recompute leaves them too', async () => {
		const stays = await newRef();
		await saveIndexer(stays, [T17]);
		const marker = await wipeTerm(T17);
		// FLOOR: the wipe emptied the mirror, so the restore's recompute WRITES (a
		// no-drift recompute stamps nothing whatever its posture).
		expect(await mirrorOf(T17)).toEqual([]);
		await sql.unsafe(
			`UPDATE "${TABLE}" SET date = jsonb_set(COALESCE(date, '{}'::jsonb), '{dd201}', '[{"id":1,"start":{"year":1903,"month":3,"day":3}}]'::jsonb)
			  WHERE section_tipo = $1 AND section_id = $2`,
			[TERM_SECTION, T17],
		);
		const stampsBefore = await modifiedStamps(TERM_SECTION, T17);
		expect(JSON.stringify(stampsBefore)).toContain('1903'); // FLOOR: the sentinel
		const outcome = await undeleteCascadeRecord(marker, {
			principal: await resolvePrincipal(USER_ID),
			userId: USER_ID,
			newBulkId: await newRun(),
			// The run wrote the term's modified stamps: its own units restore them,
			// so no write here may stamp the record (runOwnsRecordStamps).
			keyAddresses: new Set([keyAddress(TERM_SECTION, T17, 'dd201')]),
		});
		expect(outcome.kind).toBe('done');
		expect(await mirrorOf(T17)).toEqual([stays]); // FLOOR: the recompute wrote the mirror
		expect(
			await modifiedStamps(TERM_SECTION, T17),
			'the covered-slot recompute of a restore whose run owns the record’s stamps stamped it anyway — a revert of the revert then refuses the record changed_since_run',
		).toEqual(stampsBefore);
	}, 120_000);

	test('10d: a soft-cascade restore whose snapshot mirror is EMPTY while truth has a referencer — the whole-section recompute lists it', async () => {
		const hub = await newHub();
		const early = await createSectionRecord(LINK_SECTION, USER_ID);
		// The hub HAD a referencer that left: its mirror is stored, and empty.
		await saveLink(early, [hub]);
		await saveLink(early, []);
		expect(await hubMirrorOf(hub)).toEqual([]); // FLOOR
		const run = await newRun();
		await deleteSectionData(HUB_SECTION, hub, USER_ID, new Date(), { bulkProcessId: run });
		const [marker] = (await markersOf(run, 4)).filter(
			(candidate) => candidate.sectionTipo === HUB_SECTION && candidate.sectionId === hub,
		);
		expect(marker, 'the wipe left no role-4 twin under the run').toBeDefined();
		// A referencer arrives while the hub is wiped, raw (nothing propagates):
		// truth is [link], the snapshot's mirror is empty — no key the restore
		// writes back names the slot.
		const link = await createSectionRecord(LINK_SECTION, USER_ID);
		await plantLocator(
			{ sectionTipo: LINK_SECTION, sectionId: link, componentTipo: LINK },
			{ sectionTipo: HUB_SECTION, sectionId: hub },
		);
		expect(await hubMirrorOf(hub)).toEqual([]); // FLOOR: no mirror knows it yet

		const outcome = await undeleteCascadeRecord(marker as RecordMarker, {
			principal: await resolvePrincipal(USER_ID),
			userId: USER_ID,
			newBulkId: await newRun(),
		});
		expect(['done', 'present']).toContain(outcome.kind);
		expect(
			await hubMirrorOf(hub),
			'the restored host’s mirror was never recomputed — only the slots the snapshot carried were (an empty snapshot slot is no restored key)',
		).toEqual([link]);
	}, 90_000);

	test('11d: a mirror host and its referencer undeleted in ONE transaction, the referencer first — the no-drift recompute its propagation ran does not swallow the host’s hop', async () => {
		const hub = await newHub();
		const back = await createSectionRecord(LINK_SECTION, USER_ID);
		const live = await createSectionRecord(LINK_SECTION, USER_ID);
		await saveLink(back, [hub]);
		await saveLink(live, [hub]);
		expect([...(await hubMirrorOf(hub))].sort((a, b) => a - b)).toEqual(
			[back, live].sort((a, b) => a - b),
		);
		expect(await backOf(live)).toEqual([hub]); // FLOOR: the depth-2 edge runs
		await deleteSectionRecord(HUB_SECTION, hub, USER_ID);
		// FLOOR: the death told the mirror's observer (on a record that stays LIVE).
		expect(await backOf(live)).toEqual([]);
		const hubRow = await wholeRecordRow(HUB_SECTION, hub);
		// Both links point at the hub again while it is gone (raw — the delete's
		// inverse strip removed their locators): the snapshot's mirror IS truth.
		for (const link of [back, live]) {
			await plantLocator(
				{ sectionTipo: LINK_SECTION, sectionId: link, componentTipo: LINK },
				{ sectionTipo: HUB_SECTION, sectionId: hub },
			);
		}
		await deleteSectionRecord(LINK_SECTION, back, USER_ID);
		const backRow = await wholeRecordRow(LINK_SECTION, back);
		const context = {
			principal: await resolvePrincipal(USER_ID),
			userId: USER_ID,
			newBulkId: await newRun(),
		};
		// The REFERENCER is queued first: its edge's propagation recomputes the hub's
		// mirror after COMMIT and finds NO drift (no write, no hop) — before the
		// hub's own covered-slot recompute, which the guard then finds done.
		await withTransaction(async () => {
			expect(
				(await undeleteCascadeRecord(markerFor(LINK_SECTION, back, backRow), context)).kind,
			).toBe('done');
			expect((await undeleteCascadeRecord(markerFor(HUB_SECTION, hub, hubRow), context)).kind).toBe(
				'done',
			);
		});
		expect([...(await hubMirrorOf(hub))].sort((a, b) => a - b)).toEqual(
			[back, live].sort((a, b) => a - b),
		); // FLOOR: no drift — the snapshot was truth
		expect(await backOf(back)).toEqual([hub]); // its own birth's recompute
		expect(
			await backOf(live),
			'the undeleted mirror’s LIVE observer never learned it back — a recompute already done (no drift) by the referencer’s propagation swallowed the forced hop',
		).toEqual([hub]);
	}, 120_000);

	test('14: apply_value of a MIRROR history row — the restore lands, and the mirror converges on the recompute truth (never the phantom)', async () => {
		const r = await newRef();
		await saveIndexer(r, [T58]);
		const rows = (await sql.unsafe(
			`SELECT id, data FROM matrix_time_machine
			  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 ORDER BY id DESC LIMIT 1`,
			[TERM_SECTION, T58, MIRROR],
		)) as { id: number; data: unknown }[];
		const listing = rows[0];
		expect(
			(Array.isArray(listing?.data) ? listing.data : []).some(
				(entry) =>
					(entry as { section_tipo?: unknown }).section_tipo === REF_SECTION &&
					Number((entry as { section_id?: unknown }).section_id) === r,
			),
		).toBe(true); // FLOOR: a history row of the mirror that lists r
		await saveIndexer(r, []);
		const truth = await mirrorOf(T58);
		expect(truth).not.toContain(r); // FLOOR: r left
		// The t1 row names r: restored verbatim and left there, it is a PHANTOM
		// referencer every search through the mirror (and its `_hi` index) matches.
		await applyValue({
			section_tipo: TERM_SECTION,
			section_id: T58,
			tipo: MIRROR,
			lang: 'lg-nolan',
			matrix_id: Number(listing?.id),
		});
		expect(
			await mirrorOf(T58),
			'apply_value wrote a past derivation of the mirror back and nothing recomputed it — a phantom referencer until the next reconcile',
		).toEqual(truth);
	}, 60_000);

	test('14b: a bulk revert of a run that wrote a MIRROR key — the key converges on truth after COMMIT, never the run’s image (the departed referencer)', async () => {
		const hub = await newHub();
		const leaves = await createSectionRecord(LINK_SECTION, USER_ID);
		const stays = await createSectionRecord(LINK_SECTION, USER_ID);
		await saveLink(leaves, [hub]);
		await saveLink(stays, [hub]);
		expect(await hubMirrorOf(hub)).toEqual([leaves, stays]); // FLOOR: the cascade built it
		const run = await newRun();
		await saveHubMirror(hub, [stays], { bulk: run });
		expect(await hubMirrorOf(hub)).toEqual([stays]);
		// The referencer leaves AFTER the run: truth is [stays], which the mirror
		// already holds (a no-drift recompute — the run's pair stays revertable).
		await saveLink(leaves, []);
		expect(await hubMirrorOf(hub)).toEqual([stays]);

		const data = await bulkRevert(run);
		expect(data.skipped, 'the revert refused the mirror key').toEqual([]);
		expect(data.counter).toBe(1);
		expect(
			await hubMirrorOf(hub),
			'the revert wrote the run’s BEFORE image of a mirror back and nothing recomputed it — the referencer that left is a phantom until the next reconcile (A14b)',
		).toEqual([stays]);
		expect(
			await backOf(leaves),
			'the reverted mirror’s past value was PROPAGATED — the departed referencer’s back-mirror lists the hub again',
		).toEqual([]);
	}, 90_000);

	test('14c: a bulk revert whose run OWNS the mirror host’s stamps — the restored mirror’s recompute leaves them (the key write’s posture)', async () => {
		const hub = await newHub();
		const leaves = await createSectionRecord(LINK_SECTION, USER_ID);
		const stays = await createSectionRecord(LINK_SECTION, USER_ID);
		await saveLink(leaves, [hub]);
		await saveLink(stays, [hub]);
		// The pre-run stamp becomes a SENTINEL no write of this test could mint (a
		// stamp minted "now" equals one minted a second ago, and would hide a re-stamp).
		await sql.unsafe(
			`UPDATE "${TABLE}" SET date = jsonb_set(COALESCE(date, '{}'::jsonb), '{dd201}', '[{"id":1,"start":{"year":1906,"month":6,"day":6}}]'::jsonb)
			  WHERE section_tipo = $1 AND section_id = $2`,
			[HUB_SECTION, hub],
		);
		const stampsBefore = await modifiedStamps(HUB_SECTION, hub);
		expect(JSON.stringify(stampsBefore)).toContain('1906'); // FLOOR: the sentinel
		const run = await newRun();
		// The importer's row shape (a CSV carrying dd201): every save with the stamp
		// SUPPRESSED — the mirror first, dd201 LAST, so the revert (newest unit
		// first) restores the stamp BEFORE the mirror unit's recompute drains: a
		// recompute that stamps is then the last word on the record's stamps.
		await saveHubMirror(hub, [stays], { bulk: run, skipModifiedStamp: true });
		await saveOn(
			HUB_SECTION,
			hub,
			'dd201',
			[{ id: 1, lang: 'lg-nolan', start: { year: 1905, month: 5, day: 5 } }],
			{ bulk: run, skipModifiedStamp: true },
		);
		expect(JSON.stringify(await modifiedStamps(HUB_SECTION, hub))).toContain('1905'); // FLOOR
		await saveLink(leaves, []);
		expect(await hubMirrorOf(hub)).toEqual([stays]); // a no-drift recompute: nothing stamped

		const data = await bulkRevert(run);
		expect(data.skipped, 'a unit of the run refused').toEqual([]);
		expect(data.counter).toBe(2);
		expect(await hubMirrorOf(hub)).toEqual([stays]);
		expect(
			await modifiedStamps(HUB_SECTION, hub),
			'the restored mirror’s recompute stamped a record whose stamps the run owns — the revert is not exact',
		).toEqual(stampsBefore);
	}, 90_000);

	test('14d: a MIRROR observed in turn — a referencer that leaves drops out of its back-mirror (the hop carries what the recompute dropped), and apply_value of the mirror’s old row never propagates the phantom', async () => {
		const hub = await newHub();
		const r = await createSectionRecord(LINK_SECTION, USER_ID);
		await saveLink(r, [hub]);
		// FLOOR: the depth-2 cascade runs — the mirror lists r, and r's back-mirror the hub.
		expect(await hubMirrorOf(hub)).toEqual([r]);
		expect(await backOf(r), 're-read this gate: the mirror’s own observer never fired').toEqual([
			hub,
		]);
		const rows = (await sql.unsafe(
			`SELECT id FROM matrix_time_machine
			  WHERE section_tipo = $1 AND section_id = $2 AND tipo = $3 ORDER BY id DESC LIMIT 1`,
			[HUB_SECTION, hub, HUB_MIRROR],
		)) as { id: number }[];
		const listing = Number(rows[0]?.id);
		expect(listing).toBeGreaterThan(0); // FLOOR: a history row of the mirror that lists r

		await saveLink(r, []);
		expect(await hubMirrorOf(hub)).toEqual([]);
		expect(
			await backOf(r),
			'r left the hub, the hub’s mirror dropped r — but r’s back-mirror still lists the hub: the recompute’s hop carried no removed set, so nothing re-derived r (it is in no current value)',
		).toEqual([]);

		await applyValue({
			section_tipo: HUB_SECTION,
			section_id: hub,
			tipo: HUB_MIRROR,
			lang: 'lg-nolan',
			matrix_id: listing,
		});
		expect(await hubMirrorOf(hub), 'the restored mirror did not converge on truth').toEqual([]);
		expect(
			await backOf(r),
			'apply_value PROPAGATED the mirror’s past value: r’s back-mirror was recomputed while the phantom stood, and the per-operation dedup kept it there after the mirror converged',
		).toEqual([]);
	}, 90_000);

	test('14e: a bulk revert of a COMPOSED unit whose main is a covered mirror (with its dataframe slot) — the main converges on truth, the departed referencer never reaches the mirror’s own observers, the kept item keeps its frame', async () => {
		const { hub, first: leaves, second: stays, rateSecond } = await framedHub();
		const run = await newRun();
		// The run saves the mirror down to `stays` (its item kept as stored) — the
		// main AND its frame slot in one composed pair (the save's remove cascade
		// drops `leaves`' frame).
		const staysItem = ((await keyOf(HUBF_SECTION, hub, 'relation', HUBF_MIRROR)) as unknown[]).find(
			(entry) => Number((entry as { section_id: unknown }).section_id) === stays,
		);
		await saveOn(HUBF_SECTION, hub, HUBF_MIRROR, [staysItem], { bulk: run });
		expect(await hubFMirrorOf(hub)).toEqual([stays]);
		// `leaves` leaves AFTER the run: truth is [stays], which the mirror already
		// holds (a no-drift recompute — the run's composed pair stays revertable).
		await saveLinkF(leaves, []);
		expect(await hubFMirrorOf(hub)).toEqual([stays]);
		expect(await backFOf(leaves)).toEqual([]); // FLOOR: it left the hub

		const data = await bulkRevert(run);
		expect(data.skipped, 'the revert refused the composed mirror unit').toEqual([]);
		expect(
			await hubFMirrorOf(hub),
			'the composed revert wrote the run’s BEFORE image of the mirror back and nothing recomputed it — the departed referencer is a phantom (writeComposedUnit not through the COMPONENT-RESTORE entry)',
		).toEqual([stays]);
		expect(
			await backFOf(leaves),
			'the composed revert PROPAGATED the mirror’s past value — the departed referencer’s back-mirror lists the hub again',
		).toEqual([]);
		expect(
			await framePairing(HUBF_SECTION, hub),
			'the kept referencer lost (or swapped) its frame through the revert and its recompute',
		).toEqual([`${stays}->${rateSecond}`]);
	}, 90_000);
});

// ---------------------------------------------------------------------------
// the COVERED UNIT — a mirror and its frames move together (record_write §3e)
// ---------------------------------------------------------------------------

describe('the covered UNIT: a mirror and the frames that pair with its items move together', () => {
	test('17a: UNDELETE of a mirror host — every frame pairs with the SAME referencer as before, the snapshot’s phantom never reaches the mirror’s own observers, and they learn the rest back', async () => {
		const f = await framedHub();
		// A third referencer that will NOT point at the hub again: in the snapshot's
		// mirror, it is a PHANTOM once the hub comes back.
		const gone = await newLinkF();
		await saveLinkF(gone, [f.hub]);
		expect(await hubFMirrorOf(f.hub)).toEqual([f.second, f.first, gone]); // FLOOR
		await deleteSectionRecord(HUBF_SECTION, f.hub, USER_ID);
		// FLOOR: the death told the mirror's own observer the hub is gone.
		expect(await backFOf(f.first)).toEqual([]);
		expect(await backFOf(gone)).toEqual([]);
		const row = await wholeRecordRow(HUBF_SECTION, f.hub);
		expect(JSON.stringify(row.data)).toContain(HUBF_FRAME); // FLOOR: the snapshot carries the frames
		// Both links point at the hub again while it is gone (raw — the delete's
		// inverse strip removed their locators, and no door writes one onto a
		// missing record): truth after the undelete is both, as the snapshot says.
		for (const link of [f.first, f.second]) {
			await plantLocator(
				{ sectionTipo: LINKF_SECTION, sectionId: link, componentTipo: LINKF },
				{ sectionTipo: HUBF_SECTION, sectionId: f.hub },
			);
		}

		await applyValue({
			section_tipo: HUBF_SECTION,
			section_id: f.hub,
			tipo: HUBF_SECTION,
			lang: 'lg-nolan',
			matrix_id: row.id,
		});
		expect(
			await framePairing(HUBF_SECTION, f.hub),
			'the undeleted hub’s frames pair with ANOTHER referencer — the birth dropped the mirror and kept its frames, and the recompute minted fresh ids into the empty slot',
		).toEqual(f.pairing);
		expect(await hubFMirrorOf(f.hub)).toEqual([f.second, f.first]); // the stored order, ids kept
		expect(
			await backFOf(gone),
			'the undelete PROPAGATED the snapshot’s mirror as an edge — the phantom’s back-mirror lists the hub, and the per-operation dedup kept it there after the recompute dropped it',
		).toEqual([]);
		expect(
			await backFOf(f.first),
			'the undeleted mirror’s own observer never learned it back — a recompute that wrote nothing did not hop',
		).toEqual([f.hub]);
		expect(await backFOf(f.second)).toEqual([f.hub]);
	}, 90_000);

	test('17b: the SOFT-cascade restore of a wiped mirror host — the mirror comes back WITH its ids (every frame pairs as before), and its own observers learn it back', async () => {
		const f = await framedHub();
		const run = await newRun();
		await deleteSectionData(HUBF_SECTION, f.hub, USER_ID, new Date(), { bulkProcessId: run });
		// FLOOR: the wipe emptied the mirror AND its frames, and told the observer.
		expect(await hubFMirrorOf(f.hub)).toEqual([]);
		expect((await keyOf(HUBF_SECTION, f.hub, 'relation', HUBF_FRAME)) ?? []).toEqual([]);
		expect(await backFOf(f.first)).toEqual([]);
		const [marker] = (await markersOf(run, 4)).filter(
			(candidate) => candidate.sectionTipo === HUBF_SECTION && candidate.sectionId === f.hub,
		);
		expect(marker, 'the wipe left no role-4 twin under the run').toBeDefined();

		const outcome = await undeleteCascadeRecord(marker as RecordMarker, {
			principal: await resolvePrincipal(USER_ID),
			userId: USER_ID,
			newBulkId: await newRun(),
		});
		expect(outcome.kind).toBe('done');
		expect(
			await framePairing(HUBF_SECTION, f.hub),
			'the restored frames pair with ANOTHER referencer — the restore put the frames back but not the mirror they pair with, and the recompute minted fresh ids',
		).toEqual(f.pairing);
		expect(await hubFMirrorOf(f.hub)).toEqual([f.second, f.first]);
		expect(
			await backFOf(f.first),
			'the restored mirror’s own observer never learned it back — a no-drift recompute did not hop',
		).toEqual([f.hub]);
		expect(await backFOf(f.second)).toEqual([f.hub]);
	}, 90_000);

	test('17c: a whole-record REPLACE over a live mirror host keeps the LIVE unit — the live mirror AND its live frames, never the snapshot’s frames beside the live items', async () => {
		const f = await framedHub();
		const snapshot = (await readMatrixRecord(TABLE, HUBF_SECTION, f.hub))?.columns;
		expect(snapshot).toBeDefined();
		// `second` leaves (its item and its frame go — the recompute's remove
		// cascade); `third` joins, and a curator frames it.
		await saveLinkF(f.second, []);
		const third = await newLinkF();
		await saveLinkF(third, [f.hub]);
		const thirdId = (await hubFItems(f.hub)).find((item) => item.link === third)?.id ?? -1;
		const rateThird = await createSectionRecord(RATE_SECTION, USER_ID);
		const liveFrames = (await keyOf(HUBF_SECTION, f.hub, 'relation', HUBF_FRAME)) as unknown[];
		await plantFrames(f.hub, [...liveFrames, rateFrame(thirdId, rateThird)]);
		const live = [`${f.first}->${f.rateFirst}`, `${third}->${rateThird}`].sort();
		expect(await framePairing(HUBF_SECTION, f.hub)).toEqual(live); // FLOOR

		await restoreSection(snapshot, 0, HUBF_SECTION, f.hub, USER_ID);
		expect(
			await framePairing(HUBF_SECTION, f.hub),
			'the replace kept the LIVE mirror but wrote the SNAPSHOT’s frames beside it — a frame pairs with no item (orphan) or with another referencer, and the live item lost its frame',
		).toEqual(live);
		expect(await hubFMirrorOf(f.hub)).toEqual([f.first, third]);
	}, 90_000);

	test('17d: a DUPLICATE of a mirror host stores neither the mirror nor its frames (the source’s referencers’), and re-mints no frame target for them', async () => {
		const f = await framedHub();
		const ratesBefore = await rateRecords();
		const clone = await duplicateSectionRecord(HUBF_SECTION, f.hub, USER_ID);
		expect((await keyOf(HUBF_SECTION, clone, 'relation', HUBF_MIRROR)) ?? []).toEqual([]);
		expect(
			(await keyOf(HUBF_SECTION, clone, 'relation', HUBF_FRAME)) ?? [],
			'the clone stored the frames of a mirror it does not copy — they pair with the SOURCE’s referencer ids, and the clone’s first recompute mints those ids for its own',
		).toEqual([]);
		expect(
			await rateRecords(),
			'the duplicate re-minted a frame target for a frame the clone never stores',
		).toBe(ratesBefore);
	}, 90_000);

	test('17e: the SOFT-cascade restore of a mirror host whose snapshot lists a referencer that LEFT while it was wiped — the phantom never propagates (its back-mirror stays empty)', async () => {
		const f = await framedHub();
		const gone = await newLinkF();
		await saveLinkF(gone, [f.hub]);
		expect(await hubFMirrorOf(f.hub)).toEqual([f.second, f.first, gone]); // FLOOR
		expect(await backFOf(gone)).toEqual([f.hub]); // FLOOR
		const run = await newRun();
		await deleteSectionData(HUBF_SECTION, f.hub, USER_ID, new Date(), { bulkProcessId: run });
		expect(await backFOf(gone)).toEqual([]); // FLOOR: the wipe told the observer
		// `gone` leaves while the hub is wiped, raw (nothing propagates): the
		// snapshot's mirror still lists it — a phantom once the hub comes back.
		await sql.unsafe(
			`UPDATE "${TABLE}" SET relation = relation - $3 WHERE section_tipo = $1 AND section_id = $2`,
			[LINKF_SECTION, gone, LINKF],
		);
		const [marker] = (await markersOf(run, 4)).filter(
			(candidate) => candidate.sectionTipo === HUBF_SECTION && candidate.sectionId === f.hub,
		);
		expect(marker, 'the wipe left no role-4 twin under the run').toBeDefined();

		const outcome = await undeleteCascadeRecord(marker as RecordMarker, {
			principal: await resolvePrincipal(USER_ID),
			userId: USER_ID,
			newBulkId: await newRun(),
		});
		expect(outcome.kind).toBe('done');
		expect(
			await hubFMirrorOf(f.hub),
			'the restored mirror is not truth — the snapshot’s phantom stayed',
		).toEqual([f.second, f.first]);
		expect(
			await backFOf(gone),
			'the restore PROPAGATED the snapshot’s past mirror as an edge — the departed referencer’s back-mirror lists the host again',
		).toEqual([]);
		expect(await framePairing(HUBF_SECTION, f.hub)).toEqual(f.pairing);
		expect(await backFOf(f.first)).toEqual([f.hub]);
	}, 90_000);
});

// ---------------------------------------------------------------------------
// the census the wipe and the covered-slot restore share
// ---------------------------------------------------------------------------

describe('one section census: what the wipe empties is what the restore recomputes', () => {
	/** A VIRT record that LINK record `link` points at (planted raw — nothing propagates). */
	async function virtualTarget(): Promise<{ record: number; link: number }> {
		const record = await createSectionRecord(VIRT, USER_ID);
		const link = await createSectionRecord(LINK_SECTION, USER_ID);
		await plantLocator(
			{ sectionTipo: LINK_SECTION, sectionId: link, componentTipo: LINK },
			{ sectionTipo: VIRT, sectionId: record },
		);
		return { record, link };
	}
	const virtMirrorOf = (record: number) => listedIn(VIRT, record, HUB_MIRROR, LINK_SECTION);

	test('16a: the COMPONENT-RESTORE of a covered slot on a VIRTUAL section that declares a component of its own — the slot it wrote is recomputed (queued exactly, never narrowed by a census)', async () => {
		const { record, link } = await virtualTarget();
		const phantom = await createSectionRecord(LINK_SECTION, USER_ID);
		// No ambient transaction: the restore's recompute drains inline.
		await persistRestoredKeys(
			{ table: TABLE, sectionTipo: VIRT, sectionId: record },
			[
				{
					column: 'relation',
					key: HUB_MIRROR,
					value: [
						{
							id: 1,
							type: 'dd151',
							section_tipo: LINK_SECTION,
							section_id: phantom,
							from_component_tipo: HUB_MIRROR,
						},
					],
				},
			],
			false,
			{ actor: USER_ID },
		);
		expect(
			await virtMirrorOf(record),
			'the restored past derivation was written and NEVER recomputed — the census dropped the slot (the virtual section has a component of its own, so its real section’s mirror was never listed)',
		).toEqual([link]);
	}, 60_000);

	test('16c: the COMPONENT-RESTORE of a covered slot a record’s section does not declare at all — still recomputed: the entry queues exactly the slots it wrote', async () => {
		// A DEF_SECTION record carrying HUB_MIRROR (declared by HUB_SECTION only —
		// e.g. a key left by an ontology move): no census of DEF_SECTION lists it,
		// and the write proved it covered (isCoveredObserverTipo) already.
		const record = await createSectionRecord(DEF_SECTION, USER_ID);
		const link = await createSectionRecord(LINK_SECTION, USER_ID);
		const phantom = await createSectionRecord(LINK_SECTION, USER_ID);
		await plantLocator(
			{ sectionTipo: LINK_SECTION, sectionId: link, componentTipo: LINK },
			{ sectionTipo: DEF_SECTION, sectionId: record },
		);
		await persistRestoredKeys(
			{ table: TABLE, sectionTipo: DEF_SECTION, sectionId: record },
			[
				{
					column: 'relation',
					key: HUB_MIRROR,
					value: [
						{
							id: 1,
							type: 'dd151',
							section_tipo: LINK_SECTION,
							section_id: phantom,
							from_component_tipo: HUB_MIRROR,
						},
					],
				},
			],
			false,
			{ actor: USER_ID },
		);
		expect(
			await listedIn(DEF_SECTION, record, HUB_MIRROR, LINK_SECTION),
			'the restored slot was dropped from its own recompute by the section census (the `only` list narrowed instead of queued exactly)',
		).toEqual([link]);
	}, 60_000);

	test('16b: the whole-section covered-slot recompute on that virtual section lists the REAL section’s mirror, and the wipe empties the same slot', async () => {
		const { record, link } = await virtualTarget();
		expect(await virtMirrorOf(record)).toEqual([]); // FLOOR: no mirror knows the link yet
		await requestCoveredSlotRecompute(
			{ table: TABLE, sectionTipo: VIRT, sectionId: record },
			false,
			{ actor: USER_ID },
		);
		expect(
			await virtMirrorOf(record),
			'the restore’s census missed the real section’s covered slot (own subtree only, when the virtual section declares a component of its own)',
		).toEqual([link]);
		await deleteSectionData(VIRT, record, USER_ID);
		expect(
			(await keyOf(VIRT, record, 'relation', HUB_MIRROR)) ?? [],
			'the wipe left the real section’s mirror on a virtual record — the wipe and the restore walk different censuses',
		).toEqual([]);
	}, 60_000);
	test('16d: a covered mirror declared under a NESTED section node — the whole-section recompute lists it, and the wipe empties the same slot', async () => {
		const record = await createSectionRecord(NEST_SECTION, USER_ID);
		const link = await createSectionRecord(NLINK_SECTION, USER_ID);
		await plantLocator(
			{ sectionTipo: NLINK_SECTION, sectionId: link, componentTipo: NLINK },
			{ sectionTipo: NEST_SECTION, sectionId: record },
		);
		const nestMirrorOf = () => listedIn(NEST_SECTION, record, NEST_MIRROR, NLINK_SECTION);
		expect(await nestMirrorOf()).toEqual([]); // FLOOR: no mirror knows the link yet
		await requestCoveredSlotRecompute(
			{ table: TABLE, sectionTipo: NEST_SECTION, sectionId: record },
			false,
			{ actor: USER_ID },
		);
		expect(
			await nestMirrorOf(),
			'the restore’s census missed a covered slot declared under a nested section node (the walk stopped at the nested section)',
		).toEqual([link]);
		await deleteSectionData(NEST_SECTION, record, USER_ID);
		expect(
			(await keyOf(NEST_SECTION, record, 'relation', NEST_MIRROR)) ?? [],
			'the wipe left a mirror declared under a nested section node — the wipe does not cross nested sections',
		).toEqual([]);
	}, 60_000);
});

// ---------------------------------------------------------------------------
// the ledger's own invariants
// ---------------------------------------------------------------------------

describe('the ledger refuses what it cannot honour, and the registry lookup stays warm', () => {
	test('15a: a write that reaches the post-write hook WITHOUT an observer declaration is a typed refusal naming its door', async () => {
		let refusal: unknown;
		try {
			await afterRecordWrite({ table: TABLE, sectionTipo: REF_SECTION, sectionId: 1 }, {
				door: 'zz_undeclared_door',
				touchedKeys: [],
				rag: null,
			} as never);
		} catch (error) {
			refusal = error;
		}
		expect(refusal, 'an undeclared write crashed untyped (or passed)').toBeInstanceOf(DedaloError);
		expect((refusal as DedaloError).code).toBe('internal.invariant');
		expect((refusal as DedaloError).message).toContain('zz_undeclared_door');
	});

	test('15b: an obligation queued by a LEAKED continuation (after its transaction settled) is refused, never dropped', async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let leaked: Promise<unknown> = Promise.resolve(null);
		await withTransaction(async () => {
			// Unawaited on purpose: this continuation outlives its withTransaction.
			leaked = (async () => {
				await gate;
				await enqueueObservedChange(
					{ table: TABLE, sectionTipo: TERM_SECTION, sectionId: T58 },
					{ kind: 'recompute', slots: [MIRROR], actor: USER_ID },
				);
				return null;
			})().catch((error: unknown) => error);
		});
		release();
		const refusal = await leaked;
		expect(refusal, 'the leaked obligation was silently dropped (or ran)').toBeInstanceOf(
			DedaloError,
		);
		expect((refusal as DedaloError).code).toBe('internal.invariant');
		expect((refusal as DedaloError).message).toContain('leaked continuation');
	});

	test('15c: a registry rebuilt cold INSIDE a transaction is warmed after COMMIT — later transactions share ONE registry, not a rebuild each', async () => {
		clearObserverSubscriptionRegistry();
		const inTx = async (): Promise<unknown> => {
			let registry: unknown;
			await withTransaction(async () => {
				registry = await getSubscriptionRegistry();
			});
			return registry;
		};
		const first = await inTx();
		const second = await inTx();
		const third = await inTx();
		expect(first).toBeDefined();
		expect(
			second === third,
			'every transaction after a cold start rebuilt the subscription registry for itself — the in-transaction lookup never warms the shared cache',
		).toBe(true);
		expect(await getSubscriptionRegistry()).toBe(
			second as Awaited<ReturnType<typeof getSubscriptionRegistry>>,
		);
	});
});

// ---------------------------------------------------------------------------
// 16e — a copy-law slot is a covered slot (the suite's own S7 legend nodes)
// ---------------------------------------------------------------------------

describe('16e: an observed_data (S7) slot is covered — its restore converges on the text’s tags', () => {
	const LEGEND_SECTION = 'test6124';
	const LEGEND_TEXT = 'test6263';
	const TAG_SLOT = 'test6380';
	const COIN_SECTION = 'test6100';
	const S7_TABLE = 'matrix_test';
	const born: { sectionTipo: string; sectionId: number }[] = [];
	const create = async (sectionTipo: string): Promise<number> => {
		const sectionId = await createSectionRecord(sectionTipo, USER_ID);
		born.push({ sectionTipo, sectionId });
		return sectionId;
	};
	const svgTag = (tagId: number, sectionId: number): string =>
		`[svg-n-${tagId}--data:{'section_tipo':'${COIN_SECTION}','section_id':'${sectionId}','component_tipo':'test6232'}:data]`;
	const slotIds = async (sectionId: number): Promise<number[]> => {
		const rows = (await sql.unsafe(
			`SELECT relation->$3 AS value FROM "${S7_TABLE}" WHERE section_tipo = $1 AND section_id = $2`,
			[LEGEND_SECTION, sectionId, TAG_SLOT],
		)) as { value: unknown }[];
		const value = rows[0]?.value;
		return (Array.isArray(value) ? value : []).map((item) =>
			Number((item as { section_id: unknown }).section_id),
		);
	};

	afterAll(async () => {
		for (const { sectionTipo, sectionId } of born.reverse()) {
			await cleanScratchRecord(sectionTipo, sectionId, S7_TABLE);
		}
	}, 60_000);

	test('16e: the COMPONENT-RESTORE of a phantom tag slot is recomputed to the legend text’s svg locators', async () => {
		// FLOOR: the slot is covered (else nothing below is asserted).
		expect(await isCoveredObserverTipo(TAG_SLOT)).toBe(true);
		expect(await getMatrixTableFromTipo(LEGEND_SECTION)).toBe(S7_TABLE);
		const coinA = await create(COIN_SECTION);
		const coinB = await create(COIN_SECTION);
		const phantom = await create(COIN_SECTION);
		const legend = await create(LEGEND_SECTION);
		const lang = config.lang.dataLangDefault;
		const saved = await saveComponentData({
			componentTipo: LEGEND_TEXT,
			sectionTipo: LEGEND_SECTION,
			sectionId: legend,
			lang,
			changedData: [
				{
					action: 'set_data',
					// document order B, A — the slot follows the text, not the ids
					value: [{ id: 1, lang, value: `<p>${svgTag(1, coinB)} and ${svgTag(2, coinA)}</p>` }],
				},
			] as never,
			userId: USER_ID,
		});
		expect(saved.ok, saved.message).toBe(true);
		expect(await slotIds(legend), 'the text save did not derive its tag slot').toEqual([
			coinB,
			coinA,
		]);
		// The restore writes a past derivation naming a coin no tag names.
		await persistRestoredKeys(
			{ table: S7_TABLE, sectionTipo: LEGEND_SECTION, sectionId: legend },
			[
				{
					column: 'relation',
					key: TAG_SLOT,
					value: [
						{
							id: 1,
							type: 'dd151',
							section_tipo: COIN_SECTION,
							section_id: phantom,
							from_component_tipo: TAG_SLOT,
						},
					],
				},
			],
			false,
			{ actor: USER_ID },
		);
		expect(
			await slotIds(legend),
			'the restored observed_data slot was left as written — a copy-law slot is not treated as covered by the restore’s recompute (the phantom coin stays listed)',
		).toEqual([coinB, coinA]);
	}, 120_000);
});
