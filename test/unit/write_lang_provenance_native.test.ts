/**
 * WRITE-LANGUAGE PROVENANCE (P0-7 — audit DATA-01/DATA-23/DATA-24/DATA-25).
 *
 * THE DEFECT THIS GATE PINS. The language a save is written in is REQUEST state:
 * the operator picks it from the data-language menu, `dd_utils_api::change_lang`
 * puts it on the session, dispatch seeds the request-language ALS from there and
 * `currentDataLang()` reads it. Three bulk import doors instead resolved
 * `translatable ? config.menu.dataLang : 'lg-nolan'` — the STATIC install
 * default — and the agent doors hardcoded `lg-eng` / defaulted `lg-nolan`. The
 * write is lang-SLICED (`set_data` replaces exactly one language's items), so a
 * wrong language does not merely mislabel: it REPLACES a language the operator
 * was not editing, and an empty cell CLEARS it. `ok:true`, every time.
 *
 * And no door checked the language against the install at all, so a phantom
 * `lg-xxx` was stored verbatim and became unreachable — the read fallback chain
 * iterates DEDALO_PROJECTS_DEFAULT_LANGS and never sees it.
 *
 * THREE THINGS ARE ASSERTED HERE:
 *
 *   1. CENSUS (TOTAL, derived — never a hand list): every caller of
 *      `saveComponentData` outside `src/core/section/` is enumerated with the
 *      language it writes in. A NEW door is RED until someone says which.
 *   2. PROVENANCE (behavioural, on the suite DB): one row imported through each
 *      threadable door under a session data language ≠ the install default
 *      lands under the SESSION's language.
 *   3. REFUSAL: a language this installation does not declare is refused
 *      loudly — before the SAVE DOOR opens its own transaction, proved against a
 *      held row lock — while a RE-SAVE of a language the stored bytes already
 *      carry, and the declared migration escape, go through. The allowance is
 *      per LANG SLICE of one COMPONENT: a sibling component of the same record
 *      still refuses the language, and an ALIAS door is judged on the stored
 *      slice of its TARGET.
 *
 * And the set itself (`src/config/data_langs.ts`): it is the READ-REACHABLE set,
 * built from `DEDALO_DATA_LANG_DEFAULT` + `DEDALO_PROJECTS_DEFAULT_LANGS` +
 * `lg-nolan` + the equivalence closure — and `DEDALO_DATA_LANG` is deliberately
 * NOT one of its inputs, because it is not in the read fallback chain and a
 * write admitted only by it would land where no read looks. The outage that
 * omission could cause (it is what a door outside any request scope, and a
 * session that has chosen no language, writes in) is closed at the source: the
 * ALS falls back to `DEDALO_DATA_LANG_DEFAULT`, and `config.menu.dataLang` is
 * resolved against the declared set at boot. An install that sets every language
 * key to the same code — this one does — cannot express any of that, so the
 * rules are exercised through the pure builder and the pure resolver on
 * configurations whose keys DISAGREE, and the module-level set the chokepoint
 * really consults is compared against one rebuilt from the live config keys.
 *
 * The situation is BUILT: `test3` + its own translatable `component_input_text`
 * (`test52`) and `component_text_area` (`test17`), plus a scratch `zzwlang` TLD
 * carrying an alias over a translatable component, on scratch ids in the
 * reserved ≥ 900000 band, removed at both ends. Nothing here reads whatever the
 * ambient database happens to hold.
 *
 * NO CASE HERE SKIPS. A missing suite database fails this file (`requireReady`),
 * because an in-body `return` is reported as a PASS and the closure of a
 * blocking defect must never be able to look green.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Glob } from 'bun';
import { setField } from '../../src/ai/mcp/tools/fields_write.ts';
import { saveComponentValue } from '../../src/ai/mcp/tools/records_write.ts';
import { config, INSTALLED_DATA_LANGS } from '../../src/config/config.ts';
import { declaredDataLangs, resolveCurrentDataLang } from '../../src/config/data_langs.ts';
import { deleteTldNodes, upsertDdOntologyNode } from '../../src/core/db/dd_ontology.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import * as postgres from '../../src/core/db/postgres.ts';
import { deferPostTransaction, sql, withTransaction } from '../../src/core/db/postgres.ts';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import {
	readComponentItems,
	resolveComponentValue,
} from '../../src/core/resolve/component_data.ts';
import { currentDataLang, runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import {
	installedDataLangs,
	isInstalledDataLang,
	saveComponentData,
} from '../../src/core/section/record/save_component.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import * as permissions from '../../src/core/security/permissions.ts';
import { groupItemsByLang } from '../../src/core/tools/import_data.ts';
import { importMappedRecords } from '../../src/core/tools/import_execute.ts';
import { tool as csvTool } from '../../tools/tool_import_dedalo_csv/server/index.ts';

const SECTION = 'test3';
/** test3's own component_input_text — TRANSLATABLE, so the lang slice is real. */
const TEXT = 'test52';
const MODEL = 'component_input_text';
/** A SECOND translatable component of the same section (component_text_area). */
const OTHER_TEXT = 'test17';
const OTHER_MODEL = 'component_text_area';
const TABLE = 'matrix_test';
const USER = 987672;
/** The importing PRINCIPAL (req 10: the executor asks the write door as it) — the superuser, so the door is not this gate's subject. */
const IMPORTER = { userId: -1, isGlobalAdmin: true, isDeveloper: true } as const;
/** Scratch ids owned by THIS gate (reserved ≥ 900000 band). */
const IMPORT_ID = 941701;
const SET_FIELD_ID = 941702;
const SAVE_COMPONENT_ID = 941703;
const REFUSAL_ID = 941704;
const ESCAPE_ID = 941705;
const ROUNDTRIP_ID = 941706;
const PREFLIGHT_ID = 941707;
const CSV_ID = 941708;
const REACHABLE_ID = 941709;
/** The alias gate's record lives in its OWN scratch section (swept with it). */
const ALIAS_RECORD_ID = 941710;
const DEFERRED_ID = 941711;
const ALL_IDS = [
	IMPORT_ID,
	SET_FIELD_ID,
	SAVE_COMPONENT_ID,
	REFUSAL_ID,
	ESCAPE_ID,
	ROUNDTRIP_ID,
	PREFLIGHT_ID,
	CSV_ID,
	REACHABLE_ID,
	DEFERRED_ID,
];

/** A global admin: this gate is about LANGUAGE, not about the ACL. */
const ADMIN: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };

/**
 * A language this install declares that is NOT the install default — the whole
 * point is that the two must be able to disagree. An install with a single data
 * language cannot express the defect, and this gate says so rather than passing
 * vacuously.
 */
const SESSION_LANG =
	config.menu.projectsDefaultLangs.find(
		(lang) => lang !== config.menu.dataLang && lang !== 'lg-nolan',
	) ?? '';

/** Grammar-valid, declared by nobody: the phantom code DATA-25 is about. */
const UNDECLARED_LANG = 'lg-zzz';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * The REAL postgres module, snapshotted at import time. `mock.module` is
 * process-GLOBAL and `mock.restore()` does NOT revert it, so the one case that
 * counts transactions re-installs these exports in an afterEach — otherwise
 * every file running after this one in the same bun process would inherit a
 * wrapped withTransaction.
 */
const REAL_POSTGRES = { ...postgres };
/** Same snapshot discipline for the security module (see REAL_POSTGRES). */
const REAL_PERMISSIONS = { ...permissions };

/** dd800 bulk-process records this gate's import runs mint, for the sweep. */
const bulkProcessIds: number[] = [];

/** Remember a run's dd800 for the sweep. Null = the run minted none (empty run). */
function rememberBulkProcess(id: number | null): void {
	if (id !== null) bulkProcessIds.push(id);
}
let ready = false;
/** Why the setup failed, verbatim, so the readiness case can name the cause. */
let setupError = '';

/**
 * REFUSE TO RUN VACUOUSLY (2026-08-27 review). `if (!ready) return;` reports a
 * PASS with zero assertions — bun cannot tell it from a case that ran — so the
 * closure of two BLOCKING write-path defects was silently green on a DB-less
 * box. Every DB-touching case below calls this instead and goes RED.
 */
function requireReady(): void {
	if (!ready) {
		throw new Error(
			`the suite database is unavailable (${setupError}) — this case proves a write-path law and cannot be skipped into green. Build the suite database with \`bun run test:db:setup\`.`,
		);
	}
}

async function storedItems(sectionId: number): Promise<unknown[]> {
	const table = await getMatrixTableFromTipo(SECTION);
	const record = await readMatrixRecord(table ?? TABLE, SECTION, sectionId);
	return record === null ? [] : (readComponentItems(record, TEXT, MODEL) ?? []);
}

/** The `lang` of every stored item, in stored order. */
async function storedLangs(sectionId: number): Promise<string[]> {
	return (await storedItems(sectionId)).map((item) =>
		String((item as { lang?: unknown } | null)?.lang ?? ''),
	);
}

beforeAll(async () => {
	try {
		for (const id of ALL_IDS) {
			await createSectionRecord(SECTION, USER, new Date(), id, { conflictTolerant: true });
		}
		ready = true;
	} catch (error) {
		ready = false;
		setupError = error instanceof Error ? error.message : String(error);
	}
});

/**
 * FIRST, AND IT FAILS RATHER THAN SKIPS: this file is the evidence that the
 * write-language law holds, and a run where the database never answered has
 * proved nothing. Reported as its own case so the reason is visible once,
 * instead of N identical failures.
 */
test('the suite database is reachable (else every case in this file is vacuous)', () => {
	expect(ready ? 'ready' : `suite database unavailable: ${setupError}`).toBe('ready');
});

afterAll(async () => {
	if (!ready) return;
	for (const id of ALL_IDS) {
		await sql.unsafe(`DELETE FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`, [
			SECTION,
			id,
		]);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2`,
			[SECTION, id],
		);
	}
	const bulkTable = await getMatrixTableFromTipo('dd800');
	for (const id of bulkProcessIds) {
		await sql.unsafe(
			`DELETE FROM ${bulkTable ?? 'matrix_dd'} WHERE section_tipo = $1 AND section_id = $2`,
			['dd800', id],
		);
		await sql.unsafe(
			`DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2`,
			['dd800', id],
		);
	}
});

/* ══════════════════════════ 1 · THE CENSUS ══════════════════════════ */

/**
 * Every caller of `saveComponentData` outside `src/core/section/` — DERIVED by
 * scanning `src/` and `tools/`, never typed out, so a new door cannot be added
 * without deciding what language it writes in.
 *
 * `lang` records WHERE the door's write language comes from:
 *   'request'    — the request-language ALS (currentDataLang), directly or via
 *                  a caller-supplied override that defaults to it;
 *   'nolan'      — always 'lg-nolan' (a non-translatable or structural write);
 *   'caller'     — an explicit language the CALLER owns and the door forwards;
 *   'items'      — grouped from the langs the stored/incoming items carry.
 *
 * A door with more than one source declares them joined with '+' (the CSV and
 * MARC21 executors resolve a column/run language AND let an item's own lang win
 * over it): naming only one of two real sources is a census that lies.
 */
const SAVE_DOORS: ReadonlyMap<string, { lang: string; reason: string }> = new Map([
	[
		'src/ai/mcp/tools/fields_write.ts',
		{
			lang: 'request',
			reason:
				'set_field / find_or_create / change-plan apply. Was a hardcoded lg-eng (DATA-23); now input.lang ?? currentDataLang() for a translatable component, lg-nolan otherwise.',
		},
	],
	[
		'src/ai/mcp/tools/records_write.ts',
		{
			lang: 'request',
			reason:
				'The MCP save door. Defaulted every omitted lang to lg-nolan, which a TRANSLATABLE component renders only as a marked fallback, in every language, forever (DATA-24); now input.lang ?? currentDataLang() when translatable.',
		},
	],
	[
		'src/core/api/handlers/dd_core_api.ts',
		{
			lang: 'caller',
			reason:
				'THE HUMAN DOOR. Forwards the rqo source.lang, which the client fills from page_globals.dedalo_data_lang — the session language dispatch also seeds the ALS with.',
		},
	],
	[
		'src/core/area_maintenance/widgets/export_hierarchy.ts',
		{ lang: 'nolan', reason: 'Writes a maintenance flag, not translatable content.' },
	],
	[
		'src/core/components/component_text_area/tag_delete.ts',
		{
			lang: 'caller',
			reason:
				'Removes a tag from the exact stored slice it was found in; the lang comes from the item being edited.',
		},
	],
	[
		'src/core/media/ingest/companion_writes.ts',
		{ lang: 'nolan', reason: 'Media companion metadata — structural, never translated.' },
	],
	[
		'src/core/media/rich_text_image_reconcile.ts',
		{
			lang: 'items',
			reason:
				'The rich-text image reconciles save back the exact stored lang slice they read (filterItemsByLang, lang = the lang the items carry) — never a request or install language. A slice whose effective save lang differs is HELD and reported instead of written, so no language the operator was not editing is replaced.',
		},
	],
	[
		'src/core/relations/declared_order_reconcile.ts',
		{
			lang: 'nolan',
			reason:
				'The portal_declared_order reconcile re-saves a relation component (portal) array re-ranked — relation data is lg-nolan by definition.',
		},
	],
	[
		'src/core/ontology/data_io.ts',
		{ lang: 'nolan', reason: 'Ontology data import writes DATA_NOLAN.' },
	],
	[
		'src/core/security/auth.ts',
		{ lang: 'nolan', reason: 'The Argon2id password hash — lg-nolan by definition.' },
	],
	[
		'src/core/security/password_reset.ts',
		{ lang: 'nolan', reason: 'Same password write, through the reset door.' },
	],
	[
		'src/core/security/section_permissions.ts',
		{ lang: 'nolan', reason: 'Permission grants are structural data.' },
	],
	[
		'src/core/tools/import_csv_execute.ts',
		{
			lang: 'caller+items',
			reason:
				'Writes the language the PLAN resolved per column (tool_import_dedalo_csv resolveMappedColumns), which is now currentDataLang() for a translatable column — BUT it saves through groupItemsByLang (import_data.ts), so an incoming item that carries its own lang (a v7 raw export, a lang-keyed conform result) wins over the column’s. Both sources are real.',
		},
	],
	[
		'src/core/tools/import_execute.ts',
		{
			lang: 'request+items',
			reason:
				'The shared MARC21/Zotero/RDF executor — DATA-01’s twin site. Read config.menu.dataLang; now resolves currentDataLang() once per run — and, like the CSV executor, saves through groupItemsByLang, so an item carrying its own lang wins over the run’s.',
		},
	],
	[
		'src/core/tools/transcription_asr.ts',
		{
			lang: 'caller',
			reason: 'The transcription target language, chosen by the operator in the tool.',
		},
	],
	[
		'tools/tool_import_dedalo_csv/server/index.ts',
		{
			lang: 'request',
			reason:
				'DATA-01’s primary site. resolveMappedColumns now reads currentDataLang() for a translatable column; the lg-nolan saves in the same file are the dd800 bulk-process record’s own label/file.',
		},
	],
	[
		'tools/tool_import_files/server/index.ts',
		{
			lang: 'items',
			reason:
				'Groups the entries the client shipped by the lang each carries and issues one save per group; lang-less entries take the component lang the tool resolved.',
		},
	],
	[
		'tools/tool_import_rdf/server/rdf_import_execute.ts',
		{
			lang: 'request+items+nolan',
			reason:
				'Writes the lang each PLAN op carries (rdf_import_plan.ts): a literal tagged xml:lang lands in the installed data lang it maps to (items); an untagged literal takes currentDataLang() resolved once per run (request); a non-translatable component, an IRI or a locator is lg-nolan.',
		},
	],
	[
		'tools/tool_bibliography_acquisition/server/index.ts',
		{
			lang: 'request+items+nolan',
			reason:
				'Every save is lg-nolan (writeField default, writeIriField, writeDateField, the link* relation saves) EXCEPT the one translatable field, ABSTRACT_TIPO Abstract: planAbstractLangs (lib/domain/abstract_langs.ts) maps each harvested variant’s own xml:lang onto an installed data lang (installedDataLangs + getAlpha2FromCode — items), an untagged variant takes currentDataLang() (request); an unmappable or already-taken slot is skipped and reported, never written.',
		},
	],
	[
		'tools/tool_numisdata_acquisition/server/index.ts',
		{
			lang: 'request+nolan',
			reason:
				'writeField defaults to lg-nolan (WEIGHT_TIPO, DIAMETER_TIPO, INVENTORY_NUMBER_TIPO, AUCTION_NUMBER_TITLE_TIPO, ENTITY_NAME_TIPO); the translatable fields (DATE_TEXT_TIPO, OBVERSE_DESIGN_TIPO, REVERSE_DESIGN_TIPO, PUBLIC_REMARK_TIPO, AUCTION_CODE_TIPO) are passed currentDataLang() explicitly — the job manager pins the submitter’s langs into the background job. writeIriField (SOURCE_URI_TIPO), the link* relation saves and the image portal add_new_element are lg-nolan.',
		},
	],
	[
		'tools/tool_posterframe/server/index.ts',
		{ lang: 'nolan', reason: 'add_new_element on a portal — a locator write, no language.' },
	],
	[
		'src/core/relations/children_write.ts',
		{
			lang: 'nolan',
			reason:
				"A children save writes each child's parent link and its order value — locators and a sort number, never translated: DATA_NOLAN whatever lang the request carried.",
		},
	],
	[
		'tools/tool_upload/server/index.ts',
		{
			lang: 'request+nolan',
			reason:
				'A component_json upload replaces the value in the slot the operator is looking at: currentDataLang() for a translatable component, lg-nolan otherwise (getTranslatableByTipo) — the same rule the media tools resolve their identity lang by.',
		},
	],
	[
		'tools/tool_tc/server/index.ts',
		{ lang: 'caller', reason: 'Time-code writes carry the lang of the component being edited.' },
	],
	[
		'tools/tool_update_cache/server/index.ts',
		{
			lang: 'request+items',
			reason:
				'Re-saves each stored lang group (groupItemsByLang); the DEFAULT bucket for lang-less items and for an empty component is currentDataLang() (lg-nolan when not translatable) — the language the operator works in, never config.menu.dataLang (DATA-01 third site, closed). The dd800 label save is lg-nolan.',
		},
	],
	[
		'tools/tool_propagate_component_data/server/index.ts',
		{
			lang: 'caller',
			reason:
				'The propagation writes in the language the operator chose in the tool (options.lang), handed to the save door as the request lang; the door’s effectiveLang rule then slices on it for a translatable model and on lg-nolan otherwise (the region the propagate transform reads is cut with the same rule). The lg-nolan save in the same file is the dd800 run label (2026-09-27, WC-2026-09-27-bulk-revert-undo-log: propagate saves through saveComponentData).',
		},
	],
]);

function censusSaveDoors(): string[] {
	const glob = new Glob('**/*.ts');
	const doors: string[] = [];
	for (const [root, prefix] of [
		[join(REPO_ROOT, 'src'), 'src/'],
		[join(REPO_ROOT, 'tools'), 'tools/'],
	] as [string, string][]) {
		for (const rel of glob.scanSync(root)) {
			const path = `${prefix}${rel}`;
			// The engine's own home: the chokepoint and its neighbours are not doors.
			if (path.startsWith('src/core/section/')) continue;
			if (path.endsWith('.test.ts')) continue;
			// A CALL, not a mention. Comment lines (prose naming the chokepoint) and
			// import lines are skipped; what remains and is followed by `(` is an
			// invocation — including `saveComponentData(request)`, which a shape-based
			// `saveComponentData({` match would miss (import_csv_execute.ts).
			const lines = readFileSync(join(root, rel), 'utf8').split('\n');
			const calls = lines.some((line) => {
				const trimmed = line.trim();
				if (
					trimmed.startsWith('//') ||
					trimmed.startsWith('*') ||
					trimmed.startsWith('/*') ||
					trimmed.startsWith('import ')
				) {
					return false;
				}
				return /\bsaveComponentData\(/.test(line);
			});
			if (calls) doors.push(path);
		}
	}
	return doors.sort();
}

describe('census — every save door declares its write language', () => {
	const doors = censusSaveDoors();

	test('the census is TOTAL: no undeclared caller of saveComponentData', () => {
		// Anti-vacuity: 18 doors over src/ + tools/ on 2026-09-02. An emptied walk
		// (wrong root, a grep that stopped matching) would leave nothing undeclared.
		expect(doors.length).toBeGreaterThan(10);
		const undeclared = doors.filter((path) => !SAVE_DOORS.has(path));
		if (undeclared.length > 0) {
			throw new Error(
				`saveComponentData is called from file(s) with no write-language declaration:\n  ${undeclared.join('\n  ')}\nEvery door must say where its lang comes from — the request-language ALS (currentDataLang), an explicit caller-owned language, the langs the items carry, or lg-nolan. The static install default (config.menu.dataLang) is NONE of those: the write is lang-sliced, so it replaces a language the operator was not editing (audit DATA-01). Add an entry to SAVE_DOORS.`,
			);
		}
		expect(undeclared).toEqual([]);
	});

	test('the census stays honest — no entry for a file that no longer writes', () => {
		expect([...SAVE_DOORS.keys()].filter((path) => !doors.includes(path))).toEqual([]);
	});

	test('every declared door names one of the four allowed sources, with a reason', () => {
		// A door may have MORE THAN ONE source and must then say so ('a+b'): the CSV
		// and MARC21 executors both resolve a caller/request language AND let an
		// item's own lang win over it (groupItemsByLang). A census that files such a
		// door under one source is a census that cannot be trusted.
		const allowed = ['request', 'caller', 'items', 'nolan'];
		const bad = [...SAVE_DOORS.entries()]
			.filter(([, entry]) => {
				const sources = entry.lang.split('+');
				return (
					sources.length === 0 ||
					sources.some((source) => !allowed.includes(source)) ||
					new Set(sources).size !== sources.length ||
					entry.reason.trim().length < 20
				);
			})
			.map(([path]) => path);
		expect(bad).toEqual([]);
	});

	/**
	 * The composite declarations are not a matter of opinion: `groupItemsByLang`
	 * is the shared code both executors save through, and it is what makes an
	 * item's own lang win over the column/run language. If that stops being true,
	 * 'caller+items' / 'request+items' become wrong and this says so.
	 */
	test('an item’s own lang really does win over the door’s (groupItemsByLang)', () => {
		const grouped = groupItemsByLang([{ lang: 'lg-fra', value: 'x' }, { value: 'y' }], 'lg-eng');
		expect([...grouped.keys()].sort()).toEqual(['lg-eng', 'lg-fra']);
		for (const path of [
			'src/core/tools/import_csv_execute.ts',
			'src/core/tools/import_execute.ts',
		]) {
			expect(readFileSync(join(REPO_ROOT, path), 'utf8')).toContain('groupItemsByLang(');
			expect(SAVE_DOORS.get(path)?.lang.split('+')).toContain('items');
		}
	});

	/**
	 * The CSV door's language resolution is not reachable in-process
	 * (`resolveMappedColumns` is module-private and the executor runs behind the
	 * staged-file pipeline), so it is pinned textually: the one line that decides
	 * a translatable column's write language must read the REQUEST's.
	 */
	test('the CSV door resolves its column language from the request, not from config', () => {
		const source = readFileSync(
			join(REPO_ROOT, 'tools/tool_import_dedalo_csv/server/index.ts'),
			'utf8',
		);
		expect(source).toContain("lang: translatable ? currentDataLang() : 'lg-nolan'");
		expect(source).not.toContain('translatable ? config.menu.dataLang');
	});
});

/* ═════════════════════ 2 · PROVENANCE (behavioural) ═════════════════════ */

describe('a write lands in the SESSION’s data language, not the install default', () => {
	test('the install declares at least two data languages (else this gate proves nothing)', () => {
		expect(config.menu.projectsDefaultLangs.length).toBeGreaterThan(1);
		expect(SESSION_LANG).not.toBe('');
		expect(SESSION_LANG).not.toBe(config.menu.dataLang);
	});

	test('the shared MARC21/Zotero import executor follows the session', async () => {
		requireReady();
		const report = await runWithRequestLangs(
			{ applicationLang: config.menu.applicationLang, dataLang: SESSION_LANG },
			() =>
				importMappedRecords(
					[{ sectionId: IMPORT_ID, fields: [{ component_tipo: TEXT, values: ['import value'] }] }],
					SECTION,
					IMPORTER,
				),
		);
		rememberBulkProcess(report.bulkProcessId);
		expect(report.failed).toEqual([]);
		expect(await storedLangs(IMPORT_ID)).toEqual([SESSION_LANG]);
	});

	test('the MCP set_field door follows the session', async () => {
		requireReady();
		await runWithRequestLangs(
			{ applicationLang: config.menu.applicationLang, dataLang: SESSION_LANG },
			() =>
				setField(ADMIN, {
					section_tipo: SECTION,
					section_id: SET_FIELD_ID,
					field: TEXT,
					value: 'set_field value',
				}),
		);
		expect(await storedLangs(SET_FIELD_ID)).toEqual([SESSION_LANG]);
	});

	test('the MCP save_component door follows the session (was lg-nolan)', async () => {
		requireReady();
		await runWithRequestLangs(
			{ applicationLang: config.menu.applicationLang, dataLang: SESSION_LANG },
			() =>
				saveComponentValue(ADMIN, {
					section_tipo: SECTION,
					tipo: TEXT,
					section_id: SAVE_COMPONENT_ID,
					action: 'insert',
					value: { value: 'save_component value' },
				}),
		);
		const langs = await storedLangs(SAVE_COMPONENT_ID);
		expect(langs).toEqual([SESSION_LANG]);
		// The specific old defect: a translatable component holding an lg-nolan
		// item renders as a marked fallback in every language and never as a value.
		expect(langs).not.toContain('lg-nolan');
	});

	test('an EMPTY import cell clears the SESSION’s slice and leaves the others intact', async () => {
		requireReady();
		// Two languages present: the install default (seeded directly) and the
		// session's (seeded through the door above).
		await saveComponentData({
			componentTipo: TEXT,
			sectionTipo: SECTION,
			sectionId: IMPORT_ID,
			lang: config.menu.dataLang,
			changedData: [
				{ action: 'set_data', id: null, value: [{ value: 'curated default-lang text' }] },
			],
			userId: USER,
		});
		expect((await storedLangs(IMPORT_ID)).sort()).toEqual(
			[SESSION_LANG, config.menu.dataLang].sort(),
		);

		const report = await runWithRequestLangs(
			{ applicationLang: config.menu.applicationLang, dataLang: SESSION_LANG },
			() =>
				importMappedRecords(
					[{ sectionId: IMPORT_ID, fields: [{ component_tipo: TEXT, values: [''] }] }],
					SECTION,
					IMPORTER,
				),
		);
		rememberBulkProcess(report.bulkProcessId);
		// THE POINT: the clear hits the session's slice. Before P0-7 it hit the
		// install default's — the curated text below would be gone.
		expect(await storedLangs(IMPORT_ID)).toEqual([config.menu.dataLang]);
		const values = (await storedItems(IMPORT_ID)).map((item) =>
			String((item as { value?: unknown }).value),
		);
		expect(values).toEqual(['curated default-lang text']);
	});
});

/* ═══════════════════ 3 · THE UNDECLARED-LANGUAGE REFUSAL ═══════════════════ */

describe('a language this installation does not declare is REFUSED', () => {
	test('the phantom code is genuinely outside the install set', () => {
		expect(config.menu.projectsDefaultLangs).not.toContain(UNDECLARED_LANG);
		expect(config.lang.dataLangDefault).not.toBe(UNDECLARED_LANG);
	});

	test('a save in an undeclared language throws record.lang_not_installed and stores NOTHING', async () => {
		requireReady();
		const attempt = saveComponentData({
			componentTipo: TEXT,
			sectionTipo: SECTION,
			sectionId: REFUSAL_ID,
			lang: UNDECLARED_LANG,
			changedData: [{ action: 'set_data', id: null, value: [{ value: 'phantom' }] }],
			userId: USER,
		});
		await expect(attempt).rejects.toThrow();
		let code = '';
		try {
			await attempt;
		} catch (error) {
			if (isDedaloError(error)) code = error.code;
		}
		expect(code).toBe('record.lang_not_installed');
		// The refusal runs before the transaction opens: nothing was written.
		expect(await storedItems(REFUSAL_ID)).toEqual([]);
	});

	test('every declared data language is accepted', async () => {
		requireReady();
		for (const lang of [...config.menu.projectsDefaultLangs, 'lg-nolan']) {
			const outcome = await saveComponentData({
				componentTipo: TEXT,
				sectionTipo: SECTION,
				sectionId: REFUSAL_ID,
				lang,
				changedData: [{ action: 'set_data', id: null, value: [{ value: `text ${lang}` }] }],
				userId: USER,
			});
			expect(outcome.ok).toBe(true);
		}
	});

	test('the DECLARED MIGRATION ESCAPE lets an undeclared language through', async () => {
		requireReady();
		const outcome = await saveComponentData({
			componentTipo: TEXT,
			sectionTipo: SECTION,
			sectionId: ESCAPE_ID,
			lang: UNDECLARED_LANG,
			changedData: [{ action: 'set_data', id: null, value: [{ value: 'migrated' }] }],
			userId: USER,
			langMigrationReason: 'gate: proving the escape exists and is a per-call declaration',
		});
		expect(outcome.ok).toBe(true);
		expect(await storedLangs(ESCAPE_ID)).toEqual([UNDECLARED_LANG]);
	});

	test('the escape is NOT a wire field — no door forwards caller input into it', () => {
		const glob = new Glob('**/*.ts');
		const setters: string[] = [];
		for (const [root, prefix] of [
			[join(REPO_ROOT, 'src'), 'src/'],
			[join(REPO_ROOT, 'tools'), 'tools/'],
		] as [string, string][]) {
			for (const rel of glob.scanSync(root)) {
				const path = `${prefix}${rel}`;
				// Its home: the interface declaration and the gate that reads it.
				if (path === 'src/core/section/record/save_component.ts') continue;
				if (readFileSync(join(root, rel), 'utf8').includes('langMigrationReason')) {
					setters.push(path);
				}
			}
		}
		// Nobody sets it today. A future migration script may — and must land here
		// with its reason, so the escape can never grow a caller unnoticed.
		expect(setters).toEqual([]);
	});
});

/* ══════ 4 · THE SET: exactly the languages a READ can reach ══════ */

describe('the declared data-language set', () => {
	/**
	 * On an install whose language keys all hold the same code, every statement
	 * about the set is true by accident. The pure builder is fed a configuration
	 * whose keys DISAGREE, which is the only shape that can tell the rule from
	 * the coincidence.
	 */
	test('every language key contributes, on a config where they all disagree', () => {
		const langs = declaredDataLangs({
			dataLangDefault: 'lg-bbb',
			projectLangs: ['lg-ccc'],
			equivalences: [['lg-ccc', 'lg-ddd']],
		});
		expect(langs.has('lg-bbb')).toBe(true);
		expect(langs.has('lg-ccc')).toBe(true);
		expect(langs.has('lg-ddd')).toBe(true); // the equivalence closure
		expect(langs.has('lg-nolan')).toBe(true);
		// And it is still a SET, not "everything": the refusal has to mean something.
		expect(langs.has('lg-zzz')).toBe(false);
	});

	/**
	 * THE FINDING THAT CLOSED THIS ROUND. `DEDALO_DATA_LANG` was seeded into the
	 * set to stop a write outage, which inverted the defect: it is NOT in the read
	 * fallback chain, so an admitted write in it lands in a slice no read ever
	 * resolves — a silent write-to-nowhere, worse than the refusal it replaced.
	 * The set is now built from the read chain's OWN inputs and the key is not one
	 * of them; the outage is closed at the other end (the two cases below).
	 */
	test('the set is the READ chain’s inputs — DEDALO_DATA_LANG is not one of them', () => {
		const langs = declaredDataLangs({
			dataLangDefault: 'lg-bbb',
			projectLangs: ['lg-ccc'],
			equivalences: [],
		});
		// 'lg-aaa' is what a disagreeing DEDALO_DATA_LANG would be. There is no
		// input it could arrive through, and the set stays exactly the read chain's.
		expect([...langs].sort()).toEqual(['lg-bbb', 'lg-ccc', 'lg-nolan']);
	});

	/**
	 * THE BOOT ASSERTION, PROVED BY CONSTRUCTION (2026-08-27 review). The previous
	 * one seeded both engine defaults into the set and then asked whether the set
	 * contained them, so it could only fail on the empty string. This one is
	 * checked BEFORE anything is seeded, and every input below is a configuration
	 * an operator can really write.
	 */
	test('a DEDALO_DATA_LANG_DEFAULT that names no single language fails the BOOT', () => {
		for (const malformed of ['', 'spa', 'all', 'lg spa']) {
			expect(() =>
				declaredDataLangs({
					dataLangDefault: malformed,
					projectLangs: ['lg-ccc'],
					equivalences: [],
				}),
			).toThrow(/DEDALO_DATA_LANG_DEFAULT/);
		}
		// NON-VACUOUS: the same call with a real code does not throw.
		expect(() =>
			declaredDataLangs({ dataLangDefault: 'lg-bbb', projectLangs: [], equivalences: [] }),
		).not.toThrow();
	});

	/**
	 * THE OTHER END OF THE OUTAGE. A `DEDALO_DATA_LANG` outside the declared set is
	 * overruled at boot rather than becoming a write language: dispatch seeds the
	 * request scope with it for every session that has not chosen a language, so
	 * an out-of-set value would be refused by the chokepoint (a total interactive
	 * write outage) or admitted into an unreachable slice.
	 */
	test('an undeclared DEDALO_DATA_LANG is overruled by DEDALO_DATA_LANG_DEFAULT', () => {
		const declared = declaredDataLangs({
			dataLangDefault: 'lg-bbb',
			projectLangs: ['lg-ccc'],
			equivalences: [],
		});
		expect(resolveCurrentDataLang('lg-aaa', declared, 'lg-bbb')).toEqual({
			lang: 'lg-bbb',
			replaced: true,
		});
		// A declared one is kept verbatim — the resolution is a guard, not a rewrite.
		expect(resolveCurrentDataLang('lg-ccc', declared, 'lg-bbb')).toEqual({
			lang: 'lg-ccc',
			replaced: false,
		});
	});

	/**
	 * THE CALL SITE, not only the builder (2026-08-27 review). A pure builder that
	 * is correct while its one call site passes different values is the shape that
	 * produced this round: the module-level set the chokepoint actually consults
	 * is rebuilt here from the live config keys and must be the same set.
	 */
	test('the set the chokepoint consults IS the one built from the live config keys', () => {
		const rebuilt = declaredDataLangs({
			dataLangDefault: config.lang.dataLangDefault,
			projectLangs: config.menu.projectsDefaultLangs,
			equivalences: config.lang.equivalences,
		});
		expect(installedDataLangs().slice().sort()).toEqual([...rebuilt].sort());
		expect([...INSTALLED_DATA_LANGS].sort()).toEqual([...rebuilt].sort());
		// Every member answers the chokepoint's own question, and a phantom does not.
		for (const lang of rebuilt) expect(isInstalledDataLang(lang)).toBe(true);
		expect(isInstalledDataLang(UNDECLARED_LANG)).toBe(false);
	});

	test('THIS install: the menu language and the default data language are both declared', () => {
		// The resolver's guarantee, on the real config: whatever DEDALO_DATA_LANG
		// holds, the value the engine publishes as the current data language is a
		// language this install declares.
		expect(isInstalledDataLang(config.menu.dataLang)).toBe(true);
		expect(isInstalledDataLang(config.lang.dataLangDefault)).toBe(true);
	});

	/**
	 * The coupling this whole law rests on, pinned where it can drift: the read
	 * fallback chain's first candidate is `config.lang.dataLangDefault`, and that
	 * is exactly what a door writes in outside a request scope. If the read chain
	 * changes its first candidate, this goes red instead of the engine going
	 * silently back to writing where nothing reads.
	 */
	test('the ALS backstop IS the read chain’s first fallback candidate', () => {
		expect(currentDataLang()).toBe(config.lang.dataLangDefault);
		// PINNED AT BOTH LINES, because the VALUE cannot tell them apart on an
		// install whose two data-language keys hold the same code — and this
		// install's do. The defect being pinned is a code shape, so the shape is
		// what is asserted: the ALS falls back to the DEFAULT data language, never
		// to the menu's current one.
		const backstop = readFileSync(join(REPO_ROOT, 'src/core/resolve/request_lang.ts'), 'utf8');
		expect(backstop).toContain('?? config.lang.dataLangDefault');
		expect(backstop).not.toContain('?? config.menu.dataLang');
		const readChain = readFileSync(join(REPO_ROOT, 'src/core/resolve/component_data.ts'), 'utf8');
		expect(readChain).toContain('const DEFAULT_DATA_LANG = config.lang.dataLangDefault;');
	});

	test('a write in the language a door OUTSIDE a request scope resolves is accepted', async () => {
		requireReady();
		// No runWithRequestLangs here on purpose: this is the ALS backstop every
		// background job, boot task and CLI script writes in. If the set omits it,
		// this save is refused and the installation cannot write at all.
		const outsideAnyRequest = currentDataLang();
		const outcome = await saveComponentData({
			componentTipo: TEXT,
			sectionTipo: SECTION,
			sectionId: REFUSAL_ID,
			lang: outsideAnyRequest,
			changedData: [{ action: 'set_data', id: null, value: [{ value: 'engine default lang' }] }],
			userId: USER,
		});
		expect(outcome.ok).toBe(true);
	});

	/**
	 * AND THE BYTES ARE REACHABLE — the half the previous shape lost. A write in
	 * the engine's own out-of-scope language is READ BACK asking for a DIFFERENT
	 * declared language: the fallback chain resolves it, so those bytes are not
	 * stranded. This is what "the declared set is the read-reachable set" means,
	 * measured instead of asserted in a comment.
	 */
	test('declared bytes are reachable from every declared language; undeclared ones are not', async () => {
		requireReady();
		const engineLang = currentDataLang();
		await saveComponentData({
			componentTipo: TEXT,
			sectionTipo: SECTION,
			sectionId: REACHABLE_ID,
			lang: engineLang,
			changedData: [{ action: 'set_data', id: null, value: [{ value: 'reachable bytes' }] }],
			userId: USER,
		});
		// The SAME component also gets a slice in an undeclared language — the only
		// way in is the declared escape, which is what makes this the situation the
		// law exists to prevent, built on purpose.
		await saveComponentData({
			componentTipo: TEXT,
			sectionTipo: SECTION,
			sectionId: REACHABLE_ID,
			lang: UNDECLARED_LANG,
			changedData: [{ action: 'set_data', id: null, value: [{ value: 'stranded bytes' }] }],
			userId: USER,
			langMigrationReason: 'gate: proving an undeclared slice is reachable from no declared lang',
		});
		const table = await getMatrixTableFromTipo(SECTION);
		const record = await readMatrixRecord(table ?? TABLE, SECTION, REACHABLE_ID);
		expect(record).not.toBeNull();

		const served = async (lang: string): Promise<string[]> => {
			const resolved = await resolveComponentValue(
				record as NonNullable<typeof record>,
				TEXT,
				MODEL,
				lang,
			);
			const items = (resolved.value ?? resolved.fallbackValue ?? []) as { value?: unknown }[];
			return items.map((item) => String(item.value));
		};

		// EVERY declared language reaches the declared bytes and NONE reaches the
		// undeclared slice: that is what "the declared set is the read-reachable
		// set" means, measured rather than asserted in a comment.
		for (const lang of installedDataLangs()) {
			const values = await served(lang);
			expect(values).toEqual(['reachable bytes']);
		}
		// And the stranded slice IS there — the loop above proves unreachability,
		// not absence.
		expect(await served(UNDECLARED_LANG)).toEqual(['stranded bytes']);
	});
});

/* ══════ 5 · THE ROUND TRIP: re-saving bytes already in the corpus ══════ */

/**
 * The law governs an OPERATOR-CHOSEN write language. Doors that forward the lang
 * of a slice they just READ choose nothing — tool_update_cache's regenerate,
 * component_text_area's tag_delete, tool_tc — and refusing them breaks ordinary
 * maintenance of a record whose language the install has stopped declaring.
 */
describe('a re-save of a language the STORED bytes already carry is not refused', () => {
	test('seed: the undeclared slice exists only through the declared escape', async () => {
		requireReady();
		const outcome = await saveComponentData({
			componentTipo: TEXT,
			sectionTipo: SECTION,
			sectionId: ROUNDTRIP_ID,
			lang: UNDECLARED_LANG,
			changedData: [{ action: 'set_data', id: null, value: [{ value: 'legacy slice' }] }],
			userId: USER,
			langMigrationReason: 'gate: seeding a record whose stored bytes predate the language set',
		});
		expect(outcome.ok).toBe(true);
		expect(await storedLangs(ROUNDTRIP_ID)).toEqual([UNDECLARED_LANG]);
	});

	test('the maintenance idiom (read → groupItemsByLang → re-save) round-trips', async () => {
		requireReady();
		// EXACTLY what tool_update_cache's regenerate does to every component it
		// sweeps: group the STORED items by their own lang and re-save each group.
		// No declaration of any kind — the engine admits the lang because the bytes
		// it is about to write already carry it.
		const groups = groupItemsByLang(await storedItems(ROUNDTRIP_ID), config.menu.dataLang);
		expect([...groups.keys()]).toEqual([UNDECLARED_LANG]);
		for (const [lang, items] of groups) {
			const outcome = await saveComponentData({
				componentTipo: TEXT,
				sectionTipo: SECTION,
				sectionId: ROUNDTRIP_ID,
				lang,
				changedData: [{ action: 'set_data', id: null, value: items }],
				userId: USER,
				saveTm: false,
			});
			expect(outcome.ok).toBe(true);
		}
		expect(await storedLangs(ROUNDTRIP_ID)).toEqual([UNDECLARED_LANG]);
		const values = (await storedItems(ROUNDTRIP_ID)).map((item) =>
			String((item as { value?: unknown }).value),
		);
		expect(values).toEqual(['legacy slice']);
	});

	test('the allowance is PER SLICE: another undeclared language on the same record is refused', async () => {
		requireReady();
		// The round trip can never INTRODUCE an unreachable language — which is the
		// property the law actually protects.
		const attempt = saveComponentData({
			componentTipo: TEXT,
			sectionTipo: SECTION,
			sectionId: ROUNDTRIP_ID,
			lang: 'lg-qqq',
			changedData: [{ action: 'set_data', id: null, value: [{ value: 'a NEW phantom' }] }],
			userId: USER,
		});
		await expect(attempt).rejects.toThrow();
		expect(await storedLangs(ROUNDTRIP_ID)).toEqual([UNDECLARED_LANG]);
	});

	test('and it is per RECORD: the same undeclared lang on a record without it is refused', async () => {
		requireReady();
		const attempt = saveComponentData({
			componentTipo: TEXT,
			sectionTipo: SECTION,
			sectionId: PREFLIGHT_ID,
			lang: UNDECLARED_LANG,
			changedData: [{ action: 'set_data', id: null, value: [{ value: 'not here' }] }],
			userId: USER,
		});
		await expect(attempt).rejects.toThrow();
		expect(await storedItems(PREFLIGHT_ID)).toEqual([]);
	});

	/**
	 * AND IT IS PER COMPONENT, on the SAME record (2026-08-27 review). The
	 * allowance is a property of the slice the write lands on, never of the record
	 * it belongs to: widening the question to "does this record carry the language
	 * anywhere" would let one component's legacy slice license a NEW unreachable
	 * slice on every other component of the same record.
	 */
	test('and it is per COMPONENT: the same record’s OTHER component still refuses it', async () => {
		requireReady();
		// test3's other translatable component; the record's test52 slice is in
		// UNDECLARED_LANG (seeded above), this one has never held it.
		const attempt = saveComponentData({
			componentTipo: OTHER_TEXT,
			sectionTipo: SECTION,
			sectionId: ROUNDTRIP_ID,
			lang: UNDECLARED_LANG,
			changedData: [{ action: 'set_data', id: null, value: [{ value: 'sibling phantom' }] }],
			userId: USER,
		});
		await expect(attempt).rejects.toThrow();
		let code = '';
		try {
			await attempt;
		} catch (error) {
			if (isDedaloError(error)) code = error.code;
		}
		expect(code).toBe('record.lang_not_installed');
		// Nothing written on the sibling, and the licensed slice is untouched.
		const record = await readMatrixRecord(
			(await getMatrixTableFromTipo(SECTION)) ?? TABLE,
			SECTION,
			ROUNDTRIP_ID,
		);
		expect(
			record === null ? [] : (readComponentItems(record, OTHER_TEXT, OTHER_MODEL) ?? []),
		).toEqual([]);
		expect(await storedLangs(ROUNDTRIP_ID)).toEqual([UNDECLARED_LANG]);
	});
});

/* ══════ 5b · THE ALIAS DOOR: judged on the tipo the write LANDS ON ══════ */

/**
 * A save addressed to a `component_alias` writes the TARGET's data (WC-020), so
 * every question about stored bytes must be asked about the target tipo. The
 * situation is BUILT here — an alias face over a translatable text component in
 * its own scratch TLD — because no generic-TLD alias over a translatable
 * component exists to borrow.
 */
const ALIAS_TLD = 'zzwlang';
const ALIAS_SECTION = `${ALIAS_TLD}1`;
const ALIAS_TARGET = `${ALIAS_TLD}2`;
const ALIAS_FACE = `${ALIAS_TLD}3`;

describe('an ALIAS door is judged on the tipo the write lands on', () => {
	beforeAll(async () => {
		requireReady();
		await deleteTldNodes(ALIAS_TLD);
		await upsertDdOntologyNode({
			tipo: ALIAS_SECTION,
			model: 'section',
			tld: ALIAS_TLD,
			term: { 'lg-eng': 'Write-language alias gate section' },
			// The `test24` matrix_table relation, so this scratch section stores in
			// `matrix_test` instead of the installation's own default table.
			relations: [{ tipo: 'test24' }],
		});
		await upsertDdOntologyNode({
			tipo: ALIAS_TARGET,
			model: 'component_input_text',
			parent: ALIAS_SECTION,
			tld: ALIAS_TLD,
			is_translatable: true,
			term: { 'lg-eng': 'Target text' },
		});
		await upsertDdOntologyNode({
			tipo: ALIAS_FACE,
			model: 'component_alias',
			parent: ALIAS_SECTION,
			tld: ALIAS_TLD,
			term: { 'lg-eng': 'Alias face' },
			properties: { alias_of: ALIAS_TARGET },
		});
		// The legacy slice lives under the TARGET key — stored data never carries
		// the alias tipo. ::text::jsonb, the Bun.sql jsonb string-param trap.
		await sql.unsafe(
			'INSERT INTO matrix_test (section_id, section_tipo, string) VALUES ($1, $2, $3::text::jsonb)',
			[
				ALIAS_RECORD_ID,
				ALIAS_SECTION,
				JSON.stringify({
					[ALIAS_TARGET]: [{ id: 1, lang: UNDECLARED_LANG, value: 'legacy alias slice' }],
				}),
			],
		);
	});

	afterAll(async () => {
		if (!ready) return;
		await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1', [ALIAS_SECTION]);
		await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [ALIAS_SECTION]);
		await deleteTldNodes(ALIAS_TLD);
	});

	/** The target's stored items, read straight from the column the alias writes. */
	async function targetItems(): Promise<{ lang?: string; value?: string }[]> {
		const rows = (await sql.unsafe(
			'SELECT string->$3 AS items FROM matrix_test WHERE section_tipo = $1 AND section_id = $2',
			[ALIAS_SECTION, ALIAS_RECORD_ID, ALIAS_TARGET],
		)) as { items: unknown }[];
		const items = rows[0]?.items;
		return Array.isArray(items) ? (items as { lang?: string; value?: string }[]) : [];
	}

	/**
	 * THE ORDER, GATED. The language check runs AFTER the alias hop, so the round
	 * trip inspects the slice the write will really land on. Move it above the hop
	 * and this save is refused — the alias tipo holds no stored items, in this
	 * record or any other, because stored data never carries it.
	 */
	test('a re-save through the ALIAS of a language only the TARGET carries is admitted', async () => {
		requireReady();
		const outcome = await saveComponentData({
			componentTipo: ALIAS_FACE,
			sectionTipo: ALIAS_SECTION,
			sectionId: ALIAS_RECORD_ID,
			lang: UNDECLARED_LANG,
			changedData: [
				{ action: 'set_data', id: null, value: [{ id: 1, value: 'maintained through the alias' }] },
			],
			userId: USER,
			saveTm: false,
		});
		expect(outcome.ok).toBe(true);
		const items = await targetItems();
		expect(items.map((item) => item.lang)).toEqual([UNDECLARED_LANG]);
		expect(items.map((item) => item.value)).toEqual(['maintained through the alias']);
		// And the alias tipo still stores nothing of its own (WC-020 unity).
		const aliasOwn = (await sql.unsafe(
			'SELECT string->$3 AS items FROM matrix_test WHERE section_tipo = $1 AND section_id = $2',
			[ALIAS_SECTION, ALIAS_RECORD_ID, ALIAS_FACE],
		)) as { items: unknown }[];
		expect(aliasOwn[0]?.items ?? null).toBeNull();
	});

	test('the alias door introduces nothing: another undeclared language is refused', async () => {
		requireReady();
		const attempt = saveComponentData({
			componentTipo: ALIAS_FACE,
			sectionTipo: ALIAS_SECTION,
			sectionId: ALIAS_RECORD_ID,
			lang: 'lg-qqq',
			changedData: [{ action: 'set_data', id: null, value: [{ value: 'a NEW phantom' }] }],
			userId: USER,
		});
		await expect(attempt).rejects.toThrow();
		expect((await targetItems()).map((item) => item.lang)).toEqual([UNDECLARED_LANG]);
	});
});

/* ══════ 6 · THE REFUSAL IS PRE-FLIGHT, not a rollback ══════ */

/** How a promise settled within `ms` — or that it was still blocked. */
async function settlement(promise: Promise<unknown>, ms: number): Promise<string> {
	return await Promise.race([
		promise.then(
			() => 'ok',
			() => 'refused',
		),
		Bun.sleep(ms).then(() => 'blocked'),
	]);
}

describe('the refusal runs BEFORE the transaction opens', () => {
	afterEach(() => {
		mock.module('../../src/core/db/postgres.ts', () => REAL_POSTGRES);
	});

	/**
	 * THE DIRECT CLAIM: no transaction is EVER opened. `withTransaction` is
	 * counted for the duration of two calls — a refused one and an accepted one —
	 * so the zero is measured against a one taken on the same code path, and this
	 * cannot pass by simply never reaching the write engine.
	 */
	test('a refused save opens NO transaction, where an accepted save opens one', async () => {
		requireReady();
		let opened = 0;
		mock.module('../../src/core/db/postgres.ts', () => ({
			...REAL_POSTGRES,
			withTransaction: async <T>(work: () => Promise<T>): Promise<T> => {
				opened += 1;
				return await REAL_POSTGRES.withTransaction(work);
			},
		}));
		try {
			const refused = saveComponentData({
				componentTipo: TEXT,
				sectionTipo: SECTION,
				sectionId: PREFLIGHT_ID,
				lang: 'lg-qqq',
				changedData: [{ action: 'set_data', id: null, value: [{ value: 'never' }] }],
				userId: USER,
			});
			await expect(refused).rejects.toThrow();
			// A rollback would have needed a BEGIN. There was none.
			expect(opened).toBe(0);

			// NON-VACUOUS: the same door, one declared language later, does open one.
			const accepted = await saveComponentData({
				componentTipo: TEXT,
				sectionTipo: SECTION,
				sectionId: PREFLIGHT_ID,
				lang: config.menu.dataLang,
				changedData: [{ action: 'set_data', id: null, value: [{ value: 'accepted' }] }],
				userId: USER,
			});
			expect(accepted.ok).toBe(true);
			expect(opened).toBeGreaterThan(0);
		} finally {
			mock.module('../../src/core/db/postgres.ts', () => REAL_POSTGRES);
		}
	});

	/**
	 * The second half, behavioural rather than instrumented: no part of the WRITE
	 * ever ran. Another connection HOLDS the record's row lock, so a save that got
	 * as far as its `SELECT … FOR UPDATE` blocks — which is what a refusal that
	 * had anything to roll back must have done first. The declared-language save
	 * proves the lock is real; the undeclared one answers straight through it.
	 */
	test('a refused save answers while another connection holds the record’s row lock', async () => {
		requireReady();
		let releaseLock = (): void => {};
		const lockReleased = new Promise<void>((done) => {
			releaseLock = done;
		});
		let lockTaken = (): void => {};
		const locked = new Promise<void>((done) => {
			lockTaken = done;
		});
		let lockerError: unknown = null;
		const locker = withTransaction(async () => {
			await sql.unsafe(
				`SELECT section_id FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2 FOR UPDATE`,
				[SECTION, PREFLIGHT_ID],
			);
			lockTaken();
			await lockReleased;
		}).catch((error: unknown) => {
			lockerError = error;
			lockTaken();
		});

		let blocked: Promise<unknown> | null = null;
		try {
			await locked;
			expect(lockerError).toBeNull();

			// THE INSTRUMENT, proved first: a DECLARED-language save on the same row
			// opens a transaction, hits the lock and does NOT answer.
			blocked = saveComponentData({
				componentTipo: TEXT,
				sectionTipo: SECTION,
				sectionId: PREFLIGHT_ID,
				lang: config.menu.dataLang,
				changedData: [{ action: 'set_data', id: null, value: [{ value: 'behind the lock' }] }],
				userId: USER,
			});
			expect(await settlement(blocked, 600)).toBe('blocked');

			// THE CLAIM: the undeclared-language refusal answers anyway. A rollback
			// cannot reach this point — the transaction that would roll back could
			// not have taken the row in the first place.
			const refused = saveComponentData({
				componentTipo: TEXT,
				sectionTipo: SECTION,
				sectionId: PREFLIGHT_ID,
				lang: 'lg-qqq',
				changedData: [{ action: 'set_data', id: null, value: [{ value: 'never' }] }],
				userId: USER,
			});
			expect(await settlement(refused, 600)).toBe('refused');
		} finally {
			releaseLock();
			await locker;
			if (blocked !== null) await blocked.catch(() => undefined);
		}
	});
});

/* ══ 6b · THE POST-SAVE CACHE CLEAR WAITS FOR THE CALLER'S TRANSACTION ══ */

/**
 * `saveComponentData` invalidates the security caches after its own
 * `withTransaction` returns — "post-commit" only when this door OWNS the
 * transaction. Under an ambient caller transaction (the import doors' per-record
 * and per-row wraps, which this batch gave the MARC21/Zotero/RDF executor)
 * `withTransaction` JOINS it and returns with the transaction still open, so a
 * direct clear there re-opens the S1-14 window: a concurrent request repopulates
 * the cache from state that does not include this write, and the entry is stale
 * from the moment the caller commits.
 *
 * The clear is therefore queued on the deferred lane, and this measures WHEN it
 * runs rather than trusting the comment. `deferPostTransaction` answers true
 * only while a live ambient queue exists, so the observed value IS the answer to
 * "were we still inside the transaction".
 */
describe('the post-save security-cache clear runs after the ambient transaction', () => {
	afterEach(() => {
		mock.module('../../src/core/security/permissions.ts', () => REAL_PERMISSIONS);
	});

	test('inside a caller transaction the clear is deferred, not run mid-transaction', async () => {
		requireReady();
		// A holder, not a `let`: TS narrows a closure-assigned local to its initial
		// type and would reject the assertions below.
		const observed: { insideTransaction: boolean | null } = { insideTransaction: null };
		mock.module('../../src/core/security/permissions.ts', () => ({
			...REAL_PERMISSIONS,
			// The name the save door queues on the DEFERRED lane since 2026-08-28: the
			// CACHE half alone. `invalidatePermissionsForWrite` also ends the account's
			// sessions, which must never replay on a rollback (P1-4), so the two were
			// split and this door takes the pure one.
			clearSecurityCachesForWrite: (): void => {
				// true = a live deferred queue, i.e. an OPEN ambient transaction.
				observed.insideTransaction = deferPostTransaction(() => {});
			},
		}));
		try {
			await withTransaction(async () => {
				const outcome = await saveComponentData({
					componentTipo: TEXT,
					sectionTipo: SECTION,
					sectionId: DEFERRED_ID,
					lang: config.menu.dataLang,
					changedData: [{ action: 'set_data', id: null, value: [{ value: 'inside a caller tx' }] }],
					userId: USER,
					saveTm: false,
				});
				expect(outcome.ok).toBe(true);
				// Not yet: the save returned, the caller's transaction is still open.
				expect(observed.insideTransaction).toBeNull();
			});
			// It ran on the way out, with the queue already closed.
			expect(observed.insideTransaction).toBe(false);
		} finally {
			mock.module('../../src/core/security/permissions.ts', () => REAL_PERMISSIONS);
		}
	});

	test('with no caller transaction it still runs inline, exactly as before', async () => {
		requireReady();
		let clears = 0;
		mock.module('../../src/core/security/permissions.ts', () => ({
			...REAL_PERMISSIONS,
			clearSecurityCachesForWrite: (): void => {
				clears += 1;
			},
		}));
		try {
			const outcome = await saveComponentData({
				componentTipo: TEXT,
				sectionTipo: SECTION,
				sectionId: DEFERRED_ID,
				lang: config.menu.dataLang,
				changedData: [{ action: 'set_data', id: null, value: [{ value: 'no caller tx' }] }],
				userId: USER,
				saveTm: false,
			});
			expect(outcome.ok).toBe(true);
			expect(clears).toBe(1);
		} finally {
			mock.module('../../src/core/security/permissions.ts', () => REAL_PERMISSIONS);
		}
	});
});

/* ══════ 7 · THE CSV DOOR, BEHAVIOURALLY (DATA-01's primary site) ══════ */

/**
 * The primary site was gated by a STRING MATCH on one line — the weakest link in
 * the whole change. This drives the door itself: a staged CSV, the real
 * `import_files` handler, a session data language ≠ the install default, and the
 * stored slice as the answer.
 */
describe('the CSV import door writes in the SESSION’s data language', () => {
	const CSV_NAME = 'write_lang_provenance_gate.csv';
	let csvPath: string | null = null;

	afterAll(() => {
		if (csvPath !== null) rmSync(csvPath, { force: true });
	});

	test('a CSV row imported under a session language lands in THAT language', async () => {
		requireReady();
		// The suite media root is armed by the test preload, so an absent one is a
		// broken run, not a reason to pass without staging a file.
		const mediaRoot = config.media.rootPath;
		expect(typeof mediaRoot === 'string' && mediaRoot !== '').toBe(true);
		// The door reads from its own staging directory, rebuilt from the user id.
		const dir = resolve(mediaRoot ?? '', 'import/files', String(USER));
		mkdirSync(dir, { recursive: true });
		csvPath = join(dir, CSV_NAME);
		// Dédalo's CSV delimiter is ';' (import_csv.ts parseCsvDetailed default).
		writeFileSync(csvPath, `section_id;${TEXT}\n${CSV_ID};csv session value\n`, 'utf8');

		// Named explicitly: an action that is renamed away must fail HERE, not
		// dissolve into an optional-chained undefined that asserts nothing.
		const handler = csvTool.apiActions.import_files?.handler;
		expect(typeof handler).toBe('function');

		// The operator's session language, exactly as dispatch would scope it.
		const response = (await runWithRequestLangs(
			{ applicationLang: config.menu.applicationLang, dataLang: SESSION_LANG },
			() =>
				handler?.({
					principal: ADMIN,
					userId: USER,
					background: false,
					options: {
						time_machine_save: false,
						files: [
							{
								file: CSV_NAME,
								section_tipo: SECTION,
								bulk_process_label: 'write_lang_provenance gate',
								ar_columns_map: [
									{ model: 'component_section_id', tipo: 'section_id' },
									{ checked: true, tipo: TEXT, map_to: TEXT, model: MODEL },
								],
							},
						],
					},
				}),
		)) as { data?: { files?: { errors?: string[]; bulk_process_id?: number | null }[] } };

		const file = response.data?.files?.[0];
		rememberBulkProcess(file?.bulk_process_id ?? null);
		expect(file).toBeDefined();
		expect(file?.errors ?? []).toEqual([]);
		expect(await storedLangs(CSV_ID)).toEqual([SESSION_LANG]);
	});
});
