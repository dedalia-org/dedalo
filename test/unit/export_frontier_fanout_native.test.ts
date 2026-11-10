/**
 * THE EXPORT FRONTIER COVERS THE FAN-OUT (T0-1 / S02, 2026-11-09).
 * Wire: WC-2026-11-09-export-frontier-fanout.
 *
 * The export frontier (src/core/security/frontier_scope.ts, EXPORT law: THROW)
 * used to guard only two crossings — a declared hop and a relation LEAF's own
 * targets (resolver.ts assertExportCrossing). Everything the walk reached
 * BEYOND them was read with no principal at all:
 *   - the fan-out of a relation leaf into its config children
 *     (atoms.ts fanOutRelation) at every depth ≥ 1;
 *   - the same chains in the VALUE format and the WC-008 COMPACT cells, which
 *     reach depth ≥ 1 through relation_list.ts resolveCellValue's datalist
 *     recursion, not through the fan-out at all;
 *   - the dataframe FRAME TARGETS paired to a main locator.
 * So a record outside the caller's projects, two links away, exported its
 * value while the SAME record, reached by a declared path, refused the export.
 *
 * ADDENDUM 2026-11-09 (owner decision D4, WC-2026-11-09-export-relation-display):
 * a record the PLAIN column DISPLAYS (the host read embeds it) is no longer a
 * record-key crossing — the depth 0/1/2 and frame-target cases below now pin
 * scoped == admin. The REFUSES law still holds for the parents chain, the
 * media walk, the no-children / iri branches (the read expands no target
 * there), and everything export_relation_display_native gates.
 *
 * WHAT THIS FILE PROVES, per crossing × format (value, grid_value fan-out,
 * WC-008 compact):
 *   REFUSES  a scoped caller's export THROWS `perm.export_column_out_of_scope`
 *            (owner decision D2, 2026-11-09) naming the COLUMN, and its answer
 *            names neither sentinel;
 *   NON-VACUOUS the global admin exports the hidden value — and DIFFERENT
 *            bytes per sentinel — so the probe measures something;
 *   LAWFUL   with every record in the caller's project the scoped export
 *            SUCCEEDS and carries the deep values, although the profile grants
 *            NOTHING on the target sections' components: a curator-configured
 *            (explicit) child is read at the subdatum floor, exactly as the
 *            edit form shows it (owner decision D3) — and a dangling deep
 *            locator refuses nothing.
 * Plus the WC-049 PARENTS chain (atoms.ts resolveParentsChain — an ancestor is
 * another record), and the dedalo_raw MEDIA walk (atoms.ts walkMediaReads): what it reads
 * leaves the system as FILES in the export archive, so a depth-2 image of a
 * hidden record must refuse the export, not be captured.
 *
 * THE SITUATION IS BUILT (`zzxg`, dropped in afterAll, residue 0) — one chain
 * A → B → C → E, plus a dataframe on A paired to the A→B locator whose frame
 * lands in D. Every section is project-gated by its own component_filter;
 * each probe flips ONE record into the OTHER project and writes the sentinel
 * into it:
 *   zzxg1  A (root)  zzxg2 filter · zzxg3 autocomplete P → B [zzxg12, zzxg13, zzxg4]
 *                    zzxg4 dataframe F (child of P) → D [zzxg42]
 *                    zzxg5 portal Q → B [zzxg12, zzxg13]   (WC-008 compact)
 *   zzxg10 B         zzxg11 filter · zzxg12 label · zzxg13 autocomplete R → C [zzxg22, zzxg23]
 *                    zzxg14 relation_parent · zzxg15 section_map (term zzxg12) — B record 2
 *                    is record 1's ANCESTOR in the WC-049 parents-chain probe
 *   zzxg20 C         zzxg21 filter · zzxg22 label · zzxg23 autocomplete R2 → E [zzxg32]
 *   zzxg30 E         zzxg31 filter · zzxg32 label · zzxg33 image (the media-ZIP probe)
 *   zzxg40 D         zzxg41 filter · zzxg42 label
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { sql } from '../../src/core/db/postgres.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import type { ToolActionContext, ToolResponse } from '../../src/core/tools/module.ts';
import { clearTermCache } from '../../src/core/ts_object/term_resolver.ts';
import { openExportGrid } from '../../src/diffusion/export/index.ts';
import { EXPORT_ROW_MEDIA } from '../../src/diffusion/export/row_media.ts';
import { toolExportGetExportGrid } from '../../tools/tool_export/server/tool_export.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { exportFrontierIdentity } from '../helpers/export_frontier_identity.ts';
import { hostColumnDisplayedValues, hostSectionReadItems } from '../helpers/host_section_read.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

const A = 'zzxg1';
const A_FILTER = 'zzxg2';
const P = 'zzxg3';
const F = 'zzxg4';
const Q = 'zzxg5';
/** An implicit select whose relations name ONLY section B: no label children. */
const SEL = 'zzxg6';
/** A component_iri whose dd560 label frame lands in E. */
const IRI = 'zzxg7';
const IRI_FRAME = 'dd560';
const B = 'zzxg10';
const B_FILTER = 'zzxg11';
const B_LABEL = 'zzxg12';
const R = 'zzxg13';
const B_PARENT = 'zzxg14';
const B_MAP = 'zzxg15';
const C = 'zzxg20';
const C_FILTER = 'zzxg21';
const C_LABEL = 'zzxg22';
const R2 = 'zzxg23';
const E = 'zzxg30';
const E_FILTER = 'zzxg31';
const E_LABEL = 'zzxg32';
const E_IMAGE = 'zzxg33';
const E_IMAGE_PATH = '/image/1.5MB/0/zzxg_hidden.jpg';
const D = 'zzxg40';
const D_FILTER = 'zzxg41';
const D_LABEL = 'zzxg42';

const SENTINEL_ALPHA = 'zzxg alpha kestrel manuscript';
const SENTINEL_BRAVO = 'zzxg bravo obsidian reliquary';

const REFUSAL = 'perm.export_column_out_of_scope';

const ID = new (class {
	readonly root = 1;
	readonly b = 1;
	readonly c = 1;
	readonly e = 1;
	readonly d = 1;
	/** The b record's PARENT (a B record too) — the WC-049 parents-chain probe. */
	readonly bParent = 2;
	/** A C record no row holds — the dangling deep locator. */
	readonly missingC = 999;
})();

const identity = exportFrontierIdentity('export_frontier_fanout', 933500);

const LANG = 'lg-eng';

registerSessionCleanup();
const term = (value: string) => ({ [LANG]: value });
const text = (tipo: string, value: string) => ({ [tipo]: [{ id: 1, lang: LANG, value }] });

/** An explicit request_config: target section + child ddos ('self'-parented). */
const requestConfig = (targetSection: string, ddoTipos: string[]) => ({
	source: {
		request_config: [
			{
				sqo: { section_tipo: [{ value: [targetSection], source: 'section' }] },
				show: {
					ddo_map: ddoTipos.map((tipo) => ({ tipo, parent: 'self', section_tipo: 'self' })),
				},
			},
		],
	},
});

const section = (tipo: string, label: string) => ({
	tipo,
	parent: 'test1',
	model: 'section',
	term: term(label),
	relations: [{ tipo: 'test24' }],
});
const filter = (tipo: string, parent: string) => ({
	tipo,
	parent,
	model: 'component_filter',
	term: term(`${tipo} projects`),
});
const label = (tipo: string, parent: string) => ({
	tipo,
	parent,
	model: 'component_input_text',
	term: term(`${tipo} label`),
	is_translatable: true,
});

const relationLocator = (from: string, sectionTipo: string, sectionId: number, id = 1) => ({
	id,
	type: 'dd151',
	section_tipo: sectionTipo,
	section_id: sectionId,
	from_component_tipo: from,
});

const S = situation({
	name: 'export frontier fan-out',
	tld: 'zzxg',
	nodes: [
		section(A, 'zz fan root'),
		filter(A_FILTER, A),
		{
			tipo: P,
			parent: A,
			model: 'component_autocomplete',
			term: term('zz fan main'),
			properties: requestConfig(B, [B_LABEL, R, F]),
		},
		{
			tipo: F,
			parent: P,
			model: 'component_dataframe',
			order_number: 2,
			term: term('zz fan frame'),
			properties: requestConfig(D, [D_LABEL]),
		},
		{
			tipo: Q,
			parent: A,
			model: 'component_portal',
			term: term('zz fan compact'),
			properties: requestConfig(B, [B_LABEL, R]),
		},
		{
			tipo: SEL,
			parent: A,
			model: 'component_select',
			term: term('zz fan select'),
			relations: [{ tipo: B }],
		},
		{ tipo: IRI, parent: A, model: 'component_iri', term: term('zz fan iri') },
		section(B, 'zz fan b'),
		filter(B_FILTER, B),
		label(B_LABEL, B),
		// B is a hierarchy: its records chain through B_PARENT, its term is B_LABEL
		{ tipo: B_PARENT, parent: B, model: 'component_relation_parent', term: term('zz fan parent') },
		{
			tipo: B_MAP,
			parent: B,
			model: 'section_map',
			term: term('zz fan map'),
			properties: { thesaurus: { term: B_LABEL, parent: B_PARENT } },
		},
		{
			tipo: R,
			parent: B,
			model: 'component_autocomplete',
			term: term('zz fan r'),
			properties: requestConfig(C, [C_LABEL, R2]),
		},
		section(C, 'zz fan c'),
		filter(C_FILTER, C),
		label(C_LABEL, C),
		{
			tipo: R2,
			parent: C,
			model: 'component_autocomplete',
			term: term('zz fan r2'),
			properties: requestConfig(E, [E_LABEL, E_IMAGE]),
		},
		section(E, 'zz fan e'),
		filter(E_FILTER, E),
		label(E_LABEL, E),
		{ tipo: E_IMAGE, parent: E, model: 'component_image', term: term('zz fan image') },
		section(D, 'zz fan d'),
		filter(D_FILTER, D),
		label(D_LABEL, D),
	],
});

/** Every gated record of the chain: where it lives and what it holds. */
const CHAIN: Record<
	string,
	{ section: string; id: number; filter: string; label: string; relation?: Record<string, unknown> }
> = {
	root: {
		section: A,
		id: ID.root,
		filter: A_FILTER,
		label: '',
		relation: {
			[P]: [relationLocator(P, B, ID.b, 1)],
			[Q]: [relationLocator(Q, B, ID.b, 1)],
			[SEL]: [relationLocator(SEL, B, ID.b, 1)],
			[IRI_FRAME]: [
				{
					id: 1,
					type: 'dd490',
					id_key: 1,
					section_tipo: E,
					section_id: ID.e,
					from_component_tipo: IRI_FRAME,
					main_component_tipo: IRI,
				},
			],
			[F]: [
				{
					id: 1,
					type: 'dd490',
					id_key: 1,
					section_tipo: D,
					section_id: ID.d,
					from_component_tipo: F,
					main_component_tipo: P,
				},
			],
		},
	},
	b: {
		section: B,
		id: ID.b,
		filter: B_FILTER,
		label: B_LABEL,
		relation: { [R]: [relationLocator(R, C, ID.c)] },
	},
	bParent: { section: B, id: ID.bParent, filter: B_FILTER, label: B_LABEL },
	c: {
		section: C,
		id: ID.c,
		filter: C_FILTER,
		label: C_LABEL,
		relation: { [R2]: [relationLocator(R2, E, ID.e)] },
	},
	e: { section: E, id: ID.e, filter: E_FILTER, label: E_LABEL },
	d: { section: D, id: ID.d, filter: D_FILTER, label: D_LABEL },
};

/** Lawful values each chain record holds while it sits in MY project. */
const LAWFUL: Record<string, string> = {
	b: 'zzxg value b',
	c: 'zzxg value c',
	e: 'zzxg value e',
	d: 'zzxg value d',
	bParent: 'zzxg value parent',
};

async function writeRecord(
	key: string,
	project: number,
	value: string,
	extraRelation: Record<string, unknown> = {},
): Promise<void> {
	const record = CHAIN[key] as (typeof CHAIN)[string];
	const relation = {
		[record.filter]: [identity.filterLocator(record.filter, project)],
		...(record.relation ?? {}),
		...extraRelation,
	};
	await sql.unsafe(`DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2`, [
		record.section,
		record.id,
	]);
	// the depth-2 record also holds an image file (the media-walk probe)
	const iri = key === 'root' ? { [IRI]: [{ id: 1, iri: 'https://example.org/zzxg' }] } : null;
	const media =
		key === 'e'
			? { [E_IMAGE]: [{ id: 1, files_info: [{ quality: 'original', file_path: E_IMAGE_PATH }] }] }
			: null;
	await sql.unsafe(
		`INSERT INTO matrix_test (section_tipo, section_id, relation, string, media, data, iri)
		 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb, $5::text::jsonb, $6::text::jsonb, $7::text::jsonb)`,
		[
			record.section,
			record.id,
			encodeForJsonb(relation),
			encodeForJsonb(record.label === '' ? {} : text(record.label, value)),
			encodeForJsonb(media),
			encodeForJsonb({ section_tipo: record.section, section_id: record.id }),
			encodeForJsonb(iri),
		],
	); // a raw write skips the engine's data-cache invalidation: the thesaurus
	// term memo (the parents chain reads it) would serve the previous value
	clearTermCache();
}

/** Every chain record back in MY project with its lawful value. */
async function resetChain(): Promise<void> {
	await writeRecord('root', identity.myProject, '');
	for (const key of ['b', 'c', 'e', 'd', 'bParent']) {
		await writeRecord(key, identity.myProject, LAWFUL[key] as string);
	}
}

const contextOf = (options: Record<string, unknown>, principal: Principal): ToolActionContext =>
	({ principal, userId: principal.userId, options, background: false }) as ToolActionContext;

type Shape = 'value' | 'fanout' | 'compact';

/** One export of the root record; the serialized answer a caller observes. */
async function exportAnswer(
	principal: Principal,
	shape: Shape,
	withParents = false,
	leafOverride?: string,
): Promise<string> {
	const leaf = leafOverride ?? (shape === 'compact' ? Q : P);
	const parents = withParents ? { value_with_parents: true } : {};
	const options = {
		section_tipo: A,
		lang: LANG,
		data_format: shape === 'value' ? 'value' : 'grid_value',
		breakdown: 'default',
		ar_ddo_to_export: [{ path: [{ section_tipo: A, component_tipo: leaf }], ...parents }],
		sqo: {
			section_tipo: [A],
			filter_by_locators: [{ section_tipo: A, section_id: ID.root }],
			limit: 10,
			offset: 0,
		},
	};
	try {
		const response: ToolResponse = await toolExportGetExportGrid(contextOf(options, principal));
		return `OK:${JSON.stringify(response.data)}`;
	} catch (error) {
		const code = (error as { code?: string }).code ?? 'unknown';
		const details = (error as { details?: unknown }).details;
		return `REFUSED:${code}:${JSON.stringify(details ?? null)}`;
	}
}

/**
 * The dedalo_raw export with media capture on (the tool_export background
 * build's mode): the media addresses its rows carry, or the refusal.
 */
async function mediaAnswer(principal: Principal): Promise<string> {
	const options = {
		section_tipo: A,
		lang: LANG,
		data_format: 'dedalo_raw',
		breakdown: 'default',
		ar_ddo_to_export: [{ path: [{ section_tipo: A, component_tipo: P }] }],
		sqo: {
			section_tipo: [A],
			filter_by_locators: [{ section_tipo: A, section_id: ID.root }],
			limit: 10,
			offset: 0,
		},
	};
	try {
		const opened = await openExportGrid(
			{ principal, options: options as ToolActionContext['options'], applicationLang: LANG },
			{ captureMedia: true },
		);
		const media: string[] = [];
		for await (const line of opened.lines) {
			// ExportRowMediaAddress = [ddo index, section_tipo, section_id, component_tipo]
			const rowMedia = (line as { [EXPORT_ROW_MEDIA]?: unknown[][] })[EXPORT_ROW_MEDIA];
			for (const [, sectionTipo, sectionId, componentTipo] of rowMedia ?? []) {
				media.push(`${String(sectionTipo)}#${String(sectionId)}#${String(componentTipo)}`);
			}
		}
		return `OK:${media.join(',')}`;
	} catch (error) {
		const code = (error as { code?: string }).code ?? 'unknown';
		const details = (error as { details?: unknown }).details;
		return `REFUSED:${code}:${JSON.stringify(details ?? null)}`;
	}
}

/** Grants: the root section + the two declared columns, NOTHING on B/C/E/D. */
const SCOPED_GRANTS = [
	{ sectionTipo: A, tipo: A, level: 2 },
	{ sectionTipo: A, tipo: P, level: 2 },
	{ sectionTipo: A, tipo: Q, level: 2 },
	{ sectionTipo: A, tipo: SEL, level: 2 },
	{ sectionTipo: A, tipo: IRI, level: 2 },
];

/** The admin: level 3 on every section and component of the situation. */
const ADMIN_GRANTS = S.nodes
	.filter((node) => node.model !== 'section')
	.flatMap((node) => {
		// the owning section: walk up through component parents (a dataframe's parent is its main)
		let owner = S.nodes.find((candidate) => candidate.tipo === node.parent);
		while (owner !== undefined && owner.model !== 'section') {
			const up = owner.parent;
			owner = S.nodes.find((candidate) => candidate.tipo === up);
		}
		return owner === undefined ? [] : [{ sectionTipo: owner.tipo, tipo: node.tipo, level: 3 }];
	})
	.concat(S.sectionTipos.map((tipo) => ({ sectionTipo: tipo, tipo, level: 3 })));

describe.if(DB_READY)('the export frontier covers the fan-out (T0-1 / S02)', () => {
	beforeAll(async () => {
		await ensureSituation(S);
		await identity.install(SCOPED_GRANTS, ADMIN_GRANTS);
		await resetChain();
	}, 120_000);

	afterAll(async () => {
		await identity.remove(true);
		expect(await dropSituation(S)).toBe(0);
	});

	describe('LAWFUL — every record in my project: the scoped export succeeds', () => {
		for (const shape of ['value', 'fanout', 'compact'] as const) {
			test(`${shape}: deep explicit children export at the subdatum floor (no grant on B/C/E)`, async () => {
				await resetChain();
				const answer = await exportAnswer(identity.scoped, shape);
				expect(answer.startsWith('OK:'), answer).toBe(true);
				// depth 0 (b), depth 1 (c) and depth 2 (e) all reach the deliverable
				expect(answer).toContain(LAWFUL.b as string);
				expect(answer).toContain(LAWFUL.c as string);
				expect(answer).toContain(LAWFUL.e as string);
				if (shape !== 'compact') expect(answer).toContain(LAWFUL.d as string);
			});
		}

		test('a DANGLING deep locator refuses nothing', async () => {
			await resetChain();
			await writeRecord('b', identity.myProject, LAWFUL.b as string, {
				[R]: [relationLocator(R, C, ID.missingC)],
			});
			const answer = await exportAnswer(identity.scoped, 'fanout');
			expect(answer.startsWith('OK:'), answer).toBe(true);
			expect(answer).toContain(LAWFUL.b as string);
		});
	});

	describe('the dedalo_raw MEDIA walk crosses the same frontier', () => {
		// dedalo_raw mints a raw column per dataframe of the top component, and
		// Gate B asks the bare grant on it (grid.ts, unchanged by T0-1).
		beforeAll(() =>
			identity.setScopedGrants([...SCOPED_GRANTS, { sectionTipo: A, tipo: F, level: 1 }]),
		);
		afterAll(() => identity.setScopedGrants(SCOPED_GRANTS));

		test('LAWFUL: the depth-2 image of an in-scope record is captured for the scoped caller', async () => {
			await resetChain();
			const answer = await mediaAnswer(identity.scoped);
			expect(answer, answer).toContain(`${E}#${ID.e}#${E_IMAGE}`);
		});

		test('REFUSES: a hidden depth-2 record is never captured — the export throws by its column', async () => {
			await resetChain();
			await writeRecord('e', identity.otherProject, SENTINEL_ALPHA);
			// non-vacuity: without a frontier (global admin) the hidden image IS captured
			expect(await mediaAnswer(identity.admin)).toContain(`${E}#${ID.e}#${E_IMAGE}`);
			expect(await mediaAnswer(identity.scoped)).toBe(
				`REFUSED:${REFUSAL}:${JSON.stringify({ column: 'zz fan main' })}`,
			);
		});
	});

	/**
	 * One hidden record per case: flip it into the OTHER project, write each
	 * sentinel in turn. The scoped caller must be refused identically for both
	 * and name neither; the admin must see both — differently.
	 */
	const HIDDEN_CASES: { name: string; key: string; shapes: Shape[] }[] = [
		{
			name: 'depth 0 (the leaf target — the already-guarded control)',
			key: 'b',
			shapes: ['value', 'fanout', 'compact'],
		},
		{ name: 'depth 1 (a target of the target)', key: 'c', shapes: ['value', 'fanout', 'compact'] },
		{ name: 'depth 2', key: 'e', shapes: ['value', 'fanout', 'compact'] },
		{ name: 'a dataframe FRAME target', key: 'd', shapes: ['value', 'fanout'] },
	];

	/**
	 * WC-049 — the parents chain: b's ANCESTOR is another record. Every case
	 * above leaves b parent-less; here b points at bParent, which flips.
	 */
	describe('the WC-049 PARENTS chain crosses the same frontier', () => {
		const linkParent = () =>
			writeRecord('b', identity.myProject, LAWFUL.b as string, {
				[B_PARENT]: [{ ...relationLocator(B_PARENT, B, ID.bParent), type: 'dd47' }],
			});

		for (const shape of ['value', 'fanout', 'compact'] as const) {
			test(`${shape}: LAWFUL — an in-scope ancestor exports its term`, async () => {
				await resetChain();
				await linkParent();
				const answer = await exportAnswer(identity.scoped, shape, true);
				expect(answer.startsWith('OK:'), answer).toBe(true);
				expect(answer).toContain(LAWFUL.bParent as string);
			});

			test(`${shape}: REFUSES — a hidden ancestor throws by the column; admin sees it`, async () => {
				await resetChain();
				await linkParent();
				const answers: Record<string, string[]> = { scoped: [], admin: [] };
				for (const sentinel of [SENTINEL_ALPHA, SENTINEL_BRAVO]) {
					await writeRecord('bParent', identity.otherProject, sentinel);
					answers.scoped?.push(await exportAnswer(identity.scoped, shape, true));
					answers.admin?.push(await exportAnswer(identity.admin, shape, true));
				}
				const [scopedAlpha, scopedBravo] = answers.scoped as [string, string];
				const [adminAlpha, adminBravo] = answers.admin as [string, string];
				expect(adminAlpha).toContain(SENTINEL_ALPHA);
				expect(adminBravo).toContain(SENTINEL_BRAVO);
				const column = shape === 'compact' ? 'zz fan compact' : 'zz fan main';
				expect(scopedAlpha).toBe(`REFUSED:${REFUSAL}:${JSON.stringify({ column })}`);
				expect(scopedBravo).toBe(scopedAlpha);
			});
		}
	});

	/**
	 * Two more branches of relation_list.ts resolveCellValue that read ANOTHER
	 * record: a relation with NO children (its label is the target's own term —
	 * resolveLocatorLabels) and a component_iri (its title is read on the dd560
	 * frame's target record — resolveIriTitles). The iri case is the ONLY guard
	 * of its crossing (mutation-verified); the no-children crossing sits behind
	 * the leaf-target and per-locator crossings, so its case pins the BEHAVIOUR
	 * (lawful OK, hidden refused by the column), not that one line.
	 */
	const OTHER_BRANCHES: { name: string; leaf: string; key: string; column: string }[] = [
		{
			name: 'a relation with NO children (label = target term)',
			leaf: SEL,
			key: 'b',
			column: 'zz fan select',
		},
		{
			name: 'a component_iri title (dd560 frame target)',
			leaf: IRI,
			key: 'e',
			column: 'zz fan iri',
		},
	];
	for (const branch of OTHER_BRANCHES) {
		describe(`the cell branch for ${branch.name} crosses the same frontier`, () => {
			for (const shape of ['value', 'fanout'] as const) {
				test(`${shape}: LAWFUL in scope; hidden → scoped THROWS by the column, admin exports`, async () => {
					await resetChain();
					const lawful = await exportAnswer(identity.scoped, shape, false, branch.leaf);
					expect(lawful.startsWith('OK:'), lawful).toBe(true);
					await writeRecord(branch.key, identity.otherProject, SENTINEL_ALPHA);
					const admin = await exportAnswer(identity.admin, shape, false, branch.leaf);
					expect(admin.startsWith('OK:'), admin).toBe(true);
					const scoped = await exportAnswer(identity.scoped, shape, false, branch.leaf);
					expect(scoped).toBe(`REFUSED:${REFUSAL}:${JSON.stringify({ column: branch.column })}`);
				});
			}
		});
	}

	/**
	 * FLIPPED 2026-11-09 (owner decision D4, WC-2026-11-09-export-relation-display):
	 * every case here is a record the PLAIN column DISPLAYS — the section read of
	 * the root embeds it under P / Q for this persona (explicit children, the
	 * subdatum floor) — so it is not a crossing for the record key: the scoped
	 * export carries exactly what the admin's does. The refusal law beyond the
	 * display (a declared path into the target, a record the read does not
	 * expand, a component it does not show, the parents chain, the media walk)
	 * is gated by export_relation_display_native and the cases above.
	 */
	for (const hidden of HIDDEN_CASES) {
		describe(`DISPLAYED — ${hidden.name}`, () => {
			for (const shape of hidden.shapes) {
				test(`${shape}: the column displays it → the scoped export equals the admin's`, async () => {
					await resetChain();
					const answers: Record<string, string[]> = { scoped: [], admin: [] };
					for (const sentinel of [SENTINEL_ALPHA, SENTINEL_BRAVO]) {
						await writeRecord(hidden.key, identity.otherProject, sentinel);
						// the SCREEN: the scoped caller's own section read of the root
						// embeds this value under this column — the carve-out's premise,
						// asked of the read itself, not of the admin's export
						const shown = hostColumnDisplayedValues(
							await hostSectionReadItems(identity.scoped, A, ID.root, LANG, 'export-fanout'),
							shape === 'compact' ? Q : P,
							A,
							ID.root,
						);
						expect(shown).toContain(sentinel);
						answers.scoped?.push(await exportAnswer(identity.scoped, shape));
						answers.admin?.push(await exportAnswer(identity.admin, shape));
					}
					const [scopedAlpha, scopedBravo] = answers.scoped as [string, string];
					const [adminAlpha, adminBravo] = answers.admin as [string, string];
					// non-vacuity: the out-of-scope record's value reaches the deliverable
					expect(adminAlpha).toContain(SENTINEL_ALPHA);
					expect(adminBravo).toContain(SENTINEL_BRAVO);
					expect(adminAlpha).not.toBe(adminBravo);
					// the scoped caller: the displayed out-of-scope value IS exported …
					expect(scopedAlpha).toContain(SENTINEL_ALPHA);
					expect(scopedBravo).toContain(SENTINEL_BRAVO);
					// … and exactly what the column displays — the admin's bytes
					expect(scopedAlpha).toBe(adminAlpha);
					expect(scopedBravo).toBe(adminBravo);
				});
			}
		});
	}
});
