/**
 * tool_upload on a component_json (feature crawl #8; PHP component_json::add_file +
 * process_uploaded_file): the context carries features.allowed_extensions ['json'] (the
 * tool crashed on open without it), and an uploaded .json REPLACES the value — parsed,
 * saved through the write chokepoint, the staged file deleted. Invalid JSON writes nothing.
 *
 * Scratch TLD zzjs (section + component_json + one record); the staged file lives in the
 * suite media root's staging dir.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from '../../src/core/db/postgres.ts';
import { stagingDir } from '../../src/core/media/ingest/add_file.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { DB_READY } from '../helpers/db_ready.ts';

const SITUATION = situation({
	name: 'component_json upload target',
	tld: 'zzjs',
	nodes: [
		{ tipo: 'zzjs1', parent: 'test1', model: 'section', term: { 'lg-eng': 'zzjs section' } },
		{ tipo: 'zzjs2', parent: 'zzjs1', model: 'component_json', order_number: 1 },
	],
	records: [{ section_tipo: 'zzjs1', section_id: 1 }],
});
const ROOT: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const KEY_DIR = 'zzjs_upload';

async function upload(fileName: string, content: string) {
	const dir = stagingDir(-1, KEY_DIR);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, fileName), content);
	const spec = (await getLoadedTool('tool_upload'))?.module.apiActions.process_uploaded_file;
	if (spec === undefined) throw new Error('tool_upload process_uploaded_file not loaded');
	return spec.handler({
		principal: ROOT,
		userId: -1,
		background: false,
		options: {
			tipo: 'zzjs2',
			section_tipo: 'zzjs1',
			section_id: 1,
			file_data: { key_dir: KEY_DIR, tmp_name: fileName, extension: 'json', name: fileName },
		},
	});
}

async function storedValue(): Promise<unknown> {
	const table = await getMatrixTableFromTipo('zzjs1');
	const rows = (await sql.unsafe(
		`SELECT misc->'zzjs2' AS v FROM "${table}" WHERE section_tipo = 'zzjs1' AND section_id = 1`,
	)) as { v: unknown }[];
	return rows[0]?.v ?? null;
}

describe.if(DB_READY)('tool_upload into a component_json', () => {
	beforeAll(async () => {
		await assertTestDatabase('tool_upload_json_native');
		await ensureSituation(SITUATION);
	});
	afterAll(async () => {
		rmSync(stagingDir(-1, KEY_DIR), { recursive: true, force: true });
		expect(await dropSituation(SITUATION)).toBe(0);
	});

	test('the context offers the upload descriptor', async () => {
		const entry = await buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			tipo: 'zzjs2',
			sectionTipo: 'zzjs1',
			mode: 'edit',
			lang: 'lg-nolan',
			permissions: 2,
		});
		expect(entry?.features).toEqual({ allowed_extensions: ['json'], default_target_quality: null });
	});

	test('an uploaded .json replaces the value; the staged file is consumed', async () => {
		const response = await upload('good.json', '{"a":[1,2],"b":"x"}');
		expect((response as { ok?: boolean }).ok).toBe(true);
		const stored = (await storedValue()) as { value?: unknown }[];
		expect(stored?.[0]?.value).toEqual({ a: [1, 2], b: 'x' });
		expect(existsSync(join(stagingDir(-1, KEY_DIR), 'good.json'))).toBe(false);
	});

	test('invalid JSON is refused and writes nothing', async () => {
		const before = await storedValue();
		const error = await upload('bad.json', '{"a":').then(
			() => null,
			(e: unknown) => e as { code?: string },
		);
		expect(error?.code).toBe('media.upload_rejected');
		expect(await storedValue()).toEqual(before);
	});
});
