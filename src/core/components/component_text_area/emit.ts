/**
 * component_text_area emit hook (audit S2-24; extracted verbatim from
 * section/read.ts):
 * - LIST values render embedded Dédalo tags to `<img>` HTML and are THEN
 *   HTML-truncated (PHP get_list_value :1928-1937 — TR::add_tag_img_on_the_fly
 *   first, truncate_html(max_chars=130) second, so a tag never splits);
 * - the item ALWAYS carries the fallback_value key (PHP
 *   component_text_area_json attaches it unconditionally — explicit null when
 *   the value is present or no cross-lang fallback exists; other literals
 *   attach it only when a fallback resolved). In LIST mode too the trigger is
 *   the slice's EMPTINESS (owner C40 2026-11-13; PHP's list counted items);
 * - LIST values follow the record's ORIGINAL language (the related
 *   component_select_lang, e.g. rsc263), equivalence-aware.
 */

import { appServedMediaSrc } from '../../media/web_base_src.ts';
import type { DataItem } from '../../resolve/component_data.ts';
import { readComponentItems } from '../../resolve/component_data.ts';
import { truncateHtml } from '../../resolve/truncate_html.ts';
import type { ComponentEmitHook, EmitHookContext } from '../emit_hooks.ts';
import { getOriginalLang, resolveRecordTextLang } from './original_lang.ts';
import {
	createSvgTagPathMemo,
	renderTagsWithResolvedSvg,
	type SvgTagPathMemo,
} from './tag_html.ts';
import { repairBrokenTags } from './tag_integrity.ts';

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

/** The text_area `properties` the EDIT decoration reads. */
interface TextAreaEditProperties {
	tags_index?: { tipo?: unknown } | null;
	tags_draw?: { tipo?: unknown } | null;
	tags_persons?: Record<string, import('./tags_persons.ts').TagsPersonsConfigEntry[]> | null;
}

/** The tag ids of the locators a `tags_<type>` pointer names, on the host record. */
async function locatorTagIds(
	pointer: { tipo?: unknown } | null | undefined,
	context: EmitHookContext,
): Promise<string[]> {
	const tipo = pointer?.tipo;
	if (typeof tipo !== 'string' || tipo === '') return [];
	const { readTagLocatorsOnRecord } = await import('./tag_locators.ts');
	const locators = await readTagLocatorsOnRecord(context.record, tipo);
	return locators.flatMap((locator) => (locator.tag_id === undefined ? [] : [locator.tag_id]));
}

/**
 * TAG INTEGRITY on EDIT (PHP component_text_area_json → fix_broken_index_tags;
 * WC-2026-11-13-text-area-broken-tag-repair): a text_area declaring
 * `tags_index` and/or `tags_draw` serves each stored text with its unpaired
 * index marks completed and its orphan index/draw locators prepended, all in
 * state `d` (blue) — see tag_integrity.ts. Both doors: the save echo REPLACES
 * the client's data, and PHP's echo ran the same controller. Nothing is saved.
 * A repaired text is never empty, so — as PHP computed the fallback AFTER the
 * repair — it carries no cross-lang fallback.
 */
async function repairTagIntegrity(
	item: DataItem,
	props: TextAreaEditProperties | null,
	context: EmitHookContext,
): Promise<void> {
	if (!hasTagPointers(props) || !Array.isArray(item.entries)) return;
	const indexIds = await locatorTagIds(props?.tags_index, context);
	const drawIds = await locatorTagIds(props?.tags_draw, context);
	let changed = false;
	const repaired = item.entries.map((entry) => {
		const text = itemText(entry);
		if (text === null) return entry;
		const repair = repairBrokenTags(text, indexIds, drawIds);
		if (repair.text === text) return entry;
		changed = true;
		return { ...(entry as object), value: repair.text };
	});
	if (!changed) return;
	item.entries = repaired;
	item.fallback_value = null;
}

/** PHP `isset($properties->tags_index) || isset($properties->tags_draw)`. */
function hasTagPointers(props: TextAreaEditProperties | null): boolean {
	return (
		(props?.tags_index !== undefined && props.tags_index !== null) ||
		(props?.tags_draw !== undefined && props.tags_draw !== null)
	);
}

/**
 * EDIT items of a text_area whose ontology declares `properties.tags_persons`
 * carry the transcription person helpers (PHP component_text_area_json.php:
 * 130-189): `tags_persons` (the per-person insert buttons / Ctrl+<n> feed) and
 * `related_sections` (the persons modal's record grouping + the print header).
 */
async function attachTagsPersons(
	item: DataItem,
	props: TextAreaEditProperties | null,
	context: EmitHookContext,
): Promise<void> {
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
		return resolveRecordTextLang(
			context.ddo.tipo,
			context.row.section_tipo,
			context.row.section_id,
			context.record,
			readComponentItems(context.record, context.ddo.tipo, context.model),
			context.model,
		);
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
		// ALWAYS keyed (explicit null when absent). The LIST face judges EMPTINESS
		// like edit and every chain rung (owner C40, 2026-11-13 — PHP's list
		// triggered by item COUNT, so a cleared transcript stayed blank in lists;
		// WC-2026-11-12-lang-fallback-judges-emptiness addendum).
		item.fallback_value = (item.fallback_value as unknown[] | null | undefined) ?? null;
		// LIST fallbacks get the SAME rendering as list values (tags → <img>,
		// then truncate). transformValue only sees `value`, so a transcript that
		// surfaces through the cross-lang fallback used to reach the client with
		// raw [TC_…]/[index-…] literals — text without its tag representation.
		if (context.ddoMode === 'list' && Array.isArray(item.fallback_value)) {
			item.fallback_value = await renderListEntries(item.fallback_value, context);
		}

		if (context.ddoMode !== 'edit') return;
		// Property-gated: the common case costs one cached ontology lookup.
		// Dynamic imports keep the cold path lazy and add no static edge into
		// the emit_hooks registry SCC.
		const { getEffectivePropertiesByTipo } = await import('../../ontology/alias.ts');
		const props = (await getEffectivePropertiesByTipo(
			context.ddo.tipo,
		)) as TextAreaEditProperties | null;
		await repairTagIntegrity(item, props, context);
		await attachTagsPersons(item, props, context);
	},
};
