/**
 * image_update_claim_native — the host updater's CLAIM installs the request it
 * CLAIMED, never one it read earlier (update audit 2026-10-29, U-43).
 *
 * THE DEFECT. claimRequest once READ request.json, then RENAMED whatever
 * request.json existed at that moment to inflight.json and overwrote it with
 * the content read before the rename. A panel cancel of request A plus a new
 * request B landing between the two steps installed the CANCELLED A and
 * swallowed B (its file renamed away, its content overwritten).
 *
 * THE LAW. The rename IS the claim: what is claimed is what the rename moved.
 * So the claim renames first, then reads and validates the claimed
 * inflight.json and uses ITS content.
 *
 * HOW. claimRequest's `seams.beforeRename` hook runs immediately before the
 * claim's rename. The interleaving is planted there: cancel A, record B. Every
 * read the claim makes after the hook must see B.
 *
 * RED BEFORE THE FIX (verified 2026-10-30 by placing the same hook between the
 * old read and the old rename): the claim answered A's id and inflight.json
 * held A, while B's request file was gone — the cancelled request installed,
 * the new one lost. Green after: B is claimed, A appears nowhere.
 *
 * Hermetic: no DB, no network — scratch dirs under the OS tmp dir.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	cancelRequest,
	claimRequest,
	type ImageUpdateRequest,
	INFLIGHT_FILE,
	OUTCOME_FILE,
	REQUEST_FILE,
	writeRequest,
} from '../../src/core/update/image_update_channel.ts';
import { DEDALO_DATA_VERSION } from '../../src/core/update/version.ts';
import { parseImageTag } from '../../src/core/update/version_walk.ts';

const SCRATCH: string[] = [];
afterAll(() => {
	for (const dir of SCRATCH) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
	const parent = mkdtempSync(join(tmpdir(), 'dedalo_image_claim_'));
	SCRATCH.push(parent);
	return join(parent, 'image_update');
}

const [MAJOR, MINOR, PATCH] = DEDALO_DATA_VERSION;

function request(tag: string): ImageUpdateRequest {
	const parsed = parseImageTag(tag);
	if (parsed === null) throw new Error(`bad fixture tag ${tag}`);
	return {
		schema: 1,
		id: crypto.randomUUID(),
		tag,
		version: parsed.version,
		channel: parsed.channel,
		from_version: DEDALO_DATA_VERSION.join('.'),
		requested_at: new Date().toISOString(),
		requested_by: -1,
	};
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, 'utf8'));
}

describe('claim installs what it claimed (U-43)', () => {
	test('cancel A + request B in the claim window: B is claimed, A is nowhere, B is not lost', async () => {
		const dir = scratchDir();
		const a = request(`${MAJOR}.${MINOR}.${PATCH + 1}`);
		const b = request(`${MAJOR}.${MINOR + 1}.0`);
		expect(await writeRequest(a, dir)).toEqual({ ok: true });
		const result = await claimRequest(new Date(), dir, {
			beforeRename: async () => {
				expect(cancelRequest(dir)).toEqual({ ok: true });
				expect(await writeRequest(b, dir)).toEqual({ ok: true });
			},
		});
		expect(result.kind).toBe('claimed');
		if (result.kind !== 'claimed') return;
		expect(result.inflight.id).toBe(b.id);
		expect(result.inflight.tag).toBe(b.tag);
		const inflight = readJson(join(dir, INFLIGHT_FILE));
		expect(inflight.id).toBe(b.id);
		expect(inflight.tag).toBe(b.tag);
		expect(typeof inflight.claimed_at).toBe('string');
		expect(existsSync(join(dir, REQUEST_FILE))).toBe(false);
	});

	test('cancelled in the claim window with nothing new: none, nothing in flight', async () => {
		const dir = scratchDir();
		await writeRequest(request(`${MAJOR}.${MINOR}.${PATCH + 1}`), dir);
		const result = await claimRequest(new Date(), dir, {
			beforeRename: () => {
				expect(cancelRequest(dir)).toEqual({ ok: true });
			},
		});
		expect(result).toEqual({ kind: 'none' });
		expect(existsSync(join(dir, INFLIGHT_FILE))).toBe(false);
	});

	test('replaced by a MALFORMED file in the claim window: the claimed file is what is judged', async () => {
		const dir = scratchDir();
		await writeRequest(request(`${MAJOR}.${MINOR}.${PATCH + 1}`), dir);
		const result = await claimRequest(new Date(), dir, {
			beforeRename: () => {
				writeFileSync(join(dir, REQUEST_FILE), '{not json');
			},
		});
		expect(result).toEqual({ kind: 'malformed' });
		expect(existsSync(join(dir, INFLIGHT_FILE))).toBe(false);
		expect(existsSync(join(dir, REQUEST_FILE))).toBe(false);
		const outcome = readJson(join(dir, OUTCOME_FILE));
		expect(outcome.status).toBe('refused');
		expect(outcome.detail).toBe('malformed_request');
	});

	test('no interleaving: the request is claimed as written, with claimed_at', async () => {
		const dir = scratchDir();
		const a = request(`${MAJOR}.${MINOR}.${PATCH + 1}`);
		await writeRequest(a, dir);
		const now = new Date();
		const result = await claimRequest(now, dir);
		expect(result).toEqual({ kind: 'claimed', inflight: { ...a, claimed_at: now.toISOString() } });
		expect(readJson(join(dir, INFLIGHT_FILE))).toEqual({ ...a, claimed_at: now.toISOString() });
	});
});
