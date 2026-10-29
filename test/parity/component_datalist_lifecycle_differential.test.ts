/**
 * Six-component lifecycle gate (2026-07-04, user-reported fixes). Drives the
 * direct get_data endpoint (readComponentData) for the components whose datalist
 * / list-value / media envelope were repaired, and diffs the projection against
 * the live PHP oracle:
 *  - component_publication / component_select_lang / component_filter /
 *    component_filter_master: EDIT datalist (deep-equal) + LIST value (labels);
 *  - component_av: posterframe_url + subtitles (edit) + list thumb quality;
 *  - component_security_access: EDIT datalist node count + envelope.
 * See rewrite/STATUS.md "SIX-COMPONENT LIFECYCLE FIX".
 */
// GENERIC-TLD MIGRATED 2026-08-19 (WC-2026-08-19-test-tld-replay).
// The install case is written in `test`-TLD terms (numisdata54 → test6136,
// its component_filter numisdata720 → test6437); every other case names
// SEED-shipped ontology (the media/av/publication sections and the dd
// permission tree), pinned as such and spelled through `seed()` where the
// install-TLD census would read the literal as a binding. The frozen PHP
// interactions are reached through `unmapRqo` (fixture lookup) +
// `adoptTipoIdMap`, and the records come from the committed corpus.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { readComponentData, readSection } from '../../src/core/section/read.ts';
import {
	dropTestCorpus,
	ensureMediaKit,
	ensureTestCorpus,
} from '../../src/core/test_data/test_corpus/ensure.ts';
import { adoptTipoIdMap, normalizeSectionIdTypes } from './normalize.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

interface DataItem {
	tipo: string;
	entries?: unknown;
	datalist?: unknown;
	posterframe_url?: unknown;
	subtitles?: unknown;
	row_section_id?: unknown;
	[k: string]: unknown;
}

/**
 * Seed-shipped ontology, spelled so the install-TLD census does not read it as
 * an install binding (the pilot's `seed()` convention).
 */
const seed = (tld: string, id: number): string => `${tld}${id}`;

/**
 * The corpus this gate OWNS: the four datalist subjects' sections, the av
 * section, and the cloned section of the one install-owned case.
 * `dd234` (the permissions profile) is NOT here — the install seed ships
 * dd234/1 itself (`seed_shipped_record`, refused.json), so it is already in
 * any database this suite runs against.
 */
const CORPUS_SCOPE = [seed('rsc', 170), seed('rsc', 205), seed('rsc', 167), 'dd128', 'test6136'];

const client = new PhpApiClient();
let ready = false;

beforeAll(async () => {
	await ensureTestCorpus(CORPUS_SCOPE);
	// component_av asserts posterframe/quality URLs, which are existence-checked
	// against the media root: plant the corpus media identities in the SUITE
	// media root (marked `.dedalo_test_media`).
	await ensureMediaKit();
	if (!hasPhpCredentials()) return;
	await client.login(
		config.phpReference.username as string,
		config.phpReference.password as string,
	);
	ready = true;
});

afterAll(async () => {
	expect(await dropTestCorpus(CORPUS_SCOPE)).toBe(0);
});

async function both(
	model: string,
	tipo: string,
	sectionTipo: string,
	sectionId: string,
	mode: string,
): Promise<{ php: DataItem | undefined; ts: DataItem | undefined }> {
	const rqo = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			model,
			tipo,
			section_tipo: sectionTipo,
			section_id: sectionId,
			mode,
			lang: 'lg-spa',
			action: 'get_data',
		},
		sqo: { section_tipo: [sectionTipo] },
	};
	const { body } = await client.call(structuredClone(rqo) as Record<string, unknown>);
	// WC-2026-08-19-test-tld-replay: the frozen install-term body, read in
	// test-TLD terms. `detail === null` is `matched === true` carrying its own
	// reason; the id resolutions are the anti-vacuity floor (a case that names
	// only seed-shipped ontology needs no tipo rewritten at all).
	const adopted = adoptTipoIdMap(body, 'component_datalist_lifecycle_differential');
	expect(adopted.detail).toBeNull();
	expect(adopted.matched).toBe(true);
	expect(adopted.rewrites.ids).toBeGreaterThan(0);
	// WC-2026-08-10-section-id-int-canonical: address keys compared by VALUE on BOTH sides (fixtures keep the PHP-era numeric strings).
	const php = normalizeSectionIdTypes(
		((adopted.body.result as { data: DataItem[] }).data ?? []).find((d) => d.tipo === tipo),
	);
	const ts = normalizeSectionIdTypes(
		((await readComponentData(rqo as unknown as Rqo)) as unknown as DataItem[]).find(
			(d) => d.tipo === tipo,
		),
	);
	// S2-40: assert presence FIRST — callers compare php?.x with ts?.x, so a
	// missing item on BOTH sides used to pass every assertion vacuously.
	expect(php).toBeDefined();
	expect(ts).toBeDefined();
	return { php, ts };
}

describe.if(hasPhpCredentials())('six-component get_data lifecycle differential', () => {
	// Datalist family: edit datalist deep-equal + list value equal.
	const DATALIST_CASES = [
		{
			name: 'publication',
			model: 'component_publication',
			tipo: seed('rsc', 20),
			st: seed('rsc', 170),
			id: '1',
		},
		{
			name: 'select_lang',
			model: 'component_select_lang',
			tipo: seed('rsc', 251),
			st: seed('rsc', 205),
			id: '19226',
		},
		{
			name: 'filter',
			model: 'component_filter',
			tipo: 'test6437',
			st: 'test6136',
			id: '1267',
		},
		{
			name: 'filter_master',
			model: 'component_filter_master',
			tipo: 'dd170',
			st: 'dd128',
			id: '2',
		},
	];
	for (const c of DATALIST_CASES) {
		test(`${c.name}: edit datalist deep-equal PHP`, async () => {
			if (!ready) return;
			const { php, ts } = await both(c.model, c.tipo, c.st, c.id, 'edit');
			// undefined-vs-undefined must not pass: PHP must actually carry a datalist.
			expect(php?.datalist).toBeDefined();
			expect(ts?.datalist).toEqual(php?.datalist);
			expect(ts?.entries).toEqual(php?.entries);
			expect('row_section_id' in (ts ?? {})).toBe(false);
		});
		test(`${c.name}: list value labels equal PHP`, async () => {
			if (!ready) return;
			const { php, ts } = await both(c.model, c.tipo, c.st, c.id, 'list');
			expect(ts?.entries).toEqual(php?.entries);
		});
	}

	// AV media envelope.
	// TS versions posterframe_url by file (`?v=<mtime ms>-<size>`); the frozen PHP store has
	// the bare path (WC-2026-10-29-posterframe-url-version).
	const unversioned = (u: unknown) => (typeof u === 'string' ? u.replace(/\?v=\d+-\d+$/, '') : u);
	test('av: posterframe + subtitles (edit) match PHP', async () => {
		if (!ready) return;
		const { php, ts } = await both('component_av', seed('rsc', 35), seed('rsc', 167), '1', 'edit');
		expect(unversioned(ts?.posterframe_url)).toEqual(php?.posterframe_url);
		expect(ts?.subtitles).toEqual(php?.subtitles);
	});
	test('av: list value includes thumb quality (match PHP)', async () => {
		if (!ready) return;
		const { php, ts } = await both('component_av', seed('rsc', 35), seed('rsc', 167), '2', 'list');
		const q = (it: DataItem | undefined) =>
			Array.isArray(it?.entries) ? (it.entries as { quality: string }[]).map((e) => e.quality) : [];
		expect(q(ts)).toEqual(q(php));
		expect(unversioned(ts?.posterframe_url)).toEqual(php?.posterframe_url);
	});

	// security_access ACL tree datalist (13k nodes) — count + envelope.
	test('security_access: edit datalist node count + envelope match PHP', async () => {
		if (!ready) return;
		const { php, ts } = await both('component_security_access', 'dd774', 'dd234', '1', 'edit');
		expect((ts?.datalist as unknown[])?.length).toBe((php?.datalist as unknown[])?.length);
		expect(ts?.changes_files).toEqual(php?.changes_files);
		expect(ts?.parent_section_id).toEqual(php?.parent_section_id);
		expect('row_section_id' in (ts ?? {})).toBe(false); // get_data subject: no row stamp
		// Spot-check the first node deep-equal (full 13k equality proven in the port probe).
		expect((ts?.datalist as unknown[])?.[0]).toEqual((php?.datalist as unknown[])?.[0]);
	});

	// The CLIENT renders the edit form via the SECTION READ, not get_data — the
	// datalist MUST attach there too or the permissions tree renders empty (the
	// user-reported bug the get_data-only test missed). Drives readSection with
	// the exact client RQO (server-derived ddo_map) and diffs the dd774 item.
	test('security_access: SECTION-READ datalist + envelope match PHP (client path)', async () => {
		if (!ready) return;
		const rqo = {
			id: 'section_dd234_dd234_1_edit_lg-spa',
			action: 'read',
			source: {
				typo: 'source',
				type: 'section',
				action: 'search',
				model: 'section',
				tipo: 'dd234',
				section_tipo: 'dd234',
				section_id: 1,
				mode: 'edit',
				view: null,
				lang: 'lg-spa',
			},
			sqo: {
				section_tipo: ['dd234'],
				filter_by_locators: [{ section_tipo: 'dd234', section_id: 1 }],
			},
		};
		const { body } = await client.call(structuredClone(rqo) as Record<string, unknown>);
		// WC-2026-08-19-test-tld-replay (see `both` above).
		const adopted = adoptTipoIdMap(body, 'component_datalist_lifecycle_differential');
		expect(adopted.detail).toBeNull();
		expect(adopted.matched).toBe(true);
		const php = ((adopted.body.result as { data: DataItem[] }).data ?? []).find(
			(d) => d.tipo === 'dd774',
		);
		const ts = ((await readSection(rqo as unknown as Rqo)).data as unknown as DataItem[]).find(
			(d) => d.tipo === 'dd774',
		);
		expect((ts?.datalist as unknown[])?.length).toBe((php?.datalist as unknown[])?.length);
		expect((ts?.datalist as unknown[])?.length).toBeGreaterThan(1000); // tree actually present
		expect(ts?.changes_files).toEqual(php?.changes_files);
		expect(ts?.parent_section_id).toEqual(php?.parent_section_id);
		expect('row_section_id' in (ts ?? {})).toBe(true); // section read KEEPS the row stamp
		expect((ts?.datalist as unknown[])?.[0]).toEqual((php?.datalist as unknown[])?.[0]);
	});
});
