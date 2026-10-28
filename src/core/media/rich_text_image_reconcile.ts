/**
 * RICH-TEXT IMAGES — the two reconciles behind TODO-069 (TODO-066 follow-up).
 *
 * Since TODO-066 an editor upload is named after the record whose text it goes
 * into (`<stem>[-n]_<section_tipo>_<section_id>.<ext>`, claimKeyedWebImage) and
 * `image/<DEDALO_IMAGE_WEB_FOLDER>` is a public quality, so rule B serves it
 * exactly while that record is published. Historic data predates the naming:
 *
 *  - `rich_text_images` (registered HERE): text_area `<img src>` values in the
 *    matrix against the web folder's file names. Drift = an `src` that is not
 *    the stored form of a file keyed to ITS record (a legacy `pic.jpg`, a
 *    keyed name behind a v6 prefix). Apply COPIES the file to a keyed name for
 *    that record (one copy per embedding record; the original is never moved
 *    or deleted — Time Machine history still points at it) and rewrites the
 *    `src` through saveComponentData (TM row, HTML write gate). A missing file
 *    is reported and its text left alone; a slice a save would corrupt (stored
 *    under a lang the save does not write, or a component with lang-less
 *    items) is HELD and reported, never saved. The save runs the html write
 *    gate, so the sanitizer may also normalize other markup of a legacy text
 *    (the TM row keeps the original). Root-only apply; operator-run: finding
 *    the texts is a scan of every record table's `string` column.
 *
 *  - `web_image_exposure` (registered in the diffusion facade, which owns the
 *    marker store — this module gets the probe injected): web-folder files
 *    whose name PARSES to a published record that does not embed them — a
 *    legacy upload whose original name happened to end `_<tipo>_<id>`, or a
 *    keyed image removed from its text. Rule B serves them anonymously for no
 *    reason. Apply renames each one out of the grammar (`.legacy`) and
 *    rewrites any text that embeds it. Cheap (a directory listing + one marker
 *    stat + one record read per parsing name), so it runs dry at boot.
 *
 * Async file IO only: this module is reached from the maintenance request path
 * (sync_io_on_request_path_tripwire). The one sync step is claimKeyedWebImage,
 * the upload's own ledgered allocator.
 */

import { constants } from 'node:fs';
import { access, copyFile, link, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../config/config.ts';
import { MATRIX_TABLE_ALLOWLIST, type MatrixRecord, readMatrixRecord } from '../db/matrix.ts';
import { sql } from '../db/postgres.ts';
import { effectiveSaveLang, getMatrixTableFromTipo, getModelByTipo } from '../ontology/resolver.ts';
import type { ReconcileDefinition, ReconcileReport } from '../reconcile/registry.ts';
import { filterItemsByLang, readComponentItems } from '../resolve/component_data.ts';
import { decodeHtmlSpecialChars } from '../resolve/html_text.ts';
import { saveComponentData } from '../section/record/save_component.ts';
import {
	claimKeyedWebImage,
	NO_HARDLINK_ERRNOS,
	stagedTmpName,
	webImageRelDir,
} from './ingest/upload.ts';
import { requireMediaRoot } from './path.ts';
import { MEDIA_FILENAME_GRAMMAR } from './protection.ts';

const GRAMMAR = new RegExp(`^${MEDIA_FILENAME_GRAMMAR}`);

/** The TM actor of a reconcile write: the registry's doors carry no principal (root, as the CLI migrations). */
const RECONCILE_USER_ID = -1;

/** The record a web-folder file name parses to (rule B's own grammar). */
interface WebImageKey {
	sectionTipo: string;
	sectionId: number;
}

/** A keyed name's record, or null when the name does not parse (rule B's own grammar). */
export function keyOfWebImage(fileName: string): WebImageKey | null {
	const match = GRAMMAR.exec(fileName);
	return match === null ? null : { sectionTipo: match[1] as string, sectionId: Number(match[2]) };
}

/** Whether `fileName` is keyed to THIS record — never a bare grammar match (`photo_2019_3.jpg`). */
export function isKeyedTo(fileName: string, sectionTipo: string, sectionId: number): boolean {
	const key = keyOfWebImage(fileName);
	return key !== null && key.sectionTipo === sectionTipo && key.sectionId === sectionId;
}

/** `_<tipo>_<id>` — the needle every encoded form of a keyed name still contains. */
function needleOf(key: WebImageKey): string {
	return `_${key.sectionTipo}_${key.sectionId}`;
}

/** The path below the media base, or null for another host / a tag-button url. */
function belowWebBase(path: string, webBase: string): string | null {
	if (webBase !== '' && path.startsWith(`${webBase}/`)) return path.slice(webBase.length);
	return /^[a-z][a-z0-9+.-]*:|^\/\//i.test(path) ? null : path;
}

/** `%xx` decoded; a malformed escape leaves the name as its raw text. */
function decodeFileName(fileName: string): string {
	try {
		return decodeURIComponent(fileName);
	} catch {
		return fileName;
	}
}

/**
 * The web-folder FILE NAME an `<img src>` points at, or null when it is not a
 * web-folder image of THIS install: every historic prefix is accepted
 * (`../../../media/`, `/dedalo/<mediaDir>/`, a v6 custom root, webBase), the
 * query (`?<cachebust>`) and fragment are dropped, HTML entities decoded (the
 * PHP `htmlspecialchars_decode` set — a stored src escapes `&` as `&amp;`;
 * decodeHtmlSpecialChars is the ONE decoder, html_text_tripwire), `%xx`
 * decoded. Another host, a subfolder, a tag/button url
 * (`…/inc/btn.php/[geo-…]`) → null.
 */
export function parseLegacyWebImageSrc(
	src: string,
	relDir: string,
	webBase: string = config.media.webBase,
): string | null {
	const path = belowWebBase(src.trim(), webBase);
	if (path === null) return null;
	const marker = `/${relDir}/`;
	const at = path.indexOf(marker);
	if (at === -1) return null;
	const rest = decodeHtmlSpecialChars(path.slice(at + marker.length).replace(/[?#].*$/, ''));
	if (rest === '' || rest.includes('/')) return null;
	return decodeFileName(rest);
}

/** The STORED `src` of a web-folder file (WC-042 / TODO-067: same-origin relative, never webBase). */
export function storedWebImageSrc(fileName: string, relDir: string): string {
	return `/dedalo/${config.mediaDir}/${relDir}/${encodeURI(fileName)}`;
}

/**
 * Rewrite the `src` of every `<img>` in `html` that `map` answers for; the rest
 * of the html is byte-identical. shortcut: double-quoted src only (what CKEditor
 * and every stored form measured on 2026-10-26 carry); a single-quoted one is
 * left as is, upgrade if a corpus shows one.
 */
export function rewriteImgSrcs(html: string, map: (src: string) => string | null): string {
	return html.replace(/(<img\b[^>]*?\ssrc=")([^"]*)(")/gi, (whole, open, src, close) => {
		const next = map(src);
		return next === null ? whole : `${open}${next}${close}`;
	});
}

/** Every `<img src>` of an html value (double-quoted, as rewriteImgSrcs). */
function imgSrcs(html: string): string[] {
	return [...html.matchAll(/<img\b[^>]*?\ssrc="([^"]*)"/gi)].map((match) => match[1] as string);
}

/** Record tables a text can live in: the allowlist minus the activity logs (no editor text, and the largest). */
const TEXT_TABLES = MATRIX_TABLE_ALLOWLIST.filter((table) => !table.startsWith('matrix_activit'));

/** `needle` as a LIKE pattern, its wildcards escaped. */
function likePattern(needle: string): string {
	return `%${needle.replace(/[\\%_]/g, '\\$&')}%`;
}

/** The `section_tipo IN (…)` narrowing of a scope, or nothing when the scope is open. */
function scopeClause(scope: readonly string[] | undefined): string {
	if (scope === undefined) return '';
	return ` AND section_tipo IN (${scope.map((_, index) => `$${index + 2}`).join(', ')})`;
}

/** Whether the table exists in this install (a matrix table an update has not created yet). */
async function matrixTableExists(table: string): Promise<boolean> {
	const rows = (await sql.unsafe('SELECT to_regclass($1) IS NOT NULL AS ok', [
		`public."${table}"`,
	])) as { ok: boolean }[];
	return rows[0]?.ok === true;
}

/** The records of ONE table whose `string` column mentions `needle` (none when the table is absent). */
async function mentioningRows(
	table: string,
	needle: string,
	scope: readonly string[] | undefined,
): Promise<{ sectionTipo: string; sectionId: number }[]> {
	if (!(await matrixTableExists(table))) return [];
	const rows = (await sql.unsafe(
		`SELECT section_tipo, section_id FROM "${table}" WHERE string::text LIKE $1${scopeClause(scope)} ORDER BY section_tipo, section_id`,
		[likePattern(needle), ...(scope ?? [])],
	)) as { section_tipo: string; section_id: number }[];
	return rows.map((row) => ({ sectionTipo: row.section_tipo, sectionId: row.section_id }));
}

/** The records whose `string` column mentions `needle`, table by table. */
async function recordsMentioning(
	needle: string,
	scope: readonly string[] | undefined,
): Promise<{ table: string; sectionTipo: string; sectionId: number }[]> {
	if (scope !== undefined && scope.length === 0) return [];
	const found: { table: string; sectionTipo: string; sectionId: number }[] = [];
	for (const table of TEXT_TABLES) {
		for (const row of await mentioningRows(table, needle, scope)) found.push({ table, ...row });
	}
	return found;
}

/** One lang slice of one text_area: what the reconcile reads, rewrites and saves. */
interface TextSlice {
	sectionTipo: string;
	sectionId: number;
	componentTipo: string;
	lang: string;
	items: unknown[];
	/**
	 * Why this slice is never SAVED (reported instead), else null. A `set_data`
	 * save replaces the EFFECTIVE-lang slice (effectiveSaveLang) and drops the
	 * component's lang-less items: a slice stored under another lang would gain
	 * a copy instead of being rewritten, and lang-less items would be lost.
	 */
	held: string | null;
}

/** Why a lang-less item set is never SAVED: any save of the component drops it. */
const LANG_LESS_HELD = 'items without a lang (any save of this component drops them)';

/** Whether a text item carries a usable `lang`. */
function hasLang(lang: unknown): lang is string {
	return typeof lang === 'string' && lang !== '';
}

/** The `lang` a text item declares. */
function langOf(item: unknown): unknown {
	return (item as { lang?: unknown } | null)?.lang;
}

/** Why this lang cannot be rewritten by a save, or null when it can. */
async function saveHeldReason(componentTipo: string, lang: string): Promise<string | null> {
	const effective = await effectiveSaveLang(componentTipo, 'component_text_area', lang);
	return effective === lang
		? null
		: `stored as ${lang} but saved as ${effective} (a save would add a copy, not rewrite it)`;
}

/** The slices of ONE text_area component: one per lang it stores, plus its lang-less items. */
async function componentTextSlices(
	record: MatrixRecord,
	componentTipo: string,
): Promise<TextSlice[]> {
	const items = readComponentItems(record, componentTipo, 'component_text_area') ?? [];
	const langLess = items.filter((item) => !hasLang(langOf(item)));
	const held = langLess.length === 0 ? null : LANG_LESS_HELD;
	const base = { sectionTipo: record.section_tipo, sectionId: record.section_id, componentTipo };
	const slices: TextSlice[] = [];
	for (const lang of [...new Set(items.map(langOf))].filter(hasLang)) {
		slices.push({
			...base,
			lang,
			items: filterItemsByLang(items, lang),
			held: held ?? (await saveHeldReason(componentTipo, lang)),
		});
	}
	if (langLess.length > 0) slices.push({ ...base, lang: '(no lang)', items: langLess, held });
	return slices;
}

/** The text_area slices of a record, one per (component, lang). */
async function textSlices(record: MatrixRecord): Promise<TextSlice[]> {
	const string = record.columns.string;
	if (string === null || typeof string !== 'object') return [];
	const slices: TextSlice[] = [];
	for (const componentTipo of Object.keys(string)) {
		if ((await getModelByTipo(componentTipo)) !== 'component_text_area') continue;
		slices.push(...(await componentTextSlices(record, componentTipo)));
	}
	return slices;
}

/** The slice with `rewrite` applied to every string value; null when nothing changed. */
function rewriteSlice(slice: TextSlice, map: (src: string) => string | null): unknown[] | null {
	let changed = false;
	const items = slice.items.map((item) => {
		const value = (item as { value?: unknown } | null)?.value;
		if (typeof value !== 'string') return item;
		const next = rewriteImgSrcs(value, map);
		if (next === value) return item;
		changed = true;
		return { ...(item as Record<string, unknown>), value: next };
	});
	return changed ? items : null;
}

/** Save one rewritten slice (TM row + the html write gate). */
async function saveSlice(slice: TextSlice, items: unknown[]): Promise<string | null> {
	const saved = await saveComponentData({
		componentTipo: slice.componentTipo,
		sectionTipo: slice.sectionTipo,
		sectionId: slice.sectionId,
		lang: slice.lang,
		changedData: [{ action: 'set_data', value: items }],
		userId: RECONCILE_USER_ID,
		skipModifiedStamp: true,
	});
	return saved.ok ? null : (saved.message ?? 'save failed');
}

/** Save a plan's rewritten items when planning produced any; nothing when it did not. */
async function saveItems(slice: TextSlice, items: unknown[] | null): Promise<string | null> {
	return items === null ? null : await saveSlice(slice, items);
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** Where a record's slice lives, for the operator's report. */
function at(slice: TextSlice): string {
	return `${slice.sectionTipo}/${slice.sectionId} ${slice.componentTipo} ${slice.lang}`;
}

// ---------------------------------------------------------------------------
// rich_text_images
// ---------------------------------------------------------------------------

/** One slice's plan: the srcs to rewrite, the copies planning minted, what could not be planned. */
interface SlicePlan {
	drift: number;
	targets: Map<string, string>;
	failure: string | null;
	/** Keyed copies minted while planning THIS slice (taken back when its save does not land). */
	created: string[];
	changes: string[];
	missing: string[];
}

/** What one slice contributed to the run's report. */
interface SliceOutcome {
	drift: number;
	applied: number;
	changes: string[];
	missing: string[];
	held: string | null;
	failure: string | null;
}

/** Everything the run carries between records and slices. */
interface RunContext {
	relDir: string;
	webDir: string;
	options: { apply: boolean; scope?: readonly string[] };
	/** Keyed copies minted for the CURRENT record, shared by its langs. */
	copies: Map<string, string>;
	drift: number;
	applied: number;
	scannedRecords: number;
	changes: string[];
	missing: string[];
	held: string[];
	failed: string[];
}

function emptyPlan(): SlicePlan {
	return { drift: 0, targets: new Map(), failure: null, created: [], changes: [], missing: [] };
}

/**
 * The `rich_text_images` run. Drift = `src` values to rewrite (legacy names to
 * copy + keyed names behind a non-stored prefix); `missing` names a referenced
 * file absent from the web folder (reported, never rewritten).
 */
export async function runRichTextImages(options: {
	apply: boolean;
	scope?: readonly string[];
}): Promise<ReconcileReport> {
	const relDir = webImageRelDir();
	const ctx: RunContext = {
		relDir,
		webDir: join(requireMediaRoot(), relDir),
		options,
		copies: new Map(),
		drift: 0,
		applied: 0,
		scannedRecords: 0,
		changes: [],
		missing: [],
		held: [],
		failed: [],
	};
	for (const { table, sectionTipo, sectionId } of await recordsMentioning(
		`/${relDir}/`,
		options.scope,
	)) {
		await runRecord(table, sectionTipo, sectionId, ctx);
	}
	return {
		drift: ctx.drift,
		applied: ctx.applied,
		detail: {
			scannedRecords: ctx.scannedRecords,
			changes: ctx.changes,
			missing: ctx.missing,
			held: ctx.held,
			failed: ctx.failed,
			webFolder: relDir,
		},
	};
}

/** One record's slices, one after another: its minted copies are shared by all of them. */
async function runRecord(
	table: string,
	sectionTipo: string,
	sectionId: number,
	ctx: RunContext,
): Promise<void> {
	const record = await readMatrixRecord(table, sectionTipo, sectionId);
	if (record === null) return;
	ctx.scannedRecords++;
	ctx.copies = new Map();
	for (const slice of await textSlices(record)) accumulate(ctx, await runSlice(slice, ctx));
}

/** Plan ONE slice, then apply it. */
async function runSlice(slice: TextSlice, ctx: RunContext): Promise<SliceOutcome> {
	const plan = emptyPlan();
	await planSlice(slice, ctx, plan);
	return settleSlice(slice, plan, ctx);
}

/** Every `<img src>` of every html value of the slice, planned in order. */
async function planSlice(slice: TextSlice, ctx: RunContext, plan: SlicePlan): Promise<void> {
	for (const value of slice.items) {
		const html = (value as { value?: unknown } | null)?.value;
		if (typeof html !== 'string') continue;
		for (const src of imgSrcs(html)) await planSrc(src, slice, ctx, plan);
	}
}

/** The stored form of an src that already IS this record's own keyed file (never a bare grammar match). */
function alreadyStored(src: string, fileName: string, slice: TextSlice, relDir: string): boolean {
	if (!isKeyedTo(fileName, slice.sectionTipo, slice.sectionId)) return false;
	return src === storedWebImageSrc(fileName, relDir);
}

/** Note the src's target and the operator's line; nothing when planning could not name a target. */
function recordTarget(
	src: string,
	fileName: string,
	target: string | null,
	slice: TextSlice,
	ctx: RunContext,
	plan: SlicePlan,
): void {
	plan.changes.push(`${at(slice)}: ${fileName} → ${target ?? '(keyed copy)'}`);
	if (target !== null) plan.targets.set(src, storedWebImageSrc(target, ctx.relDir));
}

/** Whether planning may mint a copy right now: an apply, no failed copy, no held slice. */
function mayMint(slice: TextSlice, ctx: RunContext, plan: SlicePlan): boolean {
	return ctx.options.apply && plan.failure === null && slice.held === null;
}

/** Claim a keyed name for this record's copy of the file (the upload's own allocator). */
async function mintCopy(
	fileName: string,
	slice: TextSlice,
	ctx: RunContext,
	plan: SlicePlan,
): Promise<string | null> {
	try {
		const path = claimKeyedWebImage(join(ctx.webDir, fileName), stagedTmpName(fileName), {
			sectionTipo: slice.sectionTipo,
			sectionId: slice.sectionId,
		});
		const target = path.slice(ctx.relDir.length + 1);
		ctx.copies.set(fileName, target);
		plan.created.push(target);
		return target;
	} catch (error) {
		plan.failure = `copy of '${fileName}' failed: ${(error as Error).message}`;
		return null;
	}
}

/**
 * The name this src must store: the record's own keyed name, the copy this
 * record's run already minted for the file, or a NEW copy (apply only, never
 * for a held slice, never after a failed copy). Null when nothing can be named.
 */
async function copyTarget(
	fileName: string,
	slice: TextSlice,
	ctx: RunContext,
	plan: SlicePlan,
): Promise<string | null> {
	if (isKeyedTo(fileName, slice.sectionTipo, slice.sectionId)) return fileName;
	const minted = ctx.copies.get(fileName) ?? null;
	if (minted !== null) return minted;
	return mayMint(slice, ctx, plan) ? mintCopy(fileName, slice, ctx, plan) : null;
}

/** Plan one src: the stored form it must become (minting its copy on an apply), or why it cannot. */
async function planSrc(
	src: string,
	slice: TextSlice,
	ctx: RunContext,
	plan: SlicePlan,
): Promise<void> {
	const fileName = parseLegacyWebImageSrc(src, ctx.relDir);
	if (fileName === null || plan.targets.has(src)) return;
	if (alreadyStored(src, fileName, slice, ctx.relDir)) return;
	if (!(await fileExists(join(ctx.webDir, fileName)))) {
		plan.missing.push(`${at(slice)}: ${fileName}`);
		return;
	}
	plan.drift++;
	recordTarget(src, fileName, await copyTarget(fileName, slice, ctx, plan), slice, ctx, plan);
}

/** Take back the copies planning minted for a slice whose save did not land. */
async function abandon(plan: SlicePlan, ctx: RunContext, failure: string): Promise<string> {
	for (const name of plan.created) {
		await unlink(join(ctx.webDir, name)).catch(() => undefined);
		for (const [legacy, keyed] of ctx.copies) if (keyed === name) ctx.copies.delete(legacy);
	}
	return failure;
}

/** A held slice's report line, only when it really had drift to rewrite. */
function heldNote(slice: TextSlice, plan: SlicePlan): string | null {
	return plan.drift > 0 ? `${at(slice)}: ${slice.held}` : null;
}

/** Save the slice's planned rewrites: never a dry run, never an empty plan. */
async function savePlan(slice: TextSlice, plan: SlicePlan, ctx: RunContext): Promise<SliceOutcome> {
	const base: SliceOutcome = {
		drift: plan.drift,
		applied: 0,
		changes: plan.changes,
		missing: plan.missing,
		held: null,
		failure: null,
	};
	if (!ctx.options.apply || plan.targets.size === 0) return { ...base, failure: plan.failure };
	const items =
		plan.failure === null ? rewriteSlice(slice, (src) => plan.targets.get(src) ?? null) : null;
	const failure = plan.failure ?? (await saveItems(slice, items));
	if (failure === null) return { ...base, applied: plan.targets.size };
	return { ...base, failure: await abandon(plan, ctx, failure) };
}

/** The slice's outcome: what it planned, plus what a save said (a held slice is never saved). */
async function settleSlice(
	slice: TextSlice,
	plan: SlicePlan,
	ctx: RunContext,
): Promise<SliceOutcome> {
	const outcome: SliceOutcome =
		slice.held === null
			? await savePlan(slice, plan, ctx)
			: {
					drift: plan.drift,
					applied: 0,
					changes: plan.changes,
					missing: plan.missing,
					held: heldNote(slice, plan),
					failure: null,
				};
	return {
		...outcome,
		failure: outcome.failure === null ? null : `${at(slice)}: ${outcome.failure}`,
	};
}

/** Fold one slice's outcome into the run's report. */
function accumulate(ctx: RunContext, outcome: SliceOutcome): void {
	ctx.drift += outcome.drift;
	ctx.applied += outcome.applied;
	ctx.changes.push(...outcome.changes);
	ctx.missing.push(...outcome.missing);
	if (outcome.held !== null) ctx.held.push(outcome.held);
	if (outcome.failure !== null) ctx.failed.push(outcome.failure);
}

export const RICH_TEXT_IMAGES_RECONCILE: ReconcileDefinition = {
	name: 'rich_text_images',
	stores: ['matrix text_area <img src> values', 'image web folder file names'],
	description:
		'Find rich-text images whose src is not a file named after the record that embeds it (pre-TODO-066 uploads, v6 prefixes). Apply copies each one to a record-keyed name — so it is public exactly while that record is published — and rewrites the src through the normal save (Time Machine row); the original file is kept, a missing file is reported and its text untouched, and a text a save would corrupt (stored under a lang the save does not write, or with lang-less items) is held and reported. The save sanitizes the whole text as any save does.',
	scopeLabel: 'section tipo',
	// A LIKE scan over every record table's string column: an operator sweep, never a boot step.
	schedule: 'operator',
	applyRootOnly: {
		reason:
			'an apply turns login-only files into public ones (a keyed copy is served while its record is published) and rewrites texts across records: root only, like every apply that changes what the public can read',
	},
	sources: ['src/core/media/rich_text_image_reconcile.ts'],
	run: runRichTextImages,
};

// ---------------------------------------------------------------------------
// web_image_exposure (the definition lives in the diffusion facade)
// ---------------------------------------------------------------------------

/** A file younger than this is never judged: its text may simply not be saved yet. */
export const EXPOSURE_GRACE_MS = 24 * 60 * 60_000;

/** What one exposure judgement needs: the web folder, the instant, the marker probe. */
interface ExposureContext {
	relDir: string;
	webDir: string;
	now: number;
	isPublished: (key: string) => Promise<boolean>;
}

/** A file's mtime, or null when it is gone since the listing (nothing to judge). */
async function mtimeOrNull(path: string): Promise<number | null> {
	return stat(path).then(
		(info) => info.mtimeMs,
		() => null,
	);
}

/** The record a file name parses to, when that record is published (rule B serves the file). */
async function publishedKeyOf(
	name: string,
	isPublished: (key: string) => Promise<boolean>,
): Promise<WebImageKey | null> {
	const key = keyOfWebImage(name);
	if (key === null) return null;
	return (await isPublished(`${key.sectionTipo}_${key.sectionId}`)) ? key : null;
}

/** A keyed name's record, read once for its `string` column. */
async function recordOf(key: WebImageKey): Promise<MatrixRecord | null> {
	const table = await getMatrixTableFromTipo(key.sectionTipo);
	return table === null ? null : await readMatrixRecord(table, key.sectionTipo, key.sectionId);
}

/** The web folder's plain files, narrowed by `only` (no folder yet ⇒ none). */
async function webImageNames(webDir: string, only?: (name: string) => boolean): Promise<string[]> {
	try {
		const entries = await readdir(webDir, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
			.map((entry) => entry.name)
			.filter((name) => only?.(name) ?? true)
			.sort();
	} catch {
		return [];
	}
}

/** Whether rule B serves this file anonymously for no reason, or it cannot be judged yet. */
async function judgeWebImage(
	name: string,
	ctx: ExposureContext,
): Promise<'exposed' | 'recent' | 'ok'> {
	const key = await publishedKeyOf(name, ctx.isPublished);
	if (key === null) return 'ok';
	const mtimeMs = await mtimeOrNull(join(ctx.webDir, name));
	if (mtimeMs === null) return 'ok';
	if (ctx.now - mtimeMs < EXPOSURE_GRACE_MS) return 'recent';
	const record = await recordOf(key);
	if (record === null) return 'exposed';
	return embeds(record, ctx.relDir, name) ? 'ok' : 'exposed';
}

/** Every name sorted into exposed (a published record does not embed it) or recent (inside the grace). */
async function judgeWebImages(
	names: readonly string[],
	ctx: ExposureContext,
): Promise<{ exposed: string[]; recent: string[] }> {
	const exposed: string[] = [];
	const recent: string[] = [];
	for (const name of names) {
		const verdict = await judgeWebImage(name, ctx);
		if (verdict === 'exposed') exposed.push(name);
		else if (verdict === 'recent') recent.push(name);
	}
	return { exposed, recent };
}

/** Rename every exposed file out of the grammar, repointing the texts that embed it. */
async function withdrawExposedFiles(
	names: readonly string[],
	ctx: ExposureContext,
): Promise<{ applied: number; failed: string[] }> {
	const failed: string[] = [];
	let applied = 0;
	for (const name of names) {
		const failure = await withdrawExposed(name, ctx);
		if (failure === null) applied++;
		else failed.push(`${name}: ${failure}`);
	}
	return { applied, failed };
}

/**
 * The `web_image_exposure` run. `isPublished(key)` is the marker store's own
 * probe (media_index.ts hasPubMarker), injected by the diffusion facade.
 * `only` narrows the judged file names (a test seam: a gate judges its own files).
 */
export async function runWebImageExposure(options: {
	apply: boolean;
	isPublished: (key: string) => Promise<boolean>;
	now?: number;
	only?: (name: string) => boolean;
}): Promise<ReconcileReport> {
	const relDir = webImageRelDir();
	const ctx: ExposureContext = {
		relDir,
		webDir: join(requireMediaRoot(), relDir),
		now: options.now ?? Date.now(),
		isPublished: options.isPublished,
	};
	const judged = await judgeWebImages(await webImageNames(ctx.webDir, options.only), ctx);
	const withdrawn = options.apply
		? await withdrawExposedFiles(judged.exposed, ctx)
		: { applied: 0, failed: [] as string[] };
	return {
		drift: judged.exposed.length,
		applied: withdrawn.applied,
		detail: {
			exposed: judged.exposed,
			recent: judged.recent,
			failed: withdrawn.failed,
			webFolder: relDir,
			graceHours: EXPOSURE_GRACE_MS / 3_600_000,
		},
	};
}

/** Every child value of a parsed jsonb value, one level down. */
function childValues(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (value !== null && typeof value === 'object') return Object.values(value);
	return [];
}

/** Every string inside a parsed jsonb value (any component, any item shape). */
function stringsIn(value: unknown, out: string[] = []): string[] {
	if (typeof value === 'string') out.push(value);
	else for (const entry of childValues(value)) stringsIn(entry, out);
	return out;
}

/** Whether ANY string of the record's `string` column has an `<img src>` resolving to `name`. */
function embeds(record: MatrixRecord, relDir: string, name: string): boolean {
	return stringsIn(record.columns.string).some((html) =>
		imgSrcs(html).some((src) => parseLegacyWebImageSrc(src, relDir) === name),
	);
}

/** Same bytes on disk: the same inode (a link) or, on a store without links, equal content. */
async function sameFile(a: string, b: string): Promise<boolean> {
	const [left, right] = await Promise.all([stat(a), stat(b)]);
	if (left.ino === right.ino && left.dev === right.dev) return true;
	if (left.size !== right.size) return false;
	const [x, y] = await Promise.all([Bun.file(a).bytes(), Bun.file(b).bytes()]);
	return Buffer.from(x).equals(Buffer.from(y));
}

/** `x.jpg` → [`x`, `.jpg`]; a name with no extension keeps its whole self. */
function splitExtension(name: string): [string, string] {
	const dot = name.lastIndexOf('.');
	return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

/** The `1`st candidate keeps the plain `.legacy` name; the rest carry a counter. */
function legacySuffix(n: number): string {
	return n === 1 ? '' : String(n);
}

/**
 * `source` under `target`: a hardlink, or an exclusive copy on a store without
 * hardlinks. Null when it landed; otherwise the errno (or a message) that says why not.
 */
async function linkOrCopy(source: string, target: string): Promise<string | null> {
	try {
		await link(source, target);
		return null;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? '';
		if (!NO_HARDLINK_ERRNOS.has(code)) return code || (error as Error).message;
		return copyFile(source, target, constants.COPYFILE_EXCL).then(
			() => null,
			(copyError: NodeJS.ErrnoException) => copyError.code ?? 'copy failed',
		);
	}
}

/**
 * Take `name` to the first free `.legacy` name in the web folder — reusing the
 * one a previous half-run left there (same bytes, so it is the same file).
 */
async function legacyNameFor(
	webDir: string,
	name: string,
): Promise<{ name: string } | { error: string }> {
	const [stem, ext] = splitExtension(name);
	const source = join(webDir, name);
	for (let n = 1; n <= 99; n++) {
		const candidate = `${stem}.legacy${legacySuffix(n)}${ext}`;
		if (GRAMMAR.test(candidate))
			return { error: `'${candidate}' would still parse as a record key` };
		const failure = await linkOrCopy(source, join(webDir, candidate));
		if (failure === null) return { name: candidate };
		if (failure !== 'EEXIST') return { error: `${candidate}: ${failure}` };
		if (await sameFile(source, join(webDir, candidate))) return { name: candidate };
	}
	return { error: 'no free .legacy name' };
}

/** Point every text of one record that embeds `name` at `target`; a refusal is returned. */
async function repointRecord(
	record: MatrixRecord,
	name: string,
	target: string,
	relDir: string,
): Promise<string | null> {
	for (const slice of await textSlices(record)) {
		const items = rewriteSlice(slice, (src) =>
			parseLegacyWebImageSrc(src, relDir) === name ? target : null,
		);
		if (items === null) continue;
		// Both names stay on any refusal: texts saved before this one already point at `target`.
		const failure = slice.held ?? (await saveItems(slice, items));
		if (failure !== null) return `${at(slice)}: ${failure}`;
	}
	return null;
}

/** Point every text that embeds `name` at `target`; a refusal is returned (nothing deleted). */
async function repointEmbeds(
	key: WebImageKey,
	name: string,
	target: string,
	relDir: string,
): Promise<string | null> {
	for (const { table, sectionTipo, sectionId } of await recordsMentioning(
		needleOf(key),
		undefined,
	)) {
		const record = await readMatrixRecord(table, sectionTipo, sectionId);
		const failure = record === null ? null : await repointRecord(record, name, target, relDir);
		if (failure !== null) return failure;
	}
	return null;
}

/** The record still embedding `name` outside a rewritable text (`tipo/id`), or null. */
async function stillEmbeddedBy(
	key: WebImageKey,
	name: string,
	relDir: string,
): Promise<string | null> {
	for (const { table, sectionTipo, sectionId } of await recordsMentioning(
		needleOf(key),
		undefined,
	)) {
		const record = await readMatrixRecord(table, sectionTipo, sectionId);
		if (record !== null && embeds(record, relDir, name)) return `${sectionTipo}/${sectionId}`;
	}
	return null;
}

/**
 * Take one exposed file out of the grammar (`x_rsc170_45.jpg` →
 * `x_rsc170_45.legacy.jpg`: the name no longer ends `_<tipo>_<id>.<ext>`, a
 * `_lg-xxx` suffix included) and point every text that embeds it at the new
 * name. Link (or, on a store without hardlinks, exclusive copy) first, texts
 * next, unlink last — and only once a re-scan finds NO string left that
 * resolves to the old name (an encoded form, a lang-less item, another
 * component): otherwise both names stay (still drift, reported; a re-run
 * reuses the new one). Never a text pointing at nothing.
 */
async function withdrawExposed(name: string, ctx: ExposureContext): Promise<string | null> {
	const key = keyOfWebImage(name);
	if (key === null) return null;
	const claim = await legacyNameFor(ctx.webDir, name);
	if ('error' in claim) return claim.error;
	const failure = await repointEmbeds(
		key,
		name,
		storedWebImageSrc(claim.name, ctx.relDir),
		ctx.relDir,
	);
	if (failure !== null) return failure;
	const embedder = await stillEmbeddedBy(key, name, ctx.relDir);
	if (embedder !== null) {
		return `${embedder} still uses '${name}' outside a rewritable text: both names kept`;
	}
	await unlink(join(ctx.webDir, name));
	return null;
}
