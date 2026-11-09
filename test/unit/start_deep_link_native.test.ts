/**
 * A SECTION deep link that names a record opens the EDIT view.
 *
 * `?tipo=<section>&section_id=<id>` is the "open this record" grammar every
 * caller uses (the inspector's Local Ontology pen, the list's edit button, the
 * job tray). PHP `start` forced edit whenever a record id arrived
 * (class.dd_core_api.php:477-501, `$current_context->set_mode('edit')`); the TS
 * port kept the section_id injection but not the mode, so the page element was
 * described in LIST mode carrying an id. The client inherits that mode into its
 * instance AND into its first read (`create_source` → `source.mode`), which
 * derives `section_list` columns instead of the edit tree: the record opened as
 * a one-row list with no edit form.
 *
 * The component/area branches never forced (PHP switch, same file) — they keep
 * their requested mode, and the second case below pins that the force is
 * scoped to sections rather than applied to every deep link.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const SECTION = 'test3';
const COMPONENT = 'test52'; // input_text — the standing generic component

let recordId = 0;

function adminContext(): ApiRequestContext {
	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	return {
		requestId: 'deep-link-native',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: { userId: -1, isGlobalAdmin: true, isDeveloper: true },
	};
}

async function startPage(
	search_obj: Record<string, unknown>,
	context: ApiRequestContext,
): Promise<Record<string, unknown>[]> {
	const outcome = await dispatchRqo(
		{
			action: 'start',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			options: { search_obj, menu: false },
		} as Rqo,
		context,
	);
	return (outcome.body.data as { context: Record<string, unknown>[] }).context;
}

describe.if(DB_READY)('start: a section deep link with a record id is EDIT', () => {
	let context: ApiRequestContext;

	beforeAll(async () => {
		recordId = await createSectionRecord(SECTION, -1);
		context = adminContext();
	});

	afterAll(async () => {
		await cleanScratchRecord(SECTION, recordId);
	});

	test('?tipo=<section>&section_id=<id> (no mode) answers edit + the record id', async () => {
		const [entry] = await startPage({ tipo: SECTION, section_id: String(recordId) }, context);
		expect(entry?.model).toBe('section');
		expect(entry?.mode).toBe('edit');
		// The record is NAMED as the selected record of its navigation, not pinned
		// alone (WC-2026-11-09-start-deep-link-found-set-position — the position
		// half is start_deep_link_navigation_native).
		expect(String(entry?.section_id_selected)).toBe(String(recordId));
		expect(entry?.section_id).toBeUndefined();
	});

	test('an explicit mode is overridden too — the id IS the edit request', async () => {
		const [entry] = await startPage(
			{ tipo: SECTION, section_id: String(recordId), mode: 'list' },
			context,
		);
		expect(entry?.mode).toBe('edit');
	});

	test('non-vacuity: the same section WITHOUT an id stays list (and keeps no id)', async () => {
		const [entry] = await startPage({ tipo: SECTION, mode: 'list' }, context);
		expect(entry?.mode).toBe('list');
		expect(entry?.section_id ?? null).toBeNull();
	});

	test('the force is scoped to sections: a component deep link keeps its mode', async () => {
		const [entry] = await startPage(
			{ tipo: COMPONENT, section_tipo: SECTION, section_id: String(recordId), mode: 'list' },
			context,
		);
		expect(entry?.model).toBe('component_input_text');
		expect(entry?.mode).toBe('list');
	});
});
