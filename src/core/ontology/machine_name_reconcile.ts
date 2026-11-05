/**
 * THE MACHINE-NAME CONVERTER'S DOORS (plan §6, WC-2026-11-04-ontology-machine-names,
 * P3). The kernel is pure (machine_name_convert.ts); this module reads ontology source
 * records, hands each to it, and writes the verdicts through three doors:
 *
 *  - `ontology_machine_names` (reconcile, class L — LOSSLESS): boot schedule,
 *    `autoApply`. Writes through the save door (saveComponentData: a Time Machine row
 *    per key, the P2 machine-name save rules, actor the system user -1).
 *  - `ontology_machine_names_strays` (reconcile, class S — STRAYS): operator schedule,
 *    `applyRootOnly`. Same writes; what it changes is which labels a UI lang resolves
 *    to, so root decides with the per-node value list in view (D3: kept as labels).
 *  - the PACKAGE IMPORT REWRITE (`convertImportedMachineNames`): called by the two
 *    package import doors right after COPY + the ONT-TLD normalization and BEFORE the
 *    dd_ontology re-derive (ontology_update.ts importOntologyPackage,
 *    data_io_import.ts importOntologyFile). L only, through the record-write
 *    chokepoint WITHOUT a Time Machine row (an import replaces the slice wholesale; the
 *    package is the history — the same posture as normalizeOntologyTld), with a count
 *    in the run's messages. Non-fatal: a failure leaves the records in the legacy shape,
 *    which the parser's rungs read correctly, and the boot reconcile converts later.
 * Class C (refused) is never written by any door: both reconciles REPORT it
 * (`detail.refused`, with the values the operator adjudicates).
 *
 * ARMED ONLY ON AN ONTOLOGY THAT DEFINES ontology43 AND ontology44 (getModelByTipo, the
 * same condition as the P2 save rules): moving a name into a component the parser
 * cannot read would NULL it. Unarmed, every dry run still MEASURES (the census reads
 * the stored keys under their fixed columns — see below), and an apply writes nothing
 * and says why (`detail.apply_refused`).
 *
 * NEVER AUTO-APPLIED ON AN ONTOLOGY SERVER (plan §6, hazard §11.3): master is converted
 * by a human (P4). On `IS_AN_ONTOLOGY_SERVER` an apply needs an explicit TLD `scope` —
 * which no scheduled or post-restore run carries — or it is refused (dry report +
 * `detail.apply_refused`). The package import rewrite is refused there OUTRIGHT (no
 * scope exists for it): on master an ontology file import lands master's own records,
 * and converting them with no Time Machine row would be the P4 migration the owner
 * reserved to a human. The seed compiler that drives the same door is unaffected and
 * byte-reproducible on every machine: its compile child runs under a hermetic
 * environment (install/seed_build.ts childEnv) that is never an ontology server.
 *
 * THE FIXED COLUMNS. ontology43 is a component_input_text (column `string`) and
 * ontology44 a component_radio_button (column `relation`) — the owner-approved
 * definitions. The census reads them there even where the release does not define the
 * tipos yet (so a dry run measures the same everywhere); an apply, armed, first checks
 * the ontology agrees and refuses loudly when it does not.
 *
 * SCOPE = TLDs. A canonical record is in scope by its section's tld; an override
 * (localontology0) by the tld of the node it overrides. Unscoped = every `<tld>0`
 * section of matrix_ontology plus every override. Every TLD an apply touched is
 * REBUILT (rebuildOntology, `mainNode: 'existing'`), so the projection follows at once
 * — the cache hub is in-process, which is why applies run in the server process.
 *
 * IDEMPOTENT: each apply re-reads the record under its row lock and re-runs the kernel
 * on what it finds; a record already converted (by a concurrent writer, an earlier run)
 * is `none` and skipped. A second run reports drift 0.
 */

import { config } from '../../config/config.ts';
import { readDdOntologyRow } from '../db/dd_ontology.ts';
import { type MatrixJsonbColumn, type MatrixRecord, readMatrixRecordBatch } from '../db/matrix.ts';
import { readMatrixKeyForUpdate } from '../db/matrix_write.ts';
import { sql, withTransaction } from '../db/postgres.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import type {
	ReconcileDefinition,
	ReconcileReport,
	ReconcileScope,
} from '../reconcile/registry.ts';
import { saveComponentData } from '../section/record/save_component.ts';
import { persistRecordKeys } from '../section_record/record_write.ts';
import { type Principal, SUPERUSER_ID } from '../security/permissions.ts';
import { deriveLegacyMachineName, isNameClassNode, modelNameOf } from './machine_name.ts';
import {
	convertCanonicalRecord,
	convertOverrideRecord,
	type MachineNameConversion,
	type MachineNameConversionClass,
	type MachineNameConversionFinding,
	type MachineNameConversionKind,
} from './machine_name_convert.ts';
import {
	flagFromItems,
	literalStrings,
	machineNameFlagItems,
	machineNameItems,
	type StoredLiteralItem,
} from './machine_name_rules.ts';
import {
	DATA_NOLAN,
	ONTOLOGY_IS_MODEL,
	ONTOLOGY_MACHINE_NAME,
	ONTOLOGY_MODEL,
	ONTOLOGY_OVERWRITE,
	ONTOLOGY_TERM,
	ONTOLOGY_TLD,
	ONTOLOGY_USE_MACHINE_NAME,
} from './ontology_tipos.ts';
import { getTermIdFromLocator } from './parser.ts';
import { getColumnNameByModel, getModelByTipo } from './resolver.ts';
import { buildTipo, LOCAL_ONTOLOGY_SECTION, requiredOntologyTld, safeTld } from './tld.ts';

/** The table every ontology source record lives in (`<tld>0` and localontology0). */
const ONTOLOGY_TABLE = 'matrix_ontology';

/** Where each key the kernel reads is stored (module header: THE FIXED COLUMNS). */
const COLUMN_OF: Readonly<Record<string, MatrixJsonbColumn>> = {
	[ONTOLOGY_TERM]: 'string',
	[ONTOLOGY_TLD]: 'string',
	[ONTOLOGY_MACHINE_NAME]: 'string',
	[ONTOLOGY_USE_MACHINE_NAME]: 'relation',
	[ONTOLOGY_MODEL]: 'relation',
	[ONTOLOGY_IS_MODEL]: 'relation',
	[ONTOLOGY_OVERWRITE]: 'relation',
};

/** The actor of a reconcile write: the registry's doors carry none (system user, superuser). */
const CONVERTER_PRINCIPAL: Principal = {
	userId: SUPERUSER_ID,
	isGlobalAdmin: true,
	isDeveloper: true,
};

/** How many units / refusals a report LISTS (the counts stay exact past it). */
const REPORT_SAMPLE = 50;

/** Records read per page from one section. */
const PAGE_SIZE = 500;

/** The reconcile names (REGISTERED_NAMES, the WC entry). */
export const ONTOLOGY_MACHINE_NAMES = 'ontology_machine_names';
export const ONTOLOGY_MACHINE_NAMES_STRAYS = 'ontology_machine_names_strays';

/** One record the census judged (its address, its tld for the rebuild, its verdict). */
export interface MachineNameUnit {
	/** `<section_tipo>/<section_id>`. */
	source: string;
	/** The node the record is (canonical) or overrides (localontology0). */
	tipo: string;
	/** The tld whose projection the record feeds (rebuilt after an apply). */
	tld: string;
	sectionTipo: string;
	sectionId: number;
	conversion: MachineNameConversion;
}

/** The census of a scope: every judged record, by class. */
export interface MachineNameCensus {
	/** Records read (nodes and overrides; contentless shells are not nodes and not counted). */
	scanned: number;
	units: MachineNameUnit[];
	classes: Record<MachineNameConversionClass, number>;
	kinds: Partial<Record<MachineNameConversionKind, number>>;
	findings: Partial<Record<MachineNameConversionFinding, number>>;
}

type Columns = Partial<Record<MatrixJsonbColumn, unknown>>;

/** A column value as a keyed bag, or null. */
function bagOf(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/** One key's stored items (null/'' holes dropped, a scalar coerced like PHP's [$data]). */
function itemsOf(columns: Columns, key: string): unknown[] {
	const raw = bagOf(columns[COLUMN_OF[key] as MatrixJsonbColumn])?.[key];
	if (raw === undefined || raw === null) return [];
	return (Array.isArray(raw) ? raw : [raw]).filter((item) => item !== null && item !== '');
}

/** The term id a relation key's first locator composes to, or null. */
async function locatorTipo(columns: Columns, key: string): Promise<string | null> {
	const locator = itemsOf(columns, key)[0];
	if (locator === undefined) return null;
	return getTermIdFromLocator(locator as Parameters<typeof getTermIdFromLocator>[0]);
}

/** ontology5 items as the kernel moves them (objects only). */
function termItemsOf(columns: Columns): StoredLiteralItem[] {
	return itemsOf(columns, ONTOLOGY_TERM).filter(
		(item): item is StoredLiteralItem => typeof item === 'object' && !Array.isArray(item),
	);
}

/**
 * The classification of a canonical record (its own model, as the save rules read it),
 * or `'unresolved'` when the record names a model whose name does not resolve (no row
 * yet — a model new in a package not derived yet, the import rewrite running after COPY
 * and before the re-derive — or a row without a name). An unknown model is NOT a label:
 * reading it as one would write a permanent ontology44 No on what may be a table/field.
 */
async function canonicalNameClass(
	tld: string,
	sectionId: number,
	columns: Columns,
): Promise<boolean | 'unresolved'> {
	const modelTipo = await locatorTipo(columns, ONTOLOGY_MODEL);
	const model = modelTipo === null ? null : modelNameOf(await readDdOntologyRow(modelTipo)).model;
	if (modelTipo !== null && model === null) return 'unresolved';
	return isNameClassNode({
		tipo: buildTipo(tld, sectionId),
		tld,
		is_model: flagFromItems(itemsOf(columns, ONTOLOGY_IS_MODEL)) === true,
		model_tipo: modelTipo,
		model,
	});
}

/** The overridden node's tld + effective flag (its derived row's, else the legacy derivation). */
async function overriddenNode(
	nodeTipo: string | null,
): Promise<{ tld: string; flag: boolean } | null> {
	const row = nodeTipo === null ? null : await readDdOntologyRow(nodeTipo);
	if (row === null) return null;
	const tld = safeTld(row.tld ?? '');
	return tld === null ? null : { tld, flag: effectiveRowFlag(row) };
}

/** A stored row's flag: its derived value, else (a row not derived yet) the legacy derivation. */
function effectiveRowFlag(
	row: NonNullable<Awaited<ReturnType<typeof readDdOntologyRow>>>,
): boolean {
	return row.use_machine_name ?? deriveLegacyMachineName(row).use_machine_name;
}

/** The node an override record overrides, when it resolves and is in scope (else null). */
async function overrideTarget(
	columns: Columns,
	tlds: ReadonlySet<string> | null,
): Promise<{ tipo: string; tld: string; flag: boolean } | null> {
	const tipo = await locatorTipo(columns, ONTOLOGY_OVERWRITE);
	const node = await overriddenNode(tipo);
	if (tipo === null || node === null) return null;
	return tlds === null || tlds.has(node.tld) ? { tipo, ...node } : null;
}

/** True when the record is an ontology node (it declares a tld): shells are never converted. */
function declaresTld(columns: Columns): boolean {
	return literalStrings(itemsOf(columns, ONTOLOGY_TLD)).some((value) => value !== '');
}

/** The census verdict of one record, or null when it is out of scope / not a node. */
async function judgeRecord(
	sectionTipo: string,
	sectionId: number,
	columns: Columns,
	tlds: ReadonlySet<string> | null,
): Promise<MachineNameUnit | null> {
	const source = `${sectionTipo}/${sectionId}`;
	const shared = {
		termItems: termItemsOf(columns),
		nameValues: literalStrings(itemsOf(columns, ONTOLOGY_MACHINE_NAME)),
	};
	const flag = flagFromItems(itemsOf(columns, ONTOLOGY_USE_MACHINE_NAME));
	if (sectionTipo === LOCAL_ONTOLOGY_SECTION) {
		const target = await overrideTarget(columns, tlds);
		if (target === null) return null;
		const conversion = convertOverrideRecord({
			...shared,
			overrideFlag: flag,
			nodeFlag: target.flag,
		});
		return { source, tipo: target.tipo, tld: target.tld, sectionTipo, sectionId, conversion };
	}
	const tld = requiredOntologyTld(sectionTipo);
	if (tld === null || !declaresTld(columns)) return null;
	const nameClass = await canonicalNameClass(tld, sectionId, columns);
	const conversion: MachineNameConversion =
		nameClass === 'unresolved'
			? { class: 'C', kind: 'model_unresolved', findings: [] }
			: convertCanonicalRecord({ ...shared, flag, nameClass });
	return { source, tipo: buildTipo(tld, sectionId), tld, sectionTipo, sectionId, conversion };
}

/** The ontology sections a scope covers (canonical `<tld>0` + localontology0). */
async function sectionsInScope(tlds: ReadonlySet<string> | null): Promise<string[]> {
	const rows = (await sql.unsafe(
		`SELECT DISTINCT section_tipo FROM "${ONTOLOGY_TABLE}" ORDER BY section_tipo`,
	)) as { section_tipo: string }[];
	return rows
		.map((row) => row.section_tipo)
		.filter((sectionTipo) => {
			if (sectionTipo === LOCAL_ONTOLOGY_SECTION) return true;
			const tld = requiredOntologyTld(sectionTipo);
			return tld !== null && (tlds === null || tlds.has(tld));
		});
}

/** Every record of one section, page by page (keyset on section_id). */
async function* recordsOf(sectionTipo: string): AsyncGenerator<MatrixRecord> {
	let after = -1;
	for (;;) {
		const rows = (await sql.unsafe(
			`SELECT section_id FROM "${ONTOLOGY_TABLE}"
			  WHERE section_tipo = $1 AND section_id > $2 ORDER BY section_id ASC LIMIT ${PAGE_SIZE}`,
			[sectionTipo, after],
		)) as { section_id: number }[];
		if (rows.length === 0) return;
		const ids = rows.map((row) => Number(row.section_id));
		const batch = await readMatrixRecordBatch(ONTOLOGY_TABLE, sectionTipo, ids);
		for (const id of ids) {
			const record = batch.get(id);
			if (record !== undefined) yield record;
		}
		after = ids[ids.length - 1] as number;
	}
}

/** A census with nothing counted yet. */
function emptyCensus(): MachineNameCensus {
	return { scanned: 0, units: [], classes: { none: 0, L: 0, S: 0, C: 0 }, kinds: {}, findings: {} };
}

/** Count one unit into the census. */
function tally(census: MachineNameCensus, unit: MachineNameUnit): void {
	const { conversion } = unit;
	census.scanned += 1;
	census.classes[conversion.class] += 1;
	census.kinds[conversion.kind] = (census.kinds[conversion.kind] ?? 0) + 1;
	for (const finding of conversion.findings) {
		census.findings[finding] = (census.findings[finding] ?? 0) + 1;
	}
	if (conversion.class !== 'none' || conversion.findings.length > 0) census.units.push(unit);
}

/** The tld set a scope names (null = everything); an unsafe entry is refused loudly. */
function scopeTlds(scope: ReconcileScope | undefined): ReadonlySet<string> | null {
	if (scope === undefined || scope.length === 0) return null;
	const out = new Set<string>();
	for (const raw of scope) {
		const tld = safeTld(String(raw).trim().toLowerCase());
		if (tld === null) {
			throw new DedaloError('request.invalid', {
				message: `${ONTOLOGY_MACHINE_NAMES}: scope entry '${String(raw)}' is not a tld`,
				publicMessage: `The scope of the machine-name reconcile is a list of TLDs; '${String(raw)}' is not one`,
			});
		}
		out.add(tld);
	}
	return out;
}

/** Throw the run's abort reason between records. */
function checkAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted !== true) return;
	throw new DedaloError('update.failed', {
		message: `${ONTOLOGY_MACHINE_NAMES}: aborted (${String(signal.reason ?? 'signal')})`,
		publicMessage: 'The machine-name reconcile was stopped',
	});
}

/** THE CENSUS (read-only): every record of the scope, judged by the kernel. */
export async function censusMachineNames(
	scope?: ReconcileScope,
	signal?: AbortSignal,
): Promise<MachineNameCensus> {
	const tlds = scopeTlds(scope);
	const census = emptyCensus();
	for (const sectionTipo of await sectionsInScope(tlds)) {
		for await (const record of recordsOf(sectionTipo)) {
			checkAborted(signal);
			const unit = await judgeRecord(sectionTipo, record.section_id, record.columns, tlds);
			if (unit !== null) tally(census, unit);
		}
	}
	return census;
}

/* ------------------------------------------------------------------ arming */

/**
 * Why an APPLY may not write here, or null when it may (module header): the ontology
 * must define ontology43/44 under the fixed columns, and an ontology server needs an
 * explicit TLD scope. `isOntologyServer` is the config's (a parameter so the gate can
 * drive the server branch on a suite that is not one).
 */
export async function applyRefusal(
	scope: ReconcileScope | undefined,
	isOntologyServer: boolean = config.ontologyIo.isOntologyServer,
): Promise<string | null> {
	if (isOntologyServer && (scope === undefined || scope.length === 0)) {
		return 'this is an ontology server: master is converted by a human — run it with an explicit TLD scope';
	}
	return armingRefusal();
}

/** Why the components cannot carry a conversion on this ontology, or null. */
async function armingRefusal(): Promise<string | null> {
	for (const tipo of [ONTOLOGY_MACHINE_NAME, ONTOLOGY_USE_MACHINE_NAME]) {
		const model = await getModelByTipo(tipo);
		if (model === null) {
			return `this ontology does not define ${tipo} yet — the records stay in the legacy shape the parser reads (an ontology update brings it)`;
		}
		if (getColumnNameByModel(model) !== COLUMN_OF[tipo]) {
			throw new DedaloError('ontology.invalid_node', {
				message: `${tipo} is a ${model} here (column ${String(getColumnNameByModel(model))}), not the ${COLUMN_OF[tipo]} component the machine-name contract defines — no conversion is written`,
				coordinates: { tipo, model },
			});
		}
	}
	return null;
}

/* ------------------------------------------------------------------- apply */

/** The record's columns under its row lock (inside the caller's transaction). */
async function lockedColumns(sectionTipo: string, sectionId: number): Promise<Columns | null> {
	// The lock is the row's: any key works.
	await readMatrixKeyForUpdate(ONTOLOGY_TABLE, sectionTipo, sectionId, 'string', ONTOLOGY_TERM);
	const batch = await readMatrixRecordBatch(ONTOLOGY_TABLE, sectionTipo, [sectionId]);
	return (batch.get(sectionId)?.columns as Columns | undefined) ?? null;
}

/** ontology5 items of one lang after the conversion (what a lang-sliced save stores). */
function itemsOfLang(items: readonly StoredLiteralItem[], lang: string): StoredLiteralItem[] {
	return items.filter((item) => item.lang === lang);
}

/** The flag locator a save stores (the dd64 yes/no locator, id assigned by the engine). */
function flagLocator(flag: boolean): Record<string, unknown>[] {
	return machineNameFlagItems(flag).map(({ id: _id, ...locator }) => locator);
}

/** One key through the save door (TM row, save rules); a refusal is a typed throw. */
async function saveKey(
	unit: MachineNameUnit,
	tipo: string,
	lang: string,
	value: unknown[],
): Promise<void> {
	const saved = await saveComponentData({
		componentTipo: tipo,
		sectionTipo: unit.sectionTipo,
		sectionId: unit.sectionId,
		lang,
		changedData: [{ action: 'set_data', value }],
		userId: CONVERTER_PRINCIPAL.userId,
		principal: CONVERTER_PRINCIPAL,
	});
	if (!saved.ok) {
		throw new DedaloError('record.save_failed', {
			message: `${ONTOLOGY_MACHINE_NAMES}: ${unit.source} ${tipo} not saved — ${saved.message}`,
			coordinates: { section_tipo: unit.sectionTipo, section_id: unit.sectionId, tipo },
		});
	}
}

/**
 * The saves of one conversion, in the order the P2 save rules admit one key at a time:
 * the name first (it derives already), then the flag, then the label slices that lose
 * the name — so no intermediate state lacks a derivable machine name.
 */
async function saveConversion(
	unit: MachineNameUnit,
	conversion: MachineNameConversion,
): Promise<void> {
	if (conversion.machineName !== undefined) {
		await saveKey(unit, ONTOLOGY_MACHINE_NAME, DATA_NOLAN, [
			{ lang: DATA_NOLAN, value: conversion.machineName },
		]);
	}
	if (conversion.flag !== undefined) {
		await saveKey(unit, ONTOLOGY_USE_MACHINE_NAME, DATA_NOLAN, flagLocator(conversion.flag));
	}
	const after = conversion.termItems ?? [];
	for (const lang of conversion.removedLangs ?? []) {
		await saveKey(unit, ONTOLOGY_TERM, lang, itemsOfLang(after, lang));
	}
}

/** The verdict of a record re-read under its lock (null = gone / out of scope). */
async function relocked(unit: MachineNameUnit): Promise<MachineNameConversion | null> {
	const columns = await lockedColumns(unit.sectionTipo, unit.sectionId);
	if (columns === null) return null;
	const fresh = await judgeRecord(unit.sectionTipo, unit.sectionId, columns, null);
	return fresh?.conversion ?? null;
}

/** What an apply did. */
interface ApplyOutcome {
	applied: number;
	/** Units the kernel no longer puts in the class once re-read under the lock. */
	skipped: number;
	failed: { source: string; error: string }[];
	failedCount: number;
	rebuilt: Record<string, { ok: boolean; msg: string }>;
}

/** A thrown failure's CODE for the report (the text goes to the log, never the payload). */
function failureCode(error: unknown, unit: MachineNameUnit, door: string): string {
	console.error(`[${door}] ${unit.source} failed:`, error);
	return error instanceof DedaloError ? error.code : 'internal.unexpected';
}

/** Apply every unit of `cls`, one record per transaction, then rebuild the touched tlds. */
async function applyClass(
	units: readonly MachineNameUnit[],
	cls: 'L' | 'S',
	door: string,
	signal: AbortSignal | undefined,
): Promise<ApplyOutcome> {
	const outcome: ApplyOutcome = { applied: 0, skipped: 0, failed: [], failedCount: 0, rebuilt: {} };
	const touched = new Set<string>();
	for (const unit of units) {
		checkAborted(signal);
		try {
			const written = await withTransaction(async () => {
				const conversion = await relocked(unit);
				if (conversion === null || conversion.class !== cls) return false;
				await saveConversion(unit, conversion);
				return true;
			});
			if (written) {
				outcome.applied += 1;
				touched.add(unit.tld);
			} else outcome.skipped += 1;
		} catch (error) {
			outcome.failedCount += 1;
			const code = failureCode(error, unit, door);
			if (outcome.failed.length < REPORT_SAMPLE)
				outcome.failed.push({ source: unit.source, error: code });
		}
	}
	outcome.rebuilt = await rebuildTouched(touched);
	return outcome;
}

/** Rebuild every tld whose records an apply changed (CONVENTIONS §2: cycle-breaking import). */
async function rebuildTouched(
	tlds: ReadonlySet<string>,
): Promise<Record<string, { ok: boolean; msg: string }>> {
	const { rebuildOntology } = await import('./ontology_state.ts');
	const out: Record<string, { ok: boolean; msg: string }> = {};
	for (const tld of [...tlds].sort()) {
		const rebuilt = await rebuildOntology(tld, -1, { mainNode: 'existing' });
		out[tld] = { ok: rebuilt.ok, msg: rebuilt.msg };
	}
	return out;
}

/* ------------------------------------------------------------ the reports */

/** A unit as the report lists it (no internal fields). */
function listed(unit: MachineNameUnit): Record<string, unknown> {
	const { conversion } = unit;
	return {
		source: unit.source,
		tipo: unit.tipo,
		kind: conversion.kind,
		...(conversion.machineName === undefined ? {} : { machine_name: conversion.machineName }),
		...(conversion.values === undefined ? {} : { values: conversion.values }),
		...(conversion.findings.length === 0 ? {} : { findings: conversion.findings }),
	};
}

/** The detail every run of either definition carries. */
function censusDetail(census: MachineNameCensus, cls: 'L' | 'S'): Record<string, unknown> {
	const ofClass = census.units.filter((unit) => unit.conversion.class === cls);
	const refused = census.units.filter((unit) => unit.conversion.class === 'C');
	const noted = census.units.filter((unit) => unit.conversion.findings.length > 0);
	return {
		scanned: census.scanned,
		classes: census.classes,
		kinds: census.kinds,
		findings: census.findings,
		units: ofClass.slice(0, REPORT_SAMPLE).map(listed),
		refused: refused.slice(0, REPORT_SAMPLE).map(listed),
		noted: noted.slice(0, REPORT_SAMPLE).map(listed),
	};
}

/** One definition's run: census, then (apply, armed, allowed) the class's writes. */
async function runClass(
	cls: 'L' | 'S',
	door: string,
	options: { apply: boolean; scope?: ReconcileScope; signal?: AbortSignal },
): Promise<ReconcileReport> {
	const census = await censusMachineNames(options.scope, options.signal);
	const units = census.units.filter((unit) => unit.conversion.class === cls);
	const detail = censusDetail(census, cls);
	if (!options.apply) return { drift: units.length, applied: 0, detail };
	const refusal = await applyRefusal(options.scope);
	if (refusal !== null) {
		return { drift: units.length, applied: 0, detail: { ...detail, apply_refused: refusal } };
	}
	const outcome = await applyClass(units, cls, door, options.signal);
	return {
		drift: units.length,
		applied: outcome.applied,
		detail: {
			...detail,
			skipped: outcome.skipped,
			failed: outcome.failed,
			failed_count: outcome.failedCount,
			rebuilt: outcome.rebuilt,
		},
	};
}

const SOURCES = [
	'src/core/ontology/machine_name_reconcile.ts',
	'src/core/ontology/machine_name_convert.ts',
];

/**
 * Class L — the lossless conversion of ontology source records into the machine-name
 * shape (module header). Boot + autoApply: nothing any reader derives changes.
 */
export const ONTOLOGY_MACHINE_NAMES_RECONCILE: ReconcileDefinition = {
	name: ONTOLOGY_MACHINE_NAMES,
	stores: [
		'matrix_ontology source records (ontology5 / ontology43 / ontology44)',
		'the machine-name shape (name in ontology43, flag stated, lg-spa out of ontology5)',
	],
	description:
		'Find ontology records still in the legacy name shape whose conversion is LOSSLESS (class L: one lg-spa name and no differing translation, a single-value local name, a duplicate lg-spa, a missing flag); apply moves the name into ontology43, states ontology44 and drops the lg-spa duplicate through the save door (TM row each), then rebuilds every touched tld. Classes S and C are reported, never written here.',
	scopeLabel: 'tld',
	schedule: 'boot',
	autoApply: {
		reason:
			'lossless by construction: the kernel converts only records whose machine name, flag, model and per-lang labels the parser derives identically before and after; armed only on an ontology defining ontology43/44, refused unscoped on an ontology server (master is converted by a human)',
	},
	sources: SOURCES,
	run: (options) => runClass('L', ONTOLOGY_MACHINE_NAMES, options),
};

/**
 * Class S — name nodes whose other langs hold DIFFERENT values (module header). The
 * name is unchanged, the strays become the node's only labels: root decides.
 */
export const ONTOLOGY_MACHINE_NAMES_STRAYS_RECONCILE: ReconcileDefinition = {
	name: ONTOLOGY_MACHINE_NAMES_STRAYS,
	stores: [
		'matrix_ontology source records of name nodes carrying differing translations',
		'the machine-name shape (strays kept as labels, D3)',
	],
	description:
		"Find name nodes still in the legacy shape whose ontology5 holds, beside the lg-spa name, translations with DIFFERENT values (class S, listed value by value); apply moves the name into ontology43 and keeps the strays as the node's labels (D3: never purged), through the save door (TM row each), then rebuilds every touched tld.",
	scopeLabel: 'tld',
	schedule: 'operator',
	applyRootOnly: {
		reason:
			'the move changes which label a UI language resolves to (a Spanish screen then shows the stray translation instead of the name): an adjudication of each listed value, not hygiene — root decides with the dry list in view',
	},
	sources: SOURCES,
	run: (options) => runClass('S', ONTOLOGY_MACHINE_NAMES_STRAYS, options),
};

/* ------------------------------------------------------ the import door */

/** What the package import rewrite did for one section. */
export interface ImportedMachineNameOutcome {
	/** Records converted (class L). */
	converted: number;
	/** Records left for the reconciles (class S / C), by class. */
	left: { S: number; C: number };
	/** Why nothing was written, when nothing could be (unarmed). */
	skipped: string | null;
}

/** The whole-key savePath of one conversion (the chokepoint writes it in ONE UPDATE). */
function conversionSavePath(conversion: MachineNameConversion): {
	column: MatrixJsonbColumn;
	key: string;
	value: unknown;
}[] {
	const path: { column: MatrixJsonbColumn; key: string; value: unknown }[] = [];
	if (conversion.machineName !== undefined) {
		path.push({
			column: 'string',
			key: ONTOLOGY_MACHINE_NAME,
			value: machineNameItems(conversion.machineName),
		});
	}
	if (conversion.flag !== undefined) {
		path.push({
			column: 'relation',
			key: ONTOLOGY_USE_MACHINE_NAME,
			value: machineNameFlagItems(conversion.flag),
		});
	}
	if (conversion.termItems !== undefined) {
		path.push({
			column: 'string',
			key: ONTOLOGY_TERM,
			value: conversion.termItems.length > 0 ? conversion.termItems : null,
		});
	}
	return path;
}

/** Why the import rewrite never runs on an ontology server (module header). */
const IMPORT_REFUSED_ON_ONTOLOGY_SERVER =
	'this is an ontology server: imported records keep their shape (master is converted by a human, P4)';

/**
 * THE PACKAGE IMPORT REWRITE (module header): class L of one imported `<tld>0`
 * section, after COPY and before the re-derive, through the record-write chokepoint
 * without a Time Machine row. Unarmed (the ontology does not define ontology43/44 yet)
 * or on an ontology server it writes nothing and says so.
 */
export async function convertImportedMachineNames(
	sectionTipo: string,
	isOntologyServer: boolean = config.ontologyIo.isOntologyServer,
): Promise<ImportedMachineNameOutcome> {
	const outcome: ImportedMachineNameOutcome = { converted: 0, left: { S: 0, C: 0 }, skipped: null };
	const tld = requiredOntologyTld(sectionTipo);
	if (tld === null) return outcome;
	outcome.skipped = isOntologyServer ? IMPORT_REFUSED_ON_ONTOLOGY_SERVER : await armingRefusal();
	return outcome.skipped === null ? convertImportedSection(sectionTipo, tld, outcome) : outcome;
}

/** The armed half of the import rewrite: census the tld, persist its section's L records. */
async function convertImportedSection(
	sectionTipo: string,
	tld: string,
	outcome: ImportedMachineNameOutcome,
): Promise<ImportedMachineNameOutcome> {
	const census = await censusMachineNames([tld]);
	outcome.left = { S: census.classes.S, C: census.classes.C };
	const lossless = census.units.filter(
		(unit) => unit.conversion.class === 'L' && unit.sectionTipo === sectionTipo,
	);
	for (const unit of lossless) {
		if (await persistImportedUnit(unit)) outcome.converted += 1;
	}
	return outcome;
}

/** One L record of the import rewrite, re-judged under its lock; false when no longer L. */
async function persistImportedUnit(unit: MachineNameUnit): Promise<boolean> {
	return withTransaction(async () => {
		const conversion = await relocked(unit);
		if (conversion === null || conversion.class !== 'L') return false;
		await persistRecordKeys(
			{ table: ONTOLOGY_TABLE, sectionTipo: unit.sectionTipo, sectionId: unit.sectionId },
			conversionSavePath(conversion),
			false,
			{ actor: SUPERUSER_ID },
		);
		return true;
	});
}

/** The operator line of an import rewrite, or null when it did nothing worth saying. */
export function importedMachineNameLine(
	sectionTipo: string,
	outcome: ImportedMachineNameOutcome,
): string | null {
	const left = outcome.left.S + outcome.left.C;
	if (outcome.converted === 0 && left === 0) return null;
	const tail =
		left > 0
			? `; ${outcome.left.S} strays / ${outcome.left.C} refused left for reconcile ${ONTOLOGY_MACHINE_NAMES_STRAYS} / ${ONTOLOGY_MACHINE_NAMES}`
			: '';
	return `${sectionTipo}: machine names converted on ${outcome.converted} record(s)${tail}`;
}

/**
 * The import doors' one call (ontology_update.ts importOntologyPackage,
 * data_io_import.ts importOntologyFile): the rewrite, its operator line, and the
 * NON-FATAL failure posture of the module header — a throw is logged and becomes a
 * message, never an import error (the legacy shape stays fully readable).
 */
export async function importedMachineNameMessages(sectionTipo: string): Promise<string[]> {
	try {
		const line = importedMachineNameLine(
			sectionTipo,
			await convertImportedMachineNames(sectionTipo),
		);
		return line === null ? [] : [line];
	} catch (error) {
		console.error(`[${ONTOLOGY_MACHINE_NAMES}] import rewrite of ${sectionTipo} failed:`, error);
		return [
			`${sectionTipo}: machine-name conversion skipped (see the server log) — the records keep the legacy shape; reconcile ${ONTOLOGY_MACHINE_NAMES} converts them`,
		];
	}
}
