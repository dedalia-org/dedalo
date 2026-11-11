/**
 * ONTOLOGY SCHEMA-CHANGE FILES — the component_security_access "Latest changes"
 * selector (src/core/ontology/schema_changes.ts) and its read door
 * dd_area_maintenance_api:parse_simple_schema_changes_files.
 *
 * Situation: a scratch changes dir (tmpdir) holding writer-shaped files + junk,
 * naming the suite's own `test3` section and its `test92`/`test91` children;
 * the door is driven through the real dispatch as the acl_identity_fixture
 * admin and non-admin (both hold dd88 at 2 — only global admin passes).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { getOntologyTermLabel } from '../../src/core/ontology/labels.ts';
import { getNode } from '../../src/core/ontology/resolver.ts';
import {
	listSchemaChangesFiles,
	parseSchemaChangesFile,
} from '../../src/core/ontology/schema_changes.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	ACL_ADMIN_USER_ID,
	ACL_NON_ADMIN_USER_ID,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const OLD = 'simple_schema_changes_2026-01-02_03-04-05.json';
const NEW = 'simple_schema_changes_2026-11-10_09-20-42.json';
const EMPTY = 'simple_schema_changes_2026-05-05_00-00-00.json';
let dir: string;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), 'dd_schema_changes_'));
	writeFileSync(join(dir, OLD), '[]');
	writeFileSync(join(dir, EMPTY), '');
	writeFileSync(
		join(dir, NEW),
		JSON.stringify([
			{ tipo: 'test3', children_added: ['test92', 'test91'] },
			{ tipo: 42, children_added: [] }, // malformed: skipped
		]),
	);
	writeFileSync(join(dir, 'notes.json'), '[]');
	writeFileSync(join(dir, 'simple_schema_changes_2026-11-10.json'), '[]');
	await installAclIdentityFixture();
});

afterAll(async () => {
	rmSync(dir, { recursive: true, force: true });
	await removeAclIdentityFixture();
});

describe('listSchemaChangesFiles', () => {
	test('writer-shaped names only, newest first', () => {
		expect(listSchemaChangesFiles(dir)).toEqual([NEW, EMPTY, OLD]);
	});
	test('a missing dir lists nothing', () => {
		expect(listSchemaChangesFiles(join(dir, 'absent'))).toEqual([]);
	});
});

describe('parseSchemaChangesFile', () => {
	test('labels the section + children and walks the parent chain farthest-first', async () => {
		const changes = await parseSchemaChangesFile(NEW, dir);
		expect(changes).toHaveLength(1);
		const [change] = changes;
		expect(change?.section).toEqual({ tipo: 'test3', label: await getOntologyTermLabel('test3') });
		expect(change?.section.label).not.toBe('');
		expect(change?.children.map((c) => c.tipo)).toEqual(['test92', 'test91']);
		expect(change?.children[0]?.label).toBe(await getOntologyTermLabel('test92'));
		const parents = change?.parents ?? [];
		expect(parents.length).toBeGreaterThan(0);
		expect(parents.at(-1)?.tipo).toBe((await getNode('test3'))?.parent as string);
		expect(parents.some((p) => p.tipo === 'dd0')).toBe(false);
		const rootParent = (await getNode(parents[0]?.tipo as string))?.parent ?? null;
		expect(rootParent === null || rootParent === '' || rootParent === 'dd0').toBe(true);
	});
	test('empty / missing file answers []', async () => {
		expect(await parseSchemaChangesFile(OLD, dir)).toEqual([]);
		expect(await parseSchemaChangesFile(EMPTY, dir)).toEqual([]);
		expect(
			await parseSchemaChangesFile('simple_schema_changes_1999-01-01_00-00-00.json', dir),
		).toEqual([]);
	});
	test('anything but a bare writer-shaped name is refused before the filesystem', async () => {
		for (const bad of [
			'../simple_schema_changes_2026-11-10_09-20-42.json',
			'simple_schema_changes_2026-11-10_09-20-42.json/../../x',
			'notes.json',
			'',
			42,
			undefined,
		]) {
			await expect(parseSchemaChangesFile(bad, dir)).rejects.toMatchObject({
				code: 'request.invalid_options',
			});
		}
	});
});

describe('dd_area_maintenance_api:parse_simple_schema_changes_files', () => {
	const call = async (userId: number, filename: unknown) => {
		const principal = await resolvePrincipal(userId);
		const session = getSession(
			createSession(userId, `schema_changes_${userId}`, principal.isGlobalAdmin),
		) as Record<string, unknown> | null;
		return dispatchRqo(
			{
				dd_api: 'dd_area_maintenance_api',
				action: 'parse_simple_schema_changes_files',
				options: { filename },
			} as unknown as Rqo,
			{
				requestId: 'schema_changes_native',
				clientIp: '127.0.0.1',
				session,
				csrfCandidate: session?.csrfToken ?? null,
				principal,
			} as never,
		);
	};

	test('global admin is served (absent file → ok, data [])', async () => {
		const response = await call(
			ACL_ADMIN_USER_ID,
			'simple_schema_changes_1999-01-01_00-00-00.json',
		);
		expect(response.status).toBe(200);
		expect(response.body).toMatchObject({ ok: true, data: [] });
	});
	test('non-admin holding dd88 is refused perm.denied', async () => {
		const response = await call(ACL_NON_ADMIN_USER_ID, NEW);
		expect(response.status).toBe(403);
		expect(response.body).toMatchObject({ ok: false, error: { code: 'perm.denied' } });
	});
	test('a traversal filename is refused request.invalid_options', async () => {
		const response = await call(ACL_ADMIN_USER_ID, '../../.env');
		expect(response.status).toBe(400);
		expect(response.body).toMatchObject({ ok: false, error: { code: 'request.invalid_options' } });
	});
});
