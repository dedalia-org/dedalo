/**
 * THE `zztags` SCRATCH SITUATION — a text_area that declares the tag properties
 * `get_tags_info` resolves (`tags_index`, `tags_notes`, `tags_persons`) plus the
 * `tags_draw` the edit-read repair reads, built rather than borrowed (AGENTS.md:
 * a test BUILDS the situation it tests).
 *
 * ONE definition, shared by the gates that build it
 * (`text_area_tags_info_action_native` — the action's argument/lang/payload
 * branches — `tags_info_read_door_native` — the read door and its hops — and
 * `text_area_broken_tag_repair_native` — the edit-read tag integrity), so
 * the scratch TLD cannot drift into two shapes. Each gate ensures it in
 * beforeAll and drops it (residue asserted) in afterAll; `bun test` runs files
 * of one process sequentially, so the two never hold it at the same time.
 *
 * The shape is copied from the shipped rsc36 declaration with the install's
 * tipos replaced by this TLD's own:
 *
 *   zztags1  section (host, project-gated by zztags8)
 *     zztags2  component_text_area (translatable) — declares the tag config
 *     zztags3  component_autocomplete_hi — the tags_index source
 *     zztags8  component_filter — the host's projects filter
 *     zztags11 component_portal — the tags_draw source (the edit-read tag
 *              integrity repair, text_area_broken_tag_repair_native)
 *   zztags4  section (the note section, project-gated by zztags10)
 *     zztags5  component_input_text   note title
 *     zztags6  component_text_area    note body
 *     zztags7  component_check_box    note publishable
 *     zztags9  component_portal       the tags_persons source (a zztags4 record
 *                                     pointing at the host IS a related record)
 *     zztags10 component_filter       the note section's projects filter
 *
 * A section is PROJECT-GATED by having a component_filter (resolver.ts
 * getComponentFilterTipo); without one the record-scope gate has nothing to
 * enforce, and every scope assertion would pass for every principal.
 */

import { situation } from '../../src/core/test_data/situations/situation.ts';

export const ZZTAGS_SECTION = 'zztags1';
export const ZZTAGS_TEXT_AREA = 'zztags2';
export const ZZTAGS_TAGS_INDEX = 'zztags3';
export const ZZTAGS_NOTE_SECTION = 'zztags4';
export const ZZTAGS_NOTE_TITLE = 'zztags5';
export const ZZTAGS_NOTE_BODY = 'zztags6';
export const ZZTAGS_NOTE_PUBLISHABLE = 'zztags7';
export const ZZTAGS_HOST_FILTER = 'zztags8';
export const ZZTAGS_PERSONS_PORTAL = 'zztags9';
export const ZZTAGS_NOTE_FILTER = 'zztags10';
export const ZZTAGS_DRAW_PORTAL = 'zztags11';

export const ZZTAGS_SITUATION = situation({
	tld: 'zztags',
	name: 'text_area tags_info',
	nodes: [
		{ tipo: ZZTAGS_SECTION, model: 'section', parent: 'dd14' },
		{ tipo: ZZTAGS_TAGS_INDEX, model: 'component_autocomplete_hi', parent: ZZTAGS_SECTION },
		{
			tipo: ZZTAGS_TEXT_AREA,
			model: 'component_text_area',
			parent: ZZTAGS_SECTION,
			is_translatable: true,
			properties: {
				tags_index: { tipo: ZZTAGS_TAGS_INDEX, section_id: 'self', section_tipo: 'self' },
				tags_draw: { tipo: ZZTAGS_DRAW_PORTAL, section_id: 'self', section_tipo: 'self' },
				tags_notes: {
					[ZZTAGS_NOTE_SECTION]: [
						{
							id: 'title',
							type: 'text',
							section_tipo: ZZTAGS_NOTE_SECTION,
							component_tipo: ZZTAGS_NOTE_TITLE,
						},
						{
							id: 'body',
							type: 'text',
							section_tipo: ZZTAGS_NOTE_SECTION,
							component_tipo: ZZTAGS_NOTE_BODY,
						},
						{
							id: 'publishable',
							type: 'bool',
							section_tipo: ZZTAGS_NOTE_SECTION,
							component_tipo: ZZTAGS_NOTE_PUBLISHABLE,
						},
					],
				},
				tags_persons: {
					[ZZTAGS_NOTE_SECTION]: [
						{
							state: 'a',
							section_tipo: ZZTAGS_NOTE_SECTION,
							component_tipo: ZZTAGS_PERSONS_PORTAL,
						},
					],
				},
			},
		},
		{ tipo: ZZTAGS_HOST_FILTER, model: 'component_filter', parent: ZZTAGS_SECTION },
		{ tipo: ZZTAGS_DRAW_PORTAL, model: 'component_portal', parent: ZZTAGS_SECTION },
		{ tipo: ZZTAGS_NOTE_SECTION, model: 'section', parent: 'dd14' },
		{ tipo: ZZTAGS_NOTE_TITLE, model: 'component_input_text', parent: ZZTAGS_NOTE_SECTION },
		{ tipo: ZZTAGS_NOTE_BODY, model: 'component_text_area', parent: ZZTAGS_NOTE_SECTION },
		{
			tipo: ZZTAGS_NOTE_PUBLISHABLE,
			model: 'component_check_box',
			parent: ZZTAGS_NOTE_SECTION,
		},
		{ tipo: ZZTAGS_PERSONS_PORTAL, model: 'component_portal', parent: ZZTAGS_NOTE_SECTION },
		{ tipo: ZZTAGS_NOTE_FILTER, model: 'component_filter', parent: ZZTAGS_NOTE_SECTION },
	],
});
