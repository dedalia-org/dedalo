/**
 * THE CODE DOOR PINS THE ARCHIVE TO THE MASTER'S OWN MANIFEST (update audit
 * 2026-10-29, U-41): src/core/update/code_manifest_pin.ts. The browser selects
 * an item; the master's answer — fetched by the engine, through the configured
 * address only — decides the URL and the sha256 that may be installed.
 */

import { describe, expect, mock, test } from 'bun:test';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import {
	type CodeManifestReader,
	fetchCodeManifestItems,
	pinToMasterManifest,
} from '../../src/core/update/code_manifest_pin.ts';

const MASTER = { url: 'https://master.example/dedalo/core/api/v1/json/', code: 'fixture_master' };
const SHA = 'a'.repeat(64);
const URL_701 = 'https://master.example/dedalo/install/code/7.0/7.0.1.zip';
const offering =
	(...items: { url: string; sha256?: string }[]): CodeManifestReader =>
	async () =>
		items.map((item) => ({ version: '7.0.1', date: '', ...item }));

async function refusal(work: Promise<unknown>): Promise<string> {
	try {
		await work;
	} catch (error) {
		if (isDedaloError(error) && error.code === 'update.refused') return error.message;
		throw error;
	}
	return 'passed';
}

describe('pinToMasterManifest', () => {
	test('an archive the master offers, with its published digest, passes', async () => {
		expect(
			await refusal(
				pinToMasterManifest(
					{ url: URL_701, declaredSha: SHA },
					MASTER,
					offering({ url: URL_701, sha256: SHA }),
				),
			),
		).toBe('passed');
	});

	test('a URL the master does not offer is refused', async () => {
		const other = 'https://master.example/dedalo/install/code/7.0/7.0.9.zip';
		expect(
			await refusal(
				pinToMasterManifest(
					{ url: other, declaredSha: SHA },
					MASTER,
					offering({ url: URL_701, sha256: SHA }),
				),
			),
		).toContain('does not offer that release');
	});

	test('a digest other than the one the master publishes is refused — the browser’s sha decides nothing', async () => {
		expect(
			await refusal(
				pinToMasterManifest(
					{ url: URL_701, declaredSha: 'b'.repeat(64) },
					MASTER,
					offering({ url: URL_701, sha256: SHA }),
				),
			),
		).toContain('does not match the one the code server publishes');
		expect(
			await refusal(
				pinToMasterManifest({ url: URL_701, declaredSha: SHA }, MASTER, offering({ url: URL_701 })),
			),
		).toContain('does not match');
	});

	test('an unreadable manifest fails closed', async () => {
		const broken: CodeManifestReader = async () => {
			throw new Error('connection reset');
		};
		expect(
			await refusal(pinToMasterManifest({ url: URL_701, declaredSha: SHA }, MASTER, broken)),
		).toContain('could not be read');
	});

	test('the ask carries the item’s channel token (master unless dev/prerelease)', async () => {
		const seen: string[] = [];
		const reader: CodeManifestReader = async (_master, channel) => {
			seen.push(channel);
			return [{ version: '7.0.1', date: '', url: URL_701, sha256: SHA }];
		};
		for (const channel of [undefined, 'dev', 'prerelease', 'bogus']) {
			await pinToMasterManifest({ url: URL_701, declaredSha: SHA, channel }, MASTER, reader);
		}
		expect(seen).toEqual(['master', 'dev', 'prerelease', 'master']);
	});

	test('the production reader dials only a configured master — never request text — and sends nothing otherwise', async () => {
		const fetchSpy = mock(globalThis.fetch);
		const original = globalThis.fetch;
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		try {
			await expect(
				fetchCodeManifestItems(
					{ url: 'https://not-configured.example/api/', code: 'fixture_master' },
					'master',
					{
						url: URL_701,
						declaredSha: SHA,
					},
				),
			).rejects.toThrow(/not a configured/);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = original;
		}
	});
});
