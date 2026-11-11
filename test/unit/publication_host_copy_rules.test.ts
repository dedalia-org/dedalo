/**
 * COPY-MODE RULES (PUBLICATION_HOST_SPEC §5/§6, plan M2): a `copy` publication host is
 * gated by the SAME phase-1 `publication_host` profile as a `shared` one, rendered over
 * the agent's own MEDIA_ROOT (the copy root). The agent mirrors pub/ markers into
 * <root>/.publication/pub/<key> (media.mark), so an unpublish is a 404 at the gate
 * before the files are deleted. The media MODE is not a rule input: the same root gives
 * the same bytes and the same hash. A host with no media root has nothing to gate.
 * Hermetic: pure renderers, no agent, no filesystem.
 */
import { describe, expect, test } from 'bun:test';
import { getPublicQualities } from '../../src/core/media/protection.ts';
import {
	buildPublicationHostApacheConf,
	buildPublicationHostNginxConf,
	getPublicationHostConfigHash,
	normalizePublicationHostInput,
} from '../../src/core/media/publication_host_rules.ts';
import type { AgentStatus } from '../../src/core/publication_host/agent_client.ts';
import type { PublicationHostRecord } from '../../src/core/publication_host/registry.ts';
import {
	expectedRulesForHost,
	expectedRulesOutcome,
	rulesRootFor,
} from '../../src/core/publication_host/rules.ts';

const COPY_ROOT = '/srv/publication/media_copy';

const RECORD: PublicationHostRecord = {
	name: 'zzcr_host',
	instance: 'test',
	fingerprint: '0'.repeat(64),
	address: { kind: 'unix', socket: '/tmp/zzcr.sock' },
	public_url: null,
	qualities: null,
	probe: { published: null, unpublished: null },
	paired_at: '2026-10-03T00:00:00.000Z',
};

function status(
	mode: 'shared' | 'copy' | 'none',
	root: string | null,
	server: 'apache' | 'nginx',
): AgentStatus {
	return {
		agent_version: '0.0.0',
		bun_version: Bun.version,
		platform: 'test',
		instance_fingerprint: '0'.repeat(64),
		apis: { v1: { current: null, previous: null }, v2: { current: null, previous: null } },
		served_apis: ['v1', 'v2'],
		rules: { server, hash: null },
		media: {
			mode,
			root,
			present: root !== null,
			read_only: mode === 'shared',
			pub_readable: root !== null,
			web_traversable: root !== null ? true : null,
			pub_markers: 0,
			problems: [],
		},
		disk: { state_root_free_bytes: 1 },
	};
}

describe('copy-mode rules: the publication_host profile over the copy root', () => {
	test('rulesRootFor answers the agent MEDIA_ROOT for copy and shared alike', () => {
		expect(rulesRootFor(status('copy', COPY_ROOT, 'apache'))).toBe(COPY_ROOT);
		expect(rulesRootFor(status('shared', COPY_ROOT, 'apache'))).toBe(COPY_ROOT);
	});

	test('a host with no media root (mode none, or no root) has nothing to gate: refused, typed', () => {
		expect(() => rulesRootFor(status('none', null, 'apache'))).toThrow(
			expect.objectContaining({ code: 'request.invalid_options' }),
		);
		expect(() => rulesRootFor(status('copy', null, 'apache'))).toThrow(
			expect.objectContaining({ code: 'request.invalid_options' }),
		);
		expect(() => expectedRulesForHost(RECORD, status('none', null, 'nginx'))).toThrow(
			expect.objectContaining({ code: 'request.invalid_options' }),
		);
		expect(expectedRulesOutcome(RECORD, status('none', null, 'nginx'))).toEqual({
			ok: false,
			reason: 'mode',
		});
		expect(expectedRulesOutcome(RECORD, status('copy', null, 'nginx'))).toEqual({
			ok: false,
			reason: 'root',
		});
	});

	for (const server of ['apache', 'nginx'] as const) {
		test(`${server}: a copy host gets exactly the phase-1 profile rendered over its copy root`, () => {
			const qualities = getPublicQualities();
			const expected = expectedRulesForHost(RECORD, status('copy', COPY_ROOT, server));
			const build =
				server === 'apache' ? buildPublicationHostApacheConf : buildPublicationHostNginxConf;
			expect(expected.server).toBe(server);
			expect(expected.text).toBe(build({ root: COPY_ROOT, qualities }));
			expect(expected.hash).toBe(
				getPublicationHostConfigHash(
					server,
					normalizePublicationHostInput({ root: COPY_ROOT, qualities }),
				),
			);
			// Rule B against the COPY root's mirrored markers; never Rule A.
			expect(expected.text).toContain(`${COPY_ROOT}/.publication/pub/`);
			expect(expected.text).not.toContain('.publication/auth');
			expect(expectedRulesOutcome(RECORD, status('copy', COPY_ROOT, server))).toEqual({
				ok: true,
				hash: expected.hash,
				dropped: expected.dropped,
			});
		});

		test(`${server}: the media mode is not a rule input — same root, same bytes, same hash`, () => {
			const copy = expectedRulesForHost(RECORD, status('copy', COPY_ROOT, server));
			const shared = expectedRulesForHost(RECORD, status('shared', COPY_ROOT, server));
			expect(copy.text).toBe(shared.text);
			expect(copy.hash).toBe(shared.hash);
		});
	}
});
