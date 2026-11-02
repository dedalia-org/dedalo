/**
 * tool_import_rdf — the EXECUTOR: applies the operation list the mapping plan
 * (rdf_import_plan.ts) derived from a remote RDF graph and the external
 * ontology, into the caller record and the records it links to.
 *
 * The port of v6 `tool_import_rdf::get_resource_to_dd_object` (search-or-create
 * through `get_resource_match`, `set_data_into_component`, `create_new_resource`),
 * on the engine's own doors, with the v6 write defects fixed rather than ported:
 *
 *   - NEVER OVERWRITES (v6 `set_data_into_component` only filled an empty value,
 *     but its relation branch wrote a bare locator in place of the list). A
 *     literal is written only when its language slice is EMPTY; an IRI is
 *     appended unless that IRI is already stored (any lang); a locator is
 *     appended through the relation INSERT LAW (dedup by address, read grant on
 *     the target, selection cap). Every write is an `appendImport` save
 *     (append_merge.ts), so even a value written concurrently between the
 *     emptiness read and the save is kept beside, never replaced. A single-choice
 *     model (select/radio — its descriptor REFUSES append) is written with a plain
 *     replace only when it holds nothing at all.
 *   - FIND BEFORE CREATE (v6 `get_resource_match` glued the value into a raw SQO
 *     string). A linked resource is found by its identifier through the engine's
 *     own code lookup (`findSectionIdByCode` — the search assembler, a byte-exact
 *     second read, ambiguity refused), scoped to the importing principal. A term
 *     no record holds by its own identifier is looked up by its EQUIVALENTS (the
 *     IRIs its fetched document writes into the match component — skos:exactMatch
 *     on the live mapping; decision 2026-10-02, `matchTerm`): ONE record holding
 *     any is the term (linked, its own identifier appended), several are a
 *     conflict (nothing linked or created). Only an identifier no visible record
 *     carries, directly or through an equivalent, creates one. A resource with NO
 *     identifier is never created: it could never be found again, and every run
 *     would add another copy. An INTERMEDIATE record (v6 `create_new_resource`,
 *     the ddo_map branch — creators → person → URI) is found among the records
 *     the target already links to, by walking the ddo_map path down to the
 *     resource's identifier; v6 answered null for an existing one and so skipped
 *     its children — here it is bound, and its children run.
 *   - EVERY WRITE ASKS THE WRITE DOOR, as the importing principal: an existing
 *     record's component through `authorizeRecordAccess` (section floor, the
 *     dd128-aware pair, the write scope — `assertRecordWriteTarget` — of a record
 *     the run bound at run time); a create through `authorizeSectionTarget` at the
 *     section (and at the match component, so a record is never born without the
 *     identifier that finds it again), the new record's components at the pair. A
 *     refused write is SKIPPED and reported; it never aborts the IRI.
 *   - THE TARGET CHECK FIRST (rdf_import_prune.ts): a link into a section its
 *     component does not target — an ontology node mapping the wrong section —
 *     is skipped with that reason before anything is found, fetched or created.
 *   - ONE TRANSACTION PER IRI, ONE SAVEPOINT PER OP. A partial failure is
 *     partial: an op the engine REFUSES (a caller/permission/conflict error —
 *     `relation.insert_refused`, `perm.denied`, `request.invalid_data`,
 *     `resource.conflict` …) rolls back to its savepoint and is a skip with its
 *     code; every op naming the record it failed to bind is skipped as depending
 *     on it; the rest commits. The groups that must stay atomic are one op: a
 *     find_or_create with its identifier write, an intermediate with the op
 *     that completes its path — and a born record whose identifier write is
 *     SKIPPED rather than thrown is refused all the same (`writeIdentity`,
 *     `tool.rdf_identifier_unwritable`): a record born without what finds it
 *     again would be re-created by every run. A term created by its own op
 *     STAYS when the separate link to it is refused (a selection cap, a term not
 *     selectable, the read grant — off_target never gets that far): it is a
 *     complete authority record, found again by the next run, reverted with the
 *     run's dd800. A FAULT (internal.*, a database error that is no refusal, a
 *     save answered `ok:false`) rolls the whole IRI back and is reported; the
 *     run continues with the next IRI.
 *   - ONE dd800 BULK PROCESS PER RUN (`createBulkProcessRecord`, shared with the
 *     mapped-record executor), minted LAZILY by the first write or create: every
 *     TM row and every birth carries it, so a wrong import is revertable as one
 *     operation; a run that changes nothing (a re-run) mints none.
 *
 * The operation list is DATA the plan builder produces with no database access;
 * this module trusts none of it beyond its shape: tipos go through the write
 * door's grammar, languages through the install's declared set, records through
 * the search and the scope. The op's `model` is re-read from the ontology,
 * never taken from the plan.
 */

import { getComponentModel, getImportAppendPolicy } from '../../../src/core/components/registry.ts';
import { compareLocators, type Locator } from '../../../src/core/concepts/locator.ts';
import { readMatrixRecord } from '../../../src/core/db/matrix.ts';
import { withSavepoint, withTransaction } from '../../../src/core/db/postgres.ts';
import { DedaloError, isDedaloError, spec } from '../../../src/core/errors/dedalo_error.ts';
import {
	getColumnNameByModel,
	getMatrixTableFromTipo,
	getModelByTipo,
	savesInRequestLang,
} from '../../../src/core/ontology/resolver.ts';
import { filterItemsByLang, readComponentItems } from '../../../src/core/resolve/component_data.ts';
import { containsDedaloTag } from '../../../src/core/section/record/append_merge.ts';
import { createSectionRecord } from '../../../src/core/section/record/create_record.ts';
import {
	isInstalledDataLang,
	saveComponentData,
} from '../../../src/core/section/record/save_component.ts';
import type { Principal } from '../../../src/core/security/permissions.ts';
import {
	authorizeRecordAccess,
	authorizeSectionTarget,
} from '../../../src/core/security/write_door.ts';
import { withLazyLiveBulkRun } from '../../../src/core/tools/bulk_run_registry.ts';
import {
	type CodeLookupOptions,
	findSectionIdByCode,
	findSectionIdsByCodes,
	type ImportCodeTarget,
	itemAsText,
} from '../../../src/core/tools/import_code_lookup.ts';
import { createBulkProcessRecord } from '../../../src/core/tools/import_execute.ts';
import {
	isWebIri,
	RDF_GEO_TAG,
	type RdfDdoStep,
	type RdfFindOrCreateOp,
	type RdfImportOp,
	type RdfImportPlan,
	type RdfIntermediateOp,
	type RdfLinkOp,
	type RdfPlanItem,
	type RdfSetOp,
	type RdfSkipOp,
	type RecordRef,
} from './rdf_import_plan.ts';
import { dependsOn, pruneOffTarget } from './rdf_import_prune.ts';

// ---------------------------------------------------------------------------
// The request and the report
// ---------------------------------------------------------------------------

/** The record the tool was opened on: every plan's `{kind:'caller'}` target. */
export interface RdfCallerLocator {
	readonly section_tipo: string;
	readonly section_id: number;
}

export interface RdfWrittenEntry {
	section_tipo: string;
	section_id: number;
	component_tipo: string;
	lang: string;
	/** A short human rendering of what was added (never the stored bytes). */
	value_summary: string;
}

export interface RdfCreatedEntry {
	section_tipo: string;
	section_id: number;
	/** The identifier the record was created for (the resource IRI, the matched text). */
	label: string;
}

export interface RdfSkippedEntry {
	/** The component the op addressed ('' when the plan named none). */
	component_tipo: string;
	reason: string;
	/**
	 * The registry code of the refusal the op met (or, for a pruned link, would
	 * have met; for a dependent, the one its record met) — absent for a skip that
	 * is a fact, not a refusal ('already present', 'not empty in …').
	 */
	code?: string;
	/** The record the skipped op addressed, when it was resolved. */
	section_tipo?: string;
	section_id?: number;
}

/**
 * One IRI's outcome. A refused op is a `skipped` entry beside what the IRI did
 * write and create (its savepoint rolled back, the rest committed); `error` set
 * ⇒ an INTERNAL fault rolled the whole IRI back: `written`/`created`/`skipped`
 * are empty.
 */
export interface RdfIriReport {
	/** The plan's subject IRI. */
	iri: string;
	written: RdfWrittenEntry[];
	created: RdfCreatedEntry[];
	skipped: RdfSkippedEntry[];
	/** The rollback's cause as log text (never sent: the action converts `failure`). */
	error: string | null;
	/** The rollback's cause itself, present only on a rolled-back IRI (the action types it for the wire). */
	failure?: unknown;
}

export interface RdfImportReport {
	/** The run's dd800 record (revert handle); null when nothing was written or created. */
	bulk_process_id: number | null;
	/** Flattened across every COMMITTED IRI, in plan order. */
	written: RdfWrittenEntry[];
	created: RdfCreatedEntry[];
	skipped: RdfSkippedEntry[];
	/** Per-IRI detail (including the rolled-back ones and why). */
	iris: RdfIriReport[];
}

export interface RdfImportRequest {
	caller: RdfCallerLocator;
	/** One per IRI, each applied in its own transaction, ops in order. */
	plans: readonly RdfImportPlan[];
	principal: Principal;
	/** The dd800 label; defaults to a sentence naming the caller record. */
	bulkLabel?: string;
	sourceFile?: string;
}

// ---------------------------------------------------------------------------
// Run state (per IRI, never module-level)
// ---------------------------------------------------------------------------

/** A record a ref resolved to; `born` ⇒ created inside THIS IRI's transaction. */
interface BoundRecord {
	section_tipo: string;
	section_id: number;
	born: boolean;
	/**
	 * A linked term matched by an EQUIVALENT ({@link bindMatch}): the record gains
	 * the term's own identifier and nothing else — every op that would write INTO
	 * it is withheld ({@link writableTarget}). Links TO it stand.
	 */
	byEquivalent?: true;
	/**
	 * A term CREATED by this IRI: the identifiers it is (its own and its
	 * equivalents, with their http/https twins) in its match component — what a
	 * later term of the same IRI is matched against before the ops that write
	 * them have run ({@link bornMatch}).
	 */
	identity?: { readonly component_tipo: string; readonly values: readonly string[] };
}

/**
 * An intermediate not created (yet): it is created only when an op COMPLETES its
 * path — see {@link applyIntermediate}. The ops on it that came first wait here.
 */
interface PendingIntermediate {
	readonly op: RdfIntermediateOp;
	readonly deferred: (RdfSetOp | RdfLinkOp)[];
}

/**
 * The run's dd800, minted LAZILY: by the first op that really writes or
 * creates (a re-run that changes nothing leaves no bulk record and no TM row
 * behind). The mint joins that op's savepoint, so a rollback of it — the op's
 * or the IRI's — takes the row with it and {@link forgetMint} forgets the id.
 */
interface LazyBulk {
	id: number | null;
	readonly caller: RdfCallerLocator;
	readonly userId: number;
	readonly label: string;
	readonly sourceFile: string | undefined;
	/** The live-run registration (bulk_run_registry withLazyLiveBulkRun). */
	readonly enter: (bulkId: number) => void;
	readonly leave: (bulkId: number) => void;
}

interface IriRun {
	principal: Principal;
	bulk: LazyBulk;
	/** Keyed by {@link refName}: the caller, and every find_or_create / intermediate key bound so far. */
	refs: Map<string, BoundRecord>;
	/** Keyed by {@link keyName}: the intermediates waiting for the op that completes their path. */
	pending: Map<string, PendingIntermediate>;
	/** Key → the refusal code of its op (rolled back to its savepoint): what names it is skipped. */
	failed: Map<string, string>;
	report: RdfIriReport;
}

/** The door name every grant/log line of this executor carries. */
const DOOR = 'tool_import_rdf.import';

/** The skip of an IRI that is not http(s). */
const UNSUPPORTED_IRI = 'unsupported IRI scheme (http/https only) — not written';

/**
 * The skip of an op that would write into a record a linked term was matched to
 * by an EQUIVALENT: that record only gains the term's own identifier (see
 * {@link bindMatch}), never the fetched term's other fields.
 */
export const RDF_EQUIVALENT_WITHHELD =
	'matched by an equivalent identifier — only its own identifier is added, not the fetched fields';

/** The map key of a RecordRef — the caller's can never collide with a plan key. */
function refName(ref: RecordRef): string {
	return ref.kind === 'caller' ? '\u0000caller' : `key:${ref.key}`;
}

function keyName(key: string): string {
	return refName({ kind: 'found_or_created', key });
}

/** A write the door refused (a level, the scope, a malformed address). */
function isRefusal(error: unknown): error is DedaloError {
	return (
		isDedaloError(error) && (error.code.startsWith('perm.') || error.code === 'request.invalid')
	);
}

function skip(
	run: IriRun,
	componentTipo: string,
	reason: string,
	record?: BoundRecord,
	code?: string,
): void {
	const entry: RdfSkippedEntry = { component_tipo: componentTipo, reason };
	if (code !== undefined) entry.code = code;
	if (record !== undefined) {
		entry.section_tipo = record.section_tipo;
		entry.section_id = record.section_id;
	}
	run.report.skipped.push(entry);
}

function locatorTo(record: BoundRecord, componentTipo: string): RdfPlanItem {
	return {
		type: 'dd151',
		section_tipo: record.section_tipo,
		section_id: record.section_id,
		from_component_tipo: componentTipo,
	};
}

// ---------------------------------------------------------------------------
// The write door
// ---------------------------------------------------------------------------

/**
 * The door for ONE component of ONE record: a record born in this IRI's
 * transaction at the pair (nothing references it yet — the import_execute
 * posture); any other record — the caller, a found term — through
 * `authorizeRecordAccess` (section floor 1, the dd128-aware pair at 2, the
 * write scope). THROWS the door's refusal.
 */
async function authorizeWrite(
	principal: Principal,
	record: BoundRecord,
	componentTipo: string,
): Promise<void> {
	if (record.born) {
		await authorizeSectionTarget(
			principal,
			{ section_tipo: record.section_tipo, tipo: componentTipo },
			{ level: 2, door: DOOR },
		);
		return;
	}
	await authorizeRecordAccess(
		principal,
		{
			section_tipo: record.section_tipo,
			component_tipo: componentTipo,
			section_id: record.section_id,
		},
		{ mode: 'write', level: 2, sectionFloor: 1, door: DOOR },
	);
}

/** The refusal sentence, or null when the door admits the write. */
async function writeRefusal(
	principal: Principal,
	record: BoundRecord,
	componentTipo: string,
): Promise<string | null> {
	try {
		await authorizeWrite(principal, record, componentTipo);
		return null;
	} catch (error) {
		if (isRefusal(error)) return `not writable by the importer (${error.code})`;
		throw error;
	}
}

/**
 * The door for a CREATE in `sectionTipo`: the section at 2 (consultation-capped),
 * and — when the record is identified by a component — that component's pair at
 * 2: a record born without its identifier could never be found again, so the
 * next run would create a duplicate of it. Answers the refusal sentence or null.
 */
async function createRefusal(
	principal: Principal,
	sectionTipo: string,
	identifierTipo: string | null,
): Promise<string | null> {
	try {
		await authorizeSectionTarget(
			principal,
			{ section_tipo: sectionTipo },
			{ level: 2, door: DOOR },
		);
		if (identifierTipo !== null) {
			await authorizeSectionTarget(
				principal,
				{ section_tipo: sectionTipo, tipo: identifierTipo },
				{ level: 2, door: DOOR },
			);
		}
		return null;
	} catch (error) {
		if (isRefusal(error)) return `not created: refused (${error.code})`;
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Never overwrite: what of the incoming items may still be written
// ---------------------------------------------------------------------------

/** The component's stored items on the record (empty when the record or key is absent). */
async function storedItems(
	record: { section_tipo: string; section_id: number },
	componentTipo: string,
	model: string,
): Promise<unknown[]> {
	const table = await getMatrixTableFromTipo(record.section_tipo);
	if (table === null) return [];
	const row = await readMatrixRecord(table, record.section_tipo, record.section_id);
	if (row === null) return [];
	return readComponentItems(row, componentTipo, model) ?? [];
}

/** The incoming items left to write, or the reason none is. */
interface WritePlan {
	items: RdfPlanItem[];
	reason: string | null;
}

/** Is `item`'s address (section_tipo + section_id, the locator equality law) already stored? */
function isLinked(stored: readonly unknown[], item: RdfPlanItem): boolean {
	return stored.some(
		(candidate) =>
			typeof candidate === 'object' &&
			candidate !== null &&
			compareLocators(item as Locator, candidate as Locator, ['section_tipo', 'section_id']),
	);
}

/**
 * A relation column: only the locators not already linked (decided HERE, before
 * the save, so a re-run reaches no save — and mints no dd800 — for a link it
 * already made; the insert law dedups again at the save); a single-choice model
 * only fills an empty one.
 */
function relationWritePlan(
	model: string,
	stored: readonly unknown[],
	items: RdfPlanItem[],
): WritePlan {
	const singleChoice = typeof getImportAppendPolicy(model) === 'object';
	if (singleChoice && stored.length > 0) {
		return { items: [], reason: 'already set (single choice) — never overwritten' };
	}
	const fresh = items.filter((item) => !isLinked(stored, item));
	return fresh.length === 0
		? { items: [], reason: 'already present' }
		: { items: fresh, reason: null };
}

const iriOf = (item: unknown): string => String((item as { iri?: unknown }).iri ?? '').trim();

/**
 * An IRI component: append only the WEB IRIs (http/https — the plan's own rule,
 * re-checked here: a `javascript:` IRI from a remote document would be served
 * as a live link) not already stored in ANY language.
 */
function iriWritePlan(stored: readonly unknown[], items: RdfPlanItem[]): WritePlan {
	const web = items.filter((item) => isWebIri(iriOf(item)));
	if (web.length === 0) return { items: [], reason: UNSUPPORTED_IRI };
	const known = new Set(stored.map(iriOf));
	const fresh = web.filter((item) => !known.has(iriOf(item)));
	return fresh.length === 0
		? { items: [], reason: 'already present' }
		: { items: fresh, reason: null };
}

/** Any other literal: written only into an EMPTY language slice. */
async function literalWritePlan(
	componentTipo: string,
	model: string,
	lang: string,
	stored: unknown[],
	items: RdfPlanItem[],
): Promise<WritePlan> {
	// The slice the write would land in: a component that saves in the request
	// lang — translatable, or TRANSLITERABLE (with_lang_versions: an lg-nolan
	// base beside per-language versions) — is judged on THAT lang's slice only,
	// so a stored lg-ell version never blocks importing the lg-nolan base (and
	// vice versa). Every other literal stores one lg-nolan slice: the whole array.
	const slice = (await savesInRequestLang(componentTipo, model))
		? filterItemsByLang(stored, lang)
		: stored;
	return slice.length > 0
		? { items: [], reason: `not empty in ${lang} — never overwritten` }
		: { items, reason: null };
}

async function writePlanFor(
	record: BoundRecord,
	componentTipo: string,
	model: string,
	lang: string,
	items: RdfPlanItem[],
): Promise<WritePlan> {
	const stored = await storedItems(record, componentTipo, model);
	if (getColumnNameByModel(model) === 'relation') return relationWritePlan(model, stored, items);
	if (model === 'component_iri') return iriWritePlan(stored, items);
	return literalWritePlan(componentTipo, model, lang, stored, items);
}

/** Why the component cannot take a value at all, or null. */
function componentRefusal(model: string | null, lang: string): string | null {
	if (model === null || getComponentModel(model) === undefined) return 'unknown component';
	if (!isInstalledDataLang(lang)) return `language ${lang} is not installed`;
	return null;
}

// ---------------------------------------------------------------------------
// The save
// ---------------------------------------------------------------------------

/** A short human rendering of one item: its text, IRI, title or locator address. */
function itemSummary(item: RdfPlanItem): string {
	const text = item.value ?? item.iri ?? item.title;
	if (typeof text === 'string' || typeof text === 'number') return String(text);
	if (item.section_tipo !== undefined) {
		return `${String(item.section_tipo)}/${String(item.section_id)}`;
	}
	return JSON.stringify(item);
}

function valueSummary(items: readonly RdfPlanItem[]): string {
	const text = items.map(itemSummary).join(' | ');
	return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

/** The plan's OWN geo tag (rdf_import_plan geoTagItem), bare or as one paragraph. */
function isPlanGeoTag(value: unknown): boolean {
	return value === RDF_GEO_TAG || value === `<p>${RDF_GEO_TAG}</p>`;
}

function carriesTag(item: RdfPlanItem): boolean {
	return typeof item.value === 'string' && containsDedaloTag(item.value);
}

/**
 * Why `items` may not be written as text: a value carrying Dédalo tag syntax
 * that is not the plan's own geo tag. Every other text is REMOTE (a label, a
 * definition from a third-party document), and a bracket tag in it would be
 * stored as a real tag — an index or reference naming any locator the document
 * chose. Null when every tag present is the geo tag.
 */
function tagRefusal(items: readonly RdfPlanItem[]): string | null {
	const foreign = items.some((item) => carriesTag(item) && !isPlanGeoTag(item.value));
	return foreign ? 'remote text carries Dédalo tag syntax — not written' : null;
}

/**
 * Whether the save is an APPEND merge. Not for a single-choice model (its
 * descriptor refuses append; reached only when it is empty), nor for the plan's
 * OWN geo tag (`[geo-n-1-1-data::data]`, the only tag that reaches the save —
 * tagRefusal): the text-paragraph merge refuses any tag — it cannot re-key one
 * — and would roll the whole IRI back. Both reach the save only for an EMPTY
 * slice (relationWritePlan / literalWritePlan, read inside this transaction), so
 * a plain `set_data` of that slice replaces nothing.
 */
function appendsInto(model: string, items: readonly RdfPlanItem[]): boolean {
	if (typeof getImportAppendPolicy(model) === 'object') return false;
	return !items.some((item) => isPlanGeoTag(item.value));
}

/**
 * The run's dd800 id, minting it now when this is the run's first write or
 * create — inside the op's savepoint (createBulkProcessRecord joins the IRI's
 * transaction), registered live right away.
 */
async function bulkId(run: IriRun): Promise<number> {
	const bulk = run.bulk;
	if (bulk.id !== null) return bulk.id;
	const minted = await createBulkProcessRecord(bulk.caller.section_tipo, bulk.userId, {
		bulkLabel: bulk.label,
		sourceFile: bulk.sourceFile,
	});
	bulk.enter(minted);
	bulk.id = minted;
	return minted;
}

/** A rollback removed the dd800 minted since `before` (null): forget it. */
function forgetMint(bulk: LazyBulk, before: number | null): void {
	if (before !== null || bulk.id === null) return;
	bulk.leave(bulk.id);
	bulk.id = null;
}

/**
 * The save itself, as an APPEND (never a replace) unless the model refuses
 * append — then a plain replace, reached only for an empty component. A refused
 * save (`ok:false`, a refusal the save door could not name) is THROWN as
 * `record.save_failed` — an INTERNAL fault: the whole IRI rolls back. A typed
 * refusal the save throws (`relation.insert_refused`, `perm.denied` …) rolls
 * back only the op's savepoint (see {@link applyIsolated}). Answers how many
 * items the append found already stored.
 */
async function saveItems(
	run: IriRun,
	record: BoundRecord,
	componentTipo: string,
	lang: string,
	items: RdfPlanItem[],
	model: string,
): Promise<number> {
	const append = appendsInto(model, items);
	const outcome = await saveComponentData({
		componentTipo,
		sectionTipo: record.section_tipo,
		sectionId: record.section_id,
		lang,
		changedData: [{ action: 'set_data', id: null, value: items }],
		userId: run.principal.userId,
		principal: run.principal,
		bulkProcessId: await bulkId(run),
		...(append ? { appendImport: true as const } : {}),
	});
	if (outcome.ok === false) {
		throw new DedaloError('record.save_failed', {
			message: `tool_import_rdf: ${record.section_tipo}/${record.section_id} ${componentTipo} refused: ${outcome.message}`,
			coordinates: { section_tipo: record.section_tipo, tipo: componentTipo },
		});
	}
	return outcome.appendSkipped ?? 0;
}

/** Write `items` into one component of one record, never overwriting; report what happened. */
async function writeItems(
	run: IriRun,
	record: BoundRecord,
	componentTipo: string,
	lang: string,
	items: readonly RdfPlanItem[],
): Promise<void> {
	const model = await getModelByTipo(componentTipo);
	const unwritable =
		componentRefusal(model, lang) ??
		tagRefusal(items) ??
		(await writeRefusal(run.principal, record, componentTipo));
	if (unwritable !== null) return skip(run, componentTipo, unwritable, record);
	const plan = await writePlanFor(record, componentTipo, model as string, lang, [...items]);
	if (plan.reason !== null) return skip(run, componentTipo, plan.reason, record);
	const duplicates = await saveItems(run, record, componentTipo, lang, plan.items, model as string);
	if (duplicates >= plan.items.length) return skip(run, componentTipo, 'already present', record);
	run.report.written.push({
		section_tipo: record.section_tipo,
		section_id: record.section_id,
		component_tipo: componentTipo,
		lang,
		value_summary: valueSummary(plan.items),
	});
}

// ---------------------------------------------------------------------------
// Records: create, find, find through a ddo_map path
// ---------------------------------------------------------------------------

/** Create a record of `sectionTipo` with the run's birth marker, bind it, report it. */
async function bornRecord(
	run: IriRun,
	sectionTipo: string,
	key: string,
	label: string,
): Promise<BoundRecord> {
	const sectionId = await createSectionRecord(
		sectionTipo,
		run.principal.userId,
		new Date(),
		undefined,
		{ bulkProcessId: await bulkId(run) },
	);
	const record: BoundRecord = { section_tipo: sectionTipo, section_id: sectionId, born: true };
	run.refs.set(keyName(key), record);
	run.report.created.push({ section_tipo: sectionTipo, section_id: sectionId, label });
	return record;
}

/** The term fields the lookup reads. */
export type TermLookupOp = Pick<
	RdfFindOrCreateOp,
	'section_tipo' | 'match_component_tipo' | 'match_value' | 'match_equivalents'
>;

/**
 * How many EQUIVALENT identifiers one search carries (an `$or` of that many
 * leaves). A term naming more is searched in several such searches, ALL of them
 * — it bounds the statement, never the answer: searching only a prefix could
 * miss a second record (a false single match) or the only one (a false "none",
 * a duplicate created). The walk stops once two records are found (a conflict
 * already). 32: a live Nomisma term names 7 (`ar`), a place or mint rarely more
 * than a dozen — one search.
 */
export const RDF_EQUIVALENTS_PER_SEARCH = 32;

/**
 * What the lookup found for a term: no record, the record holding its OWN
 * identifier, the ONE record holding one of its equivalents (the source
 * identifier is then appended to it), or a conflict (the refusal sentence,
 * naming the candidates).
 */
export type TermMatch =
	| { readonly kind: 'none' }
	| { readonly kind: 'own' | 'equivalent'; readonly section_id: number }
	| { readonly kind: 'conflict'; readonly reason: string };

const NO_MATCH: TermMatch = Object.freeze({ kind: 'none' });

/**
 * A code lookup ACROSS PROJECTS (v6 `get_resource_match`'s
 * `skip_projects_filter`): a term another project holds is the same authority,
 * so it is LINKED, never created again — a copy would also make every later
 * lookup ambiguous. The lookup's `resource.conflict` (a code two records share,
 * a full candidate window) is answered as its refusal sentence.
 */
async function acrossProjects<T>(
	op: TermLookupOp,
	lookup: (target: ImportCodeTarget, options: CodeLookupOptions) => Promise<T>,
): Promise<T | string> {
	try {
		return await lookup(
			{ sectionTipo: op.section_tipo, componentTipo: op.match_component_tipo },
			{ skipProjectsFilter: true },
		);
	} catch (error) {
		if (isDedaloError(error) && error.code === 'resource.conflict') return error.message;
		throw error;
	}
}

/**
 * The same web address under the other http scheme (`http://x` ↔ `https://x`);
 * anything else is returned as it is. One resource for the run's fetch
 * (rdf_import_run.ts `subjectOf`) and for the equivalents' lookup.
 */
export function schemeTwin(iri: string): string {
	if (iri.startsWith('https://')) return `http://${iri.slice('https://'.length)}`;
	if (iri.startsWith('http://')) return `https://${iri.slice('http://'.length)}`;
	return iri;
}

/**
 * The term's equivalents worth a search: its `match_equivalents` and the
 * http/https TWIN of each and of its own identifier (one authority publishes
 * both: Getty, Wikidata, Nomisma), trimmed, not blank, not its own, distinct
 * (ALL of them). Each is still compared byte for byte; a trailing slash or any
 * other spelling is another identifier.
 */
function equivalentValues(op: TermLookupOp): string[] {
	const own = op.match_value.trim();
	const given = [own, ...(op.match_equivalents ?? []).map((value) => value.trim())];
	const values = given.flatMap((value) => [value, schemeTwin(value)]);
	return [...new Set(values.filter((value) => value !== '' && value !== own))];
}

async function ownMatch(op: TermLookupOp, principal: Principal): Promise<TermMatch | null> {
	const found = await acrossProjects(op, (target, options) =>
		findSectionIdByCode(target, op.match_value, principal, options),
	);
	if (found === null) return null;
	return typeof found === 'string'
		? { kind: 'conflict', reason: found }
		: { kind: 'own', section_id: found };
}

/**
 * The records the equivalents name: one is the term, several name none of
 * them. EVERY equivalent is searched, {@link RDF_EQUIVALENTS_PER_SEARCH} per
 * search, until two records are found.
 */
async function equivalentMatch(op: TermLookupOp, principal: Principal): Promise<TermMatch> {
	const values = equivalentValues(op);
	const ids = new Set<number>();
	for (let start = 0; start < values.length && ids.size < 2; start += RDF_EQUIVALENTS_PER_SEARCH) {
		const chunk = values.slice(start, start + RDF_EQUIVALENTS_PER_SEARCH);
		const found = await acrossProjects(op, (target, options) =>
			findSectionIdsByCodes(target, chunk, principal, options),
		);
		if (typeof found === 'string') return { kind: 'conflict', reason: found };
		for (const id of found) ids.add(id);
	}
	return matchOfRecords(op, ids);
}

/** No record (none), ONE (the term), or several (a conflict naming them). */
function matchOfRecords(op: TermLookupOp, ids: ReadonlySet<number>): TermMatch {
	if (ids.size === 0) return NO_MATCH;
	const [first] = ids;
	if (ids.size === 1) return { kind: 'equivalent', section_id: first as number };
	const reason =
		`The linked term '${op.match_value.trim()}' is held by no record of section ${op.section_tipo}, ` +
		`but its equivalent identifiers are held by ${ids.size} different records (${[...ids].join(', ')}), ` +
		`so it names none of them. Not linked, not created — merge the duplicate records in ` +
		`${op.match_component_tipo} first.`;
	return { kind: 'conflict', reason };
}

/**
 * THE LOOKUP RULE of a linked term, one for the run (match first, fetch only
 * new) and the executor (find before create): its own identifier first; when no
 * record holds it, its EQUIVALENTS (`match_equivalents`, the decision of
 * 2026-10-02) — exactly one record holding any of them is the term, more than
 * one is a conflict. Every search is the code lookup's, principal-scoped and
 * across projects ({@link acrossProjects}): one for the own identifier, then one
 * per {@link RDF_EQUIVALENTS_PER_SEARCH} equivalents — all of them, never a
 * prefix answer.
 */
export async function matchTerm(op: TermLookupOp, principal: Principal): Promise<TermMatch> {
	return (await ownMatch(op, principal)) ?? equivalentMatch(op, principal);
}

/**
 * The record of `op.section_tipo` that IS the term ({@link matchTerm}): its id,
 * null when none is, or a STRING (the refusal sentence) when the identifiers
 * name more than one record. Exported for the action, which looks a linked term
 * up BEFORE deciding to fetch it (the 2026-10-01 decision: match first, fetch
 * only new terms) — and again, by its equivalents, once it was fetched.
 */
export async function findTermRecord(
	op: TermLookupOp,
	principal: Principal,
): Promise<number | null | string> {
	const match = await matchTerm(op, principal);
	if (match.kind === 'conflict') return match.reason;
	return match.kind === 'none' ? null : match.section_id;
}

/**
 * Why `op`'s identifier can never name a record, or null: a blank one (it could
 * never be found again), or a non-web IRI in an IRI component (never stored —
 * see iriWritePlan — so a record born for it would be born without it).
 */
async function identifierRefusal(op: RdfFindOrCreateOp): Promise<string | null> {
	const value = op.match_value.trim();
	if (value === '') return 'no identifier — not matched, not created';
	const model = await getModelByTipo(op.match_component_tipo);
	return model === 'component_iri' && !isWebIri(value) ? UNSUPPORTED_IRI : null;
}

async function findOrCreate(run: IriRun, op: RdfFindOrCreateOp): Promise<void> {
	if (run.refs.has(keyName(op.key))) return; // one resource reached twice in one graph: bound once
	const unusable = await identifierRefusal(op);
	if (unusable !== null) return skip(run, op.match_component_tipo, unusable);
	const match = await termMatch(run, op);
	if (match.kind === 'none') return createTerm(run, op);
	return bindMatch(run, op, match);
}

/**
 * The lookup rule ({@link matchTerm}), then — when no record answers — the
 * terms THIS IRI created ({@link bornMatch}): a record born a few ops earlier
 * does not hold its equivalents yet (the ops writing them come after every term
 * the plan names), so without this two linked terms sharing one would both be
 * created, and every later lookup by it would be a conflict.
 */
async function termMatch(run: IriRun, op: RdfFindOrCreateOp): Promise<TermMatch> {
	const match = await matchTerm(op, run.principal);
	return match.kind === 'none' ? bornMatch(run, op) : match;
}

/** The term's own identifier and its equivalents, as {@link BoundRecord.identity} keeps them. */
function identityOf(op: TermLookupOp): string[] {
	return [op.match_value.trim(), ...equivalentValues(op)];
}

/** The records THIS IRI created whose identity shares one of `op`'s identifiers. */
function bornMatch(run: IriRun, op: RdfFindOrCreateOp): TermMatch {
	const wanted = new Set(identityOf(op));
	const ids = new Set<number>();
	for (const record of run.refs.values()) {
		const identity = record.identity;
		if (identity?.component_tipo !== op.match_component_tipo) continue;
		if (record.section_tipo !== op.section_tipo) continue;
		if (identity.values.some((value) => wanted.has(value))) ids.add(record.section_id);
	}
	return matchOfRecords(op, ids);
}

/**
 * Bind the record the lookup found (`born:false`: any write into it passes the
 * importer's record scope). Found by an EQUIVALENT, it is given the term's own
 * identifier (`match_item`, appended — never an overwrite, deduped), so the next
 * run finds it directly, with no fetch; the term's other equivalents it lacks are
 * NOT added (the decision of 2026-10-02 asks for the source identifier only). A
 * refused append is a skip; the link still stands.
 */
async function bindMatch(
	run: IriRun,
	op: RdfFindOrCreateOp,
	match: Exclude<TermMatch, { kind: 'none' }>,
): Promise<void> {
	if (match.kind === 'conflict') return skip(run, op.match_component_tipo, match.reason);
	const record: BoundRecord = {
		section_tipo: op.section_tipo,
		section_id: match.section_id,
		born: false,
	};
	if (match.kind === 'equivalent') record.byEquivalent = true;
	run.refs.set(keyName(op.key), record);
	if (match.kind === 'equivalent') {
		await writeItems(run, record, op.match_component_tipo, op.match_lang, [op.match_item]);
	}
}

/** No record is the term: create it, with the identifier that finds it again (atomic). */
async function createTerm(run: IriRun, op: RdfFindOrCreateOp): Promise<void> {
	const refused = await createRefusal(run.principal, op.section_tipo, op.match_component_tipo);
	if (refused !== null) return skip(run, op.match_component_tipo, refused);
	const born = await bornRecord(run, op.section_tipo, op.key, op.match_value);
	const identity = { component_tipo: op.match_component_tipo, values: identityOf(op) };
	const record: BoundRecord = { ...born, identity };
	run.refs.set(keyName(op.key), record);
	await writeIdentity(run, () =>
		writeItems(run, record, op.match_component_tipo, op.match_lang, [op.match_item]),
	);
}

/**
 * Run the write that makes a BORN record findable again — a term's identifier,
 * the op that completes an intermediate's path. A born record left WITHOUT it
 * (the write skipped, not thrown: a component grant, remote text carrying tag
 * syntax, an undeclared language) could never be found again, and every run
 * would add another. So a skip here is THROWN as a refusal
 * (`tool.rdf_identifier_unwritable`, the skip sentence as its reason): the op's
 * savepoint takes the record, its link and the ops that waited for it back.
 */
async function writeIdentity(run: IriRun, write: () => Promise<void>): Promise<void> {
	const before = run.report.written.length;
	await write();
	if (run.report.written.length > before) return;
	throw unidentifiable(run.report.skipped.at(-1)?.reason ?? 'not written');
}

/** The refusal of a born record left without what finds it again (`reason`: the skip sentence). */
function unidentifiable(reason: string): DedaloError {
	return new DedaloError('tool.rdf_identifier_unwritable', {
		message: `tool_import_rdf: a born record cannot hold its identifier: ${reason}`,
		details: { reason },
	});
}

/**
 * Does one of `items` (of a component of `model`) hold the identifier `wanted`?
 * Compared as the code lookup compares: the trimmed text of the item's value or
 * IRI, an HTML component's on its paragraph text.
 */
function holdsIdentifier(model: string, items: readonly unknown[], wanted: string): boolean {
	const html = getComponentModel(model)?.render === 'html';
	return items.some((item) => itemAsText(item, html) === wanted);
}

/**
 * Does the ddo_map path from `step` on `record` lead to `wanted`? A step whose
 * component has a child step in `remaining` is a relation hop (follow its
 * locators into the child's section); a step with none is the LEAF, which holds
 * the identifier (compared as the code lookup compares: trimmed bytes of the
 * item's value or IRI). Each step is consumed once, so a path can never loop.
 */
async function pathLeadsTo(
	record: { section_tipo: string; section_id: number },
	step: RdfDdoStep,
	remaining: readonly RdfDdoStep[],
	wanted: string,
): Promise<boolean> {
	const model = await getModelByTipo(step.component_tipo);
	if (model === null) return false;
	const items = await storedItems(record, step.component_tipo, model);
	const child = remaining.find((candidate) => candidate.parent === step.component_tipo);
	if (child === undefined) return holdsIdentifier(model, items, wanted);
	const rest = remaining.filter((candidate) => candidate !== child);
	for (const target of linkedIn(items, child.section_tipo)) {
		if (await pathLeadsTo(target, child, rest, wanted)) return true;
	}
	return false;
}

/** The record addresses of the locators among `items` that point into `sectionTipo`. */
function linkedIn(
	items: readonly unknown[],
	sectionTipo: string,
): { section_tipo: string; section_id: number }[] {
	return items
		.filter((item) => (item as { section_tipo?: unknown }).section_tipo === sectionTipo)
		.map((item) => ({
			section_tipo: sectionTipo,
			section_id: Number((item as { section_id?: unknown }).section_id),
		}));
}

/** The intermediate record `from` already links to whose path holds the identifier, or null. */
async function linkedIntermediate(
	from: BoundRecord,
	op: RdfIntermediateOp,
): Promise<number | null> {
	const model = await getModelByTipo(op.component_tipo);
	const next = op.path.find((step) => step.parent === op.component_tipo);
	if (model === null || next === undefined) return null;
	const linked = linkedIn(await storedItems(from, op.component_tipo, model), next.section_tipo);
	const rest = op.path.filter((step) => step !== next);
	for (const candidate of linked) {
		if (await pathLeadsTo(candidate, next, rest, op.match_value.trim())) {
			return candidate.section_id;
		}
	}
	return null;
}

/** The refusal of creating `op`'s record and linking it from `from`, or null. */
async function intermediateRefusal(
	run: IriRun,
	from: BoundRecord,
	op: RdfIntermediateOp,
): Promise<string | null> {
	return (
		(await writeRefusal(run.principal, from, op.component_tipo)) ??
		(await createRefusal(run.principal, op.intermediate_section_tipo, null))
	);
}

/** Is `key` already bound, or waiting for its path? (one resource reached twice: once). */
function isKnownKey(run: IriRun, key: string): boolean {
	return run.refs.has(keyName(key)) || run.pending.has(keyName(key));
}

/**
 * The record BETWEEN the target and a resource (creators → person → URI): the
 * one the target already links to whose path leads to the resource is bound.
 * Otherwise a new one is due — when the target's link to it is writable and its
 * section creatable (an unlinked intermediate would be an orphan no later run
 * could find) — but it is NOT created here: it waits, PENDING, for the op that
 * completes its path (the link to the resource's record, or the identifier
 * itself). Created before, an intermediate whose resource is then not bound (an
 * ambiguous or refused find, a skipped term) would commit EMPTY, linked from the
 * target; no later run could find it through its path, so every run would add
 * another. An intermediate under a pending one waits with it.
 */
async function applyIntermediate(run: IriRun, op: RdfIntermediateOp): Promise<void> {
	if (isKnownKey(run, op.key)) return;
	if (run.pending.has(refName(op.target))) {
		run.pending.set(keyName(op.key), { op, deferred: [] });
		return;
	}
	const from = writableTarget(run, op.target, op.component_tipo);
	if (from === null) return;
	const found = await linkedIntermediate(from, op);
	if (found !== null) {
		const record = { section_tipo: op.intermediate_section_tipo, section_id: found, born: false };
		run.refs.set(keyName(op.key), record);
		return;
	}
	const refused = await intermediateRefusal(run, from, op);
	if (refused !== null) return skip(run, op.component_tipo, refused, from);
	run.pending.set(keyName(op.key), { op, deferred: [] });
}

/**
 * Does `op` (on the pending intermediate) COMPLETE its path — write the
 * component its path continues through with what leads to its resource: the
 * identifier itself (a leaf), or a link to a record whose own path holds it?
 */
async function completesPath(
	run: IriRun,
	pending: RdfIntermediateOp,
	op: RdfSetOp | RdfLinkOp,
): Promise<boolean> {
	const step = pending.path.find((candidate) => candidate.parent === pending.component_tipo);
	if (step === undefined || op.component_tipo !== step.component_tipo) return false;
	const rest = pending.path.filter((candidate) => candidate !== step);
	return stepCompletes(run, step, rest, op, pending.match_value.trim());
}

async function stepCompletes(
	run: IriRun,
	step: RdfDdoStep,
	rest: readonly RdfDdoStep[],
	op: RdfSetOp | RdfLinkOp,
	wanted: string,
): Promise<boolean> {
	const child = rest.find((candidate) => candidate.parent === step.component_tipo);
	if (op.op === 'set') return child === undefined && (await setHolds(op, wanted));
	const to = run.refs.get(refName(op.to));
	if (child === undefined || to?.section_tipo !== child.section_tipo) return false;
	return pathLeadsTo(
		to,
		child,
		rest.filter((candidate) => candidate !== child),
		wanted,
	);
}

async function setHolds(op: RdfSetOp, wanted: string): Promise<boolean> {
	const model = await getModelByTipo(op.component_tipo);
	return model !== null && holdsIdentifier(model, op.value, wanted);
}

/**
 * An op on a PENDING intermediate: it waits — or, when it completes the path,
 * the intermediate is created first (see {@link realize}). False: the op's
 * target is not pending, apply it as usual.
 */
async function throughPending(run: IriRun, op: RdfSetOp | RdfLinkOp): Promise<boolean> {
	const pending = run.pending.get(refName(op.target));
	if (pending === undefined) return false;
	if (!(await completesPath(run, pending.op, op))) {
		pending.deferred.push(op);
		return true;
	}
	// Realized (created and linked — or THROWN, see createIntermediate): the op is
	// what makes it findable again.
	await realize(run, pending);
	await writeIdentity(run, () => applyOp(run, op));
	return true;
}

/**
 * Create a pending intermediate — its pending ancestors first — link it from its
 * target, then apply the ops that waited for it, in order — EACH under its own
 * (nested) savepoint: a waiting op the engine refuses is a skip, never the end
 * of the intermediate (only the op that completes its path is atomic with it).
 * A create refused now THROWS (see {@link createIntermediate}).
 */
async function realize(run: IriRun, pending: PendingIntermediate): Promise<void> {
	const { op } = pending;
	run.pending.delete(keyName(op.key));
	const ancestor = run.pending.get(refName(op.target));
	if (ancestor !== undefined) await realize(run, ancestor);
	await createIntermediate(run, op);
	for (const waiting of pending.deferred) await applyIsolated(run, waiting);
}

/**
 * Create `op`'s record and link it from its target. A create REFUSED here — an
 * intermediate under a pending one is first asked now, when the completing op
 * realizes the chain — is THROWN as `tool.rdf_identifier_unwritable`, never
 * reported as a skip: the ancestors this realize already created (and linked
 * from the caller) could no longer reach their resource, so every run would add
 * another. The completing op's savepoint takes them all back.
 */
async function createIntermediate(run: IriRun, op: RdfIntermediateOp): Promise<void> {
	const from = run.refs.get(refName(op.target));
	if (from === undefined) throw unidentifiable(`record '${refKeyOf(op.target)}' not resolved`);
	const refused = await intermediateRefusal(run, from, op);
	if (refused !== null) throw unidentifiable(refused);
	const record = await bornRecord(run, op.intermediate_section_tipo, op.key, op.match_value);
	await writeItems(run, from, op.component_tipo, 'lg-nolan', [
		locatorTo(record, op.component_tipo),
	]);
}

/** The intermediates no op completed: never created, reported with what waited for them. */
function reportUnrealized(run: IriRun): void {
	for (const { op, deferred } of run.pending.values()) {
		const reason = `intermediate not created — no record of ${op.match_value} was linked`;
		skip(run, op.component_tipo, reason, run.refs.get(refName(op.target)));
		for (const waiting of deferred) {
			skip(run, waiting.component_tipo, `record '${op.key}' not created`);
		}
	}
}

// ---------------------------------------------------------------------------
// The other operations
// ---------------------------------------------------------------------------

/** Report an op whose record is not bound (a refused/ambiguous find, a skipped term). */
function skipUnbound(run: IriRun, componentTipo: string, ref: RecordRef): void {
	skip(run, componentTipo, `record '${refKeyOf(ref)}' not resolved`);
}

/** A ref as the report names it. */
function refKeyOf(ref: RecordRef): string {
	return ref.kind === 'caller' ? 'caller' : ref.key;
}

/**
 * The record `ref` names, to be written INTO — or null, reported: not bound, or
 * a term matched by an equivalent (it gains only its own identifier; the
 * fetched term's fields are withheld — the decision of 2026-10-02 asks for the
 * source identifier only, and holds it however the match was reached: at the
 * run's lookup, or only here, when an earlier IRI or op created the record).
 */
function writableTarget(run: IriRun, ref: RecordRef, componentTipo: string): BoundRecord | null {
	const record = run.refs.get(refName(ref));
	if (record === undefined) {
		skipUnbound(run, componentTipo, ref);
		return null;
	}
	if (record.byEquivalent === true) {
		skip(run, componentTipo, RDF_EQUIVALENT_WITHHELD, record);
		return null;
	}
	return record;
}

async function applySet(run: IriRun, op: RdfSetOp): Promise<void> {
	if (await throughPending(run, op)) return;
	const record = writableTarget(run, op.target, op.component_tipo);
	if (record === null) return;
	await writeItems(run, record, op.component_tipo, op.lang, op.value);
}

async function applyLink(run: IriRun, op: RdfLinkOp): Promise<void> {
	if (await throughPending(run, op)) return;
	const from = writableTarget(run, op.target, op.component_tipo);
	if (from === null) return;
	const to = run.refs.get(refName(op.to));
	if (to === undefined) return skipUnbound(run, op.component_tipo, op.to);
	await writeItems(run, from, op.component_tipo, 'lg-nolan', [locatorTo(to, op.component_tipo)]);
}

/** A predicate the plan could map but not write: reported, never silent. */
function applySkip(run: IriRun, op: RdfSkipOp): void {
	skip(run, op.component_tipo ?? '', `${op.reason} (${op.rdf_predicate})`);
}

async function applyOp(run: IriRun, op: RdfImportOp): Promise<void> {
	switch (op.op) {
		case 'find_or_create':
			return findOrCreate(run, op);
		case 'intermediate':
			return applyIntermediate(run, op);
		case 'set':
			return applySet(run, op);
		case 'link':
			return applyLink(run, op);
		case 'skip':
			return applySkip(run, op);
	}
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function emptyIriReport(iri: string): RdfIriReport {
	return { iri, written: [], created: [], skipped: [], error: null };
}

// ---------------------------------------------------------------------------
// Per-op isolation: a refused op rolls back ALONE
// ---------------------------------------------------------------------------

/**
 * A refusal of the CALLER, PERMISSION or CONFLICT category (the registry's,
 * never a code list kept here): the op asked for something the engine
 * declines — a link off its component's targets, a write the door refuses, a
 * value the save rejects, an identifier two records share. It rolls back to the
 * op's savepoint and becomes a skip. Anything else — internal.*, a database
 * fault that is not a refusal, an untyped throw — is a FAULT: it aborts the IRI.
 */
function isOpRefusal(error: unknown): error is DedaloError {
	if (!isDedaloError(error)) return false;
	const { category } = spec(error);
	return category === 'caller' || category === 'permission' || category === 'conflict';
}

/** The refusal as the report tells it: the registry's message and its public details. */
function refusalReason(error: DedaloError): string {
	const keys = spec(error).details_keys ?? [];
	const details = keys
		.map((key) => error.details?.[key])
		.filter((value) => value !== undefined && value !== null && value !== '');
	const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
	return `refused: ${spec(error).message}${suffix}`;
}

/** The keys an op names: what it emits, the record it writes, the record it links. */
function namedKeys(op: RdfImportOp): string[] {
	const refs: RecordRef[] =
		op.op === 'link' ? [op.target, op.to] : 'target' in op ? [op.target] : [];
	const keys = refs.flatMap((ref) => (ref.kind === 'found_or_created' ? [ref.key] : []));
	return op.op === 'find_or_create' || op.op === 'intermediate' ? [op.key, ...keys] : keys;
}

/** The component an op addresses (a term's: its identifier). */
function opComponent(op: RdfImportOp): string {
	return op.op === 'find_or_create' ? op.match_component_tipo : (op.component_tipo ?? '');
}

/** What an op may change of the run, taken before its savepoint. */
interface OpSnapshot {
	refs: Map<string, BoundRecord>;
	pending: Map<string, PendingIntermediate>;
	lengths: [number, number, number];
	bulk: number | null;
}

function snapshotOf(run: IriRun): OpSnapshot {
	const pending = new Map<string, PendingIntermediate>();
	for (const [key, entry] of run.pending)
		pending.set(key, { op: entry.op, deferred: [...entry.deferred] });
	const { written, created, skipped } = run.report;
	return {
		refs: new Map(run.refs),
		pending,
		lengths: [written.length, created.length, skipped.length],
		bulk: run.bulk.id,
	};
}

/** The run as it was before the op whose savepoint was just rolled back. */
function restore(run: IriRun, snapshot: OpSnapshot): void {
	run.refs = snapshot.refs;
	run.pending = snapshot.pending;
	const [written, created, skipped] = snapshot.lengths;
	run.report.written.length = written;
	run.report.created.length = created;
	run.report.skipped.length = skipped;
	forgetMint(run.bulk, snapshot.bulk);
}

/**
 * The records a refused op leaves unbound: the one it emits, and the PENDING
 * intermediate it was completing (realized in its savepoint, gone with it) —
 * whose waiting ops are skipped now, as depending on it.
 */
function markFailed(run: IriRun, op: RdfImportOp, code: string): void {
	if (op.op === 'find_or_create' || op.op === 'intermediate') run.failed.set(op.key, code);
	for (const key of namedKeys(op)) failPending(run, key, code);
}

function failPending(run: IriRun, key: string, code: string): void {
	const pending = run.pending.get(keyName(key));
	if (pending === undefined) return;
	run.failed.set(key, code);
	run.pending.delete(keyName(key));
	for (const waiting of pending.deferred) {
		skip(run, waiting.component_tipo, dependsOn(key), undefined, code);
	}
}

/** An op naming a failed record: skipped with its code — and a record it emits fails too. */
function skipDependent(run: IriRun, op: RdfImportOp, blocked: string): void {
	const code = run.failed.get(blocked) as string;
	if (op.op === 'find_or_create' || op.op === 'intermediate') run.failed.set(op.key, code);
	skip(run, opComponent(op), dependsOn(blocked), undefined, code);
}

/**
 * Apply ONE op under its own SAVEPOINT. An op that names a record whose op was
 * refused is skipped ('depends on <key>, which failed') — and, when it emits a
 * record itself, that one fails with it. A refusal ({@link isOpRefusal}) rolls
 * the op back — the rows, the run's bindings, its report lines, a dd800 it
 * minted — and is reported as a skip with its code; a fault propagates and
 * aborts the IRI. The groups that must stay atomic are ONE op here: a
 * find_or_create with its identifier write, a pending intermediate with the op
 * that completes its path and the ops that waited for it ({@link writeIdentity}
 * makes a skipped completing write a refusal too).
 */
async function applyIsolated(run: IriRun, op: RdfImportOp): Promise<void> {
	const blocked = namedKeys(op).find((key) => run.failed.has(key));
	if (blocked !== undefined) return skipDependent(run, op, blocked);
	const snapshot = snapshotOf(run);
	try {
		await withSavepoint(() => applyOp(run, op));
	} catch (error) {
		if (!isOpRefusal(error)) throw error;
		restore(run, snapshot);
		markFailed(run, op, error.code);
		skip(run, opComponent(op), refusalReason(error), undefined, error.code);
	}
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * The IRI's ops, in ONE transaction, each under its own savepoint
 * ({@link applyIsolated}): a refused op is a skip, the rest commits. The target
 * check runs first, outside the transaction (rdf_import_prune.ts): a link the
 * ontology maps off target is skipped before anything is found or created. A
 * FAULT rolls the whole IRI back and is reported.
 */
async function runIri(
	plan: RdfImportPlan,
	caller: RdfCallerLocator,
	principal: Principal,
	bulk: LazyBulk,
): Promise<RdfIriReport> {
	const report = emptyIriReport(plan.subject);
	const onTarget = await pruneOffTarget(plan.ops, caller.section_tipo);
	report.skipped.push(...onTarget.skipped);
	const callerRecord: BoundRecord = { ...caller, born: false };
	const refs = new Map<string, BoundRecord>([[refName({ kind: 'caller' }), callerRecord]]);
	const run: IriRun = { principal, bulk, refs, pending: new Map(), failed: new Map(), report };
	const mintedBefore = bulk.id;
	try {
		await withTransaction(async () => {
			for (const op of onTarget.ops) await applyIsolated(run, op);
			reportUnrealized(run);
		});
	} catch (error) {
		// Nothing of the IRI happened: what it wrote, created or found already
		// present was inside the rolled-back transaction — a dd800 it minted too.
		// The error says why.
		forgetMint(bulk, mintedBefore);
		report.written = [];
		report.created = [];
		report.skipped = [];
		report.error = error instanceof Error ? error.message : String(error);
		report.failure = error;
	}
	return report;
}

function flatten(bulkProcessId: number | null, iris: RdfIriReport[]): RdfImportReport {
	return {
		bulk_process_id: bulkProcessId,
		written: iris.flatMap((iri) => iri.written),
		created: iris.flatMap((iri) => iri.created),
		skipped: iris.flatMap((iri) => iri.skipped),
		iris,
	};
}

/**
 * Apply every IRI's plan for the caller record, as `principal`: one
 * transaction per IRI, one savepoint per op, and ONE dd800 bulk process for the
 * run — minted by its first write or create, never before (a run that changes
 * nothing leaves no bulk record; `bulk_process_id` is then null).
 */
export async function executeRdfImport(request: RdfImportRequest): Promise<RdfImportReport> {
	const { caller, plans, principal } = request;
	if (plans.every((plan) => plan.ops.length === 0)) {
		return flatten(
			null,
			plans.map((plan) => emptyIriReport(plan.subject)),
		);
	}
	const iris: RdfIriReport[] = [];
	return withLazyLiveBulkRun(async ({ enter, leave }) => {
		const bulk: LazyBulk = {
			id: null,
			caller,
			userId: principal.userId,
			label: request.bulkLabel ?? `RDF import into ${caller.section_tipo}/${caller.section_id}`,
			sourceFile: request.sourceFile,
			enter,
			leave,
		};
		for (const plan of plans) iris.push(await runIri(plan, caller, principal, bulk));
		return flatten(bulk.id, iris);
	});
}
