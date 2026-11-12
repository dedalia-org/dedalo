/**
 * component_text_area emit hook (audit S2-24; extracted verbatim from
 * section/read.ts):
 * - LIST values render embedded Dédalo tags to `<img>` HTML and are THEN
 *   HTML-truncated (PHP get_list_value :1928-1937 — TR::add_tag_img_on_the_fly
 *   first, truncate_html(max_chars=130) second, so a tag never splits);
 * - the item ALWAYS carries the fallback_value key (PHP
 *   component_text_area_json attaches it unconditionally — explicit null when
 *   the value is present or no cross-lang fallback exists; other literals
 *   attach it only when a fallback resolved);
 * - LIST values follow the record's ORIGINAL language (the related
 *   component_select_lang, e.g. rsc263), equivalence-aware.
 */

import { appServedMediaSrc } from '../../media/web_base_src.ts';
import type { DataItem } from '../../resolve/component_data.ts';
import { filterItemsByLang, readComponentItems } from '../../resolve/component_data.ts';
import { equivalentLangsOf } from '../../resolve/lang_alias.ts';
import { truncateHtml } from '../../resolve/truncate_html.ts';
import type { ComponentEmitHook, EmitHookContext } from '../emit_hooks.ts';
import { getOriginalLang } from './original_lang.ts';
import {
	createSvgTagPathMemo,
	renderTagsWithResolvedSvg,
	type SvgTagPathMemo,
} from './tag_html.ts';

/** text_area list values are HTML-truncated (PHP get_list_value max_chars=130). */
const TEXT_AREA_LIST_MAX_CHARS = 130;

/** Max raw chars any list-preview text processor sees (DOS-01). */
const LIST_SOURCE_CAP = 16 * 1024;

/**
 * The per-read svg-tag path memo, on the emission's scratch (one per read —
 * never module state; see EmissionContext). A list of N records whose
 * transcripts point at the same few glyph records resolves each locator once.
 */
const SVG_TAG_MEMO = Symbol('component_text_area.svg_tag_memo');

function svgTagMemoOf(context: EmitHookContext): SvgTagPathMemo {
	let memo = context.emission.scratch.get(SVG_TAG_MEMO) as SvgTagPathMemo | undefined;
	if (memo === undefined) {
		memo = createSvgTagPathMemo();
		context.emission.scratch.set(SVG_TAG_MEMO, memo);
	}
	return memo;
}

/** The list rendering of one stored string: tags → <img>, then HTML-truncate. */
async function renderListString(value: string, context: EmitHookContext): Promise<string> {
	// DOS-01 (2026-07-28 audit): bound the input BEFORE the tag processors —
	// addTagImgOnTheFly's mark/HTML regexes, like truncateHtml, are super-linear
	// on adversarial CKEditor markup (a 200 KB value froze the loop ~19 s). This
	// is a ≤130-char preview, so capping a large prefix loses no preview content.
	// The svg pre-scan runs on the capped slice too.
	const capped = value.length > LIST_SOURCE_CAP ? value.slice(0, LIST_SOURCE_CAP) : value;
	// THE AUDIENCE: this is the list value the engine serves to ITS OWN client,
	// so svg glyph URLs root on config.media.webBase (split-origin installs —
	// WC-042; see SvgTagAudience). The path itself is the locator's full media
	// path (T0-10, WC-2026-11-11-svg-tag-url-full-media-path).
	const rendered = await renderTagsWithResolvedSvg(capped, 'served', svgTagMemoOf(context));
	return truncateHtml(TEXT_AREA_LIST_MAX_CHARS, rendered);
}

/** The non-empty stored string of one item, or null when there is nothing to render. */
function itemText(item: unknown): string | null {
	if (item === null || typeof item !== 'object') return null;
	const text = (item as { value?: unknown }).value;
	return typeof text === 'string' && text !== '' ? text : null;
}

/** LIST fallback entries with their text rendered (non-text entries untouched). */
async function renderListEntries(entries: unknown[], context: EmitHookContext): Promise<unknown[]> {
	const rendered: unknown[] = [];
	for (const entry of entries) {
		const text = itemText(entry);
		rendered.push(
			text === null
				? entry
				: { ...(entry as object), value: await renderListString(text, context) },
		);
	}
	return rendered;
}

/** True when a lang slice holds at least one item with real text. */
function sliceHasText(items: unknown[], lang: string): boolean {
	return filterItemsByLang(items, lang).some(
		(item) =>
			item !== null &&
			typeof item === 'object' &&
			typeof (item as { value?: unknown }).value === 'string' &&
			(item as { value: string }).value !== '',
	);
}

/**
 * One stored item as served: its media src rebased and, in list mode, rendered
 * to the list string. Returns the SAME item reference when nothing changed, so
 * the caller can hand back the untouched value.
 */
async function serveTextItem(item: unknown, context: EmitHookContext): Promise<unknown> {
	const text = itemText(item);
	if (text === null) return item;
	// Stored media src are relative; this client may load media from another
	// origin (TODO-067, WC-042 — same rebase as the svg tags below).
	const rebased = appServedMediaSrc(text);
	const next = context.ddoMode === 'list' ? await renderListString(rebased, context) : rebased;
	if (next === text) return item;
	return { ...(item as object), value: next };
}

export const textAreaEmitHook: ComponentEmitHook = {
	/**
	 * ORIGINAL-LANGUAGE forcing for LIST values (PHP get_list_value :2519-2525):
	 * a text_area whose ontology relates a component_select_lang ("Original
	 * language" — interviews are recorded in different languages per record)
	 * reads its list value in the RECORD's language, not the menu's.
	 *
	 * EQUIVALENCE-AWARE: when the original-language slice itself is empty but a
	 * declared same-language sibling holds the text (rsc263 says lg-vlca, the
	 * transcript was typed under lg-cat — Català === Valencià), the sibling IS
	 * the record's language and is forced instead. Without this the text
	 * arrived as raw fallback: visible, but stripped of its tag rendering.
	 *
	 * Cheap by construction: the no-related-select-lang answer is
	 * ontology-cached, the locator and the slices live in the ALREADY-LOADED
	 * record, and the lg1 code map is a save-invalidated cache. Null = no
	 * forcing (v6 semantics).
	 */
	async resolveEmitLang(context: EmitHookContext): Promise<string | null> {
		if (context.ddoMode !== 'list') return null;
		const originalLang = await getOriginalLang(
			context.ddo.tipo,
			context.row.section_tipo,
			context.row.section_id,
			context.record,
		);
		if (originalLang === null) return null;

		const items = readComponentItems(context.record, context.ddo.tipo, context.model);
		if (items === null || sliceHasText(items, originalLang)) return originalLang;
		for (const sibling of equivalentLangsOf(originalLang)) {
			if (sliceHasText(items, sibling)) return sibling;
		}
		return originalLang;
	},

	/**
	 * EDIT contexts carry the record's original language as
	 * `options.related_component_lang` (PHP component_text_area_json.php:61-69) —
	 * the key the transcription/indexation/lang tools read to open the component
	 * in the interview's own language. Null (no related select_lang, no value)
	 * emits no `options` key at all: the PHP wire shape.
	 */
	async resolveContextOptions(target: {
		tipo: string;
		sectionTipo: string;
		sectionId: number;
	}): Promise<Record<string, unknown> | null> {
		const originalLang = await getOriginalLang(target.tipo, target.sectionTipo, target.sectionId);
		return originalLang === null ? null : { related_component_lang: originalLang };
	},

	async transformValue(
		value: unknown[] | null,
		context: EmitHookContext,
	): Promise<unknown[] | null> {
		if (!Array.isArray(value)) return value;
		let changed = false;
		const served: unknown[] = [];
		for (const item of value) {
			const next = await serveTextItem(item, context);
			if (next !== item) changed = true;
			served.push(next);
		}
		// Unchanged (non-list, no media src to rebase) → the value itself, untouched.
		return changed ? served : value;
	},

	async decorateItem(item: DataItem, context: EmitHookContext): Promise<void> {
		if (!('fallback_value' in item)) {
			item.fallback_value = null;
		}
		// LIST fallbacks get the SAME rendering as list values (tags → <img>,
		// then truncate). transformValue only sees `value`, so a transcript that
		// surfaces through the cross-lang fallback used to reach the client with
		// raw [TC_…]/[index-…] literals — text without its tag representation.
		if (context.ddoMode === 'list' && Array.isArray(item.fallback_value)) {
			item.fallback_value = await renderListEntries(item.fallback_value, context);
		}

		// EDIT items of a text_area whose ontology declares
		// `properties.tags_persons` carry the transcription person helpers (PHP
		// component_text_area_json.php:130-189): `tags_persons` (the per-person
		// insert buttons / Ctrl+<n> feed) and `related_sections` (the persons
		// modal's record grouping + the print header). Property-gated: the
		// common case costs one cached ontology lookup and returns here.
		// Dynamic imports keep the cold path lazy and add no static edge into
		// the emit_hooks registry SCC.
		if (context.ddoMode !== 'edit') return;
		const { getEffectivePropertiesByTipo } = await import('../../ontology/alias.ts');
		const props = (await getEffectivePropertiesByTipo(context.ddo.tipo)) as {
			tags_persons?: Record<string, import('./tags_persons.ts').TagsPersonsConfigEntry[]>;
		} | null;
		if (props?.tags_persons === undefined || props.tags_persons === null) return;

		const { buildRelatedSections } = await import('../../resolve/related_sections.ts');
		// NOTE the emit path carries no principal (EmitHookContext has none), so
		// this embedded related_sections is unscoped — ledgered in
		// rewrite/LEDGER.md; the dispatch route (read_facade related_search) IS
		// principal-scoped.
		const related = await buildRelatedSections(
			[{ section_tipo: context.row.section_tipo, section_id: context.row.section_id }],
			{
				callerTipo: context.row.section_tipo,
				lang: context.defaultLang,
				sectionTipos: 'all',
				limit: false,
			},
		);
		const sectionsEntry = related.data.find(
			(entry) => (entry as { typo?: string }).typo === 'sections',
		) as
			| {
					value?: {
						section_tipo: string;
						// Canonical ids (WC-2026-08-10-section-id-int-canonical); the
						// persons feed re-canonicalizes anyway, so pre-sweep strings
						// arriving here are harmless.
						section_id: import('../../concepts/locator.ts').StoredSectionId;
					}[];
			  }
			| undefined;

		const { buildTagsPersons } = await import('./tags_persons.ts');
		item.related_sections = related;
		item.tags_persons = await buildTagsPersons(
			props.tags_persons,
			context.row,
			context.record,
			sectionsEntry?.value ?? [],
			// Internal read, unchanged: EmitHookContext carries no principal (same
			// ledgered gap as the unscoped related_sections above) — the gated
			// persons feed is dd_component_text_area_api.get_tags_info.
			undefined,
		);
	},
};
