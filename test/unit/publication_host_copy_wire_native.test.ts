/**
 * Copy-mode agent reasons → typed engine errors (PUBLICATION_HOST_SPEC §6, phase-3 E7):
 * the copy refusals go through the ONE wire mapping (wire.ts agentResponseError), REASON
 * FIRST — a `key_unpublished` / `media_mode` / `media_path_refused` / `size_mismatch` /
 * `hash_mismatch` / `key_invalid` / `media_level_foreign` refusal is one a retry cannot fix, `rejected` whatever
 * status carried it (never the transient `busy`, never `failed`); `busy` is busy. The
 * reason rides `details.reason` and the log-only coordinates; agent prose never reaches
 * the public sentence. And the manifest read keeps no second mapping of its own.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	AGENT_REASON_SENTENCES,
	agentResponseError,
} from '../../src/core/publication_host/wire.ts';
import { stripComments } from '../helpers/strip_comments.ts';

const PROSE = '/srv/agent/secret path detail (test)';

function problem(status: number, reason: string): string {
	return JSON.stringify({
		type: `https://dedalo.dev/publication-host/problems/${reason}`,
		title: reason,
		status,
		reason,
		detail: PROSE,
	});
}

const REFUSALS = [
	'media_mode',
	'media_path_refused',
	'size_mismatch',
	'hash_mismatch',
	'key_unpublished',
	'key_invalid',
	'media_level_foreign',
] as const;

describe('copy-mode agent reasons', () => {
	for (const reason of REFUSALS) {
		for (const status of [409, 422, 500, 503]) {
			test(`${reason} (HTTP ${status}) → rejected; reason kept; prose never public`, () => {
				const error = agentResponseError('pub1', status, problem(status, reason));
				expect<string>(error.code).toBe('publication_host.rejected');
				expect(error.details).toEqual({ reason });
				expect(error.coordinates?.agent_reason).toBe(reason);
				expect(error.publicMessage).toBe(AGENT_REASON_SENTENCES[reason]);
				expect(error.publicMessage).not.toContain(PROSE);
			});
		}
	}

	test('busy is busy at any status (retryable)', () => {
		for (const status of [409, 503]) {
			expect<string>(agentResponseError('pub1', status, problem(status, 'busy')).code).toBe(
				'publication_host.busy',
			);
		}
	});

	test('a reason outside the agent list still falls back on the status', () => {
		expect<string>(agentResponseError('pub1', 500, problem(500, 'made_up')).code).toBe(
			'publication_host.failed',
		);
		expect<string>(agentResponseError('pub1', 409, problem(409, 'made_up')).code).toBe(
			'publication_host.rejected',
		);
	});

	test('media_level_foreign (T0-6) tells the operator what to fix: a folder owned by another user, its owner or mode', () => {
		const sentence = AGENT_REASON_SENTENCES.media_level_foreign ?? '';
		expect(sentence).toContain('owned by another user');
		expect(sentence).toContain('web server');
		expect(sentence).toContain('owner or permissions');
	});

	test('hash_mismatch names both commands that send a checksum (rules, media put)', () => {
		const sentence = AGENT_REASON_SENTENCES.hash_mismatch ?? '';
		expect(sentence).toContain('media file');
		expect(sentence).toContain('rules');
	});

	test('the media commands and the manifest read map refusals through the one wire mapping (no second table)', () => {
		const source = stripComments(
			readFileSync(
				join(import.meta.dir, '..', '..', 'src/core/publication_host/agent_client.ts'),
				'utf8',
			),
		);
		expect(source).not.toContain('manifestStatusError');
		expect(source).not.toContain('MANIFEST_STATUS_CODES');
		expect(source.match(/agentResponseError\(/g)).toHaveLength(1);
		expect(source).toContain('throw agentResponseError(host.name, res.status, res.text)');
	});
});
