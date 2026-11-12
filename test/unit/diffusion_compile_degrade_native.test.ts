/**
 * DIFFUSION field-local degradation + ddo-fn loudness gates
 * (audit 2026-08_oh1_beta B3 + §5.3 publishing majors).
 *
 * THE GUARANTEES under test:
 *
 * 1. B3 — ONE dangling ddo tipo must not abort the whole element. The oracle
 *    (diffusion_chain_processor::resolve_ddo_value :133-152 → component_common
 *    ::get_instance :394-406) logs "Component instance not found" and returns
 *    [] for THAT ddo, leaving the rest of the field and every other field of
 *    the element publishable. The TS compiler aborted the element instead, so
 *    the real oral-history element `mht2` (4 bibliography fields pointing at
 *    the absent Zenon tipos zzabsent4/5/6/9) could not compile at all.
 *    Degradation is per ddo ENTRY, recorded structurally on the plan, and
 *    surfaced on the run — never silent. It degrades the VALUE, never the
 *    SHAPE: the oracle derives a datum's `columns` from the FULL ddo_map
 *    (build_datum_context :1288-1308, with no ontology lookup at all), so the
 *    dangling entry KEEPS its place in the chain and its empty column slot.
 *
 * 1b. The dd1758 retry is SERIALIZED across concurrent runners and its
 *    unredeemed debt reaches the job row (not only stderr).
 *
 * 2. Genuinely STRUCTURAL failures stay fatal: the SQL identifier chokepoint
 *    (DIFFUSION_SPEC §8.3) and an unknown parser fn (§5) still refuse the
 *    whole element, and a compile that fails for one of those still REPORTS
 *    the degradations gathered on the way.
 *
 * 3. An unported/unresolvable component ddo fn is a LOUD per-field error, not
 *    an empty emission. `map_section_id_to_subtitles_url` (zzc546, the AV
 *    subtitles URL) published silently empty — no atoms, no error, validate
 *    clean — which is the worst possible outcome: a publish that looks
 *    successful and is not.
 *
 * 4. A media ddo's `options.quality` / `options.extension` select the tier
 *    (component_media_common::get_diffusion_data :530-560); an option the
 *    engine does not implement is refused loudly instead of ignored.
 *
 * 5. The dd1758 unpublish queue is retried OPPORTUNISTICALLY on a publish run
 *    (PHP dd_diffusion_api::diffuse :171-183, first chunk only), not only when
 *    an administrator presses the manual button — a deleted interview whose
 *    delete propagation failed must not stay live on the public site. The
 *    automatic door is NOT single-operator the way the manual one was, so the
 *    drain is single-flighted across concurrent runners, and the debt it could
 *    not redeem reaches the job row rather than only stderr.
 *
 * Ledger: engineering/wire_contract/WC-2026-08-09-diffusion-degradation-and-loud-ddo-fns.md
 * (1, 3 and 5 restore PHP; the run REPORT becoming stricter than PHP's, and the
 * refusal of the media options this engine cannot reproduce, are the divergences).
 *
 * HERMETIC: the plan compiler's ontology reads are INJECTED (CompileOptions
 * tree + resolveModelByTipo), the retry and its single-flight are INJECTED,
 * and the fn dispatch and the media primitive are pure functions over a
 * hand-built MatrixRecord. No database, no writes.
 *
 * ...and hermetic about the CONFIG too: the media tiers are derived from the
 * component_av model spec and the URL from `config.mediaDir`, never hardcoded.
 * Hardcoding them made the tier assertion pass only on an install whose AV
 * default quality happened to differ from the requested one.
 */
// Migrated to the generic `test` TLD 2026-08-19. The suite is HERMETIC — the
// ontology is INJECTED (a stub tree + resolveModelByTipo), so every tipo is a
// label and nothing is looked up. The install names became scratch `zzc*`
// (the component graph) and `zzabsent*` (the package NO install carries — the
// dangling-ddo subject), and the record section is the generic `test6813`.
// The prose keeps the historical install names: a comment is not a binding.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { mediaTypeOf } from '../../src/core/concepts/media.ts';
import type { MatrixRecord } from '../../src/core/db/matrix.ts';
import type { PendingRetrySingleFlight } from '../../src/diffusion/jobs/pending_retry.ts';
import { retryPendingUnpublishOpportunistically } from '../../src/diffusion/jobs/pending_retry.ts';
import { merge } from '../../src/diffusion/parsers/parser_helper.ts';
import type { CompileOptions, ParserClassifier } from '../../src/diffusion/plan/compile.ts';
import {
	compileElementPlan,
	PlanCompileError,
	validateElementPlan,
} from '../../src/diffusion/plan/compile.ts';
import type { ResolveStep } from '../../src/diffusion/plan/types.ts';
import type {
	OntologyIndex,
	RawOntologyNode,
	VirtualDiffusionTree,
	VirtualTreeNode,
} from '../../src/diffusion/plan/virtual_tree.ts';
import { createSvgTagPathMemo } from '../../src/diffusion/resolve/ddo_fns.ts';
import { defaultPublicationValue } from '../../src/diffusion/resolve/default_value.ts';
import { leafMergeColumns, resolveComponentFnAtoms } from '../../src/diffusion/resolve/resolver.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

// ---------------------------------------------------------------------------
// A synthetic virtual diffusion tree: one sql element → one database → one
// table → the field nodes each test declares. Everything the compiler reads
// is served from these literals, so the gate needs no ontology.
// ---------------------------------------------------------------------------

/** One field node declaration (what the ontology row would hold). */
interface FieldSpec {
	tipo: string;
	/** Structure-lang term = the published column name. */
	label: string;
	/** properties->process of the field node. */
	process?: Record<string, unknown>;
}

const ELEMENT_TIPO = 'el1';

function pathItems(): VirtualTreeNode['parents'] {
	return [
		{
			tipo: ELEMENT_TIPO,
			model: 'diffusion_element',
			label: 'Test element',
			realTipo: null,
			type: 'sql',
		},
	];
}

function buildTree(fields: FieldSpec[]): VirtualDiffusionTree {
	const fieldNodes = new Map<string, RawOntologyNode>(
		fields.map((field) => [
			field.tipo,
			{
				tipo: field.tipo,
				parent: 'tb1',
				model: 'field_text',
				term: { 'lg-spa': field.label },
				properties: field.process === undefined ? null : { process: field.process },
				relations: null,
			},
		]),
	);

	const index: OntologyIndex = {
		nodeOf: async (tipo) => fieldNodes.get(tipo) ?? null,
		childTipos: async () => [],
		relatedByModel: async () => [],
		relationTipos: async () => [],
		resolveAlias: async () => null,
	};

	const nodes: VirtualTreeNode[] = [
		{
			tipo: ELEMENT_TIPO,
			model: 'diffusion_element',
			label: 'Test element',
			properties: { diffusion: { type: 'sql' } },
			realTipo: null,
			isAlias: false,
			parents: [],
			childrenTipos: [],
			directChildrenTipos: ['db1'],
			relatedSections: [],
		},
		{
			tipo: 'db1',
			model: 'database',
			label: 'web_test',
			properties: null,
			realTipo: null,
			isAlias: false,
			parents: pathItems(),
			childrenTipos: [],
			directChildrenTipos: ['tb1'],
			relatedSections: [],
		},
		{
			tipo: 'tb1',
			model: 'table',
			label: 'interview',
			properties: null,
			realTipo: null,
			isAlias: false,
			parents: pathItems(),
			childrenTipos: fields.map((field) => field.tipo),
			directChildrenTipos: fields.map((field) => field.tipo),
			relatedSections: ['test6813'],
		},
	];

	return { domainName: 'test', domainTipo: 'dom1', nodes, index };
}

/**
 * The injected model resolver: the ontology this gate pretends to have. Any
 * tipo not listed is DANGLING (the zzabsent4/5/6/9 situation on the real mht2).
 */
const MODELS: Record<string, string> = {
	zzc36: 'component_text_area',
	zzc175: 'component_section_id',
	zzc35: 'component_av',
	// CANONICAL models, i.e. what the injected resolver's real twin
	// (ontology/resolver.ts getModelByTipo) returns: zzc368 is stored as the
	// legacy `component_autocomplete`, whose descriptor aliases it to
	// component_portal — and only the RESOLVED model makes it a relation hop.
	zzc368: 'component_portal',
	// Real model of the live mht ontology (dd_ontology of dedalo7_mht), so the
	// mht2 topology case reproduces a true chain.
	zzc140: 'component_input_text',
	// the info family: component_info and its two legacy aliases
	zzcinfo: 'component_info',
	zzcstate: 'component_state',
	zzccalc: 'component_calculation',
};

const compileOptions = (fields: FieldSpec[]): CompileOptions => ({
	tree: buildTree(fields),
	classifyParserFn: ((fn) =>
		fn.startsWith('parser_') ? 'runtime' : 'unknown') as ParserClassifier,
	resolveModelByTipo: async (tipo) => MODELS[tipo] ?? null,
});

/** A ddo_map entry as v7 properties stores it. */
const ddo = (tipo: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	tipo,
	section_tipo: 'self',
	parent: 'self',
	...extra,
});

// ---------------------------------------------------------------------------
// 1. A ddo of an UNINSTALLED package is skipped (2026-08-11, supersedes B3)
// ---------------------------------------------------------------------------
//
// B3 (2026-08-09) kept a dangling ddo in the chain as a `degraded` step so the
// field's column topology could not shift. That was REVERSED on 2026-08-11 in
// favour of the TLD split (compile.ts uninstalledTldOf): an absent optional
// PACKAGE is skipped outright, a missing node inside an INSTALLED package is an
// authoring defect and stays fatal. These tests now pin the reversal — INCLUDING
// the oracle divergence it accepts, which is asserted rather than glossed.
//
// `zenon*` is the real mht2 case AND an uninstalled package on every install
// that does not use the DAI catalogue; the install-independent twin of these
// scenarios lives in diffusion_plan_uninstalled_tld.test.ts.

describe('a ddo of an uninstalled package is skipped, never fatal', () => {
	test('the element still compiles; the skip is a WARNING, not a degradation', async () => {
		const plan = await compileElementPlan(
			ELEMENT_TIPO,
			compileOptions([
				{ tipo: 'f_ok', label: 'title', process: { ddo_map: [ddo('zzc36')] } },
				{
					tipo: 'f_dangling',
					label: 'ref_publications_title',
					process: { ddo_map: [ddo('zzabsent4')] },
				},
			]),
		);

		// The element compiled: a 98-record run is possible again.
		expect(plan.sections).toHaveLength(1);
		const section = plan.sections[0];
		if (section === undefined) throw new Error('no section compiled');
		expect(section.fields.map((field) => field.columnName)).toEqual([
			'title',
			'ref_publications_title',
		]);

		// The FIELD survives with its column — which packages an install carries
		// must not reshape the published schema at field level. The ddo itself is
		// gone from the chain (the 2026-08-11 reversal; B3 kept it as `degraded`).
		const skipped = section.fields.find((field) => field.id === 'f_dangling');
		expect(skipped?.sourceChain).toEqual([]);

		// Skipped, never silent — but a WARNING now, not a PlanDegradation.
		expect(plan.warnings).toContain('uninstalled-tld:zzabsent@f_dangling');
		expect(plan.degradations).toEqual([]);
	});

	test('a PARTIALLY skipped chain keeps its resolvable ddos', async () => {
		const plan = await compileElementPlan(
			ELEMENT_TIPO,
			compileOptions([
				{
					tipo: 'f_mixed',
					label: 'ref_publications_url',
					process: {
						ddo_map: [
							ddo('zzc368'),
							{ tipo: 'zzc36', parent: 'zzc368' },
							{ tipo: 'zzabsent9', parent: 'zzc368' },
						],
					},
				},
			]),
		);
		const field = plan.sections[0]?.fields[0];
		// The skipped entry LEAVES the chain (no longer 1:1 with the ddo_map).
		expect(
			field?.sourceChain.map((step: ResolveStep) => ('tipo' in step ? step.tipo : '')),
		).toEqual(['zzc368', 'zzc36']);
		expect(field?.sourceChain.map((step: ResolveStep) => step.kind)).toEqual([
			'relation-hop',
			'component',
		]);
		expect(plan.warnings).toContain('uninstalled-tld:zzabsent@f_mixed');
	});

	test('THE degraded-element CASE: the skipped ddo loses its column — the ACCEPTED oracle divergence', async () => {
		// zzc1194 of the live mht ontology, verbatim (dedalo7_mht dd_ontology):
		// ddo_map [zzc368 (autocomplete hop), zzc140 under it, zzabsent4 under it],
		// no explicit parser → the parser-less merge path, merge:'string' with
		// `empty_columns` defaulting to TRUE.
		const plan = await compileElementPlan(
			ELEMENT_TIPO,
			compileOptions([
				{
					tipo: 'f_zzc1194',
					label: 'ref_publications_title',
					process: {
						ddo_map: [
							{ tipo: 'zzc368', section_tipo: 'self' },
							{ tipo: 'zzc140', label: 'Term', parent: 'zzc368' },
							{ tipo: 'zzabsent4', label: 'Term', parent: 'zzc368' },
						],
					},
				},
			]),
		);
		const field = plan.sections[0]?.fields[0];
		if (field === undefined) throw new Error('no field compiled');

		// PHP leaf rule (:1294): parents = {zzc368}; every other ddo is a column,
		// INCLUDING zzabsent4 — the oracle never looks its tipo up, so IT publishes
		// two columns here. We publish one: the skipped ddo takes its column with
		// it. That is the cost of the 2026-08-11 reversal, pinned here so it can
		// never be mistaken for an accident.
		expect(leafMergeColumns(field.sourceChain)).toEqual([
			{ tipo: 'zzc140', model: 'component_input_text' },
		]);

		// The divergence in published BYTES, stated exactly: the oracle joins
		// 'Historia' with the empty zzabsent4 slot and emits 'Historia, '; this
		// engine emits 'Historia'. Only on an install missing the package.
		const merged = merge(
			[
				{
					id: null,
					value: 'Historia',
					tipo: 'zzc140',
					lang: 'lg-spa',
					section_id: '4649',
					section_tipo: 'test3',
				},
			],
			{ columns: leafMergeColumns(field.sourceChain), merge: 'string' },
			{ langs: ['lg-spa'], mainLang: 'lg-spa' },
		);
		expect(merged?.map((item) => item.value)).toEqual(['Historia']);
	});

	test('ddos hanging under a SKIPPED one are unreachable, and add no phantom column', async () => {
		// The children keep a `parent` naming the skipped ddo, so they land in a
		// chainTreeOf bucket no walk ever visits (resolver.ts: roots are the ''
		// bucket) — unreachable, exactly like the subtree of a hop that resolved
		// no locators. What matters is that they invent nothing: no orphan is
		// promoted to root, and the leaf-column set is unchanged.
		const plan = await compileElementPlan(
			ELEMENT_TIPO,
			compileOptions([
				{
					tipo: 'f_subtree',
					label: 'ref_publications_url',
					process: {
						ddo_map: [
							ddo('zzabsent9'),
							{ tipo: 'zzc36', parent: 'zzabsent9' },
							{ tipo: 'zzc368', parent: 'zzc36' },
						],
					},
				},
			]),
		);
		expect(plan.warnings).toContain('uninstalled-tld:zzabsent@f_subtree');
		const field = plan.sections[0]?.fields[0];
		if (field === undefined) throw new Error('no field compiled');
		// The orphan still POINTS at the skipped ddo — that is what keeps it out
		// of the root bucket. If this ever became `undefined`, zzc36 would run
		// against the section itself and publish data the oracle never emits.
		const orphan = field.sourceChain.find(
			(step: ResolveStep) => step.kind !== 'system' && step.tipo === 'zzc36',
		);
		expect(orphan !== undefined && orphan.kind !== 'system' ? orphan.parent : null).toBe(
			'zzabsent9',
		);
		// Leaf columns unchanged: zzc36 is still a parent, zzc368 still the one leaf.
		expect(leafMergeColumns(field.sourceChain).map((column) => column.tipo)).toEqual(['zzc368']);
	});

	test('a SKIPPED first ddo does not promote the second (no invented output_format)', async () => {
		// PHP reads the model of ddo_map[0] for the output_format fallback; a
		// tipo that is not in the ontology has none, so there is no fallback.
		// This is the ONE place the 2026-08-11 reversal was NOT allowed to reach:
		// the fallback reads ddo_map[0], never sourceChain[0], so skipping zzabsent5
		// cannot promote the relation-family zzc368 and stamp a 'json' format the
		// oracle never picks. Delete that and this goes green->wrong silently.
		const plan = await compileElementPlan(
			ELEMENT_TIPO,
			compileOptions([
				{
					tipo: 'f_first',
					label: 'ref_publications_authors',
					process: { ddo_map: [ddo('zzabsent5'), ddo('zzc368')] },
				},
			]),
		);
		expect(plan.sections[0]?.fields[0]?.outputFormat).toBeUndefined();
	});

	test('EVERY skipped ddo is reported, not just the first', async () => {
		const plan = await compileElementPlan(
			ELEMENT_TIPO,
			compileOptions([
				{ tipo: 'f_a', label: 'ref_publications_title', process: { ddo_map: [ddo('zzabsent4')] } },
				{
					tipo: 'f_b',
					label: 'ref_publications_authors',
					process: { ddo_map: [ddo('zzabsent5')] },
				},
				{ tipo: 'f_c', label: 'ref_publications_date', process: { ddo_map: [ddo('zzabsent6')] } },
				{ tipo: 'f_d', label: 'ref_publications_url', process: { ddo_map: [ddo('zzabsent9')] } },
			]),
		);
		// One warning per FIELD, naming the package — four fields, four lines. The
		// mht2 run reported nothing at all before any of this landed.
		expect(plan.warnings.filter((warning) => warning.startsWith('uninstalled-tld:'))).toEqual([
			'uninstalled-tld:zzabsent@f_a',
			'uninstalled-tld:zzabsent@f_b',
			'uninstalled-tld:zzabsent@f_c',
			'uninstalled-tld:zzabsent@f_d',
		]);
	});

	test('validate reports the skips alongside the compiled plan', async () => {
		const validation = await validateElementPlan(
			ELEMENT_TIPO,
			compileOptions([
				{
					tipo: 'f_dangling',
					label: 'ref_publications_title',
					process: { ddo_map: [ddo('zzabsent4')] },
				},
			]),
		);
		expect(validation.errors).toEqual([]);
		expect(validation.result).not.toBeNull();
		expect(validation.warnings).toContain('uninstalled-tld:zzabsent@f_dangling');
	});
});

// ---------------------------------------------------------------------------
// 2. Structural failures stay fatal
// ---------------------------------------------------------------------------

describe('structural failures stay FATAL (the chokepoints are deliberate)', () => {
	test('an invalid SQL column identifier still refuses the whole element', async () => {
		const promise = compileElementPlan(
			ELEMENT_TIPO,
			compileOptions([{ tipo: 'f_bad', label: '3d', process: { ddo_map: [ddo('zzc36')] } }]),
		);
		await expect(promise).rejects.toThrow(PlanCompileError);
	});

	test('an unknown parser fn still refuses the whole element (spec §5)', async () => {
		const promise = compileElementPlan(
			ELEMENT_TIPO,
			compileOptions([
				{
					tipo: 'f_parser',
					label: 'title',
					process: { ddo_map: [ddo('zzc36')], parser: [{ fn: 'nonesuch::method' }] },
				},
			]),
		);
		await expect(promise).rejects.toThrow(/unknown parser fn/);
	});

	test('a fatal compile STILL reports the warnings gathered on the way', async () => {
		const validation = await validateElementPlan(
			ELEMENT_TIPO,
			compileOptions([
				{
					tipo: 'f_dangling',
					label: 'ref_publications_title',
					process: { ddo_map: [ddo('zzabsent4')] },
				},
				{ tipo: 'f_bad', label: '3d', process: { ddo_map: [ddo('zzc36')] } },
			]),
		);
		expect(validation.result).toBeNull();
		expect(validation.errors.join(' ')).toMatch(/Invalid column identifier/);
		// The skip that happened BEFORE the fatal field is still reported: an
		// operator debugging the failure sees the whole picture, not just the throw.
		expect(validation.warnings).toContain('uninstalled-tld:zzabsent@f_dangling');
	});
});

// ---------------------------------------------------------------------------
// 3. ddo fns: ported ones resolve, unported ones are LOUD
// ---------------------------------------------------------------------------

/** A minimal loaded record (only what the pure fn dispatch reads). */
function recordOf(sectionId: number, columns: MatrixRecord['columns'] = {}): MatrixRecord {
	return { id: 1, section_id: sectionId, section_tipo: 'test6813', columns, rawText: {} };
}

const fnEnv = {
	langs: ['lg-spa', 'lg-eng'],
	pairedGeolocationTipo: async () => null,
	svgTagPathMemo: createSvgTagPathMemo(),
};

const componentStep = (
	tipo: string,
	model: string,
	fn: string,
): Extract<ResolveStep, { kind: 'component' }> => ({
	kind: 'component',
	tipo,
	model,
	sectionTipo: 'test6813',
	fn,
});

describe('a ddo fn either resolves or fails LOUDLY (never a silent empty publish)', () => {
	test('map_section_id_to_subtitles_url emits one URL per diffusion lang', async () => {
		const atoms = await resolveComponentFnAtoms(
			fnEnv,
			recordOf(1),
			componentStep('zzc175', 'component_section_id', 'map_section_id_to_subtitles_url'),
		);
		expect(atoms).toEqual([
			{
				kind: 'scalar',
				value: '/dedalo/publication/server_api/v1/subtitles/?section_id=1&lang=lg-spa',
				lang: 'lg-spa',
				meta: { tipo: 'zzc175' },
			},
			{
				kind: 'scalar',
				value: '/dedalo/publication/server_api/v1/subtitles/?section_id=1&lang=lg-eng',
				lang: 'lg-eng',
				meta: { tipo: 'zzc175' },
			},
		]);
	});

	test('an UNPORTED fn throws even when the component slice is EMPTY', async () => {
		// hierarchy83's map_target_section_tipo: latent today because the slice is
		// usually empty — which is exactly how it stayed invisible.
		const promise = resolveComponentFnAtoms(
			fnEnv,
			recordOf(1),
			componentStep('hierarchy53', 'component_input_text', 'map_target_section_tipo'),
		);
		await expect(promise).rejects.toThrow(/map_target_section_tipo/);
	});
});

/**
 * PHP component_info::get_diffusion_data OVERRIDES the common one, so a ddo fn
 * on an info-family component never ran: the live widget compute IS the value
 * (resolve/info_value.ts). The compiler keeps the fn OFF the step — and says
 * so (`info-fn-ignored:<fn>@<field>`), or the narrowing would be silent.
 */
describe('a ddo fn on an info-family component is dropped LOUDLY', () => {
	const FN = 'map_section_id_to_subtitles_url';
	const stepOf = (plan: Awaited<ReturnType<typeof compileElementPlan>>, fieldId: string) =>
		plan.sections[0]?.fields.find((field) => field.id === fieldId)?.sourceChain[0];

	test('info / state / calculation: no step.fn, one warning per field', async () => {
		const infoTipos = ['zzcinfo', 'zzcstate', 'zzccalc'];
		const plan = await compileElementPlan(
			ELEMENT_TIPO,
			compileOptions([
				...infoTipos.map((tipo) => ({
					tipo: `f_${tipo}`,
					label: `col_${tipo}`,
					process: { ddo_map: [ddo(tipo, { fn: FN })] },
				})),
				// control: the SAME fn on a non-info component is kept
				{ tipo: 'f_text', label: 'col_text', process: { ddo_map: [ddo('zzc175', { fn: FN })] } },
			]),
		);
		for (const tipo of infoTipos) {
			const step = stepOf(plan, `f_${tipo}`);
			expect(step?.kind).toBe('component');
			expect(step !== undefined && 'fn' in step).toBe(false);
			expect(plan.warnings).toContain(`info-fn-ignored:${FN}@f_${tipo}`);
		}
		const control = stepOf(plan, 'f_text') as { fn?: string } | undefined;
		expect(control?.fn).toBe(FN);
		expect(plan.warnings.filter((w) => w.startsWith('info-fn-ignored:'))).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// 4. Media ddo options
// ---------------------------------------------------------------------------

describe('a media ddo honours options.quality / options.extension', () => {
	// HERMETIC BY CONSTRUCTION. The first version of this suite hardcoded
	// 'original' as the requested tier and '/dedalo/media/...' as the expected
	// URL, which only proved anything because THIS install happens to default
	// component_av to quality '404' and DEDALO_MEDIA_DIR to 'media'. On an
	// install whose AV default is 'original' the test stayed green while
	// asserting nothing — the silent vacuity the testing rules exist to stop.
	// So the tiers are DERIVED from the model spec, the requested one is
	// asserted to differ from the default, and the URL is built from config.
	const avSpec = mediaTypeOf('component_av');
	if (avSpec === null) throw new Error('component_av is not a media model');
	const defaultQuality = avSpec.defaultQuality;
	const requestedQuality = avSpec.qualities.find((quality) => quality !== defaultQuality);
	if (requestedQuality === undefined) {
		throw new Error('component_av declares a single quality — the tier test cannot mean anything');
	}
	const extension = avSpec.defaultExtension;
	const urlOf = (quality: string): string =>
		`/dedalo/${config.mediaDir}/av/${quality}/7.${extension}`;

	// component_av stores in the `media` jsonb column (getColumnNameByModel).
	const mediaRecord = recordOf(7, {
		media: {
			zzc35: [
				{
					files_info: [
						{
							quality: defaultQuality,
							extension,
							file_exist: true,
							file_path: `/av/${defaultQuality}/7.${extension}`,
						},
						{
							quality: requestedQuality,
							extension,
							file_exist: true,
							file_path: `/av/${requestedQuality}/7.${extension}`,
						},
					],
				},
			],
		},
	} as MatrixRecord['columns']);

	const publishedUrlOf = (ddoOptions?: Record<string, unknown>): unknown => {
		const atoms = defaultPublicationValue(
			mediaRecord,
			'zzc35',
			'component_av',
			{ tipo: 'zzc35' },
			ddoOptions,
		);
		expect(atoms).toHaveLength(1);
		return (atoms[0] as { value: unknown }).value;
	};

	test('the tiers under test are genuinely different (anti-vacuity guard)', () => {
		expect(requestedQuality).not.toBe(defaultQuality);
	});

	test('no options → the model default tier', () => {
		expect(publishedUrlOf()).toBe(urlOf(defaultQuality));
	});

	test('the requested quality wins over the default tier', () => {
		expect(publishedUrlOf({ quality: requestedQuality, extension })).toBe(urlOf(requestedQuality));
	});

	test('an option the engine does not implement is refused loudly', () => {
		expect(() =>
			defaultPublicationValue(
				mediaRecord,
				'zzc35',
				'component_av',
				{ tipo: 'zzc35' },
				{
					avoid_cache: true,
				},
			),
		).toThrow(/avoid_cache/);
	});

	test('an unimplemented option set FALSY publishes normally (PHP `?? false`)', () => {
		// component_media_common :530-536 reads every one of these as
		// `$ddo->options->x ?? false`, so spelling out PHP's own default is
		// semantically identical to omitting the key. Refusing on key PRESENCE
		// broke a ddo that asked for nothing this engine cannot do.
		expect(
			publishedUrlOf({ quality: requestedQuality, extension, absolute: false, test_file: false }),
		).toBe(urlOf(requestedQuality));
		expect(publishedUrlOf({ default_add: 0, avoid_cache: '', test_file: null })).toBe(
			urlOf(defaultQuality),
		);
	});

	test('...and the SAME option set truthy is still refused', () => {
		expect(() => publishedUrlOf({ absolute: true })).toThrow(/absolute/);
		expect(() => publishedUrlOf({ test_file: 'placeholder.jpg' })).toThrow(/test_file/);
	});
});

// ---------------------------------------------------------------------------
// 5. Opportunistic dd1758 unpublish retry (PHP dd_diffusion_api::diffuse :174)
// ---------------------------------------------------------------------------

describe('the dd1758 unpublish queue is retried opportunistically on every run', () => {
	/** A single-flight that always wins the lock (the uncontended runner). */
	const uncontended: PendingRetrySingleFlight = (work) => work();

	test('a debt STILL OWED after the retry reaches the job row, not only stderr', async () => {
		const report = await retryPendingUnpublishOpportunistically(
			async () => ({ total: 3, retried: 2, remaining: 1 }),
			uncontended,
		);
		// errors[], because one record the archive deleted is still live on the
		// public site. The header used to promise "report lines the run report
		// prints" while the runner only console.error'd them.
		expect(report.errors.join(' ')).toMatch(/3 row\(s\) owed/);
		expect(report.errors.join(' ')).toMatch(/retried 2/);
		expect(report.log).toEqual([]);
	});

	test('a FULLY drained queue is a log line, never an error', async () => {
		// The system worked. Flipping the run to "Partial success" for it would
		// make the one signal that matters meaningless.
		const report = await retryPendingUnpublishOpportunistically(
			async () => ({ total: 3, retried: 3, remaining: 0 }),
			uncontended,
		);
		expect(report.errors).toEqual([]);
		expect(report.log.join(' ')).toMatch(/retried 3/);
	});

	test('an empty queue is silent', async () => {
		const report = await retryPendingUnpublishOpportunistically(
			async () => ({ total: 0, retried: 0, remaining: 0 }),
			uncontended,
		);
		expect(report).toEqual({ log: [], errors: [] });
	});

	test('a failing retry NEVER fails the publish run (PHP fire-and-forget) but IS reported', async () => {
		const report = await retryPendingUnpublishOpportunistically(async () => {
			throw new Error('target down');
		}, uncontended);
		expect(report.errors.join(' ')).toMatch(/target down/);
	});

	test('SERIALIZATION: a runner that loses the lock does not drain, and says nothing', async () => {
		// The manual door was implicitly single-operator; the automatic one runs
		// on DEDALO_DIFFUSION_MAX_RUNNERS concurrent runners (2 by default), and
		// retryPendingDiffusion SELECTs its 100 rows with no claim. Two runners
		// draining in parallel = duplicate delete propagation to the target.
		let ran = 0;
		const report = await retryPendingUnpublishOpportunistically(
			async () => {
				ran++;
				return { total: 3, retried: 3, remaining: 0 };
			},
			async () => null, // another runner holds the advisory lock
		);
		expect(ran).toBe(0);
		expect(report).toEqual({ log: [], errors: [] });
	});

	test('the default single-flight takes a Postgres advisory lock on a RESERVED connection', () => {
		// A session-level advisory lock belongs to the connection that took it:
		// issued through the pool, the unlock could land elsewhere and leak the
		// lock for the life of the process. Asserted on the source because the
		// alternative is a two-process integration test for a one-line invariant.
		const source = readFileSync(join(REPO_ROOT, 'src/diffusion/jobs/pending_retry.ts'), 'utf8');
		expect(source).toContain('sql.reserve()');
		expect(source).toContain('pg_try_advisory_lock');
		expect(source).toContain('pg_advisory_unlock');
		expect(source).toContain('reserved.release()');
	});

	test('TRIPWIRE: the runner CALLS it, routes BOTH buckets, and seeds the plan degradations', () => {
		// Asserted on the call expressions, not the imports: importing a helper
		// and never invoking it — or invoking it and dropping half its result,
		// which is what the first version of this change did — is exactly the
		// regression this guards.
		const runner = readFileSync(join(REPO_ROOT, 'src/diffusion/runner.ts'), 'utf8');
		expect(runner).toContain('await retryPendingUnpublishOpportunistically()');
		expect(runner).toContain('planDegradationReportLines(plan)) trackError(');
		expect(runner).toContain('retryReport.errors) trackError(');
		expect(runner).toContain('retryReport.log)');
		// PHP guards the retry to the first chunk (dd_diffusion_api::diffuse
		// :174 `if (empty($rqo->sqo->offset))`): a checkpoint RESUME continues a
		// run that already paid this debt.
		expect(runner).toContain('isFirstInvocation');
	});
});
