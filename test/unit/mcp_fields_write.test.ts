/**
 * Gate: MCP field-level write tools + media source gating (Phase 3 of the
 * work-system MCP foundation).
 *
 * - set_field append/replace literal semantics on the scratch section (test2 →
 *   matrix_test), including translation-preserving replace;
 * - portal link/unlink on a scratch host record (test3 rows created and removed
 *   here — same pattern as dataframe_cascade_removal);
 * - find_or_create: create → find (idempotent) → ambiguous_match with
 *   candidates;
 * - the write gate chain: a denied user is denied on EVERY new write tool;
 * - media source gating (pure): path source disabled without the import dir,
 *   traversal/symlink escapes rejected, base64 caps enforced.
 */
// Migrated to the generic `test` TLD 2026-08-19: the portal host is now the `test3`
// playground section (its own portal `test80`, storing in matrix_test) and the literal
// under test is `test52` — no install's records are read or written.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import {
	findOrCreate,
	portalLink,
	portalUnlink,
	setField,
} from '../../src/ai/mcp/tools/fields_write.ts';
import { loadMediaSource } from '../../src/ai/mcp/tools/media.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const NO_ACCESS: Principal = { userId: 999999, isGlobalAdmin: false, isDeveloper: false };

const SCRATCH_SECTION = 'test2';
const SCRATCH_TABLE = 'matrix_test';
const TEXT_FIELD = 'test52'; // component_input_text (proven write fixture)

/** Scratch host for the portal round-trip (same fixture family as the
 *  dataframe cascade gate — rows created here, removed in afterAll). */
const HOST_SECTION = 'test3';
const HOST_TABLE = 'matrix_test';
const PORTAL_FIELD = 'test80';

const createdScratch: number[] = [];
const createdHosts: number[] = [];

afterAll(async () => {
	for (const id of createdScratch) {
		await cleanScratchRecord(SCRATCH_SECTION, id, SCRATCH_TABLE);
	}
	for (const id of createdHosts) {
		await cleanScratchRecord(HOST_SECTION, id, HOST_TABLE);
	}
});

async function createScratchRecord(): Promise<number> {
	const { createSectionRecord } = await import('../../src/core/section/record/create_record.ts');
	const id = await createSectionRecord(SCRATCH_SECTION, SUPERUSER.userId);
	createdScratch.push(id);
	return id;
}

async function storedItems(
	table: string,
	sectionTipo: string,
	sectionId: number,
	column: string,
	tipo: string,
): Promise<{ id?: number; lang?: string; value?: unknown }[]> {
	const rows = (await sql.unsafe(
		`SELECT ${column}->'${tipo}' AS items FROM ${table} WHERE section_tipo = $1 AND section_id = $2`,
		[sectionTipo, sectionId],
	)) as { items: { id?: number; lang?: string; value?: unknown }[] | null }[];
	return rows[0]?.items ?? [];
}

describe('dedalo_set_field (scratch section)', () => {
	test('append inserts; replace overwrites only the requested language', async () => {
		const id = await createScratchRecord();

		await setField(SUPERUSER, {
			section_tipo: SCRATCH_SECTION,
			section_id: id,
			field: TEXT_FIELD,
			value: 'first-es',
			lang: 'lg-spa',
		});
		await setField(SUPERUSER, {
			section_tipo: SCRATCH_SECTION,
			section_id: id,
			field: TEXT_FIELD,
			value: 'first-en',
			lang: 'lg-eng',
		});
		let items = await storedItems(SCRATCH_TABLE, SCRATCH_SECTION, id, 'string', TEXT_FIELD);
		expect(items.some((item) => item.lang === 'lg-spa' && item.value === 'first-es')).toBe(true);
		expect(items.some((item) => item.lang === 'lg-eng' && item.value === 'first-en')).toBe(true);

		// replace lg-spa: the Spanish item is overwritten, English survives.
		await setField(SUPERUSER, {
			section_tipo: SCRATCH_SECTION,
			section_id: id,
			field: TEXT_FIELD,
			value: 'second-es',
			lang: 'lg-spa',
			mode: 'replace',
		});
		items = await storedItems(SCRATCH_TABLE, SCRATCH_SECTION, id, 'string', TEXT_FIELD);
		expect(items.some((item) => item.lang === 'lg-spa' && item.value === 'second-es')).toBe(true);
		expect(items.some((item) => item.lang === 'lg-spa' && item.value === 'first-es')).toBe(false);
		expect(items.some((item) => item.lang === 'lg-eng' && item.value === 'first-en')).toBe(true);
	});
});

describe('dedalo_portal_link / dedalo_portal_unlink (scratch host)', () => {
	test('link writes the canonical locator; unlink removes exactly it', async () => {
		const { createSectionRecord } = await import('../../src/core/section/record/create_record.ts');
		const hostId = await createSectionRecord(HOST_SECTION, SUPERUSER.userId);
		createdHosts.push(hostId);
		// The target MUST be a declared target of the portal — test80 declares
		// test3 — or validateRelationInsert refuses the link (off_target).
		const targetId = await createSectionRecord(HOST_SECTION, SUPERUSER.userId);
		createdHosts.push(targetId);

		await portalLink(SUPERUSER, {
			section_tipo: HOST_SECTION,
			section_id: hostId,
			field: PORTAL_FIELD,
			target: { section_tipo: HOST_SECTION, section_id: targetId },
		});
		let locators = await storedItems(HOST_TABLE, HOST_SECTION, hostId, 'relation', PORTAL_FIELD);
		const written = locators.find(
			(item) =>
				(item as { section_tipo?: string }).section_tipo === HOST_SECTION &&
				Number((item as { section_id?: unknown }).section_id) === targetId,
		) as Record<string, unknown> | undefined;
		expect(written).toBeDefined();
		expect(written?.type).toBe('dd151');
		expect(written?.from_component_tipo).toBe(PORTAL_FIELD);

		const unlinked = await portalUnlink(SUPERUSER, {
			section_tipo: HOST_SECTION,
			section_id: hostId,
			field: PORTAL_FIELD,
			target: { section_tipo: HOST_SECTION, section_id: targetId },
		});
		expect(unlinked.unlinked).toBe(true);
		locators = await storedItems(HOST_TABLE, HOST_SECTION, hostId, 'relation', PORTAL_FIELD);
		expect(
			locators.some((item) => Number((item as { section_id?: unknown }).section_id) === targetId),
		).toBe(false);
	});
});

describe('dedalo_find_or_create (scratch section)', () => {
	const unique = `mcp-foc-${process.pid}-${Math.floor(Math.random() * 1e9)}`;

	test('create → find (same id, nothing new) → ambiguous with candidates', async () => {
		const first = await findOrCreate(SUPERUSER, {
			section_tipo: SCRATCH_SECTION,
			match: [{ field: TEXT_FIELD, value: unique, lang: 'lg-spa' }],
		});
		expect(first.created).toBe(true);
		createdScratch.push(first.section_id);

		const second = await findOrCreate(SUPERUSER, {
			section_tipo: SCRATCH_SECTION,
			match: [{ field: TEXT_FIELD, value: unique, lang: 'lg-spa' }],
		});
		expect(second.created).toBe(false);
		expect(second.section_id).toBe(first.section_id);

		// Force a duplicate → the third call must refuse with candidates.
		const dupe = await createScratchRecord();
		await setField(SUPERUSER, {
			section_tipo: SCRATCH_SECTION,
			section_id: dupe,
			field: TEXT_FIELD,
			value: unique,
			lang: 'lg-spa',
		});
		try {
			await findOrCreate(SUPERUSER, {
				section_tipo: SCRATCH_SECTION,
				match: [{ field: TEXT_FIELD, value: unique, lang: 'lg-spa' }],
			});
			throw new Error('expected ambiguous_match');
		} catch (error) {
			expect(error).toBeInstanceOf(DedaloError);
			expect((error as DedaloError).code).toBe('mcp.ambiguous_match');
			// the model-facing payload rides as an extension key (top level beside `error`)
			const details = (error as DedaloError).extend as { candidates: unknown[] };
			expect(details.candidates.length).toBeGreaterThanOrEqual(2);
		}
	});
});

describe('write gate chain (denied user is denied everywhere)', () => {
	test('every field-level write tool refuses a user the human API denies', async () => {
		await expect(
			setField(NO_ACCESS, {
				section_tipo: SCRATCH_SECTION,
				section_id: 1,
				field: TEXT_FIELD,
				value: 'nope',
			}),
		).rejects.toMatchObject({ code: 'perm.denied' });
		await expect(
			portalLink(NO_ACCESS, {
				section_tipo: HOST_SECTION,
				section_id: 1,
				field: PORTAL_FIELD,
				target: { section_tipo: SCRATCH_SECTION, section_id: 1 },
			}),
		).rejects.toMatchObject({ code: 'perm.denied' });
		await expect(
			portalUnlink(NO_ACCESS, {
				section_tipo: HOST_SECTION,
				section_id: 1,
				field: PORTAL_FIELD,
				target: { section_tipo: SCRATCH_SECTION, section_id: 1 },
			}),
		).rejects.toMatchObject({ code: 'perm.denied' });
		// find_or_create with no match hit reaches the create gate and dies there.
		await expect(
			findOrCreate(NO_ACCESS, {
				section_tipo: SCRATCH_SECTION,
				match: [{ field: TEXT_FIELD, value: `never-${process.pid}`, lang: 'lg-spa' }],
			}),
		).rejects.toMatchObject({ code: 'perm.denied' });
	});

	test('injection-shaped identifiers die at the chokepoint', async () => {
		await expect(
			setField(SUPERUSER, {
				section_tipo: "test2'; DROP TABLE matrix; --",
				section_id: 1,
				field: TEXT_FIELD,
				value: 'x',
			}),
		).rejects.toThrow(/identifier gate/);
	});
});

describe('media source gating (pure — no DB, no ingest)', () => {
	const ROOT = scratchDir('mcp_media');
	const OUTSIDE = scratchDir('mcp_outside');

	function withImportDir<T>(dir: string | undefined, run: () => Promise<T>): Promise<T> {
		const saved = process.env.DEDALO_MCP_MEDIA_IMPORT_DIR;
		if (dir === undefined) process.env.DEDALO_MCP_MEDIA_IMPORT_DIR = '';
		else process.env.DEDALO_MCP_MEDIA_IMPORT_DIR = dir;
		return run().finally(() => {
			if (saved === undefined) {
				// undefined assignment leaves the STRING 'undefined'
				delete process.env.DEDALO_MCP_MEDIA_IMPORT_DIR;
			} else {
				process.env.DEDALO_MCP_MEDIA_IMPORT_DIR = saved;
			}
		});
	}

	test('path source is DISABLED without the import dir (fail-closed)', async () => {
		await withImportDir(undefined, async () => {
			await expect(loadMediaSource({ kind: 'path', path: '/etc/hosts' })).rejects.toMatchObject({
				code: 'mcp.media_path_disabled',
			});
		});
	});

	test('containment: inside OK; ../ traversal and symlink escapes rejected', async () => {
		mkdirSync(ROOT, { recursive: true });
		mkdirSync(OUTSIDE, { recursive: true });
		writeFileSync(`${ROOT}/ok.jpg`, 'x');
		writeFileSync(`${OUTSIDE}/secret.jpg`, 'y');
		symlinkSync(`${OUTSIDE}/secret.jpg`, `${ROOT}/sneaky.jpg`);
		try {
			await withImportDir(ROOT, async () => {
				const loaded = await loadMediaSource({ kind: 'path', path: `${ROOT}/ok.jpg` });
				expect(loaded.fileName).toBe('ok.jpg');
				await expect(
					loadMediaSource({
						kind: 'path',
						path: `${ROOT}/../${OUTSIDE.split('/').pop()}/secret.jpg`,
					}),
				).rejects.toMatchObject({ code: 'request.invalid' });
				await expect(
					loadMediaSource({ kind: 'path', path: `${ROOT}/sneaky.jpg` }),
				).rejects.toMatchObject({ code: 'request.invalid' });
				await expect(
					loadMediaSource({ kind: 'path', path: 'relative/path.jpg' }),
				).rejects.toMatchObject({ code: 'request.invalid' });
			});
		} finally {
			rmSync(ROOT, { recursive: true, force: true });
			rmSync(OUTSIDE, { recursive: true, force: true });
		}
	});

	test('a NON-NUMERIC cap fails CLOSED to the default, not open (F1)', async () => {
		const saved = process.env.DEDALO_MCP_MEDIA_MAX_BYTES;
		process.env.DEDALO_MCP_MEDIA_MAX_BYTES = '10MB'; // NaN under Number()
		try {
			// A payload under the 10 MiB DEFAULT still loads (cap did not vanish)…
			const small = await loadMediaSource({
				kind: 'base64',
				data: Buffer.from('ok').toString('base64'),
				filename: 'ok.txt',
			});
			expect(small.bytes.byteLength).toBe(2);
			// …and a payload over the default is still rejected (NOT unbounded).
			const huge = Buffer.alloc(11 * 1024 * 1024, 1).toString('base64');
			await expect(
				loadMediaSource({ kind: 'base64', data: huge, filename: 'huge.bin' }),
			).rejects.toMatchObject({ code: 'mcp.media_too_large' });
		} finally {
			if (saved === undefined) {
				// undefined assignment leaves the STRING 'undefined'
				delete process.env.DEDALO_MCP_MEDIA_MAX_BYTES;
			} else {
				process.env.DEDALO_MCP_MEDIA_MAX_BYTES = saved;
			}
		}
	});

	test('base64: caps enforced before decode; invalid/empty payloads rejected', async () => {
		const saved = process.env.DEDALO_MCP_MEDIA_MAX_BYTES;
		process.env.DEDALO_MCP_MEDIA_MAX_BYTES = '16';
		try {
			const small = await loadMediaSource({
				kind: 'base64',
				data: Buffer.from('tiny').toString('base64'),
				filename: 'tiny.txt',
			});
			expect(small.bytes.byteLength).toBe(4);
			await expect(
				loadMediaSource({
					kind: 'base64',
					data: Buffer.from('x'.repeat(64)).toString('base64'),
					filename: 'big.txt',
				}),
			).rejects.toMatchObject({ code: 'mcp.media_too_large' });
			await expect(
				loadMediaSource({ kind: 'base64', data: '', filename: 'empty.txt' }),
			).rejects.toMatchObject({ code: 'request.invalid' });
		} finally {
			if (saved === undefined) {
				// undefined assignment leaves the STRING 'undefined'
				delete process.env.DEDALO_MCP_MEDIA_MAX_BYTES;
			} else {
				process.env.DEDALO_MCP_MEDIA_MAX_BYTES = saved;
			}
		}
	});
});
