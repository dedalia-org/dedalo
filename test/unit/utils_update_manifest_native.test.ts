/**
 * The TWO update-manifest doors (CRAP Tier 3 item 3.7).
 *
 * `get_ontology_update_info` and `get_code_update_info` were two near-identical
 * 40-line blocks whose ONLY differences were invisible: the ontology door adds
 * the 'localhost' pseudo-code and reads TWO version parts; the code door does
 * neither and demands THREE. Both are now rewired onto the single parameterised
 * `authorizeUpdateManifest`, so the asymmetry is an argument, not a diff.
 *
 * What these tests defend:
 *   1. ORDER IS SECURITY — a non-master answers 'not a … server' BEFORE any
 *      code is examined. Answering 'Invalid code' first would confirm to an
 *      unauthenticated prober that this host IS a master.
 *   2. The `Number('') === 0` trap — an empty/short version must be refused.
 *   3. The refusal bytes are PHP parity, typo included ('is not an code
 *      server') — this is a MACHINE-TO-MACHINE wire another Dédalo install
 *      speaks. Envelope v2 keeps them: every refusal is the ONE public-
 *      disclosure code `update_server.refused` (403) carrying the exact
 *      sentence as its `publicMessage`. One code for every reason is the
 *      point (see the registry entry): "not a master", "invalid code" and
 *      "invalid version" must stay indistinguishable to a prober.
 *   4. The rewire itself (source assertions): a revert that re-inlines the old
 *      blocks must go red, not silently pass.
 *   5. The local-origin refusal (WC-2026-09-30-update-manifest-local-origin-refusal),
 *      DRIVEN on both doors in a child configured as a master: refused for a
 *      remote peer, served to a same-machine one, only AFTER authorization.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../src/config/config.ts';
import type { ApiRequestContext } from '../../src/core/api/dispatch.ts';
import {
	authorizeUpdateManifest,
	localOriginRefusal,
	utilsApiActions,
} from '../../src/core/api/handlers/dd_utils_api.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { getOntologyIoPath } from '../../src/core/ontology/data_io_import.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

const HANDLER_SOURCE_PATH = join(import.meta.dir, '../../src/core/api/handlers/dd_utils_api.ts');

/** A scratch ontology IO dir holding the `7.0` version dir the doors ask for —
 * BUILT here, never borrowed from the ambient `ONTOLOGY_DATA_IO_DIR` (its default
 * moved to `<private>/import/ontology`, which a checkout need not have). */
function scratchOntologyIoDir(): string {
	const dir = scratchDir('ontology_io');
	mkdirSync(join(dir, '7.0'), { recursive: true });
	return dir;
}

/** Base input: an authorized ontology-door call. Each test perturbs ONE field. */
function ontologyInput(overrides: Record<string, unknown> = {}) {
	return {
		isServer: true,
		configuredCodes: ['s1', undefined, '', 'alpha'] as readonly (string | undefined)[],
		allowLocalhost: true,
		presentedCode: 's1' as unknown,
		versionRaw: '7.0' as unknown,
		requiredParts: 2 as 2 | 3,
		...overrides,
	} as Parameters<typeof authorizeUpdateManifest>[0];
}

/** Base input: an authorized code-door call. */
function codeInput(overrides: Record<string, unknown> = {}) {
	return {
		isServer: true,
		configuredCodes: ['c1'] as readonly (string | undefined)[],
		allowLocalhost: false,
		presentedCode: 'c1' as unknown,
		versionRaw: '7.0.0' as unknown,
		requiredParts: 3 as 2 | 3,
		serverKind: 'code' as const,
		...overrides,
	} as Parameters<typeof authorizeUpdateManifest>[0];
}

describe('authorizeUpdateManifest — gate 1: am I even a master?', () => {
	test('a non-master refuses with the ontology bytes by default', () => {
		const out = authorizeUpdateManifest(ontologyInput({ isServer: false }));
		expect(out).toEqual({ ok: false, msg: 'Error. Server is not an ontology server' });
	});

	test("serverKind 'code' keeps the PHP 'an code server' typo VERBATIM", () => {
		// Wire parity, not prose: correcting this needs a WIRE_CONTRACT entry.
		const out = authorizeUpdateManifest(codeInput({ isServer: false }));
		expect(out).toEqual({ ok: false, msg: 'Error. Server is not an code server' });
	});

	test('ORDERING: a non-master never answers "Invalid code" (no master confirmation)', () => {
		// Both the code AND the version are garbage here. If the server check
		// were not first, the prober would learn which one the host cares about.
		const out = authorizeUpdateManifest(
			ontologyInput({ isServer: false, presentedCode: 'nope', versionRaw: 'garbage' }),
		);
		expect(out).toEqual({ ok: false, msg: 'Error. Server is not an ontology server' });
	});
});

describe('authorizeUpdateManifest — gate 2: the version', () => {
	test.each([
		['', 'empty string — the Number("") === 0 trap: major is 0, minor is NaN'],
		['7', 'one part only'],
		['7.x', 'non-numeric minor'],
		['v7.0', 'a "v" prefix is not stripped'],
		[null, 'null is not a string → coerced to ""'],
		[7, 'a NUMBER is not a string → coerced to ""'],
		[undefined, 'absent'],
		[{ major: 7 }, 'an object'],
	])('requiredParts 2 refuses %p (%s)', (versionRaw) => {
		const out = authorizeUpdateManifest(ontologyInput({ versionRaw }));
		expect(out).toEqual({ ok: false, msg: 'Error. Invalid version number' });
	});

	test('requiredParts 2 accepts "7.0" → [7,0]', () => {
		expect(authorizeUpdateManifest(ontologyInput({ versionRaw: '7.0' }))).toEqual({
			ok: true,
			version: [7, 0],
		});
	});

	test('requiredParts 2 truncates "7.0.3" to the major.minor pair [7,0]', () => {
		// The ontology IO dir is major.minor — patch releases share one dir.
		expect(authorizeUpdateManifest(ontologyInput({ versionRaw: '7.0.3' }))).toEqual({
			ok: true,
			version: [7, 0],
		});
	});

	test('requiredParts 3 REFUSES "7.0" — the asymmetry the extraction makes explicit', () => {
		expect(authorizeUpdateManifest(codeInput({ versionRaw: '7.0' }))).toEqual({
			ok: false,
			msg: 'Error. Invalid version number',
		});
	});

	test.each([
		['7.0.0', [7, 0, 0]],
		['7.0.0.dev', [7, 0, 0]], // parseVersionString strips the prerelease tail
		// A peer naming itself by a PRERELEASE identity is read as its data triple
		// (design gate 4): before, Number('0-beta') = NaN refused every beta asker.
		['7.0.0-beta.6', [7, 0, 0]],
		['7.0.0-alpha.1', [7, 0, 0]],
		['7.0.0-rc.2', [7, 0, 0]],
		['7.0.0.1', [7, 0, 0, 1]], // extra parts are PRESERVED, not truncated
	])('requiredParts 3 accepts %p → %p', (versionRaw, expected) => {
		expect(authorizeUpdateManifest(codeInput({ versionRaw }))).toEqual({
			ok: true,
			version: expected as number[],
		});
	});

	test.each([['7.0.x'], ['7.0.0.dev.1'], ['7.0.0-pre.1'], ['7.0.0-beta']])(
		'requiredParts 3 refuses %p',
		(versionRaw) => {
			expect(authorizeUpdateManifest(codeInput({ versionRaw }))).toEqual({
				ok: false,
				msg: 'Error. Invalid version number',
			});
		},
	);

	test('MOVED FAITHFULLY, NOT FIXED: ".0" is accepted as version [0,0]', () => {
		// Number('') === 0 makes a leading-dot string a valid "major". This is the
		// pre-existing behaviour of the inline block, pinned here on purpose — a
		// behaviour fix hidden inside a refactor is unreviewable. Downstream the
		// path 0.0 simply does not exist, so getOntologyIoPath answers false.
		expect(authorizeUpdateManifest(ontologyInput({ versionRaw: '.0' }))).toEqual({
			ok: true,
			version: [0, 0],
		});
		expect(getOntologyIoPath(config.ops.ontologyDataIoDir, [0, 0])).toBe(false);
	});

	test('MOVED FAITHFULLY, NOT FIXED: an empty segment counts as 0 ("7..0")', () => {
		// Same Number('') === 0 trap, one segment in: '7..0' passes BOTH doors.
		// Pinned, not corrected — see the note on '.0' above.
		expect(authorizeUpdateManifest(codeInput({ versionRaw: '7..0' }))).toEqual({
			ok: true,
			version: [7, 0, 0],
		});
		expect(authorizeUpdateManifest(ontologyInput({ versionRaw: '7..0' }))).toEqual({
			ok: true,
			version: [7, 0],
		});
	});

	test('the version is judged BEFORE the code', () => {
		// Both invalid → the version message wins (the inline order, preserved).
		const out = authorizeUpdateManifest(
			ontologyInput({ versionRaw: 'nope', presentedCode: 'also-nope' }),
		);
		expect(out).toEqual({ ok: false, msg: 'Error. Invalid version number' });
	});
});

describe('authorizeUpdateManifest — gate 3: the code', () => {
	test.each([['s1'], ['alpha']])('a configured code (%p) is accepted', (presentedCode) => {
		expect(authorizeUpdateManifest(ontologyInput({ presentedCode }))).toEqual({
			ok: true,
			version: [7, 0],
		});
	});

	test.each([
		['', 'the empty configured entry must NOT become a usable code'],
		[undefined, 'the undefined configured entry must NOT become a usable code'],
		['nope', 'an unconfigured code'],
		[42, 'a non-string'],
		[null, 'null'],
		[['s1'], 'an array wrapping a valid code'],
	])('%p is refused (%s)', (presentedCode) => {
		expect(authorizeUpdateManifest(ontologyInput({ presentedCode }))).toEqual({
			ok: false,
			msg: 'Error. Invalid code',
		});
	});

	test("allowLocalhost:true honors the 'localhost' pseudo-code (ontology door)", () => {
		expect(authorizeUpdateManifest(ontologyInput({ presentedCode: 'localhost' }))).toEqual({
			ok: true,
			version: [7, 0],
		});
	});

	test("allowLocalhost:false REFUSES 'localhost' (code door) — the second asymmetry", () => {
		expect(authorizeUpdateManifest(codeInput({ presentedCode: 'localhost' }))).toEqual({
			ok: false,
			msg: 'Error. Invalid code',
		});
	});

	test('an empty configured-code list authorizes nobody but localhost when allowed', () => {
		expect(
			authorizeUpdateManifest(ontologyInput({ configuredCodes: [], presentedCode: 's1' })),
		).toEqual({ ok: false, msg: 'Error. Invalid code' });
		expect(
			authorizeUpdateManifest(ontologyInput({ configuredCodes: [], presentedCode: 'localhost' })),
		).toEqual({ ok: true, version: [7, 0] });
		expect(
			authorizeUpdateManifest(codeInput({ configuredCodes: [], presentedCode: 'localhost' })),
		).toEqual({ ok: false, msg: 'Error. Invalid code' });
	});
});

describe('the two doors as wired (this install is neither master)', () => {
	const context = {
		requestId: 'test',
		clientIp: '127.0.0.1',
		session: null,
		sessionToken: null,
		csrfCandidate: null,
	} as unknown as ApiRequestContext;

	/** The registered handler, asserted present (a missing action must FAIL loud). */
	function handlerFor(action: string) {
		const handler = utilsApiActions[action];
		if (handler === undefined) throw new Error(`utilsApiActions.${action} is not registered`);
		return handler;
	}

	function rqo(options: Record<string, unknown>): Rqo {
		return { dd_api: 'dd_utils_api', action: 'x', options } as unknown as Rqo;
	}

	test('the test env really is neither an ontology nor a code master', () => {
		// Names the precondition these two cases rest on, so a config change
		// turns them RED instead of quietly making them vacuous.
		expect(config.ontologyIo.isOntologyServer).toBe(false);
		expect(config.update.isCodeServer).toBe(false);
	});

	/** The DedaloError a door threw (the handler builds no failure body). */
	async function refusalOf(call: Promise<unknown>): Promise<DedaloError> {
		const outcome = await call.then(
			(value) => ({ threw: false as const, value }),
			(error: unknown) => ({ threw: true as const, error }),
		);
		if (!outcome.threw) {
			throw new Error(`expected a refusal, got ${JSON.stringify(outcome.value)}`);
		}
		if (!(outcome.error instanceof DedaloError)) throw outcome.error;
		return outcome.error;
	}

	test('get_ontology_update_info refuses a non-master before any code check', async () => {
		const refusal = await refusalOf(
			handlerFor('get_ontology_update_info')(rqo({ version: '7.0', code: 'localhost' }), context),
		);
		expect(refusal.code).toBe('update_server.refused');
		expect(refusal.spec.status).toBe(403);
		// PUBLIC disclosure — the PHP sentence still reaches the peer install.
		expect(refusal.publicMessage).toBe('Error. Server is not an ontology server');
	});

	test("get_code_update_info answers the PHP typo 'is not an code server' VERBATIM", async () => {
		const refusal = await refusalOf(
			handlerFor('get_code_update_info')(rqo({ version: '7.0.0', code: 'localhost' }), context),
		);
		expect(refusal.code).toBe('update_server.refused');
		expect(refusal.publicMessage).toBe('Error. Server is not an code server');
	});
});

describe('getOntologyIoPath (the ontology door s downstream step)', () => {
	const IO = scratchOntologyIoDir();
	afterAll(() => {
		rmSync(IO, { recursive: true, force: true });
	});

	test('an existing major.minor dir resolves', () => {
		const resolved = getOntologyIoPath(IO, [7, 0]);
		expect(typeof resolved).toBe('string');
		expect(String(resolved).endsWith('/7.0')).toBe(true);
	});

	test('a version with no shipped ontology files answers false', () => {
		expect(getOntologyIoPath(IO, [99, 9])).toBe(false);
	});

	test('a non-integer part answers false before touching the filesystem', () => {
		expect(getOntologyIoPath(IO, [7, Number.NaN])).toBe(false);
	});
});

describe('the rewire is real (source assertions — a revert must go red)', () => {
	const source = readFileSync(HANDLER_SOURCE_PATH, 'utf8');

	test('BOTH doors call authorizeUpdateManifest', () => {
		const calls = source.split('authorizeUpdateManifest({').length - 1;
		expect(calls).toBe(2);
	});

	test.each([
		["validCodes.add('localhost');", 'the inline localhost pseudo-code'],
		['const minor = Number(parts[1]);', 'the inline two-part version parse'],
		['clientVersion.length < 3', 'the inline three-part version check'],
		['config.ontologyIo.isOntologyServer !== true', 'the inline ontology master check'],
		['config.update.isCodeServer !== true', 'the inline code master check'],
		['const validCodes = new Set(', 'the inline code sets'],
	])('the inline block %p is GONE (%s)', (marker) => {
		expect(source.includes(marker as string)).toBe(false);
	});

	test('each door passes ITS OWN asymmetry (this env cannot execute past gate 1)', () => {
		// Both doors short-circuit at 'not a master' here, so the arguments they
		// pass are only observable in the source. Without this, swapping
		// requiredParts between the doors would be invisible to the whole suite.
		const ontologyDoor = source.slice(
			source.indexOf('get_ontology_update_info: async'),
			source.indexOf('get_code_update_info: async'),
		);
		const codeDoor = source.slice(source.indexOf('get_code_update_info: async'));
		expect(ontologyDoor.length).toBeGreaterThan(200);
		expect(codeDoor.length).toBeGreaterThan(200);
		for (const marker of ['allowLocalhost: true', 'requiredParts: 2', "serverKind: 'ontology'"]) {
			expect(ontologyDoor.includes(marker)).toBe(true);
			expect(codeDoor.includes(marker)).toBe(false);
		}
		for (const marker of ['allowLocalhost: false', 'requiredParts: 3', "serverKind: 'code'"]) {
			expect(codeDoor.includes(marker)).toBe(true);
			expect(ontologyDoor.includes(marker)).toBe(false);
		}
	});

	test('the refusal bytes live in exactly one place now', () => {
		expect(source.split("'Error. Invalid code'").length - 1).toBe(1);
		expect(source.split("'Error. Invalid version number'").length - 1).toBe(1);
	});
});

describe('localOriginRefusal — a local public origin is never advertised to another machine', () => {
	test('a public origin serves everyone', () => {
		expect(localOriginRefusal({ originIsLocal: false, clientIp: '203.0.113.9' })).toBeNull();
	});

	test.each(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'local'])(
		'a local origin still serves a same-machine caller (%p — dev two-instance, update drill)',
		(clientIp) => {
			expect(localOriginRefusal({ originIsLocal: true, clientIp })).toBeNull();
		},
	);

	test.each(['203.0.113.9', '192.168.1.20', '2001:db8::1'])(
		'a local origin REFUSES a remote caller (%p) and names the key to fix',
		(clientIp) => {
			const msg = localOriginRefusal({ originIsLocal: true, clientIp });
			expect(msg).not.toBeNull();
			expect(msg as string).toContain('DEDALO_HOST');
		},
	);
});

/**
 * THE LOCAL-ORIGIN REFUSAL, DRIVEN (F9, 2026-09-30; WC-2026-09-30-update-manifest-local-origin-refusal).
 * Each case boots a CHILD process configured as a master of BOTH kinds (config
 * is frozen at load, and a child avoids a mock.module leak), calls the
 * registered door with a caller IP, and reports what it answered. Neither door
 * touches the database; DB_NAME is never set. Replaces a source-ORDER pin
 * (indexOf of two call spellings), which a rename defeated and an unreached
 * `throw` satisfied.
 */
describe('both doors refuse a remote peer when this master would advertise a local origin', () => {
	const HANDLER = join(import.meta.dir, '../../src/core/api/handlers/dd_utils_api.ts');
	const ONTOLOGY_CODE = 'zzprobe';
	const CODE_CODE = 'zzcode';
	const REMOTE = '203.0.113.9';
	// The ontology door serves its manifest FROM this dir: given explicitly, so the
	// child never depends on which default the ambient checkout resolves.
	const IO = scratchOntologyIoDir();
	afterAll(() => {
		rmSync(IO, { recursive: true, force: true });
	});
	type Door = 'get_ontology_update_info' | 'get_code_update_info';
	const VERSION: Record<Door, string> = {
		get_ontology_update_info: '7.0',
		get_code_update_info: '7.0.0',
	};
	const VALID: Record<Door, string> = {
		get_ontology_update_info: ONTOLOGY_CODE,
		get_code_update_info: CODE_CODE,
	};

	interface Answer {
		ok?: true;
		code?: string;
		publicMessage?: string;
		error?: string;
	}

	function drive(door: Door, host: string, clientIp: string, code: string): Answer {
		const script = `
			const { utilsApiActions } = await import(${JSON.stringify(HANDLER)});
			const context = { requestId: 'probe', clientIp: ${JSON.stringify(clientIp)}, session: null, sessionToken: null, csrfCandidate: null };
			const rqo = { dd_api: 'dd_utils_api', action: ${JSON.stringify(door)}, options: { version: ${JSON.stringify(VERSION[door])}, code: ${JSON.stringify(code)} } };
			try {
				await utilsApiActions[${JSON.stringify(door)}](rqo, context);
				console.log(JSON.stringify({ ok: true }));
			} catch (error) {
				console.log(JSON.stringify({ code: error?.code, publicMessage: error?.publicMessage, error: String(error?.message ?? error) }));
			}
			process.exit(0);`;
		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			IS_AN_ONTOLOGY_SERVER: 'true',
			ONTOLOGY_SERVER_CODE: ONTOLOGY_CODE,
			IS_A_CODE_SERVER: 'true',
			CODE_SERVERS: JSON.stringify([{ name: 'p', url: 'https://p.test', code: CODE_CODE }]),
			DEDALO_HOST: host,
			ONTOLOGY_DATA_IO_DIR: IO,
		};
		const run = Bun.spawnSync(['bun', '-e', script], { env, cwd: join(import.meta.dir, '../..') });
		const out = run.stdout.toString().trim().split('\n').at(-1) ?? '';
		if (run.exitCode !== 0 || !out.startsWith('{')) {
			throw new Error(
				`probe child failed (${run.exitCode}): ${run.stderr.toString().slice(-2000)}`,
			);
		}
		return JSON.parse(out) as Answer;
	}

	const DOORS: Door[] = ['get_ontology_update_info', 'get_code_update_info'];

	for (const door of DOORS) {
		for (const host of ['', 'localhost']) {
			test(`(a) ${door}: DEDALO_HOST=${JSON.stringify(host)} + a remote caller + a valid code → refused, naming DEDALO_HOST`, () => {
				const answer = drive(door, host, REMOTE, VALID[door]);
				expect(answer.code, JSON.stringify(answer)).toBe('update_server.refused');
				expect(answer.publicMessage ?? '').toMatch(/DEDALO_HOST/);
			}, 30_000);
		}

		for (const clientIp of ['127.0.0.1', 'local']) {
			test(`(b) ${door}: a local origin still serves a same-machine caller (${clientIp})`, () => {
				const answer = drive(door, 'localhost', clientIp, VALID[door]);
				expect(JSON.stringify(answer)).not.toContain('DEDALO_HOST');
				expect(answer, 'the manifest is served').toEqual({ ok: true });
			}, 30_000);
		}

		test(`(c) ${door}: a WRONG code from a remote caller gets the authorization refusal — the origin refusal comes after auth`, () => {
			const answer = drive(door, 'localhost', REMOTE, 'not-the-code');
			expect(answer.code, JSON.stringify(answer)).toBe('update_server.refused');
			expect(answer.publicMessage).toBe('Error. Invalid code');
		}, 30_000);

		test(`(d) ${door}: a public origin serves a remote caller (no origin refusal)`, () => {
			const answer = drive(door, 'dedalo.test', REMOTE, VALID[door]);
			expect(JSON.stringify(answer)).not.toContain('DEDALO_HOST');
			expect(answer, 'the manifest is served').toEqual({ ok: true });
		}, 30_000);
	}
});

describe('publicOriginIsLocal — the predicate BOTH the refusal above and the boot warning read', () => {
	// localOriginRefusal is tested with an INJECTED boolean; this is the thing that
	// produces it. Behaviour, not a source grep: an earlier text-window assertion of
	// this predicate matched the COMMENT above the code and stayed green with the
	// loopback branch deleted.
	const withHost = async (host: string): Promise<boolean> => {
		const { publicOriginIsLocal } = await import('../../src/core/resolve/public_origin.ts');
		const previous = process.env.DEDALO_HOST;
		process.env.DEDALO_HOST = host;
		try {
			return publicOriginIsLocal();
		} finally {
			if (previous === undefined) delete process.env.DEDALO_HOST;
			else process.env.DEDALO_HOST = previous;
		}
	};

	test('unset is local — the documented `localhost` fallback', async () => {
		expect(await withHost('')).toBe(true);
	});

	test.each(['localhost', 'LocalHost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', 'localhost:4001'])(
		'an EXPLICIT loopback name (%p) is local too — it advertises the same useless urls',
		async (host) => {
			expect(await withHost(host)).toBe(true);
		},
	);

	test.each(['v7.master.dedalo.dev', 'dedalo.example.org', 'localhost.dedalo.dev', '10.0.0.5'])(
		'a real name (%p) is NOT local — or every server would be refused or warned forever',
		async (host) => {
			expect(await withHost(host)).toBe(false);
		},
	);

	test('a server with no usable public name says so at boot (role-gated, warned not dropped)', () => {
		const server = readFileSync(join(import.meta.dir, '../../src/server.ts'), 'utf8');
		expect(server).toMatch(/isOntologyServer\s*\|\|\s*config\.update\.isCodeServer/);
		expect(server).toMatch(/publicOriginIsLocal\(\)\s*\)\s*\{[\s\S]{0,600}?console\.warn\(/);
	});
});

/**
 * GATE 14, THE DOOR (RELEASE_IDENTITY_DESIGN §2.8 item 2). The code door reads
 * the consumer's `channel` token and `release` identity and this master's
 * DEDALO_CODE_SERVER_PRERELEASE_CHANNEL switch — driven in a CHILD configured
 * as a code master over a real archive tree (config is frozen at load), so the
 * outcome is what a consumer receives, not a source spelling.
 */
describe('get_code_update_info: the prerelease channel, through the door', () => {
	const HANDLER = join(import.meta.dir, '../../src/core/api/handlers/dd_utils_api.ts');
	const CODE = 'zzcode';
	const FILES = scratchDir('prerelease_door');

	interface Manifest {
		files?: { version: string; release?: string; channel?: string }[];
		channels?: string[];
		error?: string;
	}

	function ask(options: Record<string, unknown>, prereleaseSwitch: boolean): Manifest {
		const script = `
			const { utilsApiActions } = await import(${JSON.stringify(HANDLER)});
			const context = { requestId: 'probe', clientIp: '203.0.113.9', session: null, sessionToken: null, csrfCandidate: null };
			const rqo = { dd_api: 'dd_utils_api', action: 'get_code_update_info', options: ${JSON.stringify({ version: '7.0.0', code: CODE, ...options })} };
			try {
				const answer = await utilsApiActions.get_code_update_info(rqo, context);
				const data = answer.body.data;
				console.log(JSON.stringify({ files: data.files, channels: data.info.channels }));
			} catch (error) {
				console.log(JSON.stringify({ error: String(error?.publicMessage ?? error?.message ?? error) }));
			}
			process.exit(0);`;
		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			IS_A_CODE_SERVER: 'true',
			CODE_SERVERS: JSON.stringify([{ name: 'p', url: 'https://p.test', code: CODE }]),
			DEDALO_HOST: 'dedalo.test',
			DEDALO_CODE_FILES_DIR: FILES,
			DEDALO_CODE_SERVER_DEV_CHANNEL: 'false',
			DEDALO_CODE_SERVER_PRERELEASE_CHANNEL: prereleaseSwitch ? 'true' : 'false',
		};
		const run = Bun.spawnSync(['bun', '-e', script], { env, cwd: join(import.meta.dir, '../..') });
		const out = run.stdout.toString().trim().split('\n').at(-1) ?? '';
		if (run.exitCode !== 0 || !out.startsWith('{')) {
			throw new Error(
				`probe child failed (${run.exitCode}): ${run.stderr.toString().slice(-2000)}`,
			);
		}
		return JSON.parse(out) as Manifest;
	}
	const offered = (answer: Manifest) => (answer.files ?? []).map((f) => f.release ?? f.version);

	beforeAll(() => {
		mkdirSync(join(FILES, '7', '7.0'), { recursive: true });
		for (const name of ['7.0.0-beta.6.zip', '7.0.0-beta.7.zip', '7.0.0.zip']) {
			writeFileSync(join(FILES, '7', '7.0', name), `PK-${name}`);
			writeFileSync(join(FILES, '7', '7.0', `${name}.sha256`), `${'a'.repeat(64)}  ${name}\n`);
		}
	});
	afterAll(() => {
		rmSync(FILES, { recursive: true, force: true });
	});

	test('an opted-in master offers a prerelease asker what sits above its identity, and says so', () => {
		const answer = ask({ channel: 'prerelease', release: '7.0.0-beta.6' }, true);
		expect(answer.error).toBeUndefined();
		expect(offered(answer)).toEqual(['7.0.0-beta.7', '7.0.0']);
		expect(answer.channels).toEqual(['master', 'prerelease']);
	}, 30_000);

	test('a RELEASE asker on the same master never sees the prerelease', () => {
		const answer = ask({ channel: 'master', release: '7.0.0-beta.6' }, true);
		expect(offered(answer)).toEqual(['7.0.0']);
		expect(answer.channels).toEqual(['master']);
	}, 30_000);

	test('an unknown channel token is the release channel — never a refusal, never wider', () => {
		for (const channel of ['PRERELEASE', 'beta', 7, null]) {
			const answer = ask({ channel, release: '7.0.0-beta.6' }, true);
			expect(answer.error).toBeUndefined();
			expect(offered(answer)).toEqual(['7.0.0']);
			expect(answer.channels).toEqual(['master']);
		}
	}, 60_000);

	test('a master WITHOUT the switch answers a prerelease ask as a release ask (no enumeration)', () => {
		const answer = ask({ channel: 'prerelease', release: '7.0.0-beta.6' }, false);
		expect(answer.error).toBeUndefined();
		expect(offered(answer)).toEqual(['7.0.0']);
		expect(answer.channels).toEqual(['master']);
	}, 30_000);
});
