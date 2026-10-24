/**
 * tls_local_ca_native — THE LOCAL CERTIFICATE AUTHORITY, MEASURED WITH A REAL
 * OPENSSL (owner decision 2026-10-16: local_ca on the production route too).
 *
 * `deploy/dedalo-tls-rotate.sh` is the ONE generator of local-CA material for
 * both install routes. What this gate holds, every leg by RUNNING the script
 * and judging the certificates with `openssl verify` — never by reading its
 * text:
 *
 *  A. THE AUTHORITY CAN ONLY CERTIFY THIS INSTALL'S NAMES. The authority
 *     workstations trust and the issuing authority whose key stays on the
 *     server both carry a critical nameConstraints extension listing exactly
 *     the requested names + localhost/127.0.0.1. The leaked-key scenario is
 *     played for real: the gate signs rogue leaves WITH THE SERVER'S ISSUING
 *     KEY and `openssl verify` must REFUSE every one outside the list (another
 *     domain, a look-alike suffix, another IPv4, an IPv6 address — a type left
 *     out of the constraint would be unconstrained) while accepting the
 *     install's own names. The ROOT key does not survive the issue: no private
 *     key in the directory but the issuing CA's and the site's.
 *  B. THE LEAF lives at most 397 days, names every requested address, keys
 *     0600, certificates 0644, no staging residue.
 *  C. RENEWAL keeps the authority: a renewal far from expiry is a byte-exact
 *     no-op; inside its window it re-issues the leaf from the SAME authority
 *     (root and issuing CA byte-identical, same root fingerprint) with a new
 *     serial and key; a name outside the authority's list is REFUSED with the
 *     working certificate untouched; a pre-2026-10-16 single-tier authority
 *     still renews; no authority → refusal, nothing created; a staging
 *     directory a KILLED run left behind (a root key in it) is swept by the
 *     next run, a minutes-young one (a concurrent run) is left alone.
 *  D. NATIVE RELOAD reloads the HOST web server through systemctl (stubbed on
 *     PATH, so the gate sees the argv) and never docker; a running server that
 *     refuses the reload is exit 3 — on the docker route too — and the
 *     obligation is REMEMBERED: the next run, though it has nothing to renew,
 *     retries the reload and stays exit 3 until it works; arguments that would
 *     half-work are refused before anything changes.
 *
 * Run against every distinct openssl on the machine (on macOS that is
 * Homebrew's OpenSSL AND the system LibreSSL, which docker hosts use — the
 * LibreSSL `-subj` trap was found exactly this way).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { scratchDir } from '../helpers/scratch_dir.ts';

const ROOT = resolve(import.meta.dir, '../..');
const SCRIPT = join(ROOT, 'deploy/dedalo-tls-rotate.sh');
const SCRATCH = scratchDir('tls_local_ca');
mkdirSync(SCRATCH, { recursive: true });
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** Every distinct openssl binary here (PATH's first, then the system one). */
function opensslCandidates(): string[] {
	const found: string[] = [];
	const versions = new Set<string>();
	for (const candidate of [Bun.which('openssl'), '/usr/bin/openssl']) {
		if (candidate === null || !existsSync(candidate)) continue;
		const version = Bun.spawnSync([candidate, 'version'], { stdout: 'pipe' })
			.stdout.toString()
			.trim();
		if (versions.has(version)) continue;
		versions.add(version);
		found.push(candidate);
	}
	return found;
}
const OPENSSLS = opensslCandidates();

/** The stubs: systemctl (state via marker files) and docker, both logging their argv. */
const STUBS = join(SCRATCH, 'stubs');
const STUB_LOG = join(STUBS, 'calls.log');
mkdirSync(STUBS, { recursive: true });
writeFileSync(
	join(STUBS, 'systemctl'),
	`#!/bin/sh\necho "systemctl $*" >> '${STUB_LOG}'\ncase "$1" in\n\tis-active) [ -f '${STUBS}/active' ] ;;\n\treload) [ ! -f '${STUBS}/reload-fails' ] ;;\n\t*) exit 0 ;;\nesac\n`,
);
writeFileSync(
	join(STUBS, 'docker'),
	`#!/bin/sh\necho "docker $*" >> '${STUB_LOG}'\n[ ! -f '${STUBS}/docker-fails' ]\n`,
);
chmodSync(join(STUBS, 'systemctl'), 0o755);
chmodSync(join(STUBS, 'docker'), 0o755);

type Run = { code: number | null; out: string; err: string };

function lane(openssl: string) {
	const env = { ...process.env, PATH: `${dirname(openssl)}:/usr/bin:/bin` };
	const stubEnv = { ...process.env, PATH: `${STUBS}:${dirname(openssl)}:/usr/bin:/bin` };
	const rotate = (args: string[], withStubs = false): Run => {
		const proc = Bun.spawnSync(['bash', SCRIPT, ...args], {
			stdout: 'pipe',
			stderr: 'pipe',
			env: withStubs ? stubEnv : env,
		});
		return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
	};
	const ssl = (args: string[]): Run => {
		const proc = Bun.spawnSync([openssl, ...args], { stdout: 'pipe', stderr: 'pipe', env });
		return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
	};
	return { rotate, ssl };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `notAfter=Nov 17 08:05:31 2027 GMT` → epoch ms (parsed by hand: the format is not ISO). */
function certDate(line: string): number {
	const match = /(\w{3})\s+(\d+) (\d\d):(\d\d):(\d\d) (\d{4}) GMT/.exec(line);
	if (match === null) throw new Error(`unparsable certificate date: ${line}`);
	const [, mon, day, hh, mm, ss, year] = match as unknown as string[];
	return Date.UTC(
		Number(year),
		MONTHS.indexOf(mon as string),
		Number(day),
		Number(hh),
		Number(mm),
		Number(ss),
	);
}

/** Every file below `dir` (relative paths), staging dirs included. */
function walk(dir: string, prefix = ''): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? [`${prefix}${entry.name}/`, ...walk(join(dir, entry.name), `${prefix}${entry.name}/`)]
			: [`${prefix}${entry.name}`],
	);
}

function octal(path: string): string {
	return (statSync(path).mode & 0o777).toString(8);
}

function snapshot(dir: string): Record<string, string> {
	return Object.fromEntries(
		walk(dir)
			.filter((name) => !name.endsWith('/'))
			.map((name) => [name, readFileSync(join(dir, name), 'utf-8')]),
	);
}

if (OPENSSLS.length === 0) {
	test('THE LOCAL-CA DRILL IS SKIPPED: openssl is not on PATH', () => {
		console.warn('[tls_local_ca_native] openssl not found — nothing was measured.');
		expect(OPENSSLS).toEqual([]);
	});
}

for (const openssl of OPENSSLS) {
	const { rotate, ssl } = lane(openssl);
	const version = ssl(['version']).out.trim();
	const dir = join(SCRATCH, `lane_${OPENSSLS.indexOf(openssl)}`);
	const root = join(dir, 'dedalo-local-ca.pem');
	const issuing = join(dir, 'dedalo-issuing-ca.pem');
	const issuingKey = join(dir, 'dedalo-issuing-ca.key');
	const leaf = join(dir, 'fullchain.pem');

	const verify = (chain: string, ca = root, untrusted = issuing): number | null =>
		ssl(['verify', '-purpose', 'sslserver', '-CAfile', ca, '-untrusted', untrusted, chain]).code;

	/** A leaf for `san`, signed with the server's issuing key — the leaked-key scenario.
	 * No CN: with no DNS SAN, LibreSSL checks a CN against the DNS constraints
	 * too, so a CN would decide the IP-only cases instead of their SAN. */
	const rogue = (
		label: string,
		san: string,
		usage = 'extendedKeyUsage = serverAuth',
		subject = '/O=rogue',
	): string => {
		const work = join(SCRATCH, `rogue_${OPENSSLS.indexOf(openssl)}_${label}`);
		mkdirSync(work, { recursive: true });
		const cnf = join(work, 'x.cnf');
		writeFileSync(
			cnf,
			`[ req ]\ndistinguished_name = dn\n[ dn ]\n[ x ]\nbasicConstraints = CA:FALSE\n${usage}\nsubjectAltName = ${san}\n`,
		);
		expect(
			ssl([
				'req',
				'-new',
				'-newkey',
				'rsa:2048',
				'-nodes',
				'-keyout',
				join(work, 'k.pem'),
				'-out',
				join(work, 'r.csr'),
				'-subj',
				subject,
				'-config',
				cnf,
			]).code,
		).toBe(0);
		const signed = ssl([
			'x509',
			'-req',
			'-in',
			join(work, 'r.csr'),
			'-CA',
			issuing,
			'-CAkey',
			issuingKey,
			'-CAserial',
			join(work, 's.srl'),
			'-CAcreateserial',
			'-days',
			'30',
			'-extfile',
			cnf,
			'-extensions',
			'x',
			'-out',
			join(work, 'leaf.pem'),
		]);
		expect(signed.code).toBe(0);
		return join(work, 'leaf.pem');
	};

	const constraintsOf = (pem: string): string[] => {
		const text = ssl(['x509', '-in', pem, '-noout', '-text']).out;
		const start = text.indexOf('X509v3 Name Constraints: critical');
		if (start < 0) return [];
		const rest = text.slice(start).split('\n').slice(1);
		// Each entry tagged with its block: `Permitted:` / `Excluded:`.
		const out: string[] = [];
		let block = '';
		for (const line of rest) {
			const heading = /^\s*(Permitted|Excluded):\s*$/.exec(line);
			if (heading !== null) {
				block = (heading[1] as string).toLowerCase();
				continue;
			}
			const entry = /^\s+(DNS:\S+|IP:\S+)\s*$/.exec(line);
			if (entry === null) break;
			out.push(`${block} ${entry[1] as string}`);
		}
		return out;
	};

	describe(`local CA with ${version}`, () => {
		test('A+B. issue: a constrained two-tier authority, the root key gone, a ≤397-day leaf', () => {
			const run = rotate([
				'--mode',
				'local-ca',
				'--host',
				'Dedalo.test',
				'--host',
				'192.168.1.20',
				'--address',
				'lan.museo',
				'--host',
				'dedalo.test',
				'--dir',
				dir,
				'--no-reload',
				'--quiet',
			]);
			expect({ code: run.code, err: run.err }).toEqual({ code: 0, err: '' });

			// The files, and nothing else (no staging residue, no root key).
			expect(walk(dir).sort()).toEqual([
				'dedalo-issuing-ca.key',
				'dedalo-issuing-ca.pem',
				'dedalo-issuing-ca.srl',
				'dedalo-local-ca.names',
				'dedalo-local-ca.pem',
				'fullchain.pem',
				'privkey.pem',
			]);
			const privateKeys = walk(dir).filter((name) =>
				readFileSync(join(dir, name), 'utf-8').includes('PRIVATE KEY'),
			);
			expect(privateKeys.sort()).toEqual(['dedalo-issuing-ca.key', 'privkey.pem']);
			for (const name of ['dedalo-issuing-ca.key', 'privkey.pem', 'dedalo-issuing-ca.srl']) {
				expect({ name, mode: octal(join(dir, name)) }).toEqual({ name, mode: '600' });
			}
			for (const name of [
				'dedalo-local-ca.pem',
				'dedalo-issuing-ca.pem',
				'fullchain.pem',
				'dedalo-local-ca.names',
			]) {
				expect({ name, mode: octal(join(dir, name)) }).toEqual({ name, mode: '644' });
			}
			// Lower-cased, deduplicated, in the order given — what a renewal re-issues for.
			expect(readFileSync(join(dir, 'dedalo-local-ca.names'), 'utf-8')).toBe(
				'dedalo.test\n192.168.1.20\nlan.museo\n',
			);

			// BOTH authorities carry exactly the install's names (+ loopback),
			// each DNS name made exact by excluding everything below it.
			const expected = [
				'permitted DNS:dedalo.test',
				'permitted IP:192.168.1.20/255.255.255.255',
				'permitted DNS:lan.museo',
				'permitted DNS:localhost',
				'permitted IP:127.0.0.1/255.255.255.255',
				'excluded DNS:.dedalo.test',
				'excluded DNS:.lan.museo',
				'excluded DNS:.localhost',
			];
			expect(constraintsOf(root)).toEqual(expected);
			expect(constraintsOf(issuing)).toEqual(expected);
			expect(ssl(['x509', '-in', root, '-noout', '-subject']).out).toMatch(
				/Dedalo local CA \d{4}-\d{2}-\d{2}T\d{6}Z/,
			);

			// The leaf: verifies, names everything, ≤ 397 days.
			expect(verify(leaf)).toBe(0);
			const text = ssl(['x509', '-in', leaf, '-noout', '-text']).out;
			for (const san of [
				'DNS:dedalo.test',
				'IP Address:192.168.1.20',
				'DNS:lan.museo',
				'DNS:localhost',
				'IP Address:127.0.0.1',
			]) {
				expect({ san, present: text.includes(san) }).toEqual({ san, present: true });
			}
			const dates = ssl(['x509', '-in', leaf, '-noout', '-startdate', '-enddate']).out.split('\n');
			const days = (certDate(dates[1] as string) - certDate(dates[0] as string)) / 86_400_000;
			expect(days).toBeGreaterThan(390);
			expect(days).toBeLessThanOrEqual(397);
		});

		test('A. the issuing key REFUSES to certify any name outside the list (openssl verify)', () => {
			const refused: Record<string, number | null> = {};
			const accepted: Record<string, number | null> = {};
			for (const [label, san] of [
				['other_domain', 'DNS:evil.example'],
				['suffix_lookalike', 'DNS:dedalo.test.evil.example'],
				['other_ipv4', 'IP:10.0.0.1'],
				['ipv6', 'IP:2001:db8::1'],
				['own_plus_foreign', 'DNS:dedalo.test,IP:10.0.0.1'],
				// A DNS constraint alone permits the name AND its subdomains
				// (RFC 5280); the `excluded;DNS:.<name>` entries make it exact.
				['own_subdomain', 'DNS:x.dedalo.test'],
				['extra_subdomain', 'DNS:mail.lan.museo'],
				['loopback_subdomain', 'DNS:evil.localhost'],
			] as const) {
				refused[label] = verify(rogue(label, san));
			}
			for (const [label, san] of [
				['own_name', 'DNS:dedalo.test'],
				['own_extra_name', 'DNS:lan.museo'],
				['own_ip', 'IP:192.168.1.20'],
				['loopback', 'DNS:localhost,IP:127.0.0.1'],
			] as const) {
				accepted[label] = verify(rogue(label, san));
			}
			expect(Object.keys(refused).length).toBe(8);
			for (const [label, code] of Object.entries(refused)) {
				expect({ label, refused: code !== 0 }).toEqual({ label, refused: true });
			}
			for (const [label, code] of Object.entries(accepted)) {
				expect({ label, code }).toEqual({ label, code: 0 });
			}
		});

		test('A. the issuing key cannot certify signed MAIL or CODE either (EKU serverAuth on both authorities)', () => {
			// The name constraint lists DNS and IP only; e-mail and the subject DN are
			// other name types, open under RFC 5280 — the leaked-key S/MIME certificate
			// below names a foreign mailbox and a foreign publisher. The EKU on the
			// authorities is what refuses it.
			const mail = rogue(
				'smime',
				'email:ceo@bank.example.com',
				'keyUsage = critical,digitalSignature\nextendedKeyUsage = emailProtection,codeSigning',
				'/CN=Microsoft Corporation',
			);
			const smime = ssl([
				'verify',
				'-purpose',
				'smimesign',
				'-CAfile',
				root,
				'-untrusted',
				issuing,
				mail,
			]);
			expect({
				refused: smime.code !== 0,
				why: /purpose/.test(`${smime.out}${smime.err}`),
			}).toEqual({ refused: true, why: true });
			// OpenSSL's `codesign` purpose does not intersect a CA's EKU with the leaf's
			// (it checks the leaf only — measured with 3.6: OK even under a serverAuth-only
			// CA). The outcome that matters is Windows' — CryptoAPI restricts a chain to
			// the usages every CA certificate in it allows, so a serverAuth-only CA
			// leaves a codeSigning leaf untrusted — and it cannot be run here (NOT
			// measured: an open item for the VM drill). What this machine CAN measure is
			// the restriction itself: each authority's EKU is exactly serverAuth.
			for (const authority of [root, issuing]) {
				// `-text`, not `-ext`: LibreSSL (macOS's /usr/bin/openssl) has no -ext.
				const text = ssl(['x509', '-in', authority, '-noout', '-text']).out;
				const eku = /X509v3 Extended Key Usage:[^\n]*\n\s*([^\n]*)/.exec(text)?.[1]?.trim();
				expect({ authority, eku }).toEqual({
					authority,
					eku: 'TLS Web Server Authentication',
				});
			}
			// Positive control: the install's own certificate still verifies as a server.
			expect(verify(leaf)).toBe(0);
		});

		test('C. renewal far from expiry is a byte-exact no-op', () => {
			const before = snapshot(dir);
			const run = rotate(['--mode', 'renew', '--dir', dir, '--no-reload']);
			expect(run.code).toBe(0);
			expect(run.out).toContain('nothing to do');
			expect(snapshot(dir)).toEqual(before);
		});

		test('C. renewal inside its window keeps the authority and replaces the leaf', () => {
			const fingerprint = ssl(['x509', '-in', root, '-noout', '-fingerprint', '-sha256']).out;
			const rootBefore = readFileSync(root, 'utf-8');
			const issuingBefore = readFileSync(issuing, 'utf-8');
			const issuingKeyBefore = readFileSync(issuingKey, 'utf-8');
			const serialBefore = ssl(['x509', '-in', leaf, '-noout', '-serial']).out;
			const endBefore = certDate(ssl(['x509', '-in', leaf, '-noout', '-enddate']).out);
			const keyBefore = readFileSync(join(dir, 'privkey.pem'), 'utf-8');

			// A 400-day window: the fresh 397-day leaf IS inside it — the real
			// expiry path, not --force.
			const run = rotate(['--mode', 'renew', '--dir', dir, '--no-reload', '--renew-days', '400']);
			expect({ code: run.code, err: run.err }).toEqual({ code: 0, err: '' });

			expect(ssl(['x509', '-in', root, '-noout', '-fingerprint', '-sha256']).out).toBe(fingerprint);
			expect(readFileSync(root, 'utf-8')).toBe(rootBefore);
			expect(readFileSync(issuing, 'utf-8')).toBe(issuingBefore);
			expect(readFileSync(issuingKey, 'utf-8')).toBe(issuingKeyBefore);
			expect(ssl(['x509', '-in', leaf, '-noout', '-serial']).out).not.toBe(serialBefore);
			expect(certDate(ssl(['x509', '-in', leaf, '-noout', '-enddate']).out)).toBeGreaterThanOrEqual(
				endBefore,
			);
			expect(readFileSync(join(dir, 'privkey.pem'), 'utf-8')).not.toBe(keyBefore);
			expect(verify(leaf)).toBe(0);
			// From the recorded names, not from arguments.
			expect(ssl(['x509', '-in', leaf, '-noout', '-text']).out).toContain('DNS:lan.museo');
			expect(octal(join(dir, 'privkey.pem'))).toBe('600');
			expect(octal(issuingKey)).toBe('600');
			expect(walk(dir).filter((name) => name.startsWith('.'))).toEqual([]);
		});

		test('C. a renewal for a name outside the list is refused, the working certificate untouched', () => {
			const before = snapshot(dir);
			const run = rotate([
				'--mode',
				'renew',
				'--dir',
				dir,
				'--no-reload',
				'--force',
				'--host',
				'other.example',
			]);
			expect(run.code).toBe(1);
			expect(run.err).toContain('Nothing was replaced');
			expect(snapshot(dir)).toEqual(before);
		});

		test('C. a pre-2026-10-16 single-tier authority still renews from its own key', () => {
			const legacy = join(SCRATCH, `legacy_${OPENSSLS.indexOf(openssl)}`);
			mkdirSync(legacy, { recursive: true });
			const caPem = join(legacy, 'dedalo-local-ca.pem');
			// The old script's exact shape: an unconstrained self-signed root whose
			// key sits next to the leaf.
			expect(
				ssl([
					'req',
					'-x509',
					'-newkey',
					'rsa:2048',
					'-sha256',
					'-days',
					'3650',
					'-nodes',
					'-keyout',
					join(legacy, 'dedalo-local-ca.key'),
					'-out',
					caPem,
					'-subj',
					'/CN=Dedalo local CA legacy',
				]).code,
			).toBe(0);
			const ca = readFileSync(caPem, 'utf-8');
			const run = rotate([
				'--mode',
				'renew',
				'--dir',
				legacy,
				'--no-reload',
				'--host',
				'old.museo',
			]);
			expect({ code: run.code, err: run.err }).toEqual({ code: 0, err: '' });
			expect(readFileSync(caPem, 'utf-8')).toBe(ca);
			expect(
				ssl(['verify', '-purpose', 'sslserver', '-CAfile', caPem, join(legacy, 'fullchain.pem')])
					.code,
			).toBe(0);
			expect(octal(join(legacy, 'privkey.pem'))).toBe('600');
		});

		test('C. no authority: renewal refuses and creates nothing', () => {
			const missing = join(SCRATCH, `missing_${OPENSSLS.indexOf(openssl)}`);
			expect(rotate(['--mode', 'renew', '--dir', missing, '--no-reload']).code).toBe(1);
			expect(existsSync(missing)).toBe(false);
		});

		test('D. native reload goes to the host web server through systemctl, never docker', () => {
			writeFileSync(STUB_LOG, '');
			writeFileSync(join(STUBS, 'active'), '');
			const run = rotate(
				['--mode', 'renew', '--dir', dir, '--force', '--reload', 'systemd', '--unit', 'apache2'],
				true,
			);
			expect({ code: run.code, err: run.err }).toEqual({ code: 0, err: '' });
			expect(readFileSync(STUB_LOG, 'utf-8').trim().split('\n')).toEqual([
				'systemctl is-active --quiet apache2',
				'systemctl reload apache2',
			]);

			// A running server that refuses the reload: the certificate is in
			// place, the exit says it is not being served.
			writeFileSync(STUB_LOG, '');
			writeFileSync(join(STUBS, 'reload-fails'), '');
			const failed = rotate(
				['--mode', 'renew', '--dir', dir, '--force', '--reload', 'systemd', '--unit', 'nginx'],
				true,
			);
			expect(failed.code).toBe(3);
			expect(failed.err).toContain('systemctl reload nginx');
			rmSync(join(STUBS, 'reload-fails'));

			// Not running: nothing to reload, success.
			rmSync(join(STUBS, 'active'));
			writeFileSync(STUB_LOG, '');
			const idle = rotate(
				['--mode', 'renew', '--dir', dir, '--force', '--reload', 'systemd', '--unit', 'httpd'],
				true,
			);
			expect(idle.code).toBe(0);
			expect(readFileSync(STUB_LOG, 'utf-8').trim()).toBe('systemctl is-active --quiet httpd');
			expect(verify(leaf)).toBe(0);
		});

		test('D. a failed reload is remembered: every later run retries it and exits 3 until it works', () => {
			const pending = join(dir, '.dedalo-reload-pending');
			const systemd = ['--mode', 'renew', '--dir', dir, '--reload', 'systemd', '--unit', 'nginx'];
			writeFileSync(join(STUBS, 'active'), '');
			writeFileSync(join(STUBS, 'reload-fails'), '');
			writeFileSync(STUB_LOG, '');
			expect(rotate([...systemd, '--force'], true).code).toBe(3);
			expect(existsSync(pending)).toBe(true);

			// The next timer tick: the leaf on disk is fresh, nothing to re-issue —
			// but the web server never loaded it, so the run reloads and, failing
			// again, stays red.
			const leafBefore = readFileSync(leaf, 'utf-8');
			writeFileSync(STUB_LOG, '');
			const retry = rotate(systemd, true);
			expect(retry.code).toBe(3);
			expect(readFileSync(STUB_LOG, 'utf-8')).toContain('systemctl reload nginx');
			expect(readFileSync(leaf, 'utf-8')).toBe(leafBefore);

			// The reload works again: exit 0, the obligation is gone, and the run
			// after that is a plain no-op that calls nothing.
			rmSync(join(STUBS, 'reload-fails'));
			writeFileSync(STUB_LOG, '');
			expect(rotate(systemd, true).code).toBe(0);
			expect(readFileSync(STUB_LOG, 'utf-8')).toContain('systemctl reload nginx');
			expect(existsSync(pending)).toBe(false);
			writeFileSync(STUB_LOG, '');
			const quiet = rotate(systemd, true);
			expect({ code: quiet.code, nothing: quiet.out.includes('nothing to do') }).toEqual({
				code: 0,
				nothing: true,
			});
			expect(readFileSync(STUB_LOG, 'utf-8')).toBe('');
			rmSync(join(STUBS, 'active'));
			expect(readFileSync(leaf, 'utf-8')).toBe(leafBefore);
		});

		test('D. docker route: a failed nginx reload is exit 3 too (a cron renewal must not read as success)', () => {
			const pending = join(dir, '.dedalo-reload-pending');
			const docker = ['--mode', 'renew', '--dir', dir, '--reload', 'docker'];
			writeFileSync(join(STUBS, 'docker-fails'), '');
			writeFileSync(STUB_LOG, '');
			const failed = rotate([...docker, '--force'], true);
			expect(failed.code).toBe(3);
			expect(failed.err).toContain('nginx -s reload');
			expect(existsSync(pending)).toBe(true);
			expect(verify(leaf)).toBe(0);

			// Retried on the next (no-op) run; cleared once it works.
			expect(rotate(docker, true).code).toBe(3);
			rmSync(join(STUBS, 'docker-fails'));
			writeFileSync(STUB_LOG, '');
			expect(rotate(docker, true).code).toBe(0);
			expect(readFileSync(STUB_LOG, 'utf-8')).toContain('exec -T nginx nginx -s reload');
			expect(existsSync(pending)).toBe(false);
		});

		test('C. a staging directory left by a killed run (a root key in it) is swept by the next run', () => {
			const stale = join(dir, '.dedalo-tls.killed');
			const young = join(dir, '.dedalo-tls.live');
			mkdirSync(stale, { mode: 0o700 });
			writeFileSync(join(stale, 'root.key'), '-----BEGIN PRIVATE KEY-----\n', { mode: 0o600 });
			mkdirSync(young, { mode: 0o700 });
			// An hour old: a killed run, not a concurrent one.
			const hourAgo = new Date(Date.now() - 3_600_000);
			utimesSync(stale, hourAgo, hourAgo);
			const run = rotate(['--mode', 'renew', '--dir', dir, '--no-reload']);
			expect(run.code).toBe(0);
			expect(run.err).toContain('.dedalo-tls.killed');
			expect(existsSync(stale)).toBe(false);
			// A minutes-young one may be a concurrent run's live staging: left alone.
			expect(existsSync(young)).toBe(true);
			rmSync(young, { recursive: true });
			expect(walk(dir).filter((name) => name.startsWith('.'))).toEqual([]);
		});

		test('D. arguments that would half-work are refused before anything changes', () => {
			const before = snapshot(dir);
			writeFileSync(STUB_LOG, '');
			for (const args of [
				['--mode', 'renew', '--dir', dir, '--reload', 'systemd'],
				['--mode', 'renew', '--dir', dir, '--reload', 'systemd', '--unit', 'sshd'],
				['--mode', 'renew', '--reload', 'systemd', '--unit', 'nginx'],
				['--mode', 'renew', '--dir', dir, '--reload', 'kubectl'],
				['--mode', 'renew', '--dir', dir, '--unit', 'nginx'],
				['--mode', 'renew', '--dir', dir, '--renew-days', 'soon'],
				['--mode', 'local-ca', '--dir', dir, '--host', '2001:db8::1', '--no-reload'],
				['--mode', 'local-ca', '--dir', dir, '--host', '*.museo.org', '--no-reload'],
				['--mode', 'local-ca', '--dir', dir, '--host', '300.1.1.1', '--no-reload'],
				['--mode', 'local-ca', '--dir', dir, '--host', '-bad.example', '--no-reload'],
				['--mode', 'local-ca', '--dir', dir, '--no-reload'],
				// A name under another listed one: the exact-name authority
				// would refuse its leaf.
				[
					'--mode',
					'local-ca',
					'--dir',
					dir,
					'--host',
					'museo.test',
					'--host',
					'dedalo.museo.test',
					'--no-reload',
				],
				[
					'--mode',
					'local-ca',
					'--dir',
					dir,
					'--host',
					'dedalo.museo.test',
					'--host',
					'museo.test',
					'--no-reload',
				],
				['--mode', 'local-ca', '--dir', dir, '--host', 'app.localhost', '--no-reload'],
			]) {
				expect({ args, code: rotate(args, true).code }).toEqual({ args, code: 1 });
			}
			expect(snapshot(dir)).toEqual(before);
			expect(readFileSync(STUB_LOG, 'utf-8')).toBe('');
		});
	});
}
