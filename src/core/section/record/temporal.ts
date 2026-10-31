/**
 * TEMPORAL instances — a tool's throwaway editable clone (WC-059).
 *
 * THE INVARIANT: a temporal instance ADDRESSES NO RECORD. The `section_id` it
 * carries is a client-side sentinel (1), not an address, and every door must
 * treat it as such: the save resolves and echoes, it never persists; the read
 * resolves CONTEXT with an empty value, it never reads the record.
 *
 * WHY THIS FILE EXISTS. The client has shipped `source.is_temporal` since PHP
 * commit 5c45c71ebb (2026-01-31), where it selected `matrix_temp_manager` — a
 * `(section_tipo, user)`-keyed row in the unlogged `temp` table — so writes went
 * to a scratch store. The TS rewrite carried the five client call sites over and
 * did NOT port the store; `rqoSourceSchema` is `.passthrough()`, so the flag rode
 * along unread and `saveComponentData({sectionId: Number(source.section_id)})`
 * wrote the sentinel straight onto the REAL record 1 of the target section —
 * value replaced, Time Machine row appended, modified-stamp falsified, and for
 * relations an orphan target record created. Un-ledgered until 2026-07-28.
 *
 * WHY `saveComponentData` IS NOT MADE POLYMORPHIC. Teaching the persisted engine
 * a second store would refactor the most load-bearing write path in the codebase
 * (row lock, counter, relation index, TM) to serve a write that must not happen
 * at all. That still holds — the scratch store is a SEPARATE module over a
 * SEPARATE table, and this door still reaches no matrix write engine.
 *
 * (!) THE STORAGE HALF OF WC-059 IS SUPERSEDED BY WC-079 (2026-07-30). The old
 * text argued "nothing ever reads the value back out of it". True of the
 * propagate tool, which sends `component_to_propagate.data.entries` straight from
 * client memory — but FALSE of service_tmp_section, whose children autoload
 * (`element_instance.build(true)`), so every render re-read through this door,
 * got `entries: []`, and silently wiped the "Values" form the operator had filled
 * in: tool_import_files lost the metadata for a whole import batch on any reload.
 *
 * So a TS-native scratch store now exists — `./temporal_store.ts`, which owns its
 * own table and is the only module allowed to name it (sql_confinement T4). What
 * did NOT change is the invariant: a temporal instance still addresses no record,
 * and nothing here writes to matrix record 1, its Time Machine or its activity
 * rows.
 *
 * The store is OPT-IN and keyed by (user_id, scope, section_tipo, tipo, lang).
 * Opt-in because only service_tmp_section wants persistence: the propagate tool
 * seeds its clone from the OPEN record and then bulk-writes across a whole search
 * result set, and the two component_text_area pickers are transient — a restored
 * value in either would be a stale locator stamped into a tag, or a stale payload
 * propagated over real records. The opt-in rides `source.temporal_scope`, NOT
 * `is_temporal`: that flag means "addresses no record" and has exactly ONE reader
 * by tripwire, so giving it a second meaning is the very mistake WC-059 was.
 * `scope` also repairs PHP's key, which was per (section_tipo, user) and so
 * collided whenever two tools were open on the same section.
 *
 * The producers (all client-side, frozen by the tripwire's allowlist):
 *   tools/tool_propagate_component_data/js/tool_propagate_component_data.js
 *   client/dedalo/core/services/service_tmp_section/js/service_tmp_section.js
 *   client/dedalo/core/component_text_area/js/render_draw.js
 *   client/dedalo/core/component_text_area/js/render_reference.js
 *   client/dedalo/core/section/js/view_graph_solved_section.js
 *
 * Gate: test/unit/temporal_instance_tripwire.test.ts.
 */

import type { ApiResult } from '../../api/response.ts';
import type { Rqo, RqoSource } from '../../concepts/rqo.ts';
import { isConsultationOnlySection } from '../../concepts/section.ts';
import { DedaloError, ok } from '../../errors/index.ts';
import {
	effectiveSaveLang,
	getColumnNameByModel,
	getModelByTipo,
	getTranslatableByTipo,
} from '../../ontology/resolver.ts';
import type { Principal } from '../../security/permissions.ts';
import { currentRequestId } from '../../security/request_context.ts';
import {
	currentChipsFromPayload,
	mergeRelationChips,
	resolveRelationEcho,
} from './resolve_echo.ts';
import {
	type ChangedDataItem,
	getIdFromKey,
	isLangSlicedModel,
	unnamedRemoveRefusal,
} from './save_component.ts';

/**
 * The record id the client stamps on a temporal instance (component_common.js
 * `section_id: 1`). Documented here so the sentinel has a name — it is NEVER
 * honored as an address; the doors branch on `is_temporal`, not on this value.
 */
export const TEMPORAL_SECTION_ID_SENTINEL = 1;

/** The actions a temporal instance may apply, in memory. */
const TEMPORAL_ACTIONS: ReadonlySet<string> = new Set([
	'set_data',
	'update',
	'insert',
	'remove',
	// The EXPLICIT wipe (save_component.ts `clear`, 2026-08-30): a temporal
	// instance must accept every shape the persisted engine accepts, or the same
	// user gesture answers on a saved record and is refused on a staged one.
	'clear',
	'add_new_element',
]);

/**
 * The PREDICATE lives in concepts/rqo.ts, beside the field declaration — this
 * module reaches back into section/read.ts (via ./resolve_echo.ts), and read.ts
 * needs the predicate too, so defining it here would close a static import cycle
 * (import_scc_tripwire). This module owns the BEHAVIOUR; rqo.ts owns the flag.
 */

/** Next in-memory item id (the engine's counter never runs — nothing persists). */
function nextItemId(items: unknown[]): number {
	return (
		(items as { id?: unknown }[]).reduce(
			(max, item) => Math.max(max, Number(item?.id ?? 0) || 0),
			0,
		) + 1
	);
}

/**
 * NORMALIZE a LITERAL temporal component's entries for the echo.
 *
 * (!) THE DELTA IS NOT RE-APPLIED, and that is the whole subtlety of this door.
 * The persisted engine seeds from the LOCKED MATRIX ROW and applies
 * `changed_data` to it (`save_component.ts` applySaveComponentData) — it
 * structurally cannot double-apply. A temporal instance has no row to seed from,
 * so the only base available is `data.entries` from the request — and the client
 * has ALREADY applied the delta to that: `component_common.prototype.change_value`
 * (:1272-1278) runs `update_data_value` for every changed_data item, mutating
 * `self.data.entries` in place, and only THEN calls `save(changed_data)`, which
 * ships `clone(self.data)` (:663-664). So `data.entries` is the POST-delta state.
 *
 * Re-applying it here would: fail every `remove` (the item is already gone, and
 * the engine's "unknown id" rule would 400 the user's deletion), duplicate every
 * `insert`, and append on every `update`. Only `set_data` — which replaces
 * wholesale — is idempotent, which is exactly why the first version of this door
 * looked correct against a set_data-only gate.
 *
 * What DOES still have to happen is the normalization the persisted path performs
 * on the way to storage, because the echo becomes the client's next `self.data`:
 * the lang stamp and the item-id mint. Without the id mint an id-less item stays
 * id-less, so the next `update` arrives with `id: null` and appends instead of
 * replacing — the array grows on every committed edit, and for
 * tool_propagate_component_data that array is what gets written across every
 * matched record.
 *
 * The relation branch needs no equivalent: `mergeRelationChips` is idempotent
 * under both orderings (its insert path dedups by locator, its remove path is a
 * filter), which is why the same payload shape is safe there.
 *
 * Returns a message instead of throwing so the door answers 400 with the reason.
 */
export function applyTemporalLiteralChanges(
	entries: unknown[],
	changedData: ChangedDataItem[],
	options: { langSliced: boolean; effectiveLang: string; translatable: boolean; lang: string },
): { ok: true; items: unknown[] } | { ok: false; message: string } {
	const { langSliced, effectiveLang, translatable, lang } = options;

	for (const change of changedData) {
		if (!TEMPORAL_ACTIONS.has(change.action)) {
			return {
				ok: false,
				message: `action '${change.action}' is not available on a temporal instance`,
			};
		}
		if (change.action === 'add_new_element') {
			return {
				ok: false,
				message: "action 'add_new_element' is only available on a relation component",
			};
		}
		if (change.action === 'insert' && (change.value === null || typeof change.value !== 'object')) {
			return { ok: false, message: 'insert value must be an object item' };
		}
	}

	// Objects only — PHP's set_data_lang accepts nothing else and drops the rest.
	const items = entries
		.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
		.map((item) => ({ ...item }));

	// Lang stamp: a sliced component FORCE-corrects every item's lang (PHP
	// set_data_lang clone-stamps the slice); a merely translatable one fills a
	// missing lang (PHP set_data's lang-orphan guard).
	for (const item of items) {
		if (langSliced) {
			item.lang = effectiveLang;
		} else if (translatable && item.lang === undefined) {
			item.lang = lang;
		}
	}

	// Item-id mint, mirroring the persisted allocator. A sliced component first
	// tries the SHARED id at the same position in the sibling languages (PHP
	// :4110-4126 get_id_from_key), so a first translation reuses its siblings' id
	// instead of orphaning itself behind a fresh one.
	items.forEach((item, index) => {
		if (item.id !== undefined && item.id !== null && item.id !== '') return;
		const shared = langSliced ? getIdFromKey(items, index, [effectiveLang]) : null;
		item.id = shared ?? nextItemId(items);
	});

	return { ok: true, items };
}

/**
 * Persist a temporal value to the scratch store — the ONE store name this module
 * knows (`temporal_instance_tripwire` pins that this door reaches no matrix write
 * engine; the scratch table is owned entirely by ./temporal_store.ts).
 *
 * NO-OP unless the source names a scope: that is the opt-in, and it is what keeps
 * the propagate tool and the component_text_area pickers persisting nothing.
 *
 * BEST EFFORT by contract. The user's edit is already applied and about to be
 * echoed; losing cross-reload persistence is a far smaller failure than losing
 * the edit, so a store error is logged and swallowed, never propagated.
 */
/**
 * The DURABLE base for a relation save, or null when there is no scratch row.
 *
 * The client can only ever ship the page it is holding, so for a persisted
 * temporal instance the store — not the payload — is the authoritative set the
 * delta applies to. Returns null (meaning "use the client's value, as before")
 * when the source did not opt in or nothing is stored yet.
 *
 * Read failures return null rather than throwing: falling back to the client's
 * page loses a page-boundary edit, which is bad, but failing the save loses the
 * edit outright, which is worse.
 */
async function readTemporalScratchBase(
	source: RqoSource,
	principal: Principal,
): Promise<Record<string, unknown>[] | null> {
	try {
		const { temporalScratchAddress, readTemporalScratch } = await import('./temporal_store.ts');
		const address = temporalScratchAddress(source);
		if (address === null) return null;
		const stored = await readTemporalScratch(principal.userId, address);
		return stored === null ? null : (stored as Record<string, unknown>[]);
	} catch (error) {
		console.warn('[temporal] scratch base read failed:', (error as Error).message);
		return null;
	}
}

async function persistTemporalScratch(
	source: RqoSource,
	principal: Principal,
	entries: readonly unknown[],
): Promise<void> {
	try {
		const { temporalScratchAddress, writeTemporalScratch } = await import('./temporal_store.ts');
		const address = temporalScratchAddress(source);
		if (address === null) return;
		await writeTemporalScratch(principal.userId, address, entries);
	} catch (error) {
		console.warn('[temporal] scratch persist failed:', (error as Error).message);
	}
}

/**
 * The echoed `data` array of a temporal relation save's ok() envelope, and the
 * entry in it that is the saved component itself (the "main" entry).
 */
function temporalEchoMainEntry(
	echo: ApiResult,
	componentTipo: string,
	sectionTipo: string,
): Record<string, unknown> | undefined {
	const echoed = ((echo.body as { data?: { data?: unknown[] } }).data?.data ?? []) as Record<
		string,
		unknown
	>[];
	return echoed.find((entry) => entry.tipo === componentTipo && entry.section_tipo === sectionTipo);
}

/**
 * Select-family AND filter-family components re-render from data.datalist
 * (e.g. component_radio_button get_checked_value_label reads it after a save;
 * view_default_edit_filter iterates it), and the persisted door attaches it —
 * so the temporal door must too, or the post-save render dereferences
 * undefined. It belongs on the RELATION branch, not the literal one, for every
 * relation-column member (all of SELECT_FAMILY_MODELS, plus component_filter /
 * _master): a datalist attach placed after the `column === 'relation'` return
 * could never run at all. The one LITERAL member — component_filter_records —
 * is attached in resolveTemporalSave's literal branch, the only arm it reaches
 * (see attachTemporalLiteralEchoDatalist).
 */
async function attachTemporalEchoDatalist(
	echo: ApiResult,
	args: {
		model: string;
		componentTipo: string;
		sectionTipo: string;
		/** The picked locators the echo hands back (the value; never the record). */
		picked: readonly unknown[];
	},
): Promise<void> {
	const { model, componentTipo, sectionTipo, picked } = args;
	const { echoesDatalist, getEchoDatalist } = await import('../../relations/datalist.ts');
	if (!(await echoesDatalist(model))) return;
	const { getNode } = await import('../../ontology/resolver.ts');
	const node = await getNode(componentTipo);
	const main = temporalEchoMainEntry(echo, componentTipo, sectionTipo);
	if (main !== undefined) {
		// The edit door, completed against the PICKED value (the raw locators
		// the echo answers with): select_lang's "<name> *" entry matches the read's.
		main.datalist = await getEchoDatalist(
			model,
			componentTipo,
			node?.properties ?? null,
			sectionTipo,
			picked,
		);
	}
}

/**
 * The LITERAL member of the filter family — component_filter_records — reaches
 * only the literal branch of resolveTemporalSave, so its echo datalist is
 * attached there (the relation-column members go through
 * attachTemporalEchoDatalist). The read door attaches it from the component's
 * emit hook; getEchoDatalist routes the user-scoped source, so echo == read.
 */
async function attachTemporalLiteralEchoDatalist(
	dataItem: unknown,
	args: {
		model: string;
		componentTipo: string;
		sectionTipo: string;
		items: readonly unknown[];
	},
): Promise<void> {
	const { model, componentTipo, sectionTipo, items } = args;
	const { FILTER_FAMILY_MODELS, getEchoDatalist } = await import('../../relations/datalist.ts');
	if (!FILTER_FAMILY_MODELS.has(model)) return;
	(dataItem as { datalist?: unknown }).datalist = await getEchoDatalist(
		model,
		componentTipo,
		null,
		sectionTipo,
		items,
	);
}

/**
 * WC-081: the persisted door stamps the same key — a temporal portal's add
 * button is the same button, and it must be able to open the same record.
 * The echo is an ok() envelope: the address rides INSIDE `data` (the payload),
 * exactly where dd_core_api.ts's persisted save puts it.
 */
function stampTemporalEchoCreatedSectionId(echo: ApiResult, createdSectionId: number | null): void {
	if (createdSectionId === null) return;
	const echoData = (echo.body as { ok?: boolean; data?: Record<string, unknown> }).data;
	if (echoData !== undefined && echoData !== null && typeof echoData === 'object') {
		echoData.created_section_id = createdSectionId;
	}
}

/**
 * The temporal SAVE door: normalize the client's value and echo it in the
 * canonical shape the client resolves by. No matrix read of the addressed
 * record, no write to it, no Time Machine row, no modified stamp, no activity row.
 *
 * AUTHORIZATION is the caller's: the door admits at a READ level (>= 1), because
 * nothing is persisted and the write grant is therefore not the question being
 * asked — the same reasoning as the search_<n> branch.
 *
 * (!) ONE EXCEPTION, and it is the only write anywhere under this door:
 * `add_new_element` really creates a record in the TARGET section (PHP's temp
 * store did too — the target is real, only the host anchor was scratch). The
 * save handler therefore admits that action at level >= 2, and the branch below
 * additionally refuses a consultation-only target. Any claim that this door
 * "never writes" must be read with that exception in mind.
 */
/**
 * ONE LAW, TWO DOORS: the in-memory door refuses exactly what the persisted door
 * refuses. Extracted 2026-08-30 to keep `resolveTemporalSave` under the complexity
 * ratchet; the predicate itself lives in save_component.ts so the two can never
 * drift apart.
 */
function assertTemporalRemoveNamesItem(
	changedData: ChangedDataItem[],
	componentTipo: string,
	sectionTipo: string,
): void {
	const refusal = unnamedRemoveRefusal(changedData);
	if (refusal === null) return;
	throw new DedaloError('record.remove_without_id', {
		message: `temporal save: ${refusal}`,
		publicMessage: refusal,
		coordinates: { tipo: componentTipo, section_tipo: sectionTipo },
	});
}

export async function resolveTemporalSave(rqo: Rqo, principal: Principal): Promise<ApiResult> {
	const source = rqo.source ?? {};
	const payload = (rqo.data ?? {}) as {
		changed_data?: ChangedDataItem[];
		entries?: unknown;
		value?: unknown;
	};
	const changedData = payload.changed_data ?? [];
	const componentTipo = source.tipo as string;
	const sectionTipo = source.section_tipo as string;
	const lang = source.lang ?? 'lg-nolan';

	const model = await getModelByTipo(componentTipo);
	if (model === null) {
		throw new DedaloError('request.invalid_tipo', { coordinates: { tipo: componentTipo } });
	}
	const column = getColumnNameByModel(model);

	for (const change of changedData) {
		if (!TEMPORAL_ACTIONS.has(change.action)) {
			throw new DedaloError('record.temporal_action_refused', {
				publicMessage: `action '${change.action}' is not available on a temporal instance`,
				coordinates: { action: change.action, tipo: componentTipo },
			});
		}
	}
	// THE REMOVE SENTINEL (DATA-06), one predicate for both doors: an id-less
	// remove is refused here too. It is not a no-op on this door — the client has
	// ALREADY applied the delta to the entries it ships, so a shape the persisted
	// engine refuses would be echoed back as a successful wipe, and on a durable
	// instance the wiped set is what the scratch row then stores.
	assertTemporalRemoveNamesItem(changedData, componentTipo, sectionTipo);

	// RELATION family: resolve the picked set into real chips and echo it. The
	// resolver is the same one the search_<n> door uses (./resolve_echo.ts) —
	// the client needs a labelled chip and a pagination.total, and only a real
	// resolution produces them.
	if (column === 'relation') {
		// THE BASE the delta is applied to. Ordinarily the client's own value —
		// but `payload.entries` is only the CURRENT PAGE of a portal (the read
		// paginates; the client's own link_record notes it can see just the loaded
		// page). Once the value is DURABLE that is a data-loss bug: staging 15
		// records then linking a 16th would ship a 10-item page, and the UPSERT
		// would replace the stored 15 with 11 — five staged relations gone, no
		// error, invisible until the import runs.
		//
		// So when a scratch row exists it is the authoritative base: seed from IT
		// and apply the delta. Behaviour is unchanged wherever no row exists,
		// which is every temporal instance that did not opt in (WC-079).
		const scratchBase = await readTemporalScratchBase(source, principal);
		let picked = mergeRelationChips(scratchBase ?? currentChipsFromPayload(payload), changedData);
		// Stable item ids on the durable set. `remove` matches by id, and after a
		// reload the client's ids come from what the graft emitted — so the stored
		// locators must carry the same ids the echo hands out (resolveRelationEcho
		// re-stamps 1..n positionally). Without this an unlink after a reload is a
		// silent server-side no-op: the row keeps a locator the operator deleted.
		picked = picked.map((locator, index) => ({ ...locator, id: index + 1 }));
		/** WC-081: the address of the record created below, echoed to the client. */
		let createdSectionId: number | null = null;
		for (const change of changedData) {
			if (change.action !== 'add_new_element') continue;
			// add_new_element genuinely creates a record — in the TARGET section,
			// never in the host. PHP's temp store behaved the same way: the target
			// is real, only the host anchor was scratch. The host-filter read is
			// SKIPPED (there is no host record to read), so the created record
			// inherits the default project locator.
			//
			// (!) This is the ONE action on this door that writes, so it carries the
			// gates the door's read-level entry check deliberately does not: the
			// caller was admitted at level >= 2 for it (see the save handler), and
			// the TARGET must be a real, writable section. Without the
			// consultation-only check the createSectionRecord engine THROWS on
			// dd542/dd15 — a 500 where a 400 is the honest answer.
			const targetSectionTipo = String(change.value ?? '');
			if (targetSectionTipo === '' || isConsultationOnlySection(targetSectionTipo)) {
				// The target is caller-supplied; it stays LOG-ONLY (echoing it back
				// would confirm which sections are consultation-only).
				throw new DedaloError('request.invalid_source', {
					message: `add_new_element: invalid target section '${targetSectionTipo}'`,
					coordinates: { target_section_tipo: targetSectionTipo },
				});
			}
			const { applyAddNewElement } = await import('../../relations/save.ts');
			const outcome = await applyAddNewElement(
				picked,
				targetSectionTipo,
				componentTipo,
				sectionTipo,
				Number(source.section_id ?? TEMPORAL_SECTION_ID_SENTINEL),
				{ skipHostFilterRead: true },
			);
			if (outcome === null) {
				throw new DedaloError('record.save_failed', {
					message: 'add_new_element failed',
					coordinates: { target_section_tipo: targetSectionTipo, tipo: componentTipo },
				});
			}
			picked = outcome.items as Record<string, unknown>[];
			createdSectionId = outcome.sectionId;
		}
		// TEMPORAL SCRATCH (WC-079). Persist the RAW picked locators, and do it
		// HERE — before resolveRelationEcho — precisely because what comes back
		// from that call are resolved CHIPS. A stored chip freezes a label the next
		// reader may want in another language, or may not be allowed to see at all;
		// the read path re-resolves from locators every time.
		await persistTemporalScratch(source, principal, picked);
		const echo = await resolveRelationEcho({
			rqo,
			principal,
			picked,
			mode: source.mode ?? 'edit',
		});
		await attachTemporalEchoDatalist(echo, { model, componentTipo, sectionTipo, picked });
		stampTemporalEchoCreatedSectionId(echo, createdSectionId);
		return echo;
	}

	// LITERAL family: apply in memory and echo.
	const translatable = await getTranslatableByTipo(componentTipo);
	const outcome = applyTemporalLiteralChanges(currentChipsFromPayload(payload), changedData, {
		langSliced: isLangSlicedModel(model),
		effectiveLang: await effectiveSaveLang(componentTipo, model, lang),
		translatable,
		lang,
	});
	if (!outcome.ok) {
		// The applier's own diagnostic is engine detail: it rides the log line, not
		// the wire (record.save_failed is operator-disclosure).
		throw new DedaloError('record.save_failed', {
			message: `save failed: ${outcome.message}`,
			coordinates: { tipo: componentTipo, section_tipo: sectionTipo },
		});
	}
	// TEMPORAL SCRATCH (WC-079). `outcome.items` is the normalized, lang-stamped,
	// id-minted array — the same value the client will hold as its next
	// `self.data.entries`, so a reload restores exactly what the widget had.
	await persistTemporalScratch(source, principal, outcome.items);

	const { buildDataItem } = await import('../../resolve/component_data.ts');
	const dataItem = buildDataItem(
		componentTipo,
		sectionTipo,
		source.section_id ?? null,
		source.mode ?? 'edit',
		lang,
		outcome.items,
	);
	// The one LITERAL filter-family member re-renders from data.datalist after a
	// save (view_default_edit_filter_records iterates it) — the read door
	// attaches it (the component's emit hook), so the echo must too. The
	// relation-column members are attached in attachTemporalEchoDatalist.
	await attachTemporalLiteralEchoDatalist(dataItem, {
		model,
		componentTipo,
		sectionTipo,
		items: outcome.items,
	});
	return {
		status: 200,
		body: ok({ context: [], data: [dataItem] }, { requestId: currentRequestId() }),
	};
}
