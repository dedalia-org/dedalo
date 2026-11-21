/**
 * CHECK `record_missing_defaults` — the records whose default-bearing component
 * holds no value (owner ruling Q3 / O14, 2026-11-19; T2-SL-7).
 *
 * THE LAW IT REPORTS AGAINST. A component's ontology-declared default
 * (`properties.dato_default`) is written ONCE, when the record is created
 * (record_defaults.ts, WC-2026-08-09-record-birth-defaults). A read never
 * writes: opening an existing record does not seed anything. Dédalo v6 seeded
 * on the first edit-form build instead, so two populations of records can lack
 * a value their section now declares a default for:
 *   - records created in v6 that nobody opened in edit before the upgrade;
 *   - records that existed before the default was ADDED to the ontology.
 * Neither is damage, and the engine cannot tell them from a value a curator
 * cleared on purpose — so nothing is repaired here. This check LISTS them, so
 * the people who own the data can fill the ones they mean to with the
 * propagate tool (tool_propagate_component_data), section by section.
 *
 * THE PAIR.
 *   store A  each section's declared birth defaults (record_defaults.ts
 *            getSectionDefaultsSpec — the SAME spec the create door seeds from,
 *            so the check and the seed can never disagree about which component
 *            of which section carries a default; the virtual-section edit scope
 *            and the alias-resolved model are its rules, not this module's);
 *   store B  the records of that section: the component's key in its column.
 * Drift = one unit per (record, component) whose key is absent, null, or an
 * empty array. A key holding anything else — a value, or a legacy husk of
 * empty items — is not this check's: it was written by someone.
 * The project filter (component_filter) is NOT part of it: it is seeded by its
 * own cascade and policed by the projects ACL, never by `dato_default`.
 *
 * REPORT-ONLY. An apply is refused at the registry (`applyRefused`): which of
 * the listed records should take the default is a data decision. The report
 * names, per section and component, the count and the first record ids.
 *
 * A section whose spec cannot be built (an unported `dato_default.method`)
 * is named in `detail.unreadable` with its error code and the scan continues —
 * one bad definition must not hide every other section's answer.
 */

import { MATRIX_TABLE_ALLOWLIST, type MatrixJsonbColumn } from '../../db/matrix.ts';
import { sql } from '../../db/postgres.ts';
import { DedaloError, isDedaloError } from '../../errors/dedalo_error.ts';
import { getMatrixTableFromTipo, listSectionNodes } from '../../ontology/resolver.ts';
import type {
	ReconcileDefinition,
	ReconcileReport,
	ReconcileRunOptions,
} from '../../reconcile/registry.ts';
import { type DefaultSpecItem, getSectionDefaultsSpec } from './record_defaults.ts';

/** The check's registry name (REGISTERED_NAMES, the widget row). */
export const RECORD_MISSING_DEFAULTS = 'record_missing_defaults';

/** Most record ids ONE finding lists; the rest are counted (`missing` is always the full count). */
const SAMPLE_IDS = 50;

/** Most findings ONE report lists; the rest are counted in `detail.more`. */
const MAX_REPORTED_FINDINGS = 500;

/** One default-bearing component of one section, and the records that hold nothing in it. */
export interface MissingDefaultFinding {
	readonly section_tipo: string;
	readonly tipo: string;
	readonly model: string;
	/** Records of the section whose key is absent / null / an empty array. */
	readonly missing: number;
	/** The first {@link SAMPLE_IDS} of them, ascending. */
	readonly section_ids: readonly number[];
}

export interface MissingDefaultsSummary {
	/** Sections with at least one declared default that were scanned. */
	scanned: number;
	/** (record, component) units missing — the drift. */
	drift: number;
	findings: MissingDefaultFinding[];
	/** Findings beyond the report cap (counted in `drift`). */
	more: number;
	/** Sections whose defaults spec could not be built: named, never dropped. */
	unreadable: { section_tipo: string; error: string }[];
}

/** The run's section scope as a set, or null when unscoped (every section). */
function scopeSet(scope: readonly string[] | undefined): ReadonlySet<string> | null {
	return scope === undefined || scope.length === 0 ? null : new Set(scope);
}

/** The records of one section whose `tipo` key holds nothing: the full count and the first ids. */
async function missingRecords(
	table: string,
	sectionTipo: string,
	column: MatrixJsonbColumn,
	tipo: string,
): Promise<{ missing: number; section_ids: number[] }> {
	// table is allowlisted and column is a MatrixJsonbColumn (the spec's own);
	// the rest is bound. `->` on a NULL column is NULL; jsonb_array_length is
	// only reached for an array (CASE), so a scalar key never errors.
	const rows = (await sql.unsafe(
		`SELECT section_id AS id, count(*) OVER () AS total
		   FROM "${table}"
		  WHERE section_tipo = $1
		    AND CASE jsonb_typeof("${column}"->$2)
		          WHEN 'array' THEN jsonb_array_length("${column}"->$2) = 0
		          WHEN 'null' THEN true
		          ELSE "${column}"->$2 IS NULL
		        END
		  ORDER BY section_id
		  LIMIT ${SAMPLE_IDS}`,
		[sectionTipo, tipo],
	)) as { id: number; total: number | string }[];
	return {
		missing: Number(rows[0]?.total ?? 0),
		section_ids: rows.map((row) => Number(row.id)),
	};
}

/** The declared defaults of one section, or the error code that kept them unreadable. */
async function declaredDefaults(
	sectionTipo: string,
): Promise<readonly DefaultSpecItem[] | { error: string }> {
	try {
		return (await getSectionDefaultsSpec(sectionTipo)).items;
	} catch (error) {
		if (!isDedaloError(error)) throw error;
		return { error: error.code };
	}
}

function checkAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted !== true) return;
	throw new DedaloError('update.failed', {
		message: `${RECORD_MISSING_DEFAULTS}: aborted (${String(signal.reason ?? 'signal')})`,
		publicMessage: 'The missing-defaults check was stopped',
	});
}

/** The matrix table a section's records live in, when the scan may read it (allowlisted). */
async function scannableTable(sectionTipo: string): Promise<string | null> {
	const table = await getMatrixTableFromTipo(sectionTipo);
	return table !== null && MATRIX_TABLE_ALLOWLIST.includes(table) ? table : null;
}

/** Fold one component's answer into the summary: counted always, listed up to the cap. */
function tally(summary: MissingDefaultsSummary, finding: MissingDefaultFinding): void {
	if (finding.missing === 0) return;
	summary.drift += finding.missing;
	if (summary.findings.length < MAX_REPORTED_FINDINGS) summary.findings.push(finding);
	else summary.more++;
}

/** One section's findings folded into the summary. */
async function scanSection(
	sectionTipo: string,
	summary: MissingDefaultsSummary,
	signal: AbortSignal | undefined,
): Promise<void> {
	const table = await scannableTable(sectionTipo);
	if (table === null) return;
	const items = await declaredDefaults(sectionTipo);
	if ('error' in items) {
		summary.unreadable.push({ section_tipo: sectionTipo, error: items.error });
		return;
	}
	if (items.length > 0) summary.scanned++;
	for (const item of items) {
		checkAborted(signal);
		const found = await missingRecords(table, sectionTipo, item.column, item.tipo);
		tally(summary, { section_tipo: sectionTipo, tipo: item.tipo, model: item.model, ...found });
	}
}

/** THE SCAN: every section in scope with a declared default, every such component. Read-only. */
export async function scanMissingDefaults(
	options: Pick<ReconcileRunOptions, 'scope' | 'signal'> = {},
): Promise<MissingDefaultsSummary> {
	const wanted = scopeSet(options.scope);
	const summary: MissingDefaultsSummary = {
		scanned: 0,
		drift: 0,
		findings: [],
		more: 0,
		unreadable: [],
	};
	for (const section of await listSectionNodes()) {
		if (wanted !== null && !wanted.has(section.tipo)) continue;
		checkAborted(options.signal);
		await scanSection(section.tipo, summary, options.signal);
	}
	return summary;
}

/** The registry run: a dry report; an apply never reaches here (applyRefused). */
async function runMissingDefaults(options: ReconcileRunOptions): Promise<ReconcileReport> {
	const summary = await scanMissingDefaults(options);
	return {
		drift: summary.drift,
		applied: 0,
		detail: summary as unknown as Record<string, unknown>,
	};
}

/**
 * The registry shape (core/reconcile/registry.ts): each section's declared
 * birth defaults vs its records. Operator-run, dry only.
 */
export const RECORD_MISSING_DEFAULTS_RECONCILE: ReconcileDefinition = {
	name: RECORD_MISSING_DEFAULTS,
	stores: [
		"each section's declared component defaults (dd_ontology properties.dato_default)",
		"the records of that section (the component's key in its matrix column)",
	],
	description:
		'List the records whose default-bearing component holds no value: a default is written only when a record is created, so records created before the default existed (or in Dédalo v6 and never opened in edit) lack it. Nothing is written — fill the ones you mean to with the propagate tool.',
	scopeLabel: 'section tipo',
	// A whole-install walk (one count per default-bearing component) an operator
	// asks for; it repairs nothing, so nothing schedules it.
	schedule: 'operator',
	applyRefused: {
		reason:
			'report-only by owner ruling (Q3, 2026-11-19): a default is written at record creation and a read never writes; whether an existing record should take it cannot be told from a value a curator cleared on purpose, so the listed records are filled deliberately with the propagate-component-data tool, never by this check',
	},
	sources: ['src/core/section/record/missing_default_check.ts'],
	run: runMissingDefaults,
};
