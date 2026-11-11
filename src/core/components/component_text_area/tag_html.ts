/**
 * TEXT_AREA TAG → HTML — TR::add_tag_img_on_the_fly (shared/class.TR.php
 * :254-437) twin: Dédalo bracket tags embedded in a stored text value
 * ([geo..], [note..], [svg..], …) rendered to the `<img>`/`<reference>` HTML
 * the client expects. Lives in core (next to tag_grammar/tag_render/
 * tag_endpoint) because BOTH consumers need it and core must never import
 * src/diffusion/**:
 * - the list read path (component_text_area emit hook — PHP get_list_value
 *   :1928 converts before truncating);
 * - diffusion's parse_tag_to_html custom fn (src/diffusion/resolve/ddo_fns.ts
 *   re-exports and layers its html_entity_decode pass on top).
 */

import { config } from '../../../config/config.ts';
import { DedaloError, logError, toDedaloError } from '../../errors/index.ts';
import {
	resolveTagLocatorMediaPath,
	type TagLocator,
	tagLocatorIdentity,
} from '../../media/tag_locator.ts';
import { escapeHtml } from '../../security/html_escape.ts';

/** A tag-embedded svg locator ({'section_tipo':…} with single quotes). */
export type SvgTagLocator = TagLocator;

/**
 * WHO READS the rendered URL — the only thing the two svg URLs differ in (WC-042).
 *
 * - `served`: a cell THIS ENGINE SERVES TO ITS OWN BROWSER (the list read),
 *   rooted on `config.media.webBase` like every other media URL the client
 *   receives. An install may serve media from ANOTHER ORIGIN
 *   (`DEDALO_MEDIA_WEB_BASE`, app on :3500, Apache media on :8080); a
 *   root-relative src would resolve against the APP origin, which in
 *   `publication` access mode serves no media — every glyph 404s in silence
 *   (2026-09-01, tool_numisdata_epigraphy).
 * - `published`: a diffusion cell — the same-origin relative
 *   `/dedalo/<mediaDir>/…`, deliberately NOT webBase: published data must not
 *   embed the application's origin.
 *
 * With the key unset `webBase` IS `/dedalo/<mediaDir>`, so a same-origin install
 * gets byte-identical output for both.
 */
export type SvgTagAudience = 'served' | 'published';

/**
 * The caller-owned svg tag memo: ONE per read / per diffusion job — never module
 * state (the path depends on the ontology and on a record's `additional_path`
 * value, both editable). `paths`: locator key → media-root-relative path (null =
 * no URL). `loggedOnce`: install-wide failure codes already reported through this
 * memo (`media.not_configured` fails EVERY locator; one line per read/run says
 * it, a line per glyph would bury it).
 */
export interface SvgTagPathMemo {
	readonly paths: Map<string, string | null>;
	readonly loggedOnce: Set<string>;
}

/** A fresh memo — one per read (emission scratch) or per diffusion run. */
export function createSvgTagPathMemo(): SvgTagPathMemo {
	return { paths: new Map(), loggedOnce: new Set() };
}

/** Bound on one memo's paths (same posture as the per-read record cache). */
const SVG_TAG_MEMO_LIMIT = 8000;

/**
 * Bound on DISTINCT locators one text may send to the resolver. The DOS-01
 * source cap bounds BYTES (16 KB), not locators: ~200 distinct section_ids fit
 * in it, and a locator whose component declares `additional_path` costs one
 * record read — so a single cell could fan out into hundreds of reads. Real
 * transcripts carry a handful of glyphs; marks past the bound render `src=""`
 * and the text gets ONE warning with the counts (degraded, never silent).
 */
export const SVG_TAG_RESOLUTIONS_PER_TEXT = 64;

/** Codes that fail every locator alike — logged once per memo, not per mark. */
const INSTALL_WIDE_CODES: ReadonlySet<string> = new Set(['media.not_configured']);

/** The svg mark pattern (groups: 2 type, 3 state, 4 id, 6 label, 7 locator data). */
const SVG_MARK_PATTERN = /(\[(svg)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\])/g;

/**
 * Parse a mark's locator text (single quotes, PHP form). Null on a parse
 * failure — the caller drops the tag (PHP's null callback → '').
 */
function parseSvgTagLocator(locatorText: string): SvgTagLocator | null {
	try {
		const parsed: unknown = JSON.parse(locatorText.replace(/'/g, '"'));
		return parsed !== null && typeof parsed === 'object' ? (parsed as SvgTagLocator) : null;
	} catch {
		return null; // probe catch: unparseable data IS the answer
	}
}

/** The memo key of a locator, or null when it fails the shape gate. */
function svgTagMemoKey(locator: SvgTagLocator): string | null {
	const identity = tagLocatorIdentity(locator);
	return identity === null
		? null
		: `${identity.componentTipo}|${identity.sectionTipo}|${identity.sectionId}`;
}

/** The base an audience prepends to the shared media-root-relative path. */
function svgTagBase(audience: SvgTagAudience): string {
	return audience === 'served' ? config.media.webBase : `/dedalo/${config.mediaDir}`;
}

/**
 * Resolve ONE distinct locator. A failure (no media root, a refused
 * `additional_path` value, an ontology read error) degrades THIS mark to
 * `src=""` — a list cell or a published row must not fail for one glyph — and
 * is reported through logError with the locator's coordinates (CONVENTIONS §1).
 */
async function resolveOne(
	key: string,
	locator: SvgTagLocator,
	memo: SvgTagPathMemo,
): Promise<string | null> {
	try {
		return await resolveTagLocatorMediaPath(locator);
	} catch (error) {
		const typed = toDedaloError(error);
		if (INSTALL_WIDE_CODES.has(typed.code)) {
			if (memo.loggedOnce.has(typed.code)) return null;
			memo.loggedOnce.add(typed.code);
		}
		const [componentTipo = '', sectionTipo = '', sectionId = ''] = key.split('|');
		logError(
			new DedaloError(typed.code, {
				message: `svg tag media path unresolved, src="": ${typed.message}`,
				coordinates: {
					...typed.coordinates,
					component_tipo: componentTipo,
					section_tipo: sectionTipo,
					section_id: sectionId,
				},
				cause: error,
			}),
			{ subsystem: 'component_text_area' },
		);
		return null;
	}
}

/**
 * Resolve every distinct svg locator of ONE text into a per-text map, seeded
 * from the shared memo. Rendering reads only this map, so a shared-memo bound
 * can never drop a key mid-text; new paths are written back after, and the
 * shared memo is cleared only BETWEEN texts.
 */
async function resolveTextLocators(
	text: string,
	memo: SvgTagPathMemo,
): Promise<Map<string, string | null>> {
	const local = new Map<string, string | null>();
	const fresh = new Map<string, string | null>();
	let overCap = 0;
	for (const [key, locator] of distinctSvgLocators(text)) {
		if (memo.paths.has(key)) {
			local.set(key, memo.paths.get(key) ?? null);
		} else if (fresh.size >= SVG_TAG_RESOLUTIONS_PER_TEXT) {
			local.set(key, null);
			overCap++;
		} else {
			const path = await resolveOne(key, locator, memo);
			local.set(key, path);
			fresh.set(key, path);
		}
	}
	reportOverCap(overCap, fresh.size);
	writeBack(memo, fresh);
	return local;
}

/** Every distinct, shape-valid svg locator of a text, keyed, in document order. */
function distinctSvgLocators(text: string): Map<string, SvgTagLocator> {
	const found = new Map<string, SvgTagLocator>();
	for (const match of text.matchAll(SVG_MARK_PATTERN)) {
		const locator = parseSvgTagLocator(match[7] ?? '');
		const key = locator === null ? null : svgTagMemoKey(locator);
		if (locator !== null && key !== null && !found.has(key)) found.set(key, locator);
	}
	return found;
}

/** ONE warning per text whose distinct locators exceeded the bound. */
function reportOverCap(overCap: number, resolved: number): void {
	if (overCap === 0) return;
	console.warn(
		`[component_text_area] svg tag locators over the per-text bound, src="" for ${overCap} distinct locator(s) (resolved ${resolved}, bound ${SVG_TAG_RESOLUTIONS_PER_TEXT})`,
	);
}

/** Write a text's new paths back; the shared memo is cleared only here, BETWEEN texts. */
function writeBack(memo: SvgTagPathMemo, fresh: Map<string, string | null>): void {
	if (memo.paths.size + fresh.size > SVG_TAG_MEMO_LIMIT) memo.paths.clear();
	for (const [key, path] of fresh) memo.paths.set(key, path);
}

/**
 * addTagImgOnTheFly with every svg mark's URL RESOLVED (T0-10): the locator's
 * own media component, full path grammar (`initial_media_path`, the
 * `max_items_folder` bucket, the record's `additional_path`), via the one core
 * resolver. The renderer itself stays synchronous (one regex pass), so this
 * pre-scans the svg marks, resolves each DISTINCT locator once (through the
 * caller's memo), and hands the renderer a synchronous lookup.
 */
export async function renderTagsWithResolvedSvg(
	text: string,
	audience: SvgTagAudience,
	memo: SvgTagPathMemo,
	options: Omit<TagRenderOptions, 'svgUrl'> = {},
): Promise<string> {
	const local = await resolveTextLocators(text, memo);
	const base = svgTagBase(audience);
	return addTagImgOnTheFly(text, {
		...options,
		svgUrl: (locator) => {
			const key = svgTagMemoKey(locator);
			if (key === null) return null;
			if (!local.has(key)) {
				// The pre-scan and the render use ONE pattern, so every key the
				// render meets was resolved. A miss is a breach — reported, src="".
				logError(
					new DedaloError('internal.invariant', {
						message: 'svg tag rendered with a locator the pre-scan did not resolve',
						coordinates: { key },
					}),
					{ subsystem: 'component_text_area' },
				);
				return null;
			}
			const path = local.get(key) ?? null;
			return path === null ? null : `${base}${path}`;
		},
	});
}

export interface TagRenderOptions {
	/** PHP $options->tag_url default '../component_text_area/tag'. */
	tagUrl?: string;
	/**
	 * svg tag URL lookup — SYNCHRONOUS; the async resolution happens before the
	 * render ({@link renderTagsWithResolvedSvg}, which every svg-rendering caller
	 * goes through). Without one, an svg mark is refused loudly.
	 */
	svgUrl?: (locator: SvgTagLocator) => string | null;
}

/**
 * The default lookup: there is none. A sync renderer cannot resolve a media
 * path (ontology + record reads), and a grammar guess is the second producer
 * T0-10 deleted — so a caller that renders an svg mark without resolving it is
 * a wiring bug, refused loudly instead of emitting a wrong URL.
 */
function unresolvedSvgUrl(): never {
	throw new DedaloError('internal.invariant', {
		message:
			'addTagImgOnTheFly: svg mark rendered without a resolved lookup — use renderTagsWithResolvedSvg',
	});
}

/**
 * TR::add_tag_img_on_the_fly (shared/class.TR.php :254-437) — Dédalo text tags
 * to `<img>`/`<reference>` HTML, all attribute captures escaped (SEC-028).
 * Patterns are byte-ports of TR::get_mark_pattern with IDENTICAL group
 * numbering (the PHP patterns carry an outer capture around the whole tag).
 * Replacement order matches PHP exactly: indexIn, indexOut, referenceIn,
 * referenceOut, tc, svg, draw, geo, page, person, note, lang.
 */
export function addTagImgOnTheFly(text: string, options: TagRenderOptions = {}): string {
	const tagUrl = `${options.tagUrl ?? '../component_text_area/tag'}/?id=`;
	const svgUrl = options.svgUrl ?? unresolvedSvgUrl;
	let out = text;

	// INDEX IN (groups: 2 type, 3 state, 4 id, 6 label, 7 data)
	out = out.replace(
		/(\[(index)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\])/g,
		(_m, _g1, g2: string, g3: string, g4: string, _g5, g6?: string, g7?: string) => {
			const [e2, e3, e4, e6, e7] = [
				escapeHtml(g2),
				escapeHtml(g3),
				escapeHtml(g4),
				escapeHtml(g6),
				escapeHtml(g7),
			];
			const id = `[${e2}-${e3}-${e4}-${e6}]`;
			return `<img id="${id}" src="${tagUrl}${id}" class="index" data-type="indexIn" data-tag_id="${e4}" data-state="${e3}" data-label="${e6}" data-data="${e7}">`;
		},
	);

	// INDEX OUT
	out = out.replace(
		/(\[\/(index)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\])/g,
		(_m, _g1, g2: string, g3: string, g4: string, _g5, g6?: string, g7?: string) => {
			const [e2, e3, e4, e6, e7] = [
				escapeHtml(g2),
				escapeHtml(g3),
				escapeHtml(g4),
				escapeHtml(g6),
				escapeHtml(g7),
			];
			const id = `[/${e2}-${e3}-${e4}-${e6}]`;
			return `<img id="${id}" src="${tagUrl}${id}" class="index" data-type="indexOut" data-tag_id="${e4}" data-state="${e3}" data-label="${e6}" data-data="${e7}">`;
		},
	);

	// REFERENCE IN
	out = out.replace(
		/(\[(reference)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\])/g,
		(_m, _g1, _g2, g3: string, g4: string, _g5, g6?: string, g7?: string) => {
			const [e3, e4, e6, e7] = [escapeHtml(g3), escapeHtml(g4), escapeHtml(g6), escapeHtml(g7)];
			return `<reference id="reference_${e4}" class="reference" data-type="reference" data-tag_id="${e4}" data-state="${e3}" data-label="${e6}" data-data="${e7}">`;
		},
	);

	// REFERENCE OUT
	out = out.replace(
		/(\[\/(reference)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\])/g,
		'</reference>',
	);

	// TC (groups: 1 full tag, 2 timecode value)
	out = out.replace(
		/(\[TC_([0-9]{1,2}:[0-9]{1,2}:[0-9]{1,2}(\.[0-9]{1,3})?)_TC\])/g,
		(_m, g1: string, g2: string) => {
			const [e1, e2] = [escapeHtml(g1), escapeHtml(g2)];
			return `<img id="${e1}" src="${tagUrl}${e1}" class="tc" data-type="tc" data-tag_id="${e1}" data-state="n" data-label="${e2}" data-data="${e2}">`;
		},
	);

	// SVG (groups: 2 type, 3 state, 4 id, 6 label, 7 locator data) — the data
	// is a locator with single quotes; on parse failure PHP's callback returns
	// null and the tag is removed (preg_replace_callback null → '').
	out = out.replace(
		SVG_MARK_PATTERN,
		(_m, _g1, g2: string, g3: string, g4: string, _g5, g6: string | undefined, g7: string) => {
			const locator = parseSvgTagLocator(g7);
			if (locator === null) return '';
			const url = svgUrl(locator);
			// PHP: $data = str_replace('"','\'',$_7) — safe single-quote form.
			const data = g7.replace(/"/g, "'");
			const [e2, e3, e4, e6] = [escapeHtml(g2), escapeHtml(g3), escapeHtml(g4), escapeHtml(g6)];
			return `<img id="[${e2}-${e3}-${e4}-${e6}]" src="${escapeHtml(url ?? '')}" class="svg" data-type="svg" data-tag_id="${e4}" data-state="${e3}" data-label="${e6}" data-data="${escapeHtml(data)}">`;
		},
	);

	// DRAW / GEO / NOTE / LANG share the svg-shaped pattern (label optional,
	// data mandatory): groups 2 type, 3 state, 4 id, 6 label, 7 data.
	const spriteTag =
		(kind: string) =>
		(
			_m: string,
			_g1: string,
			g2: string,
			g3: string,
			g4: string,
			_g5: string | undefined,
			g6: string | undefined,
			g7: string,
		): string => {
			const [e2, e3, e4, e6, e7] = [
				escapeHtml(g2),
				escapeHtml(g3),
				escapeHtml(g4),
				escapeHtml(g6),
				escapeHtml(g7),
			];
			const id = `[${e2}-${e3}-${e4}-${e6}]`;
			return `<img id="${id}" src="${tagUrl}${id}" class="${kind}" data-type="${kind}" data-tag_id="${e4}" data-state="${e3}" data-label="${e6}" data-data="${e7}">`;
		};
	out = out.replace(
		/(\[(draw)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\])/g,
		spriteTag('draw'),
	);
	out = out.replace(
		/(\[(geo)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\])/g,
		spriteTag('geo'),
	);

	// PAGE (index-shaped pattern: label+data optional as a block)
	out = out.replace(
		/(\[(page)-([a-z])-([0-9]{1,6})(-([^-]{0,22})-data:(.*?):data)?\])/g,
		(_m, _g1, g2: string, g3: string, g4: string, _g5, g6?: string, g7?: string) => {
			const [e2, e3, e4, e6, e7] = [
				escapeHtml(g2),
				escapeHtml(g3),
				escapeHtml(g4),
				escapeHtml(g6),
				escapeHtml(g7),
			];
			const id = `[${e2}-${e3}-${e4}-${e6}]`;
			return `<img id="${id}" src="${tagUrl}${id}" class="page" data-type="page" data-tag_id="${e4}" data-state="${e3}" data-label="${e6}" data-data="${e7}">`;
		},
	);

	// PERSON (groups: 2 type, 3 state, 4 id, 5 label, 6 data — no optional wrap)
	out = out.replace(
		/(\[(person)-([a-z])-([0-9]{0,6})-([^-]{0,22})-data:(.*?):data\])/g,
		(_m, _g1, g2: string, g3: string, g4: string, g5: string, g6: string) => {
			const [e2, e3, e4, e5, e6] = [
				escapeHtml(g2),
				escapeHtml(g3),
				escapeHtml(g4),
				escapeHtml(g5),
				escapeHtml(g6),
			];
			const id = `[${e2}-${e3}-${e4}-${e5}]`;
			return `<img id="${id}" src="${tagUrl}${id}" class="person" data-type="person" data-tag_id="${e4}" data-state="${e3}" data-label="${e5}" data-data="${e6}">`;
		},
	);

	out = out.replace(
		/(\[(note)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\])/g,
		spriteTag('note'),
	);
	out = out.replace(
		/(\[(lang)-([a-z])-([0-9]{1,6})(-([^-]{0,22}))?-data:(.*?):data\])/g,
		spriteTag('lang'),
	);

	return out;
}
