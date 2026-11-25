/**
 * PUBLICATION-HOST REGISTRY — src/core/publication_host/registry.ts (phase 3, E1/E2).
 *
 * Pins: absent = empty; any other unreadable/invalid file THROWS with a named reason
 * (never empty, never partial — Review Focus 2); the strict shape, field by field;
 * atomic 0600 writes that leave no temp file; a throwing or invalid update writes
 * nothing; the flock is exclusive across processes AND within one (no re-entry), and the
 * kernel frees it when the holder dies (nothing to reclaim, nothing deleted); the test
 * seam accepts only a declared temp dir.
 *
 * Every case runs on a declared scratch base (test/helpers/publication_host_fixtures.ts),
 * never on the live <private>.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import {
	getHost,
	loadRegistry,
	overridePublicationHostsBaseForTests,
	PUBLICATION_HOSTS_TEST_MARKER,
	type PublicationHostRecord,
	REGISTRY_MAX_BYTES,
	RegistryError,
	type RegistryErrorReason,
	type RegistryFile,
	registryPath,
	saveRegistry,
	updateRegistry,
	validateRegistry,
} from '../../src/core/publication_host/registry.ts';
import { useScratchPublicationHostsBase } from '../helpers/publication_host_fixtures.ts';

const REGISTRY_MODULE = join(import.meta.dir, '../../src/core/publication_host/registry.ts');

function host(overrides: Partial<PublicationHostRecord> = {}): PublicationHostRecord {
	return {
		name: 'pub_main',
		instance: 'museum',
		fingerprint: 'a'.repeat(64),
		address: { kind: 'tls', host: 'pub.museum.example', port: 8443 },
		public_url: 'https://www.museum.example',
		qualities: ['1.5MB', 'web'],
		probe: { published: null, unpublished: null },
		paired_at: '2026-10-03T10:00:00.000Z',
		...overrides,
	};
}

function file(...hosts: PublicationHostRecord[]): RegistryFile {
	return { version: 1, hosts };
}

function reasonOf(fn: () => unknown): RegistryErrorReason | 'no throw' | 'not a RegistryError' {
	try {
		fn();
		return 'no throw';
	} catch (error) {
		return error instanceof RegistryError ? error.reason : 'not a RegistryError';
	}
}

let scratch: { base: string; dispose: () => void };
beforeEach(() => {
	scratch = useScratchPublicationHostsBase();
});
afterEach(() => {
	scratch.dispose();
});

describe('read', () => {
	test('an absent file is the empty registry', () => {
		expect(existsSync(registryPath())).toBe(false);
		expect(loadRegistry()).toEqual({ version: 1, hosts: [] });
		expect(getHost('pub_main')).toBeNull();
	});

	test('the registry path is <base>/publication_hosts.json', () => {
		expect(registryPath()).toBe(join(scratch.base, 'publication_hosts.json'));
	});

	test.each([
		['not json', 'invalid_json'],
		['', 'invalid_json'],
		['{"version":1,"hosts":[', 'invalid_json'],
		['[]', 'invalid_shape'],
		['null', 'invalid_shape'],
	] as const)('file text %p → %s (never an empty list)', (text, reason) => {
		writeFileSync(registryPath(), text, { mode: 0o600 });
		expect(reasonOf(() => loadRegistry())).toBe(reason);
		expect(reasonOf(() => getHost('pub_main'))).toBe(reason);
	});

	test('the read is BOUNDED: over REGISTRY_MAX_BYTES is unreadable, at the cap it loads', () => {
		// a sync read on the request path must not scale with a hand-edited file
		// (sync_io_on_request_path_tripwire): padding a valid file past the cap refuses it
		const body = JSON.stringify(file(host()));
		writeFileSync(registryPath(), body.padEnd(REGISTRY_MAX_BYTES, ' '), { mode: 0o600 });
		expect(loadRegistry()).toEqual(file(host()));
		writeFileSync(registryPath(), body.padEnd(REGISTRY_MAX_BYTES + 1, ' '), { mode: 0o600 });
		expect(reasonOf(() => loadRegistry())).toBe('unreadable');
	});

	test('a registry path that cannot be read is unreadable, not empty', () => {
		mkdirSync(registryPath());
		expect(reasonOf(() => loadRegistry())).toBe('unreadable');
	});

	// The registry is the trust anchor for WHERE the engine dials (a unix host's socket):
	// a file another local user can write, or a link to one, is refused, never read.
	test('a registry that is not 0600 is unreadable, never loaded', () => {
		writeFileSync(registryPath(), JSON.stringify(file(host())), { mode: 0o600 });
		chmodSync(registryPath(), 0o644);
		expect(reasonOf(() => loadRegistry())).toBe('unreadable');
		chmodSync(registryPath(), 0o660);
		expect(reasonOf(() => loadRegistry())).toBe('unreadable');
		chmodSync(registryPath(), 0o600);
		expect(loadRegistry()).toEqual(file(host()));
	});

	test('a valid 0600 registry owned by another uid is unreadable (the owner check, not the mode)', () => {
		// no second uid needed: the engine's euid is stubbed, so the test-owned file reads as foreign
		writeFileSync(registryPath(), JSON.stringify(file(host())), { mode: 0o600 });
		chmodSync(registryPath(), 0o600);
		expect(loadRegistry()).toEqual(file(host())); // control: same file, own euid, loads
		const real = process.geteuid;
		process.geteuid = () => 4_242_424;
		let caught: unknown = null;
		try {
			loadRegistry();
		} catch (error) {
			caught = error;
		} finally {
			process.geteuid = real;
		}
		expect(caught instanceof RegistryError && caught.reason).toBe('unreadable');
		expect((caught as Error).message).toContain('must be owned by the engine user');
	});

	test('a symlinked registry is unreadable even when its target is a valid 0600 file', () => {
		const target = join(scratch.base, 'elsewhere.json');
		writeFileSync(target, JSON.stringify(file(host())), { mode: 0o600 });
		symlinkSync(target, registryPath());
		expect(reasonOf(() => loadRegistry())).toBe('unreadable');
		expect(reasonOf(() => getHost('pub_main'))).toBe('unreadable');
	});

	test('a FIFO at the registry path is unreadable and never blocks the read', () => {
		const made = Bun.spawnSync(['mkfifo', '-m', '600', registryPath()]);
		expect(made.exitCode).toBe(0);
		expect(reasonOf(() => loadRegistry())).toBe('unreadable');
	});

	test('a symlinked lock file is refused as unreadable and the write writes nothing', () => {
		const target = join(scratch.base, 'lock_target');
		writeFileSync(target, '', { mode: 0o600 });
		symlinkSync(target, `${registryPath()}.lock`);
		expect(reasonOf(() => saveRegistry(file(host())))).toBe('unreadable');
		expect(existsSync(registryPath())).toBe(false);
	});

	test('one invalid host invalidates the WHOLE file (never a partial list)', () => {
		const good = host();
		const bad = { ...host({ name: 'pub_two' }), fingerprint: 'XYZ' };
		writeFileSync(registryPath(), JSON.stringify(file(good, bad as PublicationHostRecord)), {
			mode: 0o600,
		});
		expect(reasonOf(() => loadRegistry())).toBe('invalid_shape');
		expect(reasonOf(() => getHost('pub_main'))).toBe('invalid_shape');
	});

	test('a repeated name is duplicate_name', () => {
		writeFileSync(registryPath(), JSON.stringify(file(host(), host())), { mode: 0o600 });
		expect(reasonOf(() => loadRegistry())).toBe('duplicate_name');
	});

	test('the error message names the field, never the file contents', () => {
		writeFileSync(
			registryPath(),
			JSON.stringify(file(host({ instance: 'SECRET-LOOKING-VALUE' }))),
			{
				mode: 0o600,
			},
		);
		try {
			loadRegistry();
			throw new Error('expected a RegistryError');
		} catch (error) {
			expect(error).toBeInstanceOf(RegistryError);
			expect((error as Error).message).toContain('hosts[0].instance');
			expect((error as Error).message).not.toContain('SECRET-LOOKING-VALUE');
		}
	});
});

describe('the strict shape', () => {
	const mutate = (fn: (h: Record<string, unknown>) => void): unknown => {
		const h = structuredClone(host()) as unknown as Record<string, unknown>;
		fn(h);
		return { version: 1, hosts: [h] };
	};

	test.each([
		[
			'an unknown host key',
			mutate((h) => {
				h.extra = 1;
			}),
		],
		[
			'a missing host key',
			mutate((h) => {
				Reflect.deleteProperty(h, 'paired_at');
			}),
		],
		[
			'an upper-case name',
			mutate((h) => {
				h.name = 'Pub';
			}),
		],
		[
			'a one-letter name',
			mutate((h) => {
				h.name = 'p';
			}),
		],
		[
			'a name with a slash',
			mutate((h) => {
				h.name = 'pub/../x';
			}),
		],
		[
			'a reserved staging name',
			mutate((h) => {
				h.name = 'pairing_0a1b2c3d';
			}),
		],
		[
			'a bad instance',
			mutate((h) => {
				h.instance = '9museum';
			}),
		],
		[
			'an upper-case fingerprint',
			mutate((h) => {
				h.fingerprint = 'A'.repeat(64);
			}),
		],
		[
			'a short fingerprint',
			mutate((h) => {
				h.fingerprint = 'a'.repeat(63);
			}),
		],
		[
			'an http address kind',
			mutate((h) => {
				h.address = { kind: 'http', host: 'x.example', port: 80 };
			}),
		],
		[
			'a tls host with a path',
			mutate((h) => {
				h.address = { kind: 'tls', host: 'x.example/a', port: 443 };
			}),
		],
		[
			'a tls host with a port',
			mutate((h) => {
				h.address = { kind: 'tls', host: 'x.example:443', port: 443 };
			}),
		],
		[
			'port 0',
			mutate((h) => {
				h.address = { kind: 'tls', host: 'x.example', port: 0 };
			}),
		],
		[
			'port 65536',
			mutate((h) => {
				h.address = { kind: 'tls', host: 'x.example', port: 65536 };
			}),
		],
		[
			'a string port',
			mutate((h) => {
				h.address = { kind: 'tls', host: 'x.example', port: '443' };
			}),
		],
		[
			'a tls address with a socket key',
			mutate((h) => {
				h.address = { kind: 'tls', host: 'x.example', port: 443, socket: '/a' };
			}),
		],
		[
			'a relative socket',
			mutate((h) => {
				h.address = { kind: 'unix', socket: 'run/agent.sock' };
			}),
		],
		[
			'a socket with ..',
			mutate((h) => {
				h.address = { kind: 'unix', socket: '/run/../etc/agent.sock' };
			}),
		],
		[
			'a socket with //',
			mutate((h) => {
				h.address = { kind: 'unix', socket: '/run//agent.sock' };
			}),
		],
		[
			'a socket longer than 103 bytes',
			mutate((h) => {
				h.address = { kind: 'unix', socket: `/${'s'.repeat(103)}` };
			}),
		],
		[
			'a public_url of another scheme',
			mutate((h) => {
				h.public_url = 'ftp://www.museum.example';
			}),
		],
		[
			'an http public_url with a path',
			mutate((h) => {
				h.public_url = 'http://www.museum.example/site';
			}),
		],
		[
			'a public_url with a path',
			mutate((h) => {
				h.public_url = 'https://www.museum.example/site';
			}),
		],
		[
			'a public_url with a trailing slash',
			mutate((h) => {
				h.public_url = 'https://www.museum.example/';
			}),
		],
		[
			'a public_url with credentials',
			mutate((h) => {
				h.public_url = 'https://u:p@www.museum.example';
			}),
		],
		[
			'an empty quality list',
			mutate((h) => {
				h.qualities = [];
			}),
		],
		[
			'a quality climbing out (..)',
			mutate((h) => {
				h.qualities = ['../original'];
			}),
		],
		[
			'a quality with an empty segment',
			mutate((h) => {
				h.qualities = ['image//thumb'];
			}),
		],
		[
			'a quality segment starting with a dot',
			mutate((h) => {
				h.qualities = ['image/.thumb'];
			}),
		],
		[
			'an absolute quality',
			mutate((h) => {
				h.qualities = ['/image/thumb'];
			}),
		],
		[
			'a quality with an embedded ..',
			mutate((h) => {
				h.qualities = ['image/a..b'];
			}),
		],
		[
			'a repeated quality',
			mutate((h) => {
				h.qualities = ['web', 'web'];
			}),
		],
		[
			'an absolute probe path',
			mutate((h) => {
				h.probe = { published: '/etc/passwd', unpublished: null };
			}),
		],
		[
			'a probe path with ..',
			mutate((h) => {
				h.probe = { published: 'image/../../x.jpg', unpublished: null };
			}),
		],
		[
			'a probe with an extra key',
			mutate((h) => {
				h.probe = { published: null, unpublished: null, x: null };
			}),
		],
		[
			'a non-ISO paired_at',
			mutate((h) => {
				h.paired_at = '2026-10-03 10:00';
			}),
		],
		['version 2', { version: 2, hosts: [] }],
		['hosts not an array', { version: 1, hosts: {} }],
		['an extra top-level key', { version: 1, hosts: [], note: 'x' }],
	])('%s is invalid_shape', (_label, value) => {
		expect(reasonOf(() => validateRegistry(value))).toBe('invalid_shape');
	});

	// §7: https is proposed, http is NOT refused (an http-only intranet); the probe
	// follows one http → https upgrade and says so.
	test.each([
		['an https origin', 'https://www.museum.example'],
		['an https origin with a port', 'https://www.museum.example:8443'],
		['an http origin', 'http://www.museum.example'],
		['an http origin with a port', 'http://intranet.museum.example:8080'],
	] as const)('public_url: %s is accepted', (_label, url) => {
		expect(validateRegistry(file(host({ public_url: url }))).hosts[0]?.public_url).toBe(url);
	});

	test.each([
		['an IPv4 tls host', { kind: 'tls', host: '10.0.0.5', port: 8443 }],
		['an IPv6 tls host', { kind: 'tls', host: 'fd00::5', port: 8443 }],
		['a unix socket', { kind: 'unix', socket: '/run/dedalo_publication_host/test/agent.sock' }],
	] as const)('%s is accepted', (_label, address) => {
		const valid = validateRegistry(file(host({ address: { ...address } })));
		expect(valid.hosts[0]?.address).toEqual({ ...address });
	});

	test('null public_url, null qualities and set probe paths are accepted', () => {
		const record = host({
			public_url: null,
			qualities: null,
			probe: {
				published: 'image/1.5MB/0/a_test3_1.jpg',
				unpublished: 'image/1.5MB/0/a_test3_2.jpg',
			},
		});
		expect(validateRegistry(file(record)).hosts[0]).toEqual(record);
	});

	test('a real public quality list (the engine grammar, /-separated) is accepted', () => {
		// what filterPublicQualities emits: the widget's set_host_fields stores exactly this
		const record = host({ qualities: ['image/1.5MB', 'av/404', 'pdf/web'] });
		expect(validateRegistry(file(record)).hosts[0]).toEqual(record);
	});
});

describe('write', () => {
	test('save → load round-trips; the file is 0600 and no temp file is left', () => {
		saveRegistry(file(host()));
		expect(loadRegistry()).toEqual(file(host()));
		expect(statSync(registryPath()).mode & 0o777).toBe(0o600);
		expect(readFileSync(registryPath(), 'utf8').endsWith('}\n')).toBe(true);
		// floor: the listing saw the saved registry, so an empty temp filter is a real verdict
		const listing = readdirSync(scratch.base);
		expect(listing.length).toBeGreaterThanOrEqual(1);
		expect(listing).toContain(basename(registryPath()));
		expect(listing.filter((name) => name.includes('.tmp-'))).toEqual([]);
	});

	test('saving an invalid registry throws and writes nothing', () => {
		expect(reasonOf(() => saveRegistry(file(host({ name: 'BAD' }))))).toBe('invalid_shape');
		expect(existsSync(registryPath())).toBe(false);
	});

	test('updateRegistry adds, replaces and returns the validated file', () => {
		const added = updateRegistry((current) => ({ ...current, hosts: [...current.hosts, host()] }));
		expect(added).toEqual(file(host()));
		const moved = host({
			address: { kind: 'unix', socket: '/run/dedalo_publication_host/test/agent.sock' },
		});
		const replaced = updateRegistry((current) => ({
			...current,
			hosts: current.hosts.map((h) => (h.name === 'pub_main' ? moved : h)),
		}));
		expect(replaced).toEqual(file(moved));
		expect(getHost('pub_main')).toEqual(moved);
	});

	test('the WRITE is bounded like the read: an oversize registry is refused and the file stays readable', () => {
		saveRegistry(file(host()));
		const before = readFileSync(registryPath(), 'utf8');
		// Each entry passes the per-item grammar; together they exceed what any read accepts.
		const qualities = Array.from({ length: 9000 }, (_, i) => `image/${'q'.repeat(100)}${i}`);
		expect(
			reasonOf(() => updateRegistry((current) => ({ ...current, hosts: [host({ qualities })] }))),
		).toBe('invalid_shape');
		expect(readFileSync(registryPath(), 'utf8')).toBe(before);
		expect(loadRegistry()).toEqual(file(host()));
		expect(readdirSync(scratch.base).filter((name) => name.includes('.tmp-'))).toEqual([]);
	});

	test('a throwing update writes nothing', () => {
		saveRegistry(file(host()));
		const before = readFileSync(registryPath(), 'utf8');
		expect(() =>
			updateRegistry(() => {
				throw new Error('operator cancelled');
			}),
		).toThrow('operator cancelled');
		expect(readFileSync(registryPath(), 'utf8')).toBe(before);
	});

	test('an update returning a duplicate writes nothing', () => {
		saveRegistry(file(host()));
		const before = readFileSync(registryPath(), 'utf8');
		expect(
			reasonOf(() => updateRegistry((current) => ({ ...current, hosts: [host(), host()] }))),
		).toBe('duplicate_name');
		expect(readFileSync(registryPath(), 'utf8')).toBe(before);
	});

	test('a corrupt file is never overwritten by an update (it throws first)', () => {
		writeFileSync(registryPath(), '{"version":1,"hosts":[{"name":', { mode: 0o600 });
		expect(reasonOf(() => updateRegistry((current) => ({ ...current, hosts: [host()] })))).toBe(
			'invalid_json',
		);
		expect(readFileSync(registryPath(), 'utf8')).toBe('{"version":1,"hosts":[{"name":');
	});
});

describe('the lock', () => {
	test('a nested write in the same process is refused as locked and writes nothing', () => {
		saveRegistry(file(host()));
		const before = readFileSync(registryPath(), 'utf8');
		const nested = reasonOf(() =>
			updateRegistry((current) => {
				saveRegistry(file());
				return current;
			}),
		);
		expect(nested).toBe('locked');
		expect(readFileSync(registryPath(), 'utf8')).toBe(before);
	});

	test('another process holding it → locked; its death frees it with nothing deleted', async () => {
		saveRegistry(file(host()));
		const child = Bun.spawn(
			[
				process.execPath,
				'-e',
				`import { writeSync } from 'node:fs';
				 import { overridePublicationHostsBaseForTests, updateRegistry } from ${JSON.stringify(REGISTRY_MODULE)};
				 overridePublicationHostsBaseForTests(${JSON.stringify(scratch.base)});
				 updateRegistry((current) => { writeSync(1, 'held\\n'); Bun.sleepSync(30000); return current; });`,
			],
			{ stdout: 'pipe', stderr: 'pipe' },
		);
		try {
			const first = await child.stdout.getReader().read();
			expect(new TextDecoder().decode(first.value)).toBe('held\n');

			expect(reasonOf(() => saveRegistry(file()))).toBe('locked');
			expect(loadRegistry()).toEqual(file(host())); // reads never wait on the lock
		} finally {
			child.kill('SIGKILL');
			await child.exited;
		}
		expect(existsSync(`${registryPath()}.lock`)).toBe(true); // never deleted: the kernel released it
		saveRegistry(file());
		expect(loadRegistry()).toEqual(file());
	});
});

describe('the test seam', () => {
	test('refuses a non-temp path', () => {
		expect(() => overridePublicationHostsBaseForTests('/var/lib/dedalo/private')).toThrow(
			RangeError,
		);
	});

	test('refuses a DECLARED dir outside os.tmpdir() (the marker alone is not enough)', () => {
		// gitignored repo-root scratch (`.scratch_*/`): carries the marker, lives outside tmpdir —
		// the only thing that can refuse it is the under-tmpdir leg.
		const outside = resolve(
			import.meta.dir,
			'..',
			'..',
			`.scratch_pubhosts_outside_${process.pid}`,
		);
		expect(outside.startsWith(resolve(tmpdir()) + sep)).toBe(false); // precondition: really outside
		mkdirSync(outside, { recursive: true });
		try {
			writeFileSync(join(outside, PUBLICATION_HOSTS_TEST_MARKER), '');
			expect(() => overridePublicationHostsBaseForTests(outside)).toThrow(RangeError);
			expect(registryPath()).toBe(join(scratch.base, 'publication_hosts.json')); // unchanged
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test('refuses a temp dir that does not declare itself', () => {
		const undeclared = mkdtempSync(join(tmpdir(), 'dedalo_pubhosts_undeclared_'));
		try {
			expect(() => overridePublicationHostsBaseForTests(undeclared)).toThrow(RangeError);
			expect(registryPath()).toBe(join(scratch.base, 'publication_hosts.json')); // unchanged
		} finally {
			rmSync(undeclared, { recursive: true, force: true });
		}
	});
});
