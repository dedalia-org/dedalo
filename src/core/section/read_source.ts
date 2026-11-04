/**
 * SectionReadSource — the pluggable row/record acquisition strategy for the
 * generic section read (readSectionRows). It swaps ONLY the two matrix-coupled
 * points of the read: where the rows come from, and how each row becomes a
 * MatrixRecord. Everything downstream (emitDdoData, the envelope, subdatum,
 * structure-context) is record-shape-only and reused unchanged.
 *
 * PHP parity: this is the TS expression of PHP's polymorphic
 * `search::get_instance()` (mode 'tm' → search_tm, a swappable SQL backend over
 * matrix_time_machine) + the per-row `tm_record::get_section_record()`
 * materialization inside the otherwise-generic sections_json loop. The whole
 * point (class.tm_record.php:533-535) is that the STANDARD pipeline renders
 * Time Machine history "without any special-cased UI code" — so dd15 is served
 * as a normal section, only its row/record acquisition (and its per-ddo cell
 * policy) differ.
 *
 * The default `matrixReadSource` is the ordinary matrix path verbatim; a
 * `tmReadSource` (src/core/resolve/read_tm.ts) serves the virtual dd15 section.
 */

import type { Ddo } from '../concepts/ddo.ts';
import { SELF_SENTINEL } from '../concepts/ddo.ts';
import type { EmitRow } from '../concepts/emit_row.ts';
import type { Rqo } from '../concepts/rqo.ts';
import type { Sqo } from '../concepts/sqo.ts';
import type { MatrixRecord } from '../db/matrix.ts';
import { readMatrixRecordBatch } from '../db/matrix.ts';
import { memoizedReadMatrixRecord, seedRecordMemo } from '../db/record_memo.ts';
import { getMatrixTableFromTipo } from '../ontology/resolver.ts';
import type { ElementNodeRegistry } from '../relations/element_registry.ts';
import type { EmissionContext } from '../resolve/component_data.ts';
import type { StructureContextEntry } from '../resolve/structure_context.ts';
import { runSearch, type SearchStatementOptions } from '../search/search_statement.ts';
import { buildSearchSql } from '../search/sql_assembler.ts';
import type { Principal } from '../security/permissions.ts';

/**
 * One matched row. `section_tipo`/`section_id` are the envelope + record
 * coordinates; `envelopeExtra` carries source-specific fields that must ride on
 * the envelope entry (the TM source adds matrix_id, timestamp, caller_* etc. — all
 * client-consumed and byte-gated by tm_read_differential). `raw` is the source's
 * own full row object, handed back to emitRow (the TM source reads its flat
 * matrix_time_machine columns from it).
 */
export interface SectionRow {
	section_tipo: string;
	section_id: number;
	envelopeExtra?: Record<string, unknown>;
	raw?: unknown;
}

/** The shared per-ddo emitter (section/read.ts emitDdoData), passed in to avoid a cycle. */
export type EmitDdo = (
	ddo: Ddo,
	ddoMap: Ddo[],
	record: MatrixRecord,
	row: EmitRow,
	defaultMode: string,
	defaultLang: string,
	callerTipo: string,
	emission: EmissionContext,
) => Promise<void>;

/** Everything a source needs to emit ONE row's data items. */
export interface EmitRowContext {
	row: SectionRow;
	ddoMap: Ddo[];
	mode: string;
	lang: string;
	callerTipo: string;
	/** The per-read emission context: items array + stamp ledger (S2-29). */
	emission: EmissionContext;
	/** The shared emitter (emitDdoData) — sources call it for generic components. */
	emitDdo: EmitDdo;
	/**
	 * The reading principal (undefined: an internal resolution, no filter — the
	 * ddoIsAuthorized posture). A source whose CELLS carry different components
	 * per row (the dd15 raw snapshot) gates each cell on it.
	 */
	principal?: Principal;
}

/**
 * A read strategy: fetch the matched rows, count them, and emit each row's data.
 * The sections envelope + structure-context are built generically by
 * readSectionRows from getRows; the per-row emission is the source's own — the
 * matrix source runs the standard direct-child ddo loop, the TM source runs its
 * who/when/where/what + cell-mode policy.
 */
export interface SectionReadSource {
	/**
	 * `readFloor` — the subdatum read floor of a component-sourced search
	 * (security/read_floor.ts subdatumReadFloor, computed by the caller from the
	 * VERIFIED rqo.source): the (section, component) pairs the search may filter
	 * and sort on although the profile holds 0 on them (closure Step 3, SEC-1).
	 * `statement` — INTERNAL, never from the wire: the referenced_by search
	 * bound's gate override (search/search_statement.ts).
	 */
	getRows(
		sqo: Sqo,
		principal?: Principal,
		readFloor?: ReadonlySet<string>,
		statement?: SearchStatementOptions,
	): Promise<SectionRow[]>;
	count(
		sqo: Sqo,
		principal?: Principal,
		readFloor?: ReadonlySet<string>,
		statement?: SearchStatementOptions,
	): Promise<number>;
	emitRow(context: EmitRowContext): Promise<void>;
	/**
	 * When present, OWNS the read's structure-context (readSection skips its
	 * generic context building). The TM source uses this: dd15's columns are the
	 * CLIENT's chosen components (not ontology-driven), so its request_config
	 * ddo_map must be built from rqo.show.ddo_map — a dd15-specific massaging the
	 * generic builder can't produce.
	 */
	buildContext?(
		rqo: Rqo,
		principal: Principal,
		/**
		 * The read's element nodes (the data half's emission registry): a column
		 * whose cells were emitted builds its context from the SAME node its data
		 * came from (section/node_contexts.ts).
		 */
		nodes?: ElementNodeRegistry,
	): Promise<StructureContextEntry[]>;
}

/**
 * Whether one emitted entry carries real content. An entry with a `value` face
 * must have it non-null/non-empty (a 'self' ddo resolved against a section it
 * doesn't belong to yields empty/null values); an entry with no `value` face
 * (locator-shaped) counts as filled. Mirrors the v6 PHP guard shape
 * (`common::get_subdatum` `$is_filled_value`).
 */
function entryFilled(entry: unknown): boolean {
	if (entry === null || entry === undefined || entry === '') return false;
	if (typeof entry === 'object') {
		const value = (entry as { value?: unknown }).value;
		if (value === undefined) return true;
		return value !== null && value !== '';
	}
	return true;
}

/** Whether an emitted data item resolved a REAL value (entries or the
 * lang-fallback face) — the WC-052 ddinfo suppression predicate. */
function emittedItemHasValue(item: object): boolean {
	const { entries, fallback_value } = item as {
		entries?: unknown[];
		fallback_value?: unknown[];
	};
	return (entries ?? []).some(entryFilled) || (fallback_value ?? []).some(entryFilled);
}

/**
 * The default matrix read source — the ordinary section path (buildSearchSql →
 * rows, readMatrixRecord → record, the standard direct-child ddo emit loop).
 * Behavior-identical to the pre-seam readSectionRows / count code.
 */
export const matrixReadSource: SectionReadSource = {
	async getRows(sqo, principal, readFloor, statement) {
		// idsOnly: the page's records are batch-hydrated below with the FULL
		// projection (::text twins included, which the search SELECT lacks), so
		// fetching the ten wide jsonb columns here would be paid twice.
		const built = await buildSearchSql(sqo, {
			principal,
			idsOnly: true,
			...(readFloor === undefined ? {} : { readFloor }),
		});
		// The one search executor: a statement a referenced_by leaf rendered into
		// runs under its bound (search/search_statement.ts); any other as before.
		const rows = await runSearch<SectionRow>(built, statement);

		// ONE record read per page per section instead of one per row (the old
		// per-emitRow readMatrixRecord N+1): batch-load and ride each record on
		// row.raw — envelope building never serializes raw, emitRow consumes it.
		const idsBySection = new Map<string, number[]>();
		for (const row of rows) {
			const ids = idsBySection.get(row.section_tipo);
			if (ids === undefined) idsBySection.set(row.section_tipo, [row.section_id]);
			else ids.push(row.section_id);
		}
		for (const [sectionTipo, ids] of idsBySection) {
			const table = (await getMatrixTableFromTipo(sectionTipo)) ?? 'matrix';
			const records = await readMatrixRecordBatch(table, sectionTipo, ids);
			for (const row of rows) {
				if (row.section_tipo === sectionTipo) row.raw = records.get(row.section_id) ?? null;
			}
			// The page's OWN rows, handed to the read-scoped memo: a widget
			// asking for a component of the row it is rendering (the usual
			// 'current' source) would otherwise re-fetch a row already in hand.
			for (const id of ids) {
				seedRecordMemo(table, sectionTipo, id, records.get(id) ?? null);
			}
		}
		return rows;
	},

	async count(sqo, principal, readFloor, statement) {
		const countSqo = { ...(sqo as Record<string, unknown>), full_count: true } as Sqo;
		const built = await buildSearchSql(countSqo, {
			principal,
			...(readFloor === undefined ? {} : { readFloor }),
		});
		const rows = await runSearch<{ full_count: number | string }>(built, statement);
		// Multi-section UNION yields one count row per branch — sum them (PHP trait.count).
		return rows.reduce((sum, row) => sum + Number(row.full_count), 0);
	},

	async emitRow({ row, ddoMap, mode, lang, callerTipo, emission, emitDdo }) {
		// The page's records ride in from getRows' batch hydration (row.raw);
		// the single read remains as the fallback for rows emitted outside it.
		const record =
			row.raw !== undefined
				? (row.raw as MatrixRecord | null)
				: await memoizedReadMatrixRecord(
						(await getMatrixTableFromTipo(row.section_tipo)) ?? 'matrix',
						row.section_tipo,
						row.section_id,
					);
		if (record === null) return;
		for (const ddo of ddoMap) {
			const parentRef = ddo.parent ?? SELF_SENTINEL;
			if (parentRef !== SELF_SENTINEL && parentRef !== callerTipo) {
				continue; // non-direct children resolve under their own parent
			}
			const emittedStart = emission.items.length;
			await emitDdo(ddo, ddoMap, record, row, mode, lang, callerTipo, emission);
			// value_with_parents ddo → the row also carries its ancestor
			// breadcrumb (PHP common::get_subdatum → get_ddinfo_parents :2802-05:
			// {tipo:'ddinfo', section_id, section_tipo, value:[parents…,hierarchy
			// label], parent:<caller tipo>}, appended AFTER the row-stamp loop so
			// it carries NO row_section_id/parent_tipo — mirrored via markStamped).
			// The autocomplete picker renders the term's thesaurus chain from it
			// ("Parcieux, Ain, Rhône-Alpes, France" — rsc92, 2026-07-09).
			//
			// WC-052: emitted ONLY when the ddo's component resolved a REAL value
			// for this row, and stamped with `from_ddo_tipo`. A 'self' ddo resolves
			// for EVERY searched section, so e.g. `hierarchy25` runs for a `tchi1`
			// row where it has no data and would emit a PHANTOM breadcrumb the
			// picker renders BEFORE the row's real term column (`tch555`, v6 fix
			// mirrored 2026-07-25). The frozen PHP oracle keeps the phantom —
			// deliberate divergence.
			if ((ddo as { value_with_parents?: unknown }).value_with_parents === true) {
				const componentHasValue = emission.items
					.slice(emittedStart)
					.some((item) => emittedItemHasValue(item as object));
				if (componentHasValue) {
					const { buildDdInfoChain } = await import('../resolve/dd_info.ts');
					// withHierarchyLabel=false: the rows breadcrumb ends at the root
					// TERM (byte-diffed vs the oracle) — the trailing registry label
					// belongs to the portal-cell ddinfo only.
					const chain = await buildDdInfoChain(row.section_tipo, row.section_id, lang, false);
					const ddInfoItem = {
						tipo: 'ddinfo',
						section_id: row.section_id,
						section_tipo: row.section_tipo,
						value: chain.length > 0 ? chain : null,
						parent: row.section_tipo,
						from_ddo_tipo: ddo.tipo,
					};
					emission.markStamped(ddInfoItem as never);
					emission.items.push(ddInfoItem as never);
				}
			}
		}
	},
};

/**
 * Select the read source for a request. `mode === 'tm'` → the dd15 Time Machine
 * source (loaded lazily to avoid a static cycle with read_tm.ts); everything
 * else → the default matrix source.
 */
export async function pickReadSource(mode: string | undefined): Promise<SectionReadSource> {
	if (mode === 'tm') {
		const { tmReadSource } = await import('../resolve/read_tm.ts');
		return tmReadSource;
	}
	return matrixReadSource;
}
