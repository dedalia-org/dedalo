/**
 * tool_bibliography_acquisition — pastes a public journal/OAI-PMH URL, harvests its metadata, and
 * lets the operator review every publication before committing: preview_url returns the parsed
 * series + publications (nothing written yet); commit_publications creates one rsc205 record per
 * kept publication, resolves/links its Series and Authors, and imports the PDF when one is found.
 */

import { NO_LANG } from '../../../src/config/data_langs.ts';
import { sanitizeClientSqo } from '../../../src/core/concepts/sqo.ts';
import { sql, withTransaction } from '../../../src/core/db/postgres.ts';
import { DedaloError } from '../../../src/core/errors/dedalo_error.ts';
import {
	type ApiErrorBody,
	ok,
	toDedaloError,
	toErrorBody,
} from '../../../src/core/errors/index.ts';
import { harvestFetch } from '../../../src/core/harvest/harvest.ts';
import {
	processUploadedFile,
	requireMediaSpec,
} from '../../../src/core/media/ingest/process_uploaded_file.ts';
import { receiveUpload } from '../../../src/core/media/ingest/upload.ts';
import { buildMediaIdentifier } from '../../../src/core/media/path.ts';
import { resolveMediaToolContext } from '../../../src/core/media/tool_support.ts';
import {
	nameKeysForQuality,
	persistUploadedMedia,
} from '../../../src/core/media/tools/files_info_persist.ts';
import { getColumnNameByModel, getModelByTipo } from '../../../src/core/ontology/resolver.ts';
import { getAlpha2FromCode } from '../../../src/core/resolve/lang_names.ts';
import { currentDataLang } from '../../../src/core/resolve/request_lang.ts';
import { runSearch } from '../../../src/core/search/search_statement.ts';
import { buildSearchSql } from '../../../src/core/search/sql_assembler.ts';
import { createSectionRecord } from '../../../src/core/section/record/create_record.ts';
import {
	installedDataLangs,
	saveComponentData,
} from '../../../src/core/section/record/save_component.ts';
import { textAsParagraph } from '../../../src/core/tools/import_code_lookup.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
} from '../../../src/core/tools/module.ts';
import {
	type AbstractLangs,
	type AbstractSkip,
	planAbstractLangs,
} from './lib/domain/abstract_langs.ts';
import { parseDcDate, splitAuthorName } from './lib/extraction/parser-utils.ts';
import { ojsOaiAdapter } from './lib/sources/ojs_oai/adapter.ts';
import type { RawSource } from './lib/sources/types.ts';

// rsc205 is a VIRTUAL section (relations -> rsc3) but real records are stamped section_tipo='rsc205'
// itself, not rsc3 - confirmed against rsc170 (the coin tool's own virtual image section), whose
// 1,820 real rows all carry section_tipo='rsc170'.
const PUBLICATION_TIPO = 'rsc205';
// Dedup key - the same field tool_import_marc21/tool_import_zotero populate with their own
// source's item id (Zotero key, MARC control number). We use the OAI <identifier>.
const CODE_TIPO = 'rsc137'; // component_input_text, "Code"
const TITLE_TIPO = 'rsc140'; // component_input_text, "Title"
const AUTHORSHIP_RELATION_TIPO = 'rsc139'; // component_autocomplete_hi -> rsc197 (People)
const PERSONAL_NAME_TIPO = 'rsc349'; // component_input_text, quick-paste author text
const PAGES_TIPO = 'rsc223'; // component_input_text, "Pages. Physical description"
const ABSTRACT_TIPO = 'rsc221'; // component_text_area, parent rsc397 "Other descriptions" -> rsc3
const PUBLISHER_TIPO = 'rsc219'; // component_input_text, parent rsc129 (same group as Title)
const SERIES_RELATION_TIPO = 'rsc211'; // component_portal -> rsc212 (Series), no autocomplete
// UI config in the ontology - doesn't block a server-resolved write, same as
// numisdata147/161 not depending on their own UI config either.
const SERIES_NUMBER_TIPO = 'rsc384'; // component_input_text, "Serie/magazine/collection number"
const PUBLICATION_DATE_TIPO = 'rsc224'; // component_date, date_mode: "range"
const URL_TIPO = 'rsc217'; // component_iri
const PDF_URI_TIPO = 'rsc668'; // component_iri
const DOCUMENT_TIPO = 'rsc209'; // component_pdf, direct field on the Publication record itself

// Thesaurus-backed (component_select -> dd810), unlike every other field here - match-only, same
// spirit as the coin tool's Type linking. section_id=8 confirmed real: tool_import_zotero's own
// production config maps CSL "article"/"article-journal" to it, and its dd812 label reads
// "Artículo en revista científica" / "Scientific journal article" - exactly what dc:type's
// "info:eu-repo/semantics/article" means.
const TYPOLOGY_RELATION_TIPO = 'rsc138';
const TYPOLOGY_SECTION_TIPO = 'dd810';
const ARTICLE_TYPOLOGY_SECTION_ID = 8;

// Same match-only pattern, confirmed the same way: tool_import_zotero's config maps CSL "ISSN" to
// dd292 section_id=2, whose dd296 label reads "ISSN".
const STANDARD_NUMBER_TIPO = 'rsc147'; // component_input_text, holds the ISBN/ISSN value itself
const STANDARD_NUMBER_TYPE_RELATION_TIPO = 'rsc249';
const STANDARD_NUMBER_TYPE_SECTION_TIPO = 'dd292';
const ISSN_TYPE_SECTION_ID = 2;

const PEOPLE_SECTION_TIPO = 'rsc197'; // also virtual (relations -> rsc75); same storage rule applies
const PERSON_SURNAME_TIPO = 'rsc86';
const PERSON_GIVEN_NAME_TIPO = 'rsc85';

const SERIES_SECTION_TIPO = 'rsc212'; // also virtual (relations -> dd22); same storage rule applies
const SERIES_NAME_TIPO = 'rsc214';

const RELATION_TYPE_LINK = 'dd151';
const IMPORT_KEY_DIR = 'bibliography_acquisition';

const ADAPTERS = [ojsOaiAdapter];

// Mirrors ojs_oai/acquisition.ts's MAX_ARTICLES (review item G): preview already caps what it
// fetches, so a normal client never sends more than this; this is defense in depth against a
// malformed/adversarial commit_publications payload, same reasoning as commit_lots's own cap in
// tool_numisdata_acquisition.
const MAX_PUBLICATIONS = 200;

/** How many look-alike candidates a find-by-name reads back for the byte-exact compare
 * (import_code_lookup.ts's reasoning: a real look-alike cluster must fit inside the window, or the
 * byte-exact row could be evicted before it is even read). */
const LOOKALIKE_WINDOW = 10;

function assertUrlOption(options: Record<string, unknown>): string {
	const url = options.url;
	if (typeof url !== 'string' || url.trim() === '') {
		throw new DedaloError('request.invalid_options', {
			message: 'preview_url requires a non-empty "url" string option.',
			publicMessage: 'Paste a journal URL first.',
		});
	}
	return url;
}

function findAdapterOrThrow(url: string) {
	const adapter = ADAPTERS.find((candidate) => candidate.matchesUrl(url));
	if (!adapter) {
		throw new DedaloError('request.invalid_options', {
			message: `No supported source adapter matches this URL: ${url}`,
			publicMessage: 'Only OAI-PMH journal/repository URLs are supported right now.',
		});
	}
	return adapter;
}

/**
 * Fetches and parses one bounded set of articles - a single article, or every article linked from
 * the pasted listing page (a journal homepage's current issue, an issue page, ...) - never a whole
 * journal's history. Also runs a read-only Series existence check so the review screen can show
 * "will link" vs "will create". Runs as a background job - one GetRecord fetch per article.
 */
async function previewUrl(context: ToolActionContext): Promise<ToolResponse> {
	const url = assertUrlOption(context.options);
	const adapter = findAdapterOrThrow(url);

	const acquisition = await adapter.acquire(url, (current, total) => {
		context.publishProgress?.({
			msg: `Fetching article ${current} of ${total}`,
			counter: current,
			total,
		});
	});
	const firstPage = acquisition.pages[0];
	if (firstPage === undefined) {
		throw new DedaloError('tool.action_failed', {
			message: `Adapter '${adapter.id}' returned zero pages for ${url}.`,
		});
	}

	const series = adapter.parseSeries(firstPage, url);
	const publications = acquisition.pages.flatMap((page) => adapter.parsePublications(page, url));

	const seriesName = series.name?.trim() ?? '';
	const existingSeriesSectionId =
		seriesName !== '' ? await findExistingSeries(seriesName, context) : null;

	return ok(
		{
			series,
			publications,
			series_status: {
				exists: existingSeriesSectionId !== null,
				section_id: existingSeriesSectionId,
			},
			// One {article_id, error} per article whose metadata could not be fetched; `error` is the
			// whole error wire body (the client renders its label/message).
			article_failures: acquisition.failures ?? [],
			publications_truncated_by: acquisition.truncatedBy ?? 0,
		},
		{ requestId: toolRequestId(context) },
	);
}

/**
 * Parses a page the OPERATOR's own browser already fetched, instead of this tool fetching it live -
 * the fallback for a source that blocks automated retrieval (confirmed live for OJS journal landing
 * pages: a Cloudflare challenge, HTTP 200, not a 403 our code can detect by status code alone).
 * Single-page only - no live fetch here to drive resumptionToken pagination.
 */
async function previewHtml(context: ToolActionContext): Promise<ToolResponse> {
	const url = assertUrlOption(context.options);
	const html = context.options.html;
	if (typeof html !== 'string' || html.trim() === '') {
		throw new DedaloError('request.invalid_options', {
			message: 'preview_html requires a non-empty "html" string option.',
			publicMessage: "Paste or upload the saved page's content first.",
		});
	}

	const adapter = findAdapterOrThrow(url);
	// No live fetch happens on this path (the operator supplies the HTML), so there is nothing here
	// for the harvesting door to guard - just the same https-only shape check previewUrl's real
	// fetch would also enforce.
	if (new URL(url).protocol !== 'https:') {
		throw new DedaloError('request.invalid_options', {
			message: `preview_html: only https:// URLs are supported, got ${url}.`,
			publicMessage: 'Only https:// URLs are supported.',
		});
	}

	const page: RawSource = { html, finalUrl: url, httpStatus: 200, contentType: 'text/xml' };
	const series = adapter.parseSeries(page, url);
	const publications = adapter.parsePublications(page, url);

	const seriesName = series.name?.trim() ?? '';
	const existingSeriesSectionId =
		seriesName !== '' ? await findExistingSeries(seriesName, context) : null;

	return ok(
		{
			series,
			publications,
			series_status: {
				exists: existingSeriesSectionId !== null,
				section_id: existingSeriesSectionId,
			},
		},
		{ requestId: toolRequestId(context) },
	);
}

/** The install's data languages for abstract planning: every installed data lang that has an ISO
 * 639-1 code through the engine's own map, plus the request data lang - the same `{data, current}`
 * tool_import_rdf's engineRdfPlanLangs builds (rdf_import_plan.ts). Never a private code table: a
 * write in a language the install does not declare is refused by save_component.ts, which would
 * roll the whole publication's transaction back. */
function abstractLangs(): AbstractLangs {
	const data = installedDataLangs()
		.map((code) => ({ code, alpha2: getAlpha2FromCode(code) }))
		.filter((lang): lang is { code: string; alpha2: string } => lang.alpha2 !== null);
	return { data, current: currentDataLang() };
}

/** The parsed `abstractVariants` from one previewed publication (plain JSON off the wire, so every
 * shape is checked at runtime) - each pairs an `xml:lang` with its own abstract text. */
function readAbstractVariants(p: Record<string, unknown>): { lang: string | null; text: string }[] {
	if (!Array.isArray(p.abstractVariants)) return [];
	const out: { lang: string | null; text: string }[] = [];
	for (const entry of p.abstractVariants) {
		if (entry === null || typeof entry !== 'object') continue;
		const e = entry as Record<string, unknown>;
		if (typeof e.text !== 'string' || e.text.trim() === '') continue;
		out.push({ lang: typeof e.lang === 'string' ? e.lang : null, text: e.text });
	}
	return out;
}

/** Writes one field as a fresh 'set_data' (a bare {id, value} item). saveComponentData does not
 * throw on a refused write - it returns {ok: false, message} - so a discarded result here would let
 * a field the engine refused still get reported to the cataloguer as written. Never narrow scope
 * silently: a write that did not happen must be visible. */
async function writeField(
	sectionId: number,
	sectionTipo: string,
	componentTipo: string,
	value: string | number,
	userId: number,
	// Defaults to NO_LANG for the (majority) non-translatable call sites; the
	// one translatable field here (rsc221, Abstract - review item C5) passes
	// the installed data lang planAbstractLangs chose for each variant, or the
	// write lands in a slot the edit form never shows.
	lang: string = NO_LANG,
): Promise<void> {
	const save = await saveComponentData({
		componentTipo,
		sectionTipo,
		sectionId,
		lang,
		userId,
		changedData: [{ action: 'set_data', value: [{ id: 1, value }] }],
	});
	if (!save.ok) {
		// The refusal reason rides `cause` (log-only, never the wire), and WHICH write failed rides
		// `coordinates` (also log-only) — never a template string: a tool holding an outbound door
		// (harvestFetch) must never carry a literal property read off an error/result object in its
		// own source (ssrf_one_guard_tripwire). The console's own Error-printing walks `cause`
		// automatically, so the refusal reason still reaches the log.
		throw new DedaloError('record.save_failed', {
			coordinates: {
				component_tipo: componentTipo,
				section_tipo: sectionTipo,
				section_id: sectionId,
			},
			cause: save,
		});
	}
}

/** component_iri stores {id, iri, title} - NOT the generic {id, value} writeField uses. A bare
 * value-only entry silently fails to render (the edit UI reads .iri, finds undefined, shows blank)
 * even though it's really stored. */
async function writeIriField(
	sectionId: number,
	sectionTipo: string,
	componentTipo: string,
	iri: string,
	title: string | null,
	userId: number,
): Promise<void> {
	const save = await saveComponentData({
		componentTipo,
		sectionTipo,
		sectionId,
		lang: NO_LANG,
		userId,
		changedData: [{ action: 'set_data', value: [{ id: 1, iri, title: title ?? '' }] }],
	});
	if (!save.ok) {
		throw new DedaloError('record.save_failed', {
			coordinates: {
				component_tipo: componentTipo,
				section_tipo: sectionTipo,
				section_id: sectionId,
			},
			cause: save,
		});
	}
}

/** Writes a component_date field's `start` only, matching how real records represent a single
 * point-in-time date - the field's own date_mode is "range", but leaving `end` unset (rather than
 * duplicating the same date into it) is what the real production records do. save_component.ts's
 * component_date override computes the sort-key `time` on `start` regardless. */
async function writeDateField(
	sectionId: number,
	sectionTipo: string,
	componentTipo: string,
	date: { year: number; month: number; day: number },
	userId: number,
): Promise<void> {
	const save = await saveComponentData({
		componentTipo,
		sectionTipo,
		sectionId,
		lang: NO_LANG,
		userId,
		changedData: [
			{
				action: 'set_data',
				value: [{ id: 1, start: { year: date.year, month: date.month, day: date.day } }],
			},
		],
	});
	if (!save.ok) {
		throw new DedaloError('record.save_failed', {
			coordinates: {
				component_tipo: componentTipo,
				section_tipo: sectionTipo,
				section_id: sectionId,
			},
			cause: save,
		});
	}
}

/** Exact Code match - lets a re-import reuse the existing rsc205 record instead of duplicating it.
 * An SQO run WITH the caller's principal (buildSearchSql), not a hand-written SQL WHERE: the raw
 * SQL bypassed the projects filter, so a non-admin could get back the section_id of a publication
 * outside their projects, or see "skipped: true" for a record they cannot actually open (review
 * item B3). */
async function findExistingPublication(
	identifier: string,
	context: ToolActionContext,
): Promise<number | null> {
	const sqo = sanitizeClientSqo({
		section_tipo: [PUBLICATION_TIPO],
		limit: 1,
		filter: {
			$and: [
				{
					q: `==${identifier}`,
					path: [{ section_tipo: PUBLICATION_TIPO, component_tipo: CODE_TIPO }],
				},
			],
		},
	});
	const built = await buildSearchSql(sqo, { principal: context.principal });
	const rows = (await runSearch(built)) as {
		section_id: number;
	}[];
	return rows[0]?.section_id ?? null;
}

/** Exact name match - used by previewUrl (check only) and findOrCreateSeries. An SQO run WITH the
 * caller's principal, not a hand-written SQL WHERE (review item B3, same reasoning as
 * findExistingPublication above). Same search-then-exact-compare as findExistingPerson: the `==`
 * operator only NARROWS (accent/case-insensitive, f_unaccent), so "Saguntum" and "SAGUNTUM" would
 * otherwise be one series; each candidate's own stored name is compared byte-exact (trimmed). */
async function findExistingSeries(
	name: string,
	context: ToolActionContext,
): Promise<number | null> {
	const sqo = sanitizeClientSqo({
		section_tipo: [SERIES_SECTION_TIPO],
		limit: LOOKALIKE_WINDOW,
		filter: {
			$and: [
				{
					q: `==${name}`,
					path: [{ section_tipo: SERIES_SECTION_TIPO, component_tipo: SERIES_NAME_TIPO }],
				},
			],
		},
	});
	const built = await buildSearchSql(sqo, { principal: context.principal });
	const rows = (await runSearch(built)) as ({
		section_id: number;
	} & Record<string, unknown>)[];

	const column = await dataColumnOf(SERIES_NAME_TIPO);
	if (column === null) return null;
	const wanted = name.trim();
	for (const row of rows) {
		if (storedTextMatches(row, column, SERIES_NAME_TIPO, wanted)) return row.section_id;
	}
	return null;
}

/** A transaction-scoped advisory lock on an arbitrary dedup key - same primitive as
 * acquireNodeLock (src/core/db/postgres.ts) for an existing node, just keyed on a find-or-create
 * dedup key instead of a section_id, since the record doesn't exist yet when the race happens.
 * Serializes two concurrent commits that would otherwise both miss the lookup and both create
 * (review item C4). Must be called inside withTransaction - the lock releases at commit/rollback. */
async function acquireDedupLock(key: string): Promise<void> {
	await sql.unsafe('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
}

/** Folds a free-text name into the SAME equivalence class the engine's own `==` search operator
 * uses (Postgres `f_unaccent`, confirmed in import_code_lookup.ts): lowercased AND stripped of
 * diacritics. A dedup lock keyed on case alone let "Martín" and "Martin" take DIFFERENT locks
 * while the search still matches them to the SAME record - two concurrent commits of either
 * spelling could both miss the lookup and both create (review item: "Entity lock key vs search",
 * same bug class as numisdata's Entity lock). JS's NFD decomposition is not byte-identical to
 * Postgres's unaccent dictionary for every exotic script, but the lock only needs the two calls
 * to COLLIDE on the SAME key - the real correctness guarantee is still the re-check under the
 * lock, through the actual (accent-insensitive) search. */
function foldNameForLock(name: string): string {
	const decomposed = name.trim().toLowerCase().normalize('NFD');
	// Drop the Unicode "Combining Diacritical Marks" block (U+0300-U+036F) that NFD split the
	// accented letters into, by code point rather than a literal-character regex (keeps this file's
	// source free of non-ASCII combining marks, which render invisibly and are easy to corrupt).
	let out = '';
	for (const ch of decomposed) {
		const code = ch.codePointAt(0) ?? 0;
		if (code < 0x0300 || code > 0x036f) out += ch;
	}
	return out;
}

/** Finds an existing rsc212 Series record, or creates one when none matches. Locked and
 * RE-CHECKED under the lock before creating, inside one transaction: the first check ran before
 * any lock was held, so two concurrent commits for the same new series name used to both miss it
 * and both create one, and a failed name write left an unnamed orphan behind (review items C1, C4). */
async function findOrCreateSeries(
	context: ToolActionContext,
	name: string,
): Promise<{ sectionId: number; created: boolean }> {
	const found = await findExistingSeries(name, context);
	if (found !== null) return { sectionId: found, created: false };

	return withTransaction(async () => {
		await acquireDedupLock(`rsc212:name:${foldNameForLock(name)}`);
		const existing = await findExistingSeries(name, context);
		if (existing !== null) return { sectionId: existing, created: false };
		const sectionId = await createSectionRecord(SERIES_SECTION_TIPO, context.userId);
		await writeField(sectionId, SERIES_SECTION_TIPO, SERIES_NAME_TIPO, name, context.userId);
		return { sectionId, created: true };
	});
}

/** Links the Publication's Series field to an EXISTING rsc212 record. */
async function linkSeries(
	context: ToolActionContext,
	publicationSectionId: number,
	seriesSectionId: number,
): Promise<void> {
	const save = await saveComponentData({
		componentTipo: SERIES_RELATION_TIPO,
		sectionTipo: PUBLICATION_TIPO,
		sectionId: publicationSectionId,
		lang: NO_LANG,
		userId: context.userId,
		changedData: [
			{
				action: 'set_data',
				value: [
					{
						id: 1,
						type: RELATION_TYPE_LINK,
						section_id: seriesSectionId,
						section_tipo: SERIES_SECTION_TIPO,
						from_component_tipo: SERIES_RELATION_TIPO,
					},
				],
			},
		],
	});
	if (!save.ok) {
		throw new DedaloError('record.save_failed', {
			coordinates: { component_tipo: SERIES_RELATION_TIPO, section_id: publicationSectionId },
			cause: save,
		});
	}
}

/** Links a Publication field to one fixed, known-in-advance thesaurus term - used for both
 * Bibliographic typology (always "journal article") and Type of standard number (always "ISSN"),
 * neither of which needs a dynamic lookup since we only ever recognize one term for each. */
async function linkFixedTerm(
	context: ToolActionContext,
	publicationSectionId: number,
	componentTipo: string,
	targetSectionTipo: string,
	targetSectionId: number,
): Promise<void> {
	const save = await saveComponentData({
		componentTipo,
		sectionTipo: PUBLICATION_TIPO,
		sectionId: publicationSectionId,
		lang: NO_LANG,
		userId: context.userId,
		changedData: [
			{
				action: 'set_data',
				value: [
					{
						id: 1,
						type: RELATION_TYPE_LINK,
						section_id: targetSectionId,
						section_tipo: targetSectionTipo,
						from_component_tipo: componentTipo,
					},
				],
			},
		],
	});
	if (!save.ok) {
		throw new DedaloError('record.save_failed', {
			coordinates: { component_tipo: componentTipo, section_id: publicationSectionId },
			cause: save,
		});
	}
}

/** The search row's data column holding `tipo`, or null when the model/column cannot be resolved -
 * the caller then treats the lookup as NO match, never trusts an uncompared row. */
async function dataColumnOf(tipo: string): Promise<string | null> {
	const model = await getModelByTipo(tipo);
	return model !== null ? getColumnNameByModel(model) : null;
}

/** Every stored item's text value (trimmed) for one component, read straight off a search result
 * row's own data column (same extraction tool_import_files' matchFreeName uses) - no separate
 * per-row read. Every item, not only the first: a multi-item/multi-lang value can carry the
 * matching text in any of them. */
function storedItemTexts(row: Record<string, unknown>, column: string, tipo: string): string[] {
	const payload = row[column] as Record<string, unknown> | null | undefined;
	const rawItems = payload?.[tipo];
	const items = Array.isArray(rawItems) ? rawItems : rawItems == null ? [] : [rawItems];
	const texts: string[] = [];
	for (const item of items) {
		if (item === null || item === '') continue;
		const text =
			typeof item === 'object' ? String((item as { value?: unknown }).value ?? '') : String(item);
		texts.push(text.trim());
	}
	return texts;
}

/** Byte-exact (trimmed) compare against EVERY stored item. An empty `wanted` matches a component
 * with no stored text at all. */
function storedTextMatches(
	row: Record<string, unknown>,
	column: string,
	tipo: string,
	wanted: string,
): boolean {
	const texts = storedItemTexts(row, column, tipo).filter((text) => text !== '');
	return wanted === '' ? texts.length === 0 : texts.includes(wanted);
}

/** Exact (Surname, Given name) match - used by findOrCreatePerson. An SQO run WITH the caller's
 * principal, not a hand-written SQL WHERE (review item B3, same reasoning as
 * findExistingPublication above). A null givenName matches an EMPTY given name ('!*'), the SQO
 * equivalent of the original SQL's `IS NOT DISTINCT FROM NULL`.
 *
 * The `==` operator NARROWS through Postgres's `f_unaccent`, so "Martín, J." and "Martin, J."
 * are one candidate set (confirmed in import_code_lookup.ts) - trusting the first row blindly
 * would silently merge two possibly-DIFFERENT real people (review item: "accent-insensitive
 * author dedup"). `limit` is raised past 1 (import_code_lookup.ts's own reasoning: a real
 * look-alike cluster must fit inside the window, or the byte-exact row could be evicted before
 * it is even read) and each candidate's OWN stored text is read back and compared BYTE-EXACT
 * (trimmed); only that - never the loose search alone - decides "this is the same person". */
async function findExistingPerson(
	surname: string,
	givenName: string | null,
	context: ToolActionContext,
): Promise<number | null> {
	const sqo = sanitizeClientSqo({
		section_tipo: [PEOPLE_SECTION_TIPO],
		limit: LOOKALIKE_WINDOW,
		filter: {
			$and: [
				{
					q: `==${surname}`,
					path: [{ section_tipo: PEOPLE_SECTION_TIPO, component_tipo: PERSON_SURNAME_TIPO }],
				},
				{
					q: givenName === null ? '!*' : `==${givenName}`,
					path: [{ section_tipo: PEOPLE_SECTION_TIPO, component_tipo: PERSON_GIVEN_NAME_TIPO }],
				},
			],
		},
	});
	const built = await buildSearchSql(sqo, { principal: context.principal });
	const rows = (await runSearch(built)) as ({
		section_id: number;
	} & Record<string, unknown>)[];

	const surnameColumn = await dataColumnOf(PERSON_SURNAME_TIPO);
	const givenNameColumn = await dataColumnOf(PERSON_GIVEN_NAME_TIPO);
	if (surnameColumn === null || givenNameColumn === null) return null;

	const wantedSurname = surname.trim();
	const wantedGivenName = (givenName ?? '').trim();
	for (const row of rows) {
		if (
			storedTextMatches(row, surnameColumn, PERSON_SURNAME_TIPO, wantedSurname) &&
			storedTextMatches(row, givenNameColumn, PERSON_GIVEN_NAME_TIPO, wantedGivenName)
		) {
			return row.section_id;
		}
	}
	return null;
}

/** Finds an existing rsc197 Person record, or creates one when none matches. Locked and
 * RE-CHECKED under the lock before creating, inside one transaction: the first check ran before
 * any lock was held, so two concurrent commits for the same new person used to both miss it and
 * both create one, and a failed name write left an unnamed orphan behind (review items C1, C4). */
async function findOrCreatePerson(
	context: ToolActionContext,
	surname: string,
	givenName: string | null,
): Promise<{ sectionId: number; created: boolean }> {
	const found = await findExistingPerson(surname, givenName, context);
	if (found !== null) return { sectionId: found, created: false };

	return withTransaction(async () => {
		await acquireDedupLock(
			`rsc197:name:${foldNameForLock(surname)}|${foldNameForLock(givenName ?? '')}`,
		);
		const existing = await findExistingPerson(surname, givenName, context);
		if (existing !== null) return { sectionId: existing, created: false };
		const sectionId = await createSectionRecord(PEOPLE_SECTION_TIPO, context.userId);
		await writeField(sectionId, PEOPLE_SECTION_TIPO, PERSON_SURNAME_TIPO, surname, context.userId);
		if (givenName !== null) {
			await writeField(
				sectionId,
				PEOPLE_SECTION_TIPO,
				PERSON_GIVEN_NAME_TIPO,
				givenName,
				context.userId,
			);
		}
		return { sectionId, created: true };
	});
}

/** Links the Publication's Authorship field to every resolved rsc197 record in one bulk replace -
 * component_portal is multi-valued (not in save_component.ts's MONOVALUE_MODELS), so a single
 * set_data with N items is the correct way to write N authors, not N separate calls. */
async function linkAuthors(
	context: ToolActionContext,
	publicationSectionId: number,
	personSectionIds: number[],
): Promise<void> {
	const save = await saveComponentData({
		componentTipo: AUTHORSHIP_RELATION_TIPO,
		sectionTipo: PUBLICATION_TIPO,
		sectionId: publicationSectionId,
		lang: NO_LANG,
		userId: context.userId,
		changedData: [
			{
				action: 'set_data',
				value: personSectionIds.map((personSectionId, index) => ({
					id: index + 1,
					type: RELATION_TYPE_LINK,
					section_id: personSectionId,
					section_tipo: PEOPLE_SECTION_TIPO,
					from_component_tipo: AUTHORSHIP_RELATION_TIPO,
				})),
			},
		],
	});
	if (!save.ok) {
		throw new DedaloError('record.save_failed', {
			coordinates: { component_tipo: AUTHORSHIP_RELATION_TIPO, section_id: publicationSectionId },
			cause: save,
		});
	}
}

/**
 * Resolves a real downloadable PDF URL when the publication doesn't already carry one - OAI-PMH's
 * oai_dc never does, so this is the normal case for our only source. Best-effort: returns null
 * (never throws) when the landing page can't be reached (e.g. a Cloudflare-blocked journal) or has
 * no PDF galley link.
 */
async function resolvePublicationPdfUrl(
	publication: Record<string, unknown>,
): Promise<{ url: string | null; error: ApiErrorBody | null }> {
	const landingPageUrl = publication.landingPageUrl;
	if (typeof landingPageUrl !== 'string' || landingPageUrl === '')
		return { url: null, error: null };

	const adapter = ADAPTERS.find((candidate) => candidate.matchesUrl(landingPageUrl));
	if (!adapter?.resolvePdfUrl) return { url: null, error: null };

	try {
		return { url: await adapter.resolvePdfUrl(landingPageUrl), error: null };
	} catch (error) {
		// Previously `catch { return null }` - a robots/SSRF/blocked refusal looked IDENTICAL to
		// "this publication simply has no PDF link" (review item: "swallowed PDF refusals"), so the
		// cataloguer could never tell the two apart. Reported structurally now, same as every other
		// per-item error in this file.
		return { url: null, error: toErrorBody(toDedaloError(error)) };
	}
}

/**
 * The publication's PDF URL: its own `pdfUrl` when the source carried one, else resolved from the
 * landing page (best-effort, see resolvePublicationPdfUrl). Runs BEFORE the publication's birth
 * transaction - it may fetch over the network, which must never hold a transaction open - so the
 * URL is known by the time the record is born and rsc668 (PDF URI) is written INSIDE that same
 * transaction, never in a post-commit window where it could replace a curator's value.
 */
async function pdfUrlForPublication(
	publication: Record<string, unknown>,
): Promise<{ url: string | null; error: ApiErrorBody | null }> {
	const existingPdfUrl = publication.pdfUrl;
	if (typeof existingPdfUrl === 'string' && existingPdfUrl !== '') {
		return { url: existingPdfUrl, error: null };
	}
	return resolvePublicationPdfUrl(publication);
}

/**
 * Downloads the publication's PDF from the already-resolved `pdfUrl` and stores it directly on the
 * Publication record's own rsc209 field - no separate resource record or crop step needed, unlike
 * the numismatic tool's obverse/reverse image split. The ONLY step that runs after the birth
 * transaction commits: the media ingest writes files, which a rollback could not undo.
 */
async function importDocumentForPublication(
	context: ToolActionContext,
	pdfUrl: string,
	sectionId: number,
): Promise<{
	documentImported: boolean;
	documentError: ApiErrorBody | null;
}> {
	const adapter = ADAPTERS.find((candidate) => candidate.matchesUrl(pdfUrl));
	if (!adapter) {
		return {
			documentImported: false,
			documentError: toErrorBody(
				new DedaloError('external.not_registered', { coordinates: { pdfUrl } }),
			),
		};
	}

	const pdfResponse = await harvestFetch({
		url: pdfUrl,
		hosts: 'public',
		requireHttps: true,
		expectContentType: ['application/pdf'],
		maxBytes: 50 * 1024 * 1024,
	});
	if (!pdfResponse.ok) {
		return {
			documentImported: false,
			documentError: toErrorBody(
				new DedaloError('external.http_status', {
					coordinates: { source: 'pdf', url: pdfUrl, status: pdfResponse.status },
				}),
			),
		};
	}
	const bytes = pdfResponse.bytes;
	const fileName = `${PUBLICATION_TIPO}_${sectionId}.pdf`;

	const staged = receiveUpload(
		{
			keyDir: IMPORT_KEY_DIR,
			fileName,
			chunked: false,
			chunkIndex: 0,
			totalChunks: 1,
			blob: bytes,
			uploadId: null,
			csrfToken: null,
		},
		context.userId,
	);
	if (staged.tmpName === undefined) {
		return {
			documentImported: false,
			documentError: toErrorBody(
				new DedaloError('tool.action_failed', { message: 'PDF upload did not stage a file.' }),
			),
		};
	}

	const spec = requireMediaSpec('component_pdf');
	const { identity, pathOpts } = await resolveMediaToolContext({
		component_tipo: DOCUMENT_TIPO,
		section_tipo: PUBLICATION_TIPO,
		section_id: sectionId,
	});
	const result = await processUploadedFile({
		spec,
		identity,
		pathOpts,
		userId: context.userId,
		keyDir: IMPORT_KEY_DIR,
		tmpName: staged.tmpName,
		extension: 'pdf',
	});
	await persistUploadedMedia({
		sectionTipo: identity.sectionTipo,
		sectionId: identity.sectionId,
		componentTipo: identity.componentTipo,
		lang: identity.lang,
		filesInfo: result.filesInfo,
		originalFileName: fileName,
		originalNormalizedName: `${buildMediaIdentifier(identity)}.${result.extension}`,
		nameKeys: nameKeysForQuality(spec, undefined),
	});
	result.startTranscode?.();
	return { documentImported: true, documentError: null };
}

/** One resolved Series, cached within a commit batch. */
interface ResolvedSeries {
	sectionId: number;
	created: boolean;
}

/** One resolved Person, cached within a commit batch. */
interface ResolvedPerson {
	sectionId: number;
	created: boolean;
}

async function resolveSeriesCached(
	context: ToolActionContext,
	cache: Map<string, ResolvedSeries>,
	name: string,
): Promise<ResolvedSeries> {
	const cached = cache.get(name);
	if (cached !== undefined) return cached;
	const resolved = await findOrCreateSeries(context, name);
	cache.set(name, resolved);
	return resolved;
}

async function resolvePersonCached(
	context: ToolActionContext,
	cache: Map<string, ResolvedPerson>,
	surname: string,
	givenName: string | null,
): Promise<ResolvedPerson> {
	const key = `${surname}|${givenName ?? ''}`;
	const cached = cache.get(key);
	if (cached !== undefined) return cached;
	const resolved = await findOrCreatePerson(context, surname, givenName);
	cache.set(key, resolved);
	return resolved;
}

/**
 * OAI identifiers are "scheme:repository-id:local-id" (colon-delimited by protocol convention) -
 * the local-id alone reads far cleaner in the Code column than the full string, BUT the repository
 * id is not actually unique: many independent OJS installs share the PKP default
 * ("ojs.pkp.sfu.ca"), so two different journals' article 123 both reduced to the identical
 * "article/123" and looked like the same publication (review item C2). The landing page's own
 * hostname IS unique per journal, so prefixing the local-id with it disambiguates while staying
 * just as short - "revistas.usal.es/article/123", not the full OAI URN.
 */
function shortPublicationCode(identifier: string, landingPageUrl: string | null): string {
	const lastColon = identifier.lastIndexOf(':');
	const localId = lastColon === -1 ? identifier : identifier.slice(lastColon + 1);
	if (landingPageUrl === null) return identifier;
	try {
		return `${new URL(landingPageUrl).hostname}/${localId}`;
	} catch {
		return identifier;
	}
}

/** One publication's outcome from commitPublications. Every `*_error` is the error system's wire
 * body (toErrorBody(toDedaloError(...))), never a raw exception's own text property - review item
 * E2: that raw text can carry tipos, ids and SQL driver text to the client. */
interface CommitOnePublicationResult {
	publication_identifier: unknown;
	section_tipo: string;
	// null only when the item failed entirely (the transactional record+fields
	// write rolled back before creating anything) - `error` names why. A
	// partial record is never left behind: review item C1.
	section_id: number | null;
	error: ApiErrorBody | null;
	/** True when an rsc205 record with this Code already existed - nothing else in this result was
	 * attempted, section_id names the pre-existing record. */
	skipped: boolean;
	fields_written: string[];
	/** Abstract variants NOT written, each with its source `xml:lang` and why: the install does not
	 * declare that language (`language_not_installed`) or an earlier variant already took the slot
	 * (`duplicate_language`). The publication itself is still committed. */
	abstract_skipped: AbstractSkip[];
	series_section_id: number | null;
	series_created: boolean | null;
	series_error: ApiErrorBody | null;
	author_section_ids: number[];
	author_errors: ApiErrorBody[];
	document_imported: boolean;
	document_error: ApiErrorBody | null;
}

/** The publication's Series, found or created BEFORE its birth transaction (its own locked
 * transaction, findOrCreateSeries). Best-effort: a failure is reported, and the publication is
 * born without the link. */
async function resolveSeriesForPublication(
	context: ToolActionContext,
	publication: Record<string, unknown>,
	seriesCache: Map<string, ResolvedSeries>,
): Promise<{ series: ResolvedSeries | null; error: ApiErrorBody | null }> {
	const name = publication.seriesName;
	if (typeof name !== 'string' || name.trim() === '') return { series: null, error: null };
	try {
		return { series: await resolveSeriesCached(context, seriesCache, name.trim()), error: null };
	} catch (error) {
		return { series: null, error: toErrorBody(toDedaloError(error)) };
	}
}

/** Each author's Person, found or created BEFORE the publication's birth transaction (each in its
 * own locked transaction, findOrCreatePerson). Best-effort per author: a failure is reported and
 * that author is left out of the link. */
async function resolveAuthorsForPublication(
	context: ToolActionContext,
	authors: string[],
	personCache: Map<string, ResolvedPerson>,
): Promise<{ sectionIds: number[]; errors: ApiErrorBody[] }> {
	const sectionIds: number[] = [];
	const errors: ApiErrorBody[] = [];
	for (const author of authors) {
		try {
			const { surname, givenName } = splitAuthorName(author);
			if (surname === '') continue;
			const resolved = await resolvePersonCached(context, personCache, surname, givenName);
			sectionIds.push(resolved.sectionId);
		} catch (error) {
			errors.push(toErrorBody(toDedaloError(error)));
		}
	}
	return { sectionIds, errors };
}

/**
 * Creates an rsc205 record from one previewed publication, writes its fields, links its Series,
 * Authors and PDF URL, and imports the PDF document. Every write to the new record happens in ONE
 * birth transaction - nothing is written to it after that commits except the PDF media ingest -
 * so no curator edit can land in between and be replaced. The Series/Person find-or-create and the
 * PDF URL resolution (network) run BEFORE that transaction and are best-effort: a failure there is
 * reported in the result and the record is born without that link. Skips entirely (no create, no
 * field writes) when a record with the same Code was already imported, rather than risk
 * clobbering a cataloger's later edits.
 */
async function commitOnePublication(
	context: ToolActionContext,
	publication: Record<string, unknown>,
	seriesCache: Map<string, ResolvedSeries>,
	personCache: Map<string, ResolvedPerson>,
): Promise<CommitOnePublicationResult> {
	const p = publication;
	const identifier =
		typeof p.publicationIdentifier === 'string' && p.publicationIdentifier !== ''
			? shortPublicationCode(
					p.publicationIdentifier,
					typeof p.landingPageUrl === 'string' ? p.landingPageUrl : null,
				)
			: null;

	if (identifier !== null) {
		const existingSectionId = await findExistingPublication(identifier, context);
		if (existingSectionId !== null) {
			return {
				publication_identifier: p.publicationIdentifier,
				section_tipo: PUBLICATION_TIPO,
				section_id: existingSectionId,
				error: null,
				skipped: true,
				fields_written: [],
				abstract_skipped: [],
				series_section_id: null,
				series_created: null,
				series_error: null,
				author_section_ids: [],
				author_errors: [],
				document_imported: false,
				document_error: null,
			};
		}
	}

	const publicationTitle = typeof p.title === 'string' ? p.title : null;
	const authors = Array.isArray(p.authors)
		? p.authors.filter((a): a is string => typeof a === 'string')
		: [];

	// Everything the links need is resolved BEFORE the birth transaction: the Series and Person
	// find-or-create run in their own locked transactions and return ids, and the PDF URL may need
	// a network fetch, which must never hold a transaction open. The links themselves are then
	// written INSIDE the birth transaction. They used to be written after it committed, a window in
	// which a curator's edit to SERIES_RELATION_TIPO / AUTHORSHIP_RELATION_TIPO / PDF_URI_TIPO on
	// the fresh record would have been replaced. HONEST LIMIT: a Series/Person created here stays
	// when the birth transaction then rolls back or finds a concurrent duplicate - a well-formed
	// find-or-create record the next import reuses, never a half-written one.
	const seriesResolution = await resolveSeriesForPublication(context, p, seriesCache);
	const authorResolution = await resolveAuthorsForPublication(context, authors, personCache);
	const pdfResolution = await pdfUrlForPublication(p);

	// One transaction for the record + its own fields and relations: a
	// writeField throw used to escape uncaught, and since the Code (the dedup
	// key) was written FIRST, the orphan it left behind made every later
	// re-import see "already imported" and skip a record with no title
	// forever (review item C1). A failed link write throws and rolls the
	// whole publication back (reported as the item's `error`), never a
	// half-linked record. Locked and RE-CHECKED under
	// the lock before creating: the FIRST check (above) ran before any lock was
	// held, so two concurrent commits of the same publication used to both
	// miss it and both create one (review item C4).
	const coreResult = await withTransaction(async () => {
		if (identifier !== null) {
			await acquireDedupLock(`rsc205:code:${identifier}`);
			const existing = await findExistingPublication(identifier, context);
			if (existing !== null) {
				return { created: false as const, sectionId: existing };
			}
		}

		const newSectionId = await createSectionRecord(PUBLICATION_TIPO, context.userId);
		const written: string[] = [];

		if (identifier !== null) {
			await writeField(newSectionId, PUBLICATION_TIPO, CODE_TIPO, identifier, context.userId);
			written.push(CODE_TIPO);
		}
		if (typeof p.title === 'string' && p.title.trim() !== '') {
			await writeField(newSectionId, PUBLICATION_TIPO, TITLE_TIPO, p.title, context.userId);
			written.push(TITLE_TIPO);
		}
		if (typeof p.pages === 'string' && p.pages.trim() !== '') {
			await writeField(newSectionId, PUBLICATION_TIPO, PAGES_TIPO, p.pages, context.userId);
			written.push(PAGES_TIPO);
		}
		// rsc221 is a component_text_area (stores HTML) - Cheerio's own .text() decodes entities, so
		// writing the plain text straight in makes e.g. "p < 0.05 &" invalid markup the moment the
		// record is opened (review item: "Abstract written as plain text into an HTML component").
		// textAsParagraph is the same escape+wrap every other HTML-component writer in this codebase
		// uses (import_code_lookup.ts), so a later lookup narrows against identical bytes.
		//
		// Each language variant goes into ITS OWN data-lang slot (review item: "Abstract language"),
		// planned against the install's declared data languages (planAbstractLangs): a variant in a
		// language the install lacks, or a second variant for an already-taken slot, is SKIPPED and
		// reported in `abstract_skipped` - never written (save_component would refuse it and roll
		// this whole publication back), never a silent last-wins overwrite.
		const abstractVariants = readAbstractVariants(p);
		const effectiveVariants =
			abstractVariants.length > 0
				? abstractVariants
				: typeof p.abstract === 'string' && p.abstract.trim() !== ''
					? [{ lang: null, text: p.abstract }]
					: [];
		const abstractPlan = planAbstractLangs(effectiveVariants, abstractLangs());
		let abstractWritten = false;
		for (const variant of abstractPlan.writes) {
			await writeField(
				newSectionId,
				PUBLICATION_TIPO,
				ABSTRACT_TIPO,
				textAsParagraph(variant.text),
				context.userId,
				variant.lang,
			);
			abstractWritten = true;
		}
		if (abstractWritten) written.push(ABSTRACT_TIPO);
		if (typeof p.publisher === 'string' && p.publisher.trim() !== '') {
			await writeField(newSectionId, PUBLICATION_TIPO, PUBLISHER_TIPO, p.publisher, context.userId);
			written.push(PUBLISHER_TIPO);
		}
		if (typeof p.seriesNumber === 'string' && p.seriesNumber.trim() !== '') {
			await writeField(
				newSectionId,
				PUBLICATION_TIPO,
				SERIES_NUMBER_TIPO,
				p.seriesNumber,
				context.userId,
			);
			written.push(SERIES_NUMBER_TIPO);
		}
		if (typeof p.landingPageUrl === 'string' && p.landingPageUrl.trim() !== '') {
			await writeIriField(
				newSectionId,
				PUBLICATION_TIPO,
				URL_TIPO,
				p.landingPageUrl,
				publicationTitle,
				context.userId,
			);
			written.push(URL_TIPO);
		}
		if (authors.length > 0) {
			await writeField(
				newSectionId,
				PUBLICATION_TIPO,
				PERSONAL_NAME_TIPO,
				authors.join('; '),
				context.userId,
			);
			written.push(PERSONAL_NAME_TIPO);
		}
		const parsedDate =
			typeof p.publicationDate === 'string' ? parseDcDate(p.publicationDate) : null;
		if (parsedDate !== null) {
			await writeDateField(
				newSectionId,
				PUBLICATION_TIPO,
				PUBLICATION_DATE_TIPO,
				parsedDate,
				context.userId,
			);
			written.push(PUBLICATION_DATE_TIPO);
		}
		const types = Array.isArray(p.types)
			? p.types.filter((t): t is string => typeof t === 'string')
			: [];
		if (types.includes('info:eu-repo/semantics/article')) {
			await linkFixedTerm(
				context,
				newSectionId,
				TYPOLOGY_RELATION_TIPO,
				TYPOLOGY_SECTION_TIPO,
				ARTICLE_TYPOLOGY_SECTION_ID,
			);
			written.push(TYPOLOGY_RELATION_TIPO);
		}
		if (typeof p.issn === 'string' && p.issn.trim() !== '') {
			await writeField(
				newSectionId,
				PUBLICATION_TIPO,
				STANDARD_NUMBER_TIPO,
				p.issn,
				context.userId,
			);
			written.push(STANDARD_NUMBER_TIPO);
			await linkFixedTerm(
				context,
				newSectionId,
				STANDARD_NUMBER_TYPE_RELATION_TIPO,
				STANDARD_NUMBER_TYPE_SECTION_TIPO,
				ISSN_TYPE_SECTION_ID,
			);
			written.push(STANDARD_NUMBER_TYPE_RELATION_TIPO);
		}
		if (seriesResolution.series !== null) {
			await linkSeries(context, newSectionId, seriesResolution.series.sectionId);
			written.push(SERIES_RELATION_TIPO);
		}
		if (authorResolution.sectionIds.length > 0) {
			await linkAuthors(context, newSectionId, authorResolution.sectionIds);
			written.push(AUTHORSHIP_RELATION_TIPO);
		}
		if (pdfResolution.url !== null) {
			// Written even when the byte download later fails: the URL is what the source states.
			await writeIriField(
				newSectionId,
				PUBLICATION_TIPO,
				PDF_URI_TIPO,
				pdfResolution.url,
				publicationTitle,
				context.userId,
			);
			written.push(PDF_URI_TIPO);
		}
		return {
			created: true as const,
			sectionId: newSectionId,
			fieldsWritten: written,
			abstractSkipped: abstractPlan.skipped,
		};
	});

	if (!coreResult.created) {
		return {
			publication_identifier: p.publicationIdentifier,
			section_tipo: PUBLICATION_TIPO,
			section_id: coreResult.sectionId,
			error: null,
			skipped: true,
			fields_written: [],
			abstract_skipped: [],
			series_section_id: null,
			series_created: null,
			series_error: null,
			author_section_ids: [],
			author_errors: [],
			document_imported: false,
			document_error: null,
		};
	}
	const { sectionId, fieldsWritten, abstractSkipped } = coreResult;

	// The ONLY post-commit step: the PDF media ingest writes files a rollback could not undo.
	let documentImported = false;
	let documentError: ApiErrorBody | null = pdfResolution.error;
	if (pdfResolution.url !== null) {
		try {
			const outcome = await importDocumentForPublication(context, pdfResolution.url, sectionId);
			documentImported = outcome.documentImported;
			documentError = outcome.documentError;
		} catch (error) {
			documentError = toErrorBody(toDedaloError(error));
		}
	}

	return {
		publication_identifier: p.publicationIdentifier,
		section_tipo: PUBLICATION_TIPO,
		section_id: sectionId,
		error: null,
		skipped: false,
		fields_written: fieldsWritten,
		abstract_skipped: [...abstractSkipped],
		series_section_id: seriesResolution.series?.sectionId ?? null,
		series_created: seriesResolution.series?.created ?? null,
		series_error: seriesResolution.error,
		author_section_ids: authorResolution.sectionIds,
		author_errors: authorResolution.errors,
		document_imported: documentImported,
		document_error: documentError,
	};
}

/**
 * Commits a curated batch of publications from the review screen. Runs as a background job - a
 * full-journal batch (hundreds of records, each a create + several field writes + author/series
 * resolution) is easily minutes. Progress is published per publication.
 */
async function commitPublications(context: ToolActionContext): Promise<ToolResponse> {
	const publications = context.options.publications;
	if (!Array.isArray(publications) || publications.length === 0) {
		throw new DedaloError('request.invalid_options', {
			message:
				'commit_publications requires a non-empty "publications" array (from preview_url, minus any excluded).',
			publicMessage: 'No publications to import — run Preview first, then keep at least one.',
		});
	}
	if (publications.length > MAX_PUBLICATIONS) {
		throw new DedaloError('request.invalid_options', {
			message: `commit_publications received ${publications.length} publications, over the ${MAX_PUBLICATIONS} cap.`,
			publicMessage: `Too many publications in one batch (${publications.length} > ${MAX_PUBLICATIONS}). Split the import into smaller batches.`,
		});
	}

	const seriesCache = new Map<string, ResolvedSeries>();
	const personCache = new Map<string, ResolvedPerson>();
	const results: CommitOnePublicationResult[] = [];
	let counter = 0;
	let stopped = false;
	for (const publication of publications) {
		// Checked at the loop boundary, same idiom as tool_import_files: a publication is committed
		// whole or not at all (C1's own transaction already guarantees that per record), so stopping
		// HERE never leaves a half-written record - it just leaves the REST of the batch uncommitted,
		// reported back as a partial summary rather than running to completion regardless of Stop.
		if (context.signal?.aborted) {
			stopped = true;
			break;
		}
		if (publication === null || typeof publication !== 'object') continue;
		counter += 1;
		const p = publication as Record<string, unknown>;
		context.publishProgress?.({
			msg: `Creating record for "${typeof p.title === 'string' ? p.title : `publication ${counter}`}"`,
			counter,
			total: publications.length,
		});
		// Never narrow scope silently: a commitOnePublication throw (e.g. its own
		// transaction rolling back) must not abort the rest of the batch, or
		// every publication already committed goes unreported and gets
		// duplicated on retry (review item C1).
		try {
			results.push(await commitOnePublication(context, p, seriesCache, personCache));
		} catch (error) {
			results.push({
				publication_identifier: p.publicationIdentifier,
				section_tipo: PUBLICATION_TIPO,
				section_id: null,
				error: toErrorBody(toDedaloError(error)),
				skipped: false,
				fields_written: [],
				abstract_skipped: [],
				series_section_id: null,
				series_created: null,
				series_error: null,
				author_section_ids: [],
				author_errors: [],
				document_imported: false,
				document_error: null,
			});
		}
	}

	return ok(
		{ results, stopped, publications_total: publications.length },
		{ requestId: toolRequestId(context) },
	);
}

export const tool: ToolServerModule = {
	name: 'tool_bibliography_acquisition',
	apiActions: {
		// 'targets' (not 'section'): previewUrl's own `options.section_tipo`, if the client sends
		// one at all, is NEVER what actually gets touched - the handler always fetches/parses
		// against rsc205. A 'section' gate reading the client's OWN field let any user who can read
		// ANY section start a live outbound fetch (review item: "preview actions are gated on any
		// section"), since nothing stopped them sending an unrelated but readable section_tipo.
		preview_url: {
			permission: 'targets',
			minLevel: 1,
			targets: () => [{ section_tipo: PUBLICATION_TIPO }],
			handler: previewUrl,
		},
		// Same gate - no network request (parses HTML/XML the operator already fetched), but still
		// never gated on a client-sent section_tipo for the same reason as preview_url.
		preview_html: {
			permission: 'targets',
			minLevel: 1,
			targets: () => [{ section_tipo: PUBLICATION_TIPO }],
			handler: previewHtml,
		},
		// 'targets' (not 'section'): the handler always writes rsc205/rsc197/
		// rsc212 regardless of what options.section_tipo says, so the gate must
		// name those fixed targets rather than trust the client's value. Each
		// (section, component) PAIR is named too, not just the bare section - a
		// section grant is not authority over a component the profile denies
		// (review item B1), so e.g. a profile allowed to edit rsc205 but denied
		// rsc209 (the PDF) or rsc139 (Authorship) must not be able to have this
		// tool write them anyway.
		commit_publications: {
			permission: 'targets',
			minLevel: 2,
			targets: () => [
				{ section_tipo: PUBLICATION_TIPO },
				{ section_tipo: PUBLICATION_TIPO, tipo: CODE_TIPO },
				{ section_tipo: PUBLICATION_TIPO, tipo: TITLE_TIPO },
				{ section_tipo: PUBLICATION_TIPO, tipo: PAGES_TIPO },
				{ section_tipo: PUBLICATION_TIPO, tipo: ABSTRACT_TIPO },
				{ section_tipo: PUBLICATION_TIPO, tipo: PUBLISHER_TIPO },
				{ section_tipo: PUBLICATION_TIPO, tipo: SERIES_NUMBER_TIPO },
				{ section_tipo: PUBLICATION_TIPO, tipo: URL_TIPO },
				{ section_tipo: PUBLICATION_TIPO, tipo: PERSONAL_NAME_TIPO },
				{ section_tipo: PUBLICATION_TIPO, tipo: PUBLICATION_DATE_TIPO },
				{ section_tipo: PUBLICATION_TIPO, tipo: TYPOLOGY_RELATION_TIPO },
				{ section_tipo: PUBLICATION_TIPO, tipo: STANDARD_NUMBER_TIPO },
				{ section_tipo: PUBLICATION_TIPO, tipo: STANDARD_NUMBER_TYPE_RELATION_TIPO },
				{ section_tipo: PUBLICATION_TIPO, tipo: SERIES_RELATION_TIPO },
				{ section_tipo: PUBLICATION_TIPO, tipo: AUTHORSHIP_RELATION_TIPO },
				{ section_tipo: PUBLICATION_TIPO, tipo: PDF_URI_TIPO },
				{ section_tipo: PUBLICATION_TIPO, tipo: DOCUMENT_TIPO },
				{ section_tipo: PEOPLE_SECTION_TIPO },
				{ section_tipo: PEOPLE_SECTION_TIPO, tipo: PERSON_SURNAME_TIPO },
				{ section_tipo: PEOPLE_SECTION_TIPO, tipo: PERSON_GIVEN_NAME_TIPO },
				{ section_tipo: SERIES_SECTION_TIPO },
				{ section_tipo: SERIES_SECTION_TIPO, tipo: SERIES_NAME_TIPO },
			],
			handler: commitPublications,
		},
	},
	backgroundRunnable: ['preview_url', 'commit_publications'],
	// preview_url scrapes the journal's OAI-PMH endpoint; commit_publications
	// stores PDFs, so it spends the media budget (PERF-11 lane declaration).
	backgroundLanes: { preview_url: 'maintenance', commit_publications: 'media' },
	// rsc3 covered too in case the resolved/real tipo is what reaches isAvailable instead of rsc205.
	isAvailable: (availabilityContext) =>
		availabilityContext.sectionTipo === PUBLICATION_TIPO ||
		availabilityContext.sectionTipo === 'rsc3',
};
