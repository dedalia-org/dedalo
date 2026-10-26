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

/** A keyed name's record, or null when the name does not parse (rule B's own grammar). */
export function keyOfWebImage(fileName: string): { sectionTipo: string; sectionId: number } | null {
	const match = GRAMMAR.exec(fileName);
	return match === null ? null : { sectionTipo: match[1] as string, sectionId: Number(match[2]) };
}

/** Whether `fileName` is keyed to THIS record — never a bare grammar match (`photo_2019_3.jpg`). */
export function isKeyedTo(fileName: string, sectionTipo: string, sectionId: number): boolean {
	const key = keyOfWebImage(fileName);
	return key !== null && key.sectionTipo === sectionTipo && key.sectionId === sectionId;
}

/**
 * The web-folder FILE NAME an `<img src>` points at, or null when it is not a
 * web-folder image of THIS install: every historic prefix is accepted
 * (`../../../media/`, `/dedalo/<mediaDir>/`, a v6 custom root, webBase), the
 * query (`?<cachebust>`) and fragment are dropped, `%xx` decoded. Another
 * host, a subfolder, a tag/button url (`…/inc/btn.php/[geo-…]`) → null.
 */
export function parseLegacyWebImageSrc(
	src: string,
	relDir: string,
	webBase: string = config.media.webBase,
): string | null {
	let path = src.trim();
	if (webBase !== '' && path.startsWith(`${webBase}/`)) path = path.slice(webBase.length);
	else if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(path)) return null;
	const marker = `/${relDir}/`;
	const at = path.indexOf(marker);
	if (at === -1) return null;
	const rest = path
		.slice(at + marker.length)
		.replace(/[?#].*$/, '')
		.replace(/&amp;/g, '&');
	if (rest === '' || rest.includes('/')) return null;
	try {
		return decodeURIComponent(rest);
	} catch {
		return rest;
	}
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

/** The records whose `string` column mentions `needle` (escaped for LIKE), table by table. */
async function recordsMentioning(
	needle: string,
	scope: readonly string[] | undefined,
): Promise<{ table: string; sectionTipo: string; sectionId: number }[]> {
	if (scope !== undefined && scope.length === 0) return [];
	const pattern = `%${needle.replace(/[\\%_]/g, '\\$&')}%`;
	const found: { table: string; sectionTipo: string; sectionId: number }[] = [];
	for (const table of TEXT_TABLES) {
		const exists = (await sql.unsafe('SELECT to_regclass($1) IS NOT NULL AS ok', [
			`public."${table}"`,
		])) as { ok: boolean }[];
		if (exists[0]?.ok !== true) continue;
		const inScope =
			scope === undefined
				? ''
				: ` AND section_tipo IN (${scope.map((_, index) => `$${index + 2}`).join(', ')})`;
		const rows = (await sql.unsafe(
			`SELECT section_tipo, section_id FROM "${table}" WHERE string::text LIKE $1${inScope} ORDER BY section_tipo, section_id`,
			[pattern, ...(scope ?? [])],
		)) as { section_tipo: string; section_id: number | string }[];
		for (const row of rows) {
			found.push({ table, sectionTipo: row.section_tipo, sectionId: Number(row.section_id) });
		}
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

/** The text_area slices of a record, one per (component, lang). */
async function textSlices(record: MatrixRecord): Promise<TextSlice[]> {
	const slices: TextSlice[] = [];
	const string = record.columns.string;
	if (string === null || typeof string !== 'object') return slices;
	for (const componentTipo of Object.keys(string)) {
		if ((await getModelByTipo(componentTipo)) !== 'component_text_area') continue;
		const items = readComponentItems(record, componentTipo, 'component_text_area') ?? [];
		const langOf = (item: unknown) => (item as { lang?: unknown } | null)?.lang;
		const hasLang = (lang: unknown): lang is string => typeof lang === 'string' && lang !== '';
		const langLess = items.filter((item) => !hasLang(langOf(item)));
		const wholeHeld =
			langLess.length === 0 ? null : 'items without a lang (any save of this component drops them)';
		const base = { sectionTipo: record.section_tipo, sectionId: record.section_id, componentTipo };
		for (const lang of [...new Set(items.map(langOf))].filter(hasLang)) {
			const effective = await effectiveSaveLang(componentTipo, 'component_text_area', lang);
			const held =
				wholeHeld ??
				(effective === lang
					? null
					: `stored as ${lang} but saved as ${effective} (a save would add a copy, not rewrite it)`);
			slices.push({ ...base, lang, items: filterItemsByLang(items, lang), held });
		}
		if (langLess.length > 0)
			slices.push({ ...base, lang: '(no lang)', items: langLess, held: wholeHeld });
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
	const webDir = join(requireMediaRoot(), relDir);
	const missing: string[] = [];
	const failed: string[] = [];
	const changes: string[] = [];
	const held: string[] = [];
	let drift = 0;
	let applied = 0;
	let scannedRecords = 0;

	for (const { table, sectionTipo, sectionId } of await recordsMentioning(
		`/${relDir}/`,
		options.scope,
	)) {
		const record = await readMatrixRecord(table, sectionTipo, sectionId);
		if (record === null) continue;
		scannedRecords++;
		// One keyed copy per (record, legacy file), shared by the record's langs.
		const copies = new Map<string, string>();
		for (const slice of await textSlices(record)) {
			// Plan: the target name of every src this slice must change.
			const targets = new Map<string, string>();
			const createdHere: string[] = [];
			let failure: string | null = null;
			let sliceDrift = 0;
			for (const value of slice.items) {
				const html = (value as { value?: unknown } | null)?.value;
				if (typeof html !== 'string') continue;
				for (const src of imgSrcs(html)) {
					const fileName = parseLegacyWebImageSrc(src, relDir);
					if (fileName === null || targets.has(src)) continue;
					const keyed = isKeyedTo(fileName, sectionTipo, sectionId);
					if (keyed && src === storedWebImageSrc(fileName, relDir)) continue;
					if (!(await fileExists(join(webDir, fileName)))) {
						missing.push(`${at(slice)}: ${fileName}`);
						continue;
					}
					drift++;
					sliceDrift++;
					let target = keyed ? fileName : (copies.get(fileName) ?? null);
					if (target === null && options.apply && failure === null && slice.held === null) {
						try {
							const path = claimKeyedWebImage(join(webDir, fileName), stagedTmpName(fileName), {
								sectionTipo,
								sectionId,
							});
							target = path.slice(relDir.length + 1);
							copies.set(fileName, target);
							createdHere.push(target);
						} catch (error) {
							failure = `copy of '${fileName}' failed: ${(error as Error).message}`;
						}
					}
					changes.push(`${at(slice)}: ${fileName} → ${target ?? '(keyed copy)'}`);
					if (target !== null) targets.set(src, storedWebImageSrc(target, relDir));
				}
			}
			if (slice.held !== null) {
				if (sliceDrift > 0) held.push(`${at(slice)}: ${slice.held}`);
				continue;
			}
			if (!options.apply || targets.size === 0) {
				if (failure !== null) failed.push(`${at(slice)}: ${failure}`);
				continue;
			}
			const items =
				failure === null ? rewriteSlice(slice, (src) => targets.get(src) ?? null) : null;
			failure ??= items === null ? null : await saveSlice(slice, items);
			if (failure !== null) {
				failed.push(`${at(slice)}: ${failure}`);
				// The copies this slice minted are referenced by nothing: take them back.
				for (const name of createdHere) {
					await unlink(join(webDir, name)).catch(() => undefined);
					for (const [legacy, keyedName] of copies) if (keyedName === name) copies.delete(legacy);
				}
				continue;
			}
			applied += targets.size;
		}
	}
	return {
		drift,
		applied,
		detail: { scannedRecords, changes, missing, held, failed, webFolder: relDir },
	};
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
	const webDir = join(requireMediaRoot(), relDir);
	const now = options.now ?? Date.now();
	const exposed: string[] = [];
	const recent: string[] = [];
	const failed: string[] = [];
	let applied = 0;

	let names: string[];
	try {
		names = (await readdir(webDir, { withFileTypes: true }))
			.filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
			.map((entry) => entry.name)
			.filter((name) => options.only?.(name) ?? true)
			.sort();
	} catch {
		names = []; // no web folder yet: nothing is exposed
	}
	for (const name of names) {
		const key = keyOfWebImage(name);
		if (key === null || !(await options.isPublished(`${key.sectionTipo}_${key.sectionId}`)))
			continue;
		const mtimeMs = await stat(join(webDir, name)).then(
			(info) => info.mtimeMs,
			() => null, // gone since the listing: nothing to judge
		);
		if (mtimeMs === null) continue;
		if (now - mtimeMs < EXPOSURE_GRACE_MS) {
			recent.push(name);
			continue;
		}
		const table = await getMatrixTableFromTipo(key.sectionTipo);
		const record =
			table === null ? null : await readMatrixRecord(table, key.sectionTipo, key.sectionId);
		if (record !== null && embeds(record, relDir, name)) continue;
		exposed.push(name);
	}

	if (options.apply) {
		for (const name of exposed) {
			const failure = await withdrawExposed(webDir, relDir, name);
			if (failure === null) applied++;
			else failed.push(`${name}: ${failure}`);
		}
	}
	return {
		drift: exposed.length,
		applied,
		detail: {
			exposed,
			recent,
			failed,
			webFolder: relDir,
			graceHours: EXPOSURE_GRACE_MS / 3_600_000,
		},
	};
}

/** Every string inside a parsed jsonb value (any component, any item shape). */
function stringsIn(value: unknown, out: string[] = []): string[] {
	if (typeof value === 'string') out.push(value);
	else if (Array.isArray(value)) for (const entry of value) stringsIn(entry, out);
	else if (value !== null && typeof value === 'object') {
		for (const entry of Object.values(value)) stringsIn(entry, out);
	}
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
async function withdrawExposed(
	webDir: string,
	relDir: string,
	name: string,
): Promise<string | null> {
	const key = keyOfWebImage(name);
	if (key === null) return null;
	const dot = name.lastIndexOf('.');
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
	const source = join(webDir, name);
	let renamed: string | null = null;
	for (let n = 1; n <= 99 && renamed === null; n++) {
		const candidate = `${stem}.legacy${n === 1 ? '' : n}${ext}`;
		if (GRAMMAR.test(candidate)) return `'${candidate}' would still parse as a record key`;
		const target = join(webDir, candidate);
		try {
			await link(source, target);
			renamed = candidate;
		} catch (error) {
			let code = (error as NodeJS.ErrnoException).code ?? '';
			if (NO_HARDLINK_ERRNOS.has(code)) {
				code = await copyFile(source, target, constants.COPYFILE_EXCL).then(
					() => {
						renamed = candidate;
						return '';
					},
					(copyError: NodeJS.ErrnoException) => copyError.code ?? 'copy failed',
				);
				if (renamed !== null) break;
			}
			if (code !== 'EEXIST') return `${candidate}: ${code || (error as Error).message}`;
			// A previous run that stopped half-way left this very file there.
			if (await sameFile(source, target)) renamed = candidate;
		}
	}
	if (renamed === null) return 'no free .legacy name';
	const target = storedWebImageSrc(renamed, relDir);
	// `_<tipo>_<id>` reads the same raw, %-encoded or entity-encoded: one needle finds every form.
	const needle = `_${key.sectionTipo}_${key.sectionId}`;
	for (const { table, sectionTipo, sectionId } of await recordsMentioning(needle, undefined)) {
		const record = await readMatrixRecord(table, sectionTipo, sectionId);
		if (record === null) continue;
		for (const slice of await textSlices(record)) {
			const items = rewriteSlice(slice, (src) =>
				parseLegacyWebImageSrc(src, relDir) === name ? target : null,
			);
			if (items === null) continue;
			// Both names stay on any refusal: texts saved before this one already point at `renamed`.
			if (slice.held !== null) return `${at(slice)}: ${slice.held}`;
			const failure = await saveSlice(slice, items);
			if (failure !== null) return `${at(slice)}: ${failure}`;
		}
	}
	for (const { table, sectionTipo, sectionId } of await recordsMentioning(needle, undefined)) {
		const record = await readMatrixRecord(table, sectionTipo, sectionId);
		if (record !== null && embeds(record, relDir, name)) {
			return `${sectionTipo}/${sectionId} still uses '${name}' outside a rewritable text: both names kept`;
		}
	}
	await unlink(source);
	return null;
}
