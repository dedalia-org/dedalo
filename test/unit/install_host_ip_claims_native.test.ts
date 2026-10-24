/**
 * install_host_ip_claims_native — A PRODUCTION INSTANCE REACHED BY IP ADDRESS
 * (owner decision 2026-10-16: on a museum intranet with no local DNS, staff
 * type the server's IPv4 address). A local CA's tls_extra_names may list IPv4
 * addresses on the production route; a browser sends NO server name for an IP
 * literal, so the installer's host-wide catch-all picks the certificate by
 * address (src/core/install/host/web/catch_all.ts, CLAIMED).
 *
 *  A. RENDERS, every supported OS row × nginx|apache, 0/1/2 instances:
 *     nginx — no claim: the catch-all byte-identical to the claimless one
 *     (ssl_reject_handshake); a claim: the "<address>|<empty SNI>" map to
 *     THIS instance's fullchain and key, every other handshake mapped to a
 *     file that never exists; a second claimant re-renders with BOTH claims; a
 *     second instance without one leaves it alone. Apache — a claim writes
 *     the first-*:443 catch-all with the instance's certificate and the
 *     instance vhost's SSL settings (a2ensite on Debian only); no claim, no
 *     file. The site answers the address on 80 (the https redirect) and 443.
 *     The site key: nginx with a claim → the generator's --key-group (the
 *     plan's key-access run and the renewal drop-in); Apache / no claim → none.
 *  B. REFUSED ON THE REVIEW (address_claims.ts claimProblems): an address that
 *     is not this host's (or unreadable addresses), one another instance
 *     claims, non-standard ports, a foreign catch-all file, nginx's operator
 *     default_server on 443 or an operator 443 server LOADED BEFORE the
 *     catch-all (the port's first server is its default — B1: the order from
 *     the dump's `include` order; unknown refused), Apache's second claimant
 *     and an operator vhost loaded before the catch-all, an operator site BOUND to the claimed
 *     address (`listen <ip>:443`, `<VirtualHost <ip>:443>` — parsed from
 *     `nginx -T` / `-S`, the address kept); IPv6 stays refused by validation.
 *     The host's addresses are read from a REAL /proc/net/fib_trie (captured,
 *     Debian 13). And AGAIN when host_web_site runs (web.ts liveClaimCheck):
 *     a claim that landed in the registry after this run's Review refuses the
 *     run before anything is written — never last-writer-wins; the catch-all
 *     renders from the LIVE claims; a registry holding one address twice
 *     still renders one map key (nginx refuses a duplicate).
 *     B1b: every refusal's opening words are a row of
 *     docs/install/troubleshooting.md (rendered here, placeholders <ip>/<j>).
 *  C. UNDO + RESUME: one claimant's --abort re-renders the catch-all from the
 *     claims left (the other instance's address stays); the last user removes
 *     it (Apache: a2dissite first on Debian). host_web_site's verify reads the
 *     catch-all: a step stopped before the catch-all write is re-run on
 *     --resume, never adopted.
 *  D. THE GENERATOR'S --key-group, EXECUTED: the key root:<group> 0640 on the
 *     issue, kept by a renewal, applied by a no-op renewal, REMEMBERED by a
 *     renewal or a local-ca rotation without the flag (the documented
 *     rotation command); never given → 0600.
 *  E. REAL SERVERS (Docker image dedalo-ci:local — Debian 13, nginx 1.26,
 *     Apache 2.4; --network none, two addresses added on lo): the rendered
 *     site + catch-all files, the certificates made by the plan's own
 *     generator argv. A nameless handshake to a claimed address verifies
 *     against THAT instance's authority and reaches its site; an unclaimed
 *     address is refused (nginx) / answered 421 (Apache, as today); an
 *     operator's vhost on the SAME address still answers by name; http:// to a
 *     claimed address redirects to https://<address>/; the undo re-render
 *     drops exactly the removed instance's address; a registry's duplicate
 *     claim renders a catch-all `nginx -t` accepts. An operator site BOUND to
 *     the claimed address takes the nameless handshake (the trap, measured)
 *     and the Review refuses it from the REAL `nginx -T` / `apache2ctl -S`
 *     output. An operator 443 server in conf.d sorting before the catch-all
 *     takes it too (measured), refused from the real dump; one in
 *     sites-enabled leaves the claim working and passes. Skipped (said so in the
 *     name) without Docker or the image — the hermetic tier has neither.
 *
 * DB-free; openssl + bash on PATH for D.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type {
	ExecCommand,
	HostCommand,
	HostCtx,
	HostPlanCtx,
} from '../../src/core/install/host/contract.ts';
import { hostAddresses } from '../../src/core/install/host/facts.ts';
import { hostFs } from '../../src/core/install/host/fs.ts';
import {
	claimedAddresses,
	claimProblems,
	nginxLoadOrder,
	ownClaims,
} from '../../src/core/install/host/production/address_claims.ts';
import { tlsCommands, tlsRenewWrite } from '../../src/core/install/host/production/tls.ts';
import {
	catchAllRemoval,
	certificatePaths,
	host_web_site,
	liveClaimCheck,
	siteCommands,
	siteText,
} from '../../src/core/install/host/production/web.ts';
import { ownEntry, updateEntry } from '../../src/core/install/host/registry.ts';
import type { CommandRunner } from '../../src/core/install/host/runner.ts';
import {
	type AddressClaim,
	CATCH_ALL_STAMP,
	catchAllPath,
	catchAllServes,
	renderApacheCatchAll,
	renderNginxCatchAll,
	UNCLAIMED_CERTIFICATE,
} from '../../src/core/install/host/web/catch_all.ts';
import {
	apacheSites,
	nginxIncludes,
	nginxSites,
	type SiteTuple,
} from '../../src/core/install/host/web/clash.ts';
import { buildInstallPlan } from '../../src/core/install/install_plan.ts';
import {
	type HostVariant,
	LOCAL_CA_VARIANTS,
	productionPlanCtx,
	productionRaw,
	REPO_ROOT,
	variantName,
} from '../helpers/install_host_scratch.ts';
import { escapeRegExp } from '../helpers/regex_escape.ts';

const CLAIMED = '192.168.1.20';
const SECOND = '192.168.1.21';

/** An instance's plan context: its extra addresses, the host's facts merged in. */
function claimCtx(
	variant: HostVariant,
	extra: Record<string, unknown> = {},
	facts: Partial<HostPlanCtx['facts']> = {},
	web: Partial<HostPlanCtx['facts']['web']> = {},
): HostPlanCtx {
	const ctx = productionPlanCtx(variant, REPO_ROOT, {
		tls_extra_names: `demo.lan,${CLAIMED}`,
		...extra,
	});
	return {
		...ctx,
		facts: {
			...ctx.facts,
			addresses: [CLAIMED, SECOND, '10.0.0.5'],
			...facts,
			web: { ...ctx.facts.web, ...web },
		},
	};
}

/** The second instance of a host (its own name, address and instance). */
const OTHER = Object.freeze({
	instance: 'second',
	entity: 'second',
	server_name: 'second.example.org',
	tls_extra_names: `second.lan,${SECOND}`,
});

/** The claim the OTHER instance holds in the registry (what facts.web.claims carries). */
function otherClaim(address = SECOND, instance = 'second'): AddressClaim {
	return {
		address,
		instance,
		fullchain: `/opt/dedalo/instances/${instance}/tls/fullchain.pem`,
		key: `/opt/dedalo/instances/${instance}/tls/privkey.pem`,
	};
}

/** The catch-all writes among the site step's commands. */
function catchAllWrites(ctx: HostPlanCtx): { path: string; content: string }[] {
	const path = catchAllPath(ctx.row.web[ctx.facts.web.kind]);
	return siteCommands(ctx).filter(
		(command): command is HostCommand & { kind: 'write'; path: string; content: string } =>
			command.kind === 'write' && command.path === path,
	);
}

/** The single catch-all text of a plan (asserts there is exactly one write). */
function catchAllText(ctx: HostPlanCtx): string {
	const writes = catchAllWrites(ctx);
	expect(writes).toHaveLength(1);
	return (writes[0] as { content: string }).content;
}

/** nginx `map` entries "<key>" <value> of one map variable. */
function mapEntries(text: string, variable: string): Map<string, string> {
	const block = new RegExp(
		`map "\\$server_addr\\|\\$ssl_server_name" \\$${variable} \\{([^}]*)\\}`,
	).exec(text)?.[1];
	expect(block, `map ${variable}`).toBeDefined();
	const entries = new Map<string, string>();
	for (const line of (block as string).split('\n')) {
		const m = /^\s*(default|"[^"]*")\s+(\S+);/.exec(line);
		if (m) entries.set((m[1] as string).replace(/"/g, ''), m[2] as string);
	}
	return entries;
}

const NGINX = LOCAL_CA_VARIANTS.filter((variant) => variant.web === 'nginx');
const APACHE = LOCAL_CA_VARIANTS.filter((variant) => variant.web === 'apache');

describe('A. renders — every row × nginx|apache, 0/1/2 instances', () => {
	test('the variant census is not empty (both servers, every row)', () => {
		expect(NGINX.length).toBeGreaterThanOrEqual(3);
		expect(APACHE.length).toBe(NGINX.length);
	});

	test('validation: an IPv4 address is a claim on production (and on no other route/mode); IPv6 stays refused', () => {
		const ctx = claimCtx(NGINX[0] as HostVariant);
		expect(claimedAddresses(ctx.answers)).toEqual([CLAIMED]);
		expect(claimedAddresses({ ...ctx.answers, route: 'docker' })).toEqual([]);
		expect(claimedAddresses({ ...ctx.answers, tls_mode: 'letsencrypt' })).toEqual([]);
		const v6 = buildInstallPlan(
			productionRaw(NGINX[0] as HostVariant, { tls_extra_names: 'demo.lan,fd00::20' }),
		);
		expect(v6.errors.join('\n')).toContain('IPv6 addresses are not supported for the local CA');
	});

	for (const variant of NGINX) {
		const name = variantName(variant);

		test(`${name}: no claim → the catch-all is the claimless one, byte for byte (ssl_reject_handshake)`, () => {
			const ctx = productionPlanCtx(variant);
			expect(claimedAddresses(ctx.answers)).toEqual([]);
			const text = catchAllText(ctx);
			expect(text).toBe(renderNginxCatchAll());
			expect(text).toContain('ssl_reject_handshake on;');
			expect(text).not.toContain('map ');
		});

		test(`${name}: ONE instance claims → its address (empty SNI) maps to ITS fullchain and key; everything else to a file that never exists`, () => {
			const ctx = claimCtx(variant);
			const text = catchAllText(ctx);
			expect(text.startsWith(`${CATCH_ALL_STAMP}\n`)).toBe(true);
			const cert = certificatePaths(ctx);
			const certs = mapEntries(text, 'dedalo_catch_all_certificate');
			const keys = mapEntries(text, 'dedalo_catch_all_certificate_key');
			expect([...certs.entries()]).toEqual([
				['default', UNCLAIMED_CERTIFICATE],
				[`${CLAIMED}|`, cert.fullchain],
			]);
			expect([...keys.entries()]).toEqual([
				['default', UNCLAIMED_CERTIFICATE],
				[`${CLAIMED}|`, cert.key],
			]);
			const https = text.slice(text.indexOf('listen 443 ssl;'));
			expect(https).toContain('ssl_certificate     $dedalo_catch_all_certificate;');
			expect(https).toContain('ssl_certificate_key $dedalo_catch_all_certificate_key;');
			expect(https).not.toContain('ssl_reject_handshake');
			// The refused handshakes are logged in the catch-all's own file, never the main log.
			expect(https).toContain(`error_log ${ctx.row.web.nginx.logDir}/dedalo-catch-all.error.log;`);
			// Never `listen <ip>:443` (it would hide every name-based site on that address).
			expect(text).not.toMatch(/listen \d+\.\d+\.\d+\.\d+/);
		});

		test(`${name}: the site answers the address — server_name on 80 (the https redirect by $host) and 443`, () => {
			const ctx = claimCtx(variant);
			const site = siteText(ctx, certificatePaths(ctx));
			const names = [...site.matchAll(/^\tserver_name ([^;]+);/gm)].map((m) =>
				(m[1] as string).split(' '),
			);
			expect(names).toHaveLength(2);
			for (const list of names) expect(list).toContain(CLAIMED);
			expect(site).toContain('return 301 https://$host$request_uri;');
		});

		test(`${name}: a SECOND claimant re-renders with BOTH claims (the other's from the registry); a second instance WITHOUT one leaves it alone`, () => {
			const ctx = claimCtx(variant, {}, {}, { catchAll: 'ours', claims: [otherClaim()] });
			const certs = mapEntries(catchAllText(ctx), 'dedalo_catch_all_certificate');
			expect(certs.get(`${SECOND}|`)).toBe(otherClaim().fullchain);
			expect(certs.get(`${CLAIMED}|`)).toBe(certificatePaths(ctx).fullchain);
			expect(certs.size).toBe(3);
			const quiet = productionPlanCtx(variant);
			expect(
				catchAllWrites({
					...quiet,
					facts: {
						...quiet.facts,
						web: { ...quiet.facts.web, catchAll: 'ours', claims: [otherClaim()] },
					},
				}),
			).toEqual([]);
		});

		test(`${name}: the site key — the plan's key-access run and the renewal drop-in carry --key-group ${variant.os.startsWith('el') ? 'nginx' : 'www-data'}; none without a claim`, () => {
			const ctx = claimCtx(variant);
			const group = ctx.row.web.nginx.user;
			const runs = tlsCommands(ctx).filter(
				(command): command is ExecCommand =>
					command.kind === 'exec' && command.argv.includes('--key-group'),
			);
			expect(runs).toHaveLength(1);
			expect((runs[0] as ExecCommand).argv.slice(1)).toEqual([
				'--mode',
				'renew',
				'--dir',
				ctx.paths.tlsDir,
				'--key-group',
				group,
				'--no-reload',
				'--quiet',
			]);
			expect(tlsRenewWrite(ctx).content).toContain(`--key-group ${group}`);
			const plain = productionPlanCtx(variant);
			expect(tlsRenewWrite(plain).content).not.toContain('--key-group');
			expect(
				tlsCommands(plain).some(
					(command) => command.kind === 'exec' && command.argv.includes('--key-group'),
				),
			).toBe(false);
		});
	}

	for (const variant of APACHE) {
		const name = variantName(variant);
		test(`${name}: a claim writes the first-*:443 catch-all with THIS instance's certificate and the vhost's SSL settings${variant.os.startsWith('el') ? '' : ', enabled with a2ensite'}; no claim, no file; the key stays root-only`, () => {
			const ctx = claimCtx(variant);
			const text = catchAllText(ctx);
			const cert = certificatePaths(ctx);
			expect(text).toContain(`SSLCertificateFile    ${cert.fullchain}`);
			expect(text).toContain(`SSLCertificateKeyFile ${cert.key}`);
			expect(text).toMatch(/RewriteRule \^ - \[R=421,L\]/);
			// mod_ssl refuses (421) a request whose vhost's SSL setup differs from the handshake's.
			const site = siteText(ctx, cert);
			for (const line of ['\tProtocols h2 http/1.1', '\tSSLProtocol -all +TLSv1.2 +TLSv1.3']) {
				expect(text).toContain(line);
				expect(site).toContain(line);
			}
			expect(site).toMatch(new RegExp(`ServerAlias [^\\n]*${escapeRegExp(CLAIMED)}`));
			const enable = siteCommands(ctx).filter(
				(command) => command.kind === 'exec' && command.argv.includes('dedalo-00-default'),
			);
			expect(enable).toHaveLength(ctx.row.web.apache.enableWithA2ensite ? 1 : 0);
			expect(catchAllWrites(productionPlanCtx(variant))).toEqual([]);
			expect(tlsRenewWrite(ctx).content).not.toContain('--key-group');
		});
	}

	test('ownClaims names the instance and its local-CA files', () => {
		const ctx = claimCtx(NGINX[0] as HostVariant);
		expect(ownClaims(ctx)).toEqual([
			{ address: CLAIMED, instance: ctx.paths.instance, ...certificatePaths(ctx) },
		]);
	});
});

/** A real /proc/net/fib_trie (dedalo-ci:local, Debian 13, one bridge address), trimmed to one table. */
const FIB_TRIE = `Main:
  +-- 0.0.0.0/0 3 0 5
     |-- 0.0.0.0
        /0 universe UNICAST
     +-- 127.0.0.0/8 2 0 2
        +-- 127.0.0.0/31 1 0 0
           |-- 127.0.0.0
              /8 host LOCAL
           |-- 127.0.0.1
              /32 host LOCAL
        |-- 127.255.255.255
           /32 link BROADCAST
     +-- 172.17.0.0/16 2 0 2
        +-- 172.17.0.0/30 2 0 2
           |-- 172.17.0.0
              /16 link UNICAST
           |-- 172.17.0.2
              /32 host LOCAL
        |-- 172.17.255.255
           /32 link BROADCAST
`;

describe('B. refused on the Review (claimProblems) — before anything changes', () => {
	const nginx = NGINX[0] as HostVariant;
	const apache = APACHE.find((v) => v.os.startsWith('debian')) ?? (APACHE[0] as HostVariant);

	test("the host's addresses come from /proc/net/fib_trie: LOCAL /32 routes, loopback and network/broadcast left out", () => {
		expect(hostAddresses(FIB_TRIE)).toEqual(['172.17.0.2']);
		expect(hostAddresses('')).toEqual([]);
	});

	test("a clean claim (this host's address, standard ports, catch-all ours or absent): no refusal — on both servers", () => {
		expect(claimProblems(claimCtx(nginx))).toEqual([]);
		expect(claimProblems(claimCtx(nginx, {}, {}, { catchAll: 'ours' }))).toEqual([]);
		expect(claimProblems(claimCtx(apache))).toEqual([]);
		// No claim: nothing to check at all.
		expect(claimProblems(productionPlanCtx(nginx))).toEqual([]);
	});

	test("an address that is not this host's is refused, naming the host's addresses; unreadable addresses refuse too", () => {
		const problems = claimProblems(claimCtx(nginx, {}, { addresses: ['10.0.0.5'] }));
		expect(problems).toEqual([
			`tls_extra_names: ${CLAIMED} is not an address of this host (its IPv4 addresses: 10.0.0.5) — a certificate for it would name an address staff cannot reach here`,
		]);
		expect(claimProblems(claimCtx(nginx, {}, { addresses: null })).join('\n')).toContain(
			"this host's addresses could not be read (/proc/net/fib_trie)",
		);
	});

	test('an address ANOTHER instance claims is refused — one address, one instance, never last-writer-wins (both servers)', () => {
		for (const variant of [nginx, apache]) {
			const problems = claimProblems(
				claimCtx(variant, {}, {}, { claims: [otherClaim(CLAIMED, 'second')] }),
			);
			expect(problems).toContain(
				`tls_extra_names: ${CLAIMED} is already claimed by instance second — an IP address reaches exactly one instance; give this one another address or a name`,
			);
		}
	});

	test('non-standard ports and a foreign catch-all file are refused', () => {
		expect(
			claimProblems(claimCtx(nginx, { http_port: '8080', https_port: '8443' })).join('\n'),
		).toContain('an IP address needs the standard ports 80/443');
		expect(claimProblems(claimCtx(nginx, {}, {}, { catchAll: 'foreign' })).join('\n')).toContain(
			"exists and is not the installer's",
		);
	});

	test("nginx: an operator's default_server on 443 answers nameless handshakes — refused; on 80 only — fine", () => {
		const file = '/etc/nginx/sites-enabled/default';
		expect(
			claimProblems(claimCtx(nginx, {}, {}, { defaults: [{ port: '443', file }] })).join('\n'),
		).toContain(`${file} is nginx's default_server on port 443`);
		expect(claimProblems(claimCtx(nginx, {}, {}, { defaults: [{ port: '80', file }] }))).toEqual(
			[],
		);
	});

	test('Apache: a second claimant is refused (one certificate per nameless handshake); an operator vhost loaded BEFORE the catch-all is refused, one loaded after is not', () => {
		expect(
			claimProblems(claimCtx(apache, {}, {}, { claims: [otherClaim()] })).join('\n'),
		).toContain('instance second already claims');
		const loaded = catchAllPath(claimCtx(apache).row.web.apache).replace(
			'/sites-available/',
			'/sites-enabled/',
		);
		const dir = loaded.slice(0, loaded.lastIndexOf('/'));
		const site = (file: string) => ({ file, names: ['op.example.org'], ports: ['443'] });
		for (const before of [`${dir}/000-op.conf`, '/etc/apache2/conf-enabled/op.conf']) {
			expect(
				claimProblems(claimCtx(apache, {}, {}, { sites: [site(before)] })).join('\n'),
				before,
			).toContain(`${before} (op.example.org) is loaded before the installer's catch-all`);
		}
		expect(claimProblems(claimCtx(apache, {}, {}, { sites: [site(`${dir}/op.conf`)] }))).toEqual(
			[],
		);
		// Another instance's site first: ours too, sorts after the catch-all.
		expect(
			claimProblems(claimCtx(apache, {}, {}, { sites: [site(`${dir}/dedalo-other.conf`)] })),
		).toEqual([]);
	});
});

/** A Debian-shaped `nginx -T` dump: relative + absolute includes, a commented one. */
const DEBIAN_DUMP = `# configuration file /etc/nginx/nginx.conf:
user www-data;
include /etc/nginx/modules-enabled/*.conf;
http {
\tinclude mime.types;
\t# include /etc/nginx/never/*.conf;
\tinclude /etc/nginx/conf.d/*.conf;
\tinclude /etc/nginx/sites-enabled/*;
}
# configuration file /etc/nginx/mime.types:
types { text/html html; }
`;
const DEBIAN_INCLUDES = [
	'/etc/nginx/modules-enabled/*.conf',
	'/etc/nginx/mime.types',
	'/etc/nginx/conf.d/*.conf',
	'/etc/nginx/sites-enabled/*',
];

describe('B1. nginx: an operator 443 server loaded BEFORE the catch-all is the nameless default — refused', () => {
	const nginx = NGINX[0] as HostVariant;
	const ours = catchAllPath(claimCtx(nginx).row.web.nginx);
	const op = (file: string, ports = ['443'], extra: Record<string, unknown> = {}) => ({
		file,
		names: ['app.example.org'],
		ports,
		...extra,
	});
	const problems = (sites: SiteTuple[], includes: string[] | null = DEBIAN_INCLUDES) =>
		claimProblems(claimCtx(nginx, {}, {}, { sites, ...(includes ? { includes } : {}) }));

	test('nginx -T → the include patterns in load order, a relative one made absolute, comments dropped', () => {
		expect(nginxIncludes(DEBIAN_DUMP)).toEqual(DEBIAN_INCLUDES);
		expect(nginxIncludes('')).toEqual([]);
	});

	test('nginxLoadOrder: the same directory by name; another by its include; a file no include brings in is unknown', () => {
		expect(ours).toBe('/etc/nginx/conf.d/dedalo-00-default.conf');
		expect(nginxLoadOrder('/etc/nginx/conf.d/app.conf', ours, [])).toBe('before');
		expect(nginxLoadOrder('/etc/nginx/conf.d/00-api.conf', ours, [])).toBe('before');
		expect(nginxLoadOrder('/etc/nginx/conf.d/zz-app.conf', ours, [])).toBe('after');
		expect(nginxLoadOrder('/etc/nginx/sites-enabled/app', ours, DEBIAN_INCLUDES)).toBe('after');
		expect(
			nginxLoadOrder('/etc/nginx/sites-enabled/app', ours, [
				'/etc/nginx/sites-enabled/*',
				'/etc/nginx/conf.d/*.conf',
			]),
		).toBe('before');
		// One include bringing in both directories: by full path.
		expect(nginxLoadOrder('/etc/nginx/a/x.conf', ours, ['/etc/nginx/*/*.conf'])).toBe('before');
		expect(nginxLoadOrder('/etc/nginx/zz/x.conf', ours, ['/etc/nginx/*/*.conf'])).toBe('after');
		expect(nginxLoadOrder('/etc/nginx/nginx.conf', ours, DEBIAN_INCLUDES)).toBe('unknown');
		expect(nginxLoadOrder('/etc/nginx/sites-enabled/app', ours, [])).toBe('unknown');
	});

	test('an operator conf.d server on 443 sorting before dedalo-00-default.conf is refused, naming the file; after it, or elsewhere loaded after, is not', () => {
		for (const file of ['/etc/nginx/conf.d/app.conf', '/etc/nginx/conf.d/00-api.conf']) {
			expect(problems([op(file)]), file).toEqual([
				`an IP address cannot reach this instance: ${file} (app.example.org) listens on port 443 and is loaded before the installer's catch-all ${ours}, so nginx answers a handshake that names no site (what a browser sends for an IP address) with it — give staff a name instead, or have that site load after ${ours}`,
			]);
		}
		expect(problems([op('/etc/nginx/conf.d/zz-app.conf')])).toEqual([]);
		expect(problems([op('/etc/nginx/sites-enabled/app')])).toEqual([]);
		// Port 80 only, another instance's site, a bound site (B2's), a default_server (B's): not this check.
		expect(problems([op('/etc/nginx/conf.d/app.conf', ['80'])])).toEqual([]);
		expect(problems([op('/etc/nginx/conf.d/dedalo-aaa.conf')])).toEqual([]);
		expect(
			problems([
				op('/etc/nginx/conf.d/app.conf', ['443'], {
					binds: [{ address: '10.9.9.9', port: '443' }],
				}),
			]),
		).toEqual([]);
		expect(
			problems([op('/etc/nginx/conf.d/app.conf', ['443'], { defaults: ['443'] })]).join('\n'),
		).not.toContain('is loaded before');
	});

	test('an order nginx -T cannot tell (no include fact, a server in nginx.conf itself) is refused — never guessed', () => {
		expect(problems([op('/etc/nginx/sites-enabled/app')], null).join('\n')).toContain(
			"/etc/nginx/sites-enabled/app (app.example.org) listens on port 443 and may load before the installer's catch-all",
		);
		expect(problems([op('/etc/nginx/nginx.conf')]).join('\n')).toContain(
			'/etc/nginx/nginx.conf (app.example.org) listens on port 443 and may load before',
		);
	});
});

describe("B1b. troubleshooting.md documents every claim refusal by the Review's own words", () => {
	const nginx = NGINX[0] as HostVariant;
	const apache = APACHE.find((v) => v.os.startsWith('debian')) ?? (APACHE[0] as HostVariant);
	const doc = readFileSync(join(REPO_ROOT, 'docs/install/troubleshooting.md'), 'utf8');
	const reach = 'an IP address cannot reach this instance: ';
	const op = (file: string, extra: Record<string, unknown> = {}) => ({
		file,
		names: ['op.example.org'],
		ports: ['443'],
		...extra,
	});
	/**
	 * Each refusal rendered for real, its values turned into the page's
	 * placeholders (`<ip>`, `<j>`), cut where the first value the page elides
	 * (`…`) begins: the page's table cell must open with that prefix.
	 */
	const cases: { name: string; ctx: HostPlanCtx; cut: string }[] = [
		{
			name: 'not this host',
			ctx: claimCtx(nginx, {}, { addresses: ['10.0.0.5'] }),
			cut: '10.0.0.5',
		},
		{ name: 'unreadable addresses', ctx: claimCtx(nginx, {}, { addresses: null }), cut: ' — ' },
		{
			name: 'claimed by another instance',
			ctx: claimCtx(nginx, {}, {}, { claims: [otherClaim(CLAIMED, 'second')] }),
			cut: ' — ',
		},
		{
			name: 'non-standard ports',
			ctx: claimCtx(nginx, { http_port: '8080', https_port: '8443' }),
			cut: ' (http_port',
		},
		{
			name: 'foreign catch-all',
			ctx: claimCtx(nginx, {}, {}, { catchAll: 'foreign' }),
			cut: reach,
		},
		{
			name: 'bound site',
			ctx: claimCtx(
				nginx,
				{},
				{},
				{
					sites: [
						op('/etc/nginx/sites-enabled/op', { binds: [{ address: CLAIMED, port: '443' }] }),
					],
				},
			),
			cut: reach,
		},
		{
			name: 'nginx default_server',
			ctx: claimCtx(nginx, {}, {}, { defaults: [{ port: '443', file: '/etc/nginx/x.conf' }] }),
			cut: reach,
		},
		{
			name: 'nginx loaded before',
			ctx: claimCtx(nginx, {}, {}, { sites: [op('/etc/nginx/conf.d/app.conf')] }),
			cut: reach,
		},
		{
			name: 'Apache claimant',
			ctx: claimCtx(apache, {}, {}, { claims: [otherClaim()] }),
			cut: reach,
		},
		{
			name: 'Apache loaded before',
			ctx: claimCtx(apache, {}, {}, { sites: [op('/etc/apache2/conf-enabled/op.conf')] }),
			cut: reach,
		},
	];
	for (const { name, ctx, cut } of cases) {
		test(`${name}: its row opens with the refusal's own words`, () => {
			const problems = claimProblems(ctx);
			expect(problems, name).toHaveLength(1);
			const text = (problems[0] as string)
				.replaceAll(CLAIMED, '<ip>')
				.replaceAll('instance second', 'instance <j>');
			// The cannot-reach family shares one row: the prefix INCLUDES the cut.
			const end = cut === reach ? cut.length : text.indexOf(cut);
			expect(cut === reach ? text.startsWith(reach) : end > 0, text).toBe(true);
			expect(doc).toContain(`| \`${text.slice(0, end)}`);
		});
	}
});

describe('B2. an operator site BOUND to the claimed address — parsed, then refused', () => {
	const nginx = NGINX[0] as HostVariant;
	const apache = APACHE.find((v) => v.os.startsWith('debian')) ?? (APACHE[0] as HostVariant);
	const op = (file: string, binds: { address: string; port: string }[]) => ({
		file,
		names: ['museo.example'],
		ports: binds.map((bind) => bind.port),
		binds,
	});

	test('nginx -T: an address-specific listen keeps its address (alone = port 80); wildcards, [::] and unix sockets bind nothing', () => {
		const dump = [
			'# configuration file /etc/nginx/sites-enabled/op:',
			`server {\n\tlisten ${CLAIMED}:443 ssl;\n\tlisten 443 ssl;\n\tlisten [::]:443 ssl;\n\tlisten ${SECOND};\n\tlisten *:80;\n\tlisten 0.0.0.0:8080;\n\tlisten unix:/run/x.sock;\n\tserver_name museo.example;\n}`,
			'# configuration file /etc/nginx/sites-enabled/plain:',
			'server {\n\tlisten 443 ssl;\n\tserver_name plain.example;\n}',
		].join('\n');
		const [bound, plain] = nginxSites(dump);
		expect(bound?.binds).toEqual([
			{ address: CLAIMED, port: '443' },
			{ address: SECOND, port: '80' },
		]);
		expect(plain?.binds).toBeUndefined();
	});

	test('apache2ctl -S: a single vhost line and a NameVirtualHost group keep the address column; *:443 binds nothing', () => {
		const output = [
			'VirtualHost configuration:',
			`${CLAIMED}:443          museo.example (/etc/apache2/sites-enabled/museo.conf:1)`,
			`${SECOND}:80            is a NameVirtualHost`,
			'         default server a.example (/etc/apache2/sites-enabled/a.conf:1)',
			'         port 80 namevhost a.example (/etc/apache2/sites-enabled/a.conf:1)',
			'         port 80 namevhost b.example (/etc/apache2/sites-enabled/b.conf:1)',
			'                 alias www.b.example',
			'*:443                  is a NameVirtualHost',
			'         default server op.example (/etc/apache2/sites-enabled/op.conf:1)',
			'         port 443 namevhost op.example (/etc/apache2/sites-enabled/op.conf:1)',
		].join('\n');
		const sites = apacheSites(output);
		expect(sites.map((site) => [site.file, site.names, site.binds ?? null])).toEqual([
			[
				'/etc/apache2/sites-enabled/museo.conf',
				['museo.example'],
				[{ address: CLAIMED, port: '443' }],
			],
			['/etc/apache2/sites-enabled/a.conf', ['a.example'], [{ address: SECOND, port: '80' }]],
			[
				'/etc/apache2/sites-enabled/b.conf',
				['b.example', 'www.b.example'],
				[{ address: SECOND, port: '80' }],
			],
			['/etc/apache2/sites-enabled/op.conf', ['op.example'], null],
		]);
	});

	test('a site bound to the claimed address on 443 or 80 is refused, naming the file — on both servers, wherever the file sorts', () => {
		const loaded = catchAllPath(claimCtx(apache).row.web.apache).replace(
			'/sites-available/',
			'/sites-enabled/',
		);
		const after = `${loaded.slice(0, loaded.lastIndexOf('/'))}/museo.conf`;
		for (const [variant, file] of [
			[nginx, '/etc/nginx/sites-enabled/museo'],
			[apache, after],
		] as const) {
			for (const port of ['443', '80']) {
				const problems = claimProblems(
					claimCtx(variant, {}, {}, { sites: [op(file, [{ address: CLAIMED, port }])] }),
				);
				expect(problems, `${variant.web} ${port}`).toEqual([
					`an IP address cannot reach this instance: ${file} (museo.example) listens on ${CLAIMED}:${port} itself, and a site bound to an address takes every connection to it from the sites on every address — this instance's included — so remove that address from its listen, or give staff another address or a name`,
				]);
			}
		}
	});

	test("a bind to ANOTHER address, another port, loopback, or the installer's own file is no refusal; a bind to a NAME is (it may resolve to the claim)", () => {
		const sites = [
			op('/etc/nginx/sites-enabled/other', [{ address: SECOND, port: '443' }]),
			op('/etc/nginx/sites-enabled/alt', [{ address: CLAIMED, port: '8443' }]),
			op('/etc/nginx/sites-enabled/lo', [{ address: 'localhost', port: '443' }]),
			op('/etc/nginx/conf.d/dedalo-x.conf', [{ address: CLAIMED, port: '443' }]),
		];
		expect(claimProblems(claimCtx(nginx, {}, {}, { sites }))).toEqual([]);
		const named = claimProblems(
			claimCtx(
				nginx,
				{},
				{},
				{
					sites: [op('/etc/nginx/sites-enabled/n', [{ address: 'intranet.lan', port: '443' }])],
				},
			),
		);
		expect(named.join('\n')).toContain(
			`listens on intranet.lan:443 itself (a name the web server resolves when it starts — it may be ${CLAIMED})`,
		);
	});
});

describe('B3. the claim re-checked against the LIVE registry when host_web_site runs', () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	});
	const nginx = NGINX[0] as HostVariant;
	const apache = APACHE.find((v) => v.os.startsWith('debian')) ?? (APACHE[0] as HostVariant);

	/** This instance's run context over a scratch registry; `other` claims `addresses` there now. */
	function liveHost(variant: HostVariant, addresses: string[]) {
		const root = mkdtempSync(join(tmpdir(), 'dedalo_ip_live_'));
		roots.push(root);
		const fs = hostFs(root, join(root, '.owners.json'));
		// The Review saw NO other claim (facts frozen then).
		const ctx = claimCtx(variant, {}, {}, { claims: [] });
		const other = productionPlanCtx(variant, REPO_ROOT, OTHER);
		fs.mkdir(ctx.paths.registryDir, 0o755, 'root', 'root');
		updateEntry(fs, other.paths, {
			catch_all: true,
			addresses,
			certificate: certificatePaths(other),
		});
		return { ctx: { ...ctx, fs } as unknown as HostCtx, other };
	}

	test("another install's claim of THIS address, made after the Review, refuses the run (install.state_conflict) — both servers", () => {
		for (const variant of [nginx, apache]) {
			const { ctx } = liveHost(variant, [CLAIMED]);
			let caught: unknown;
			try {
				liveClaimCheck(ctx);
			} catch (error) {
				caught = error;
			}
			expect((caught as { code?: string })?.code, variant.web).toBe('install.state_conflict');
			expect(String((caught as Error).message)).toContain(
				`${CLAIMED} is already claimed by instance second`,
			);
		}
	});

	test('Apache: ANY other live claimant refuses (one certificate per nameless handshake); nginx: a different address is fine, and the catch-all renders it beside ours', () => {
		const apacheHost = liveHost(apache, [SECOND]);
		expect(() => liveClaimCheck(apacheHost.ctx)).toThrow('instance second already claims');
		const { ctx, other } = liveHost(nginx, [SECOND]);
		const live = liveClaimCheck(ctx);
		expect(live.map((claim) => claim.address)).toEqual([SECOND]);
		const write = siteCommands(ctx, false, live).find(
			(command) => command.kind === 'write' && command.path === catchAllPath(ctx.row.web.nginx),
		) as { content: string };
		const certs = mapEntries(write.content, 'dedalo_catch_all_certificate');
		expect(certs.get(`${SECOND}|`)).toBe(certificatePaths(other).fullchain);
		expect(certs.get(`${CLAIMED}|`)).toBe(certificatePaths(ctx).fullchain);
	});

	test('a registry holding one address twice renders ONE map key per address (nginx refuses a duplicate key)', () => {
		const text = renderNginxCatchAll([
			otherClaim(CLAIMED, 'zeta'),
			otherClaim(CLAIMED, 'alpha'),
			otherClaim(SECOND, 'beta'),
		]);
		expect(text.split(`"${CLAIMED}|"`).length - 1).toBe(2); // once per map (certificate + key)
		const certs = mapEntries(text, 'dedalo_catch_all_certificate');
		expect(certs.get(`${CLAIMED}|`)).toBe(otherClaim(CLAIMED, 'alpha').fullchain);
	});
});

describe('C. undo — re-render from the claims left; the last user removes it', () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	});

	/** A host fs over a scratch root, with the catch-all `text` and both instances' entries. */
	function scratchHost(variant: HostVariant, text: string, otherUses: boolean) {
		const root = mkdtempSync(join(tmpdir(), 'dedalo_ip_claims_'));
		roots.push(root);
		const fs = hostFs(root, join(root, '.owners.json'));
		const ctx = claimCtx(variant);
		const other = productionPlanCtx(variant, REPO_ROOT, OTHER);
		fs.mkdir(ctx.paths.registryDir, 0o755, 'root', 'root');
		updateEntry(fs, ctx.paths, {
			catch_all: true,
			addresses: [CLAIMED],
			certificate: certificatePaths(ctx),
		});
		updateEntry(fs, other.paths, {
			catch_all: otherUses,
			addresses: otherUses ? [SECOND] : [],
			...(otherUses ? { certificate: certificatePaths(other) } : {}),
		});
		const path = catchAllPath(ctx.row.web[variant.web]);
		mkdirSync(join(root, path.slice(0, path.lastIndexOf('/'))), { recursive: true });
		fs.write(path, text, 0o644, 'root', 'root');
		return { ctx: { ...ctx, fs } as unknown as HostCtx, fs, path };
	}

	for (const variant of NGINX) {
		test(`${variantName(variant)}: one claimant's --abort re-renders WITHOUT its address (the other's stays); its entry's claims emptied`, () => {
			const both = renderNginxCatchAll(
				[...ownClaims(claimCtx(variant)), otherClaim()],
				claimCtx(variant).row.web.nginx.logDir,
			);
			const { ctx, fs, path } = scratchHost(variant, both, true);
			const commands = catchAllRemoval(ctx);
			expect(commands).toHaveLength(1);
			const write = commands[0] as { kind: string; path: string; content: string };
			expect(write.kind).toBe('write');
			expect(write.path).toBe(path);
			const certs = mapEntries(write.content, 'dedalo_catch_all_certificate');
			expect(certs.has(`${CLAIMED}|`)).toBe(false);
			expect(certs.get(`${SECOND}|`)).toBe(
				certificatePaths(productionPlanCtx(variant, REPO_ROOT, OTHER)).fullchain,
			);
			expect(ownEntry(fs, ctx.paths)?.addresses).toEqual([]);
		});

		test(`${variantName(variant)}: the LAST user's --abort removes the catch-all`, () => {
			const { ctx, path } = scratchHost(
				variant,
				renderNginxCatchAll(ownClaims(claimCtx(variant))),
				false,
			);
			expect(catchAllRemoval(ctx)).toEqual([
				{
					kind: 'remove',
					path,
					label: 'the host-wide catch-all site (no instance uses it any more)',
				},
			]);
		});
	}

	for (const variant of APACHE) {
		test(`${variantName(variant)}: the claimant's --abort removes the Apache catch-all${variant.os.startsWith('el') ? '' : ' (a2dissite first)'}`, () => {
			const { ctx, path } = scratchHost(
				variant,
				`${CATCH_ALL_STAMP}\n<VirtualHost *:443>\n`,
				false,
			);
			const commands = catchAllRemoval(ctx);
			const removal = commands.at(-1) as { kind: string; path: string };
			expect(removal.kind).toBe('remove');
			expect(removal.path).toBe(path);
			const disable = commands.filter(
				(command) => command.kind === 'exec' && command.argv.includes('dedalo-00-default'),
			);
			expect(disable).toHaveLength(ctx.row.web.apache.enableWithA2ensite ? 1 : 0);
		});
	}
});

describe('C2. resume — host_web_site verify reads the catch-all (a step stopped before it is re-run)', () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	});
	/** A runner whose every probe (the configuration test) succeeds. */
	const okRunner: CommandRunner = {
		run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
	};

	/** The site file in place; the catch-all as `catchAll` (null: absent). */
	function stopped(variant: HostVariant, catchAll: string | null, enabled = true) {
		const root = mkdtempSync(join(tmpdir(), 'dedalo_ip_resume_'));
		roots.push(root);
		const fs = hostFs(root, join(root, '.owners.json'));
		const plan = claimCtx(variant);
		const ctx = { ...plan, fs, runner: okRunner, secrets: {} } as unknown as HostCtx;
		const flavor = plan.row.web[variant.web];
		const site = flavor.sitePath.replace('<i>', plan.paths.instance);
		const write = (path: string, text: string) => {
			mkdirSync(join(root, path.slice(0, path.lastIndexOf('/'))), { recursive: true });
			fs.write(path, text, 0o644, 'root', 'root');
		};
		write(site, siteText(plan, certificatePaths(plan)));
		// nginx with the media gate: the rule copies (not this gate's subject).
		write(`/etc/nginx/dedalo/${plan.paths.instance}/media_protection.conf`, '');
		write(`/etc/nginx/dedalo/${plan.paths.instance}/media_protection_map.conf`, '');
		const path = catchAllPath(flavor);
		if (catchAll !== null) write(path, catchAll);
		if (catchAll !== null && enabled && flavor.enableWithA2ensite)
			write(path.replace('/sites-available/', '/sites-enabled/'), catchAll);
		return { ctx, path };
	}

	for (const variant of [
		NGINX[0] as HostVariant,
		APACHE.find((v) => v.os.startsWith('debian')) as HostVariant,
	]) {
		test(`${variantName(variant)}: catch-all missing, or without this instance's address → NOT adopted; serving it → adopted`, async () => {
			const plan = claimCtx(variant);
			const served =
				variant.web === 'nginx'
					? renderNginxCatchAll(ownClaims(plan), plan.row.web.nginx.logDir)
					: renderApacheCatchAll(ownClaims(plan)[0] as AddressClaim, [CLAIMED]);
			const missing = await host_web_site.verify?.(stopped(variant, null).ctx);
			expect(missing?.ok).toBe(false);
			expect(missing?.detail).toContain(
				`does not serve ${CLAIMED} with this instance's certificate`,
			);
			const without = await host_web_site.verify?.(
				stopped(
					variant,
					variant.web === 'nginx'
						? renderNginxCatchAll([otherClaim()])
						: renderApacheCatchAll(otherClaim(), [SECOND]),
				).ctx,
			);
			expect(without?.ok).toBe(false);
			const done = await host_web_site.verify?.(stopped(variant, served).ctx);
			expect(done, JSON.stringify(done)).toEqual({ ok: true, detail: expect.any(String) });
			expect(catchAllServes(variant.web, served, ownClaims(plan))).toBe(true);
			if (plan.row.web.apache.enableWithA2ensite && variant.web === 'apache') {
				const disabled = await host_web_site.verify?.(stopped(variant, served, false).ctx);
				expect(disabled?.ok).toBe(false);
			}
		});
	}
});

describe('D. the generator keeps the key readable by --key-group (executed)', () => {
	const root = mkdtempSync(join(tmpdir(), 'dedalo_key_group_'));
	afterAll(() => rmSync(root, { recursive: true, force: true }));
	const script = join(REPO_ROOT, 'deploy', 'dedalo-tls-rotate.sh');
	const group = spawnSync('id', ['-gn'], { encoding: 'utf8' }).stdout.trim();

	function run(dir: string, args: readonly string[]) {
		return spawnSync('bash', [script, ...args, '--dir', dir, '--no-reload', '--quiet'], {
			encoding: 'utf8',
			timeout: 120_000,
		});
	}
	function keyMode(dir: string): { mode: number; gid: number } {
		const stat = statSync(join(dir, 'privkey.pem'));
		return { mode: stat.mode & 0o777, gid: stat.gid };
	}

	test(`issue with --key-group (${group}): 0640 and that group; a forced renewal keeps it; one WITHOUT the flag keeps it too (remembered)`, () => {
		const dir = join(root, 'grouped');
		const issued = run(dir, [
			'--mode',
			'local-ca',
			'--host',
			'demo.example.org',
			'--host',
			CLAIMED,
			'--key-group',
			group,
		]);
		expect(issued.status, issued.stderr).toBe(0);
		const gid = userInfo().gid;
		expect(keyMode(dir)).toEqual({ mode: 0o640, gid });
		const renewed = run(dir, ['--mode', 'renew', '--force', '--key-group', group]);
		expect(renewed.status, renewed.stderr).toBe(0);
		expect(keyMode(dir).mode).toBe(0o640);
		const plain = run(dir, ['--mode', 'renew', '--force']);
		expect(plain.status, plain.stderr).toBe(0);
		expect(keyMode(dir)).toEqual({ mode: 0o640, gid });
	}, 120_000);

	test('the DOCUMENTED rotation (--mode local-ca, no --key-group) over a 0640 key keeps 0640 and the group; a directory never given one stays 0600', () => {
		const dir = join(root, 'rotated');
		const hosts = ['--host', 'demo.example.org', '--host', CLAIMED];
		expect(run(dir, ['--mode', 'local-ca', ...hosts, '--key-group', group]).status).toBe(0);
		const rotated = run(dir, ['--mode', 'local-ca', ...hosts]);
		expect(rotated.status, rotated.stderr).toBe(0);
		expect(keyMode(dir)).toEqual({ mode: 0o640, gid: userInfo().gid });
		const fresh = join(root, 'fresh');
		expect(run(fresh, ['--mode', 'local-ca', ...hosts]).status).toBe(0);
		expect(run(fresh, ['--mode', 'local-ca', ...hosts]).status).toBe(0);
		expect(keyMode(fresh).mode).toBe(0o600);
	}, 120_000);

	test('a renewal with NOTHING to renew still applies --key-group (an install claiming an address over an existing authority)', () => {
		const dir = join(root, 'adopted');
		expect(run(dir, ['--mode', 'local-ca', '--host', 'demo.example.org']).status).toBe(0);
		expect(keyMode(dir).mode).toBe(0o600);
		const noop = run(dir, ['--mode', 'renew', '--key-group', group]);
		expect(noop.status, noop.stderr).toBe(0);
		expect(keyMode(dir).mode).toBe(0o640);
	}, 120_000);

	test('a group that is not a group NAME is refused before anything changes', () => {
		const result = run(join(root, 'bad'), ['--mode', 'renew', '--key-group', 'x;rm']);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('--key-group takes a group name');
	});
});

// ── E. real servers ──────────────────────────────────────────────────────────

const IMAGE = 'dedalo-ci:local';
const REAL_CLAIMED = '10.77.0.2';
const REAL_UNCLAIMED = '10.77.0.3';
const REAL_SECOND = '10.77.0.4';

/** Is a Docker image present here (the real-server checks run only then)? */
function imageReady(image: string): boolean {
	return spawnSync('docker', ['image', 'inspect', image], { timeout: 20_000 }).status === 0;
}

/** Run `script` in the image as root, --network none, NET_ADMIN (addresses on lo); `dir` at /t. */
function inImage(dir: string, script: string): string {
	writeFileSync(join(dir, 'run.sh'), script);
	chmodSync(join(dir, 'run.sh'), 0o755);
	const run = spawnSync(
		'docker',
		[
			'run',
			'--rm',
			'--network',
			'none',
			'--cap-add',
			'NET_ADMIN',
			'--user',
			'0',
			'-v',
			`${dir}:/t:ro`,
			'-v',
			`${join(REPO_ROOT, 'deploy')}:/deploy:ro`,
			'--entrypoint',
			'bash',
			IMAGE,
			'/t/run.sh',
		],
		{ encoding: 'utf8', timeout: 240_000 },
	);
	return `${run.stdout}\n${run.stderr}`;
}

/** A plan's exec argv as a shell line (the root-owned generator copy at its bin path). */
function shellLine(argv: readonly string[]): string {
	return argv.map((word) => `'${word.replace(/'/g, "'\\''")}'`).join(' ');
}

/** The commands that make an instance's certificate (issue + key access), from the PLAN. */
function certificateScript(ctx: HostPlanCtx): string[] {
	const generator = `${ctx.paths.binDir}/dedalo-tls-rotate.sh`;
	const runs = tlsCommands(ctx).filter(
		(command): command is ExecCommand => command.kind === 'exec' && command.argv[0] === generator,
	);
	expect(runs.length).toBeGreaterThanOrEqual(1);
	return [
		`mkdir -p ${ctx.paths.binDir} ${ctx.paths.tlsDir}`,
		`cp /deploy/dedalo-tls-rotate.sh ${generator}`,
		...runs.map((command) => shellLine(command.argv)),
	];
}

/** curl one URL: `TAG[<http code> <location>|exit=<curl exit>]`. */
function curlLine(tag: string, args: string): string {
	return `out=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' ${args}); rc=$?; if [ $rc -eq 0 ]; then echo "${tag}[$out]"; else echo "${tag}[exit=$rc]"; fi`;
}

const NGINX_DEBIAN = NGINX.find((v) => v.os === 'debian13') ?? (NGINX[0] as HostVariant);
const APACHE_DEBIAN = APACHE.find((v) => v.os === 'debian13') ?? (APACHE[0] as HostVariant);

describe('E. real servers (dedalo-ci:local: Debian 13 nginx + Apache, --network none)', () => {
	const roots: string[] = [];
	afterAll(() => {
		for (const root of roots) rmSync(root, { recursive: true, force: true });
	});
	const scratch = () => {
		const dir = mkdtempSync(join(tmpdir(), 'dedalo_ip_real_'));
		roots.push(dir);
		return dir;
	};
	/** The two instances of the real run (each claims its own address). */
	const pair = (variant: HostVariant) => {
		const facts = { addresses: [REAL_CLAIMED, REAL_UNCLAIMED, REAL_SECOND] };
		const a = claimCtx(variant, { tls_extra_names: `demo.lan,${REAL_CLAIMED}` }, facts);
		const b = claimCtx(variant, { ...OTHER, tls_extra_names: `second.lan,${REAL_SECOND}` }, facts);
		return { a, b };
	};
	const operatorCert = [
		'mkdir -p /op',
		'openssl req -x509 -newkey rsa:2048 -nodes -keyout /op/key.pem -out /op/cert.pem -days 2 -subj /CN=op.example.org -addext subjectAltName=DNS:op.example.org 2>/dev/null',
	];
	const addresses = [REAL_CLAIMED, REAL_UNCLAIMED, REAL_SECOND].map(
		(address) => `ip addr add ${address}/32 dev lo`,
	);

	test.skipIf(!imageReady(IMAGE))(
		`nginx (${IMAGE}): two claimants + an operator vhost on the same address — nameless handshakes get their instance's leaf, an unclaimed address is refused, names still route, http redirects, the undo re-render drops one address (skipped without Docker or the image)`,
		() => {
			const dir = scratch();
			const { a, b } = pair(NGINX_DEBIAN);
			// The second claimant's re-render holds both (the first's from the registry).
			const bWithA = {
				...b,
				facts: {
					...b.facts,
					web: { ...b.facts.web, catchAll: 'ours' as const, claims: ownClaims(a) },
				},
			};
			const catchAll = catchAllText(bWithA);
			// The undo of b, rendered by the real undo path over a scratch registry.
			const host = mkdtempSync(join(tmpdir(), 'dedalo_ip_undo_'));
			roots.push(host);
			const fs = hostFs(host, join(host, '.owners.json'));
			fs.mkdir(a.paths.registryDir, 0o755, 'root', 'root');
			for (const ctx of [a, b])
				updateEntry(fs, ctx.paths, {
					catch_all: true,
					addresses: claimedAddresses(ctx.answers),
					certificate: certificatePaths(ctx),
				});
			const path = catchAllPath(b.row.web.nginx);
			mkdirSync(join(host, path.slice(0, path.lastIndexOf('/'))), { recursive: true });
			fs.write(path, catchAll, 0o644, 'root', 'root');
			const undo = catchAllRemoval({ ...b, fs } as unknown as HostCtx)[0] as { content: string };
			writeFileSync(join(dir, 'catch_all.conf'), catchAll);
			writeFileSync(join(dir, 'catch_all_undone.conf'), undo.content);
			for (const [name, ctx] of [
				['a', a],
				['b', b],
			] as const)
				writeFileSync(join(dir, `site_${name}.conf`), siteText(ctx, certificatePaths(ctx)));
			writeFileSync(
				join(dir, 'operator.conf'),
				'server {\n\tlisten 443 ssl;\n\tserver_name op.example.org;\n\tssl_certificate /op/cert.pem;\n\tssl_certificate_key /op/key.pem;\n\treturn 200 "operator\\n";\n}\n',
			);
			const media = (ctx: HostPlanCtx) => `/etc/nginx/dedalo/${ctx.paths.instance}`;
			const checks = (phase: string) => [
				curlLine(
					`${phase}A_IP`,
					`--cacert ${a.paths.tlsDir}/dedalo-local-ca.pem https://${REAL_CLAIMED}/`,
				),
				curlLine(
					`${phase}B_IP`,
					`--cacert ${b.paths.tlsDir}/dedalo-local-ca.pem https://${REAL_SECOND}/`,
				),
				curlLine(`${phase}UNCLAIMED`, `-k https://${REAL_UNCLAIMED}/`),
				curlLine(
					`${phase}OP_ON_A`,
					`--cacert /op/cert.pem --resolve op.example.org:443:${REAL_CLAIMED} https://op.example.org/`,
				),
				curlLine(
					`${phase}A_NAME`,
					`--cacert ${a.paths.tlsDir}/dedalo-local-ca.pem --resolve ${a.answers.server_name}:443:${REAL_SECOND} https://${a.answers.server_name}/`,
				),
				curlLine(
					`${phase}UNKNOWN_SNI`,
					`-k --resolve zz.example.org:443:${REAL_CLAIMED} https://zz.example.org/`,
				),
				curlLine(`${phase}HTTP_A`, `http://${REAL_CLAIMED}/x`),
			];
			const out = inImage(
				dir,
				[
					'set -u',
					...addresses,
					...certificateScript(a),
					...certificateScript(b),
					...operatorCert,
					...[a, b].flatMap((ctx) => [
						`mkdir -p ${media(ctx)}`,
						`: > ${media(ctx)}/media_protection.conf`,
					]),
					'cp /t/catch_all.conf /etc/nginx/conf.d/dedalo-00-default.conf',
					`cp /t/site_a.conf /etc/nginx/conf.d/dedalo-${a.paths.instance}.conf`,
					`cp /t/site_b.conf /etc/nginx/conf.d/dedalo-${b.paths.instance}.conf`,
					'cp /t/operator.conf /etc/nginx/sites-enabled/zz-operator',
					`echo "KEYMODE[$(stat -c '%a %G' ${a.paths.tlsDir}/privkey.pem)]"`,
					`echo "FIB[$(grep -c '/32 host LOCAL' /proc/net/fib_trie)]"; cp /proc/net/fib_trie /tmp/fib`,
					'nginx -t 2>&1 | tail -1',
					'nginx; sleep 1',
					...checks(''),
					'cp /t/catch_all_undone.conf /etc/nginx/conf.d/dedalo-00-default.conf',
					'nginx -t 2>&1 | tail -1; nginx -s reload; sleep 1',
					...checks('UNDONE_'),
					`echo "LOG[$(grep -c 'cannot load certificate' /var/log/nginx/dedalo-catch-all.error.log)]"`,
					`echo "MAINLOG[$(grep -c 'cannot load certificate' /var/log/nginx/error.log)]"`,
					'echo ADDRS; cat /tmp/fib',
				].join('\n'),
			);
			expect(out).toContain('KEYMODE[640 www-data]');
			expect(out.match(/test is successful/g)?.length).toBe(2);
			// The address facts of THIS container list the claimed addresses.
			expect(hostAddresses(out.slice(out.indexOf('ADDRS')))).toEqual(
				expect.arrayContaining([REAL_CLAIMED, REAL_UNCLAIMED, REAL_SECOND]),
			);
			// A nameless handshake verifies against THAT instance's authority and reaches its site.
			expect(out).toContain('A_IP[302 ');
			expect(out).toContain('B_IP[302 ');
			expect(out).toMatch(/\nUNCLAIMED\[exit=35\]/);
			expect(out).toContain('OP_ON_A[200 ]');
			expect(out).toContain('A_NAME[302 ');
			expect(out).toMatch(/\nUNKNOWN_SNI\[exit=35\]/);
			expect(out).toContain(`HTTP_A[301 https://${REAL_CLAIMED}/x]`);
			// The undo of b: its address refused now, a's untouched, names untouched.
			expect(out).toContain('UNDONE_A_IP[302 ');
			expect(out).toMatch(/UNDONE_B_IP\[exit=35\]/);
			expect(out).toContain('UNDONE_OP_ON_A[200 ]');
			// The refused handshakes are logged in the catch-all's own file, not the main log.
			expect(out).toMatch(/\nLOG\[[1-9]\d*\]/);
			expect(out).toContain('MAINLOG[0]');
		},
		300_000,
	);

	test.skipIf(!imageReady(IMAGE))(
		`Apache (${IMAGE}): the claimant's catch-all — a nameless handshake to its address verifies against its authority and reaches it, an unclaimed address answers 421 (as today), the operator's name still routes, http redirects (skipped without Docker or the image)`,
		() => {
			const dir = scratch();
			const { a } = pair(APACHE_DEBIAN);
			const commands = siteCommands(a);
			const catchAll = catchAllText(a);
			expect(
				commands.some(
					(c) => c.kind === 'exec' && c.argv.join(' ').endsWith('a2ensite dedalo-00-default'),
				),
			).toBe(true);
			writeFileSync(join(dir, 'catch_all.conf'), catchAll);
			writeFileSync(join(dir, 'site_a.conf'), siteText(a, certificatePaths(a)));
			writeFileSync(
				join(dir, 'op.conf'),
				'<VirtualHost *:443>\n\tServerName op.example.org\n\tSSLEngine on\n\tSSLCertificateFile /op/cert.pem\n\tSSLCertificateKeyFile /op/key.pem\n\tRewriteEngine On\n\tRewriteRule ^ - [G]\n</VirtualHost>\n',
			);
			const out = inImage(
				dir,
				[
					'set -u',
					...addresses,
					...certificateScript(a),
					...operatorCert,
					'a2enmod -q ssl headers http2 rewrite proxy proxy_http >/dev/null',
					'a2dissite -q 000-default >/dev/null',
					'mkdir -p /var/www/empty',
					'cp /t/catch_all.conf /etc/apache2/sites-available/dedalo-00-default.conf && a2ensite -q dedalo-00-default',
					`cp /t/site_a.conf /etc/apache2/sites-available/dedalo-${a.paths.instance}.conf && a2ensite -q dedalo-${a.paths.instance}`,
					'cp /t/op.conf /etc/apache2/sites-available/op.conf && a2ensite -q op',
					`echo "KEYMODE[$(stat -c '%a %U' ${a.paths.tlsDir}/privkey.pem)]"`,
					'apache2ctl configtest 2>&1 | tail -1',
					'apache2ctl -S 2>&1 | grep -E "default server" | sed "s/^/DEFAULT[/; s/$/]/"',
					'apache2ctl start; sleep 1',
					curlLine(
						'A_IP',
						`--cacert ${a.paths.tlsDir}/dedalo-local-ca.pem https://${REAL_CLAIMED}/`,
					),
					curlLine(
						'A_IP_H2',
						`--http2 --cacert ${a.paths.tlsDir}/dedalo-local-ca.pem https://${REAL_CLAIMED}/`,
					),
					curlLine('UNCLAIMED', `-k https://${REAL_UNCLAIMED}/`),
					curlLine(
						'OP_ON_A',
						`--cacert /op/cert.pem --resolve op.example.org:443:${REAL_CLAIMED} https://op.example.org/`,
					),
					curlLine('HTTP_A', `http://${REAL_CLAIMED}/x`),
				].join('\n'),
			);
			// Apache reads the key as root at start: it stays root-only.
			expect(out).toContain('KEYMODE[600 root]');
			expect(out).toContain('Syntax OK');
			expect(out).toMatch(/DEFAULT\[\s*default server dedalo-catch-all\.invalid/);
			expect(out).toContain('A_IP[302 ');
			expect(out).toContain('A_IP_H2[302 ');
			expect(out).toContain('UNCLAIMED[421 ]');
			expect(out).toContain('OP_ON_A[410 ]');
			expect(out).toContain(`HTTP_A[301 https://${REAL_CLAIMED}/x]`);
		},
		300_000,
	);
	test.skipIf(!imageReady(IMAGE))(
		`nginx + Apache (${IMAGE}): an operator site BOUND to the claimed address takes the nameless handshake (the trap, measured) — and the Review refuses it from the REAL nginx -T / apache2ctl -S output; a registry's duplicate claim still passes nginx -t (skipped without Docker or the image)`,
		() => {
			const dir = scratch();
			const { a } = pair(NGINX_DEBIAN);
			const apacheA = pair(APACHE_DEBIAN).a;
			const own = ownClaims(a);
			// One address twice in the registry (the floor under the live check): one map key.
			writeFileSync(
				join(dir, 'catch_all.conf'),
				renderNginxCatchAll(
					[...own, { ...(own[0] as AddressClaim), instance: 'zz-duplicate' }],
					a.row.web.nginx.logDir,
				),
			);
			writeFileSync(join(dir, 'site_a.conf'), siteText(a, certificatePaths(a)));
			writeFileSync(
				join(dir, 'op_bound.conf'),
				`server {\n\tlisten ${REAL_CLAIMED}:443 ssl;\n\tserver_name op.example.org;\n\tssl_certificate /op/cert.pem;\n\tssl_certificate_key /op/key.pem;\n\treturn 200 "operator\\n";\n}\n`,
			);
			writeFileSync(
				join(dir, 'apache_catch_all.conf'),
				renderApacheCatchAll(ownClaims(apacheA)[0] as AddressClaim, [REAL_CLAIMED]),
			);
			writeFileSync(join(dir, 'apache_site_a.conf'), siteText(apacheA, certificatePaths(apacheA)));
			writeFileSync(
				join(dir, 'apache_op_bound.conf'),
				`<VirtualHost ${REAL_CLAIMED}:443>\n\tServerName op.example.org\n\tSSLEngine on\n\tSSLCertificateFile /op/cert.pem\n\tSSLCertificateKeyFile /op/key.pem\n</VirtualHost>\n`,
			);
			const subject = (tag: string) =>
				`echo "${tag}[$(echo | openssl s_client -connect ${REAL_CLAIMED}:443 -noservername 2>/dev/null | openssl x509 -noout -subject 2>/dev/null)]"`;
			const out = inImage(
				dir,
				[
					'set -u',
					...addresses,
					...certificateScript(a),
					...operatorCert,
					`mkdir -p /etc/nginx/dedalo/${a.paths.instance}`,
					`: > /etc/nginx/dedalo/${a.paths.instance}/media_protection.conf`,
					'cp /t/catch_all.conf /etc/nginx/conf.d/dedalo-00-default.conf',
					`cp /t/site_a.conf /etc/nginx/conf.d/dedalo-${a.paths.instance}.conf`,
					'cp /t/op_bound.conf /etc/nginx/sites-enabled/zz-op',
					'nginx -t 2>&1 | tail -1',
					'echo NGINX_DUMP_BEGIN; nginx -T 2>/dev/null; echo NGINX_DUMP_END',
					'nginx; sleep 1',
					subject('NGINX_NAMELESS'),
					'nginx -s stop; sleep 1',
					'a2enmod -q ssl headers http2 rewrite proxy proxy_http >/dev/null',
					'a2dissite -q 000-default >/dev/null',
					'mkdir -p /var/www/empty',
					'cp /t/apache_catch_all.conf /etc/apache2/sites-available/dedalo-00-default.conf && a2ensite -q dedalo-00-default',
					`cp /t/apache_site_a.conf /etc/apache2/sites-available/dedalo-${apacheA.paths.instance}.conf && a2ensite -q dedalo-${apacheA.paths.instance}`,
					'cp /t/apache_op_bound.conf /etc/apache2/sites-available/zz-op.conf && a2ensite -q zz-op',
					'echo APACHE_S_BEGIN; apache2ctl -S 2>/dev/null; echo APACHE_S_END',
					'apache2ctl start; sleep 1',
					subject('APACHE_NAMELESS'),
				].join('\n'),
			);
			expect(out).toContain('test is successful');
			// THE TRAP, measured: a bound operator site takes the nameless handshake on both servers.
			expect(out).toMatch(/NGINX_NAMELESS\[subject=CN\s?=\s?op\.example\.org\]/);
			expect(out).toMatch(/APACHE_NAMELESS\[subject=CN\s?=\s?op\.example\.org\]/);
			const between = (begin: string, end: string) =>
				out.slice(out.indexOf(begin) + begin.length, out.indexOf(end));
			const nginxParsed = nginxSites(between('NGINX_DUMP_BEGIN', 'NGINX_DUMP_END'));
			const apacheParsed = apacheSites(between('APACHE_S_BEGIN', 'APACHE_S_END'));
			expect(nginxParsed.length).toBeGreaterThanOrEqual(3);
			expect(apacheParsed.length).toBeGreaterThanOrEqual(3);
			const facts = { addresses: [REAL_CLAIMED, REAL_UNCLAIMED, REAL_SECOND] };
			const nginxProblems = claimProblems(
				claimCtx(NGINX_DEBIAN, { tls_extra_names: `demo.lan,${REAL_CLAIMED}` }, facts, {
					sites: nginxParsed,
				}),
			);
			expect(nginxProblems).toEqual([
				expect.stringContaining(
					`/etc/nginx/sites-enabled/zz-op (op.example.org) listens on ${REAL_CLAIMED}:443 itself`,
				),
			]);
			const apacheProblems = claimProblems(
				claimCtx(APACHE_DEBIAN, { tls_extra_names: `demo.lan,${REAL_CLAIMED}` }, facts, {
					sites: apacheParsed,
				}),
			);
			expect(apacheProblems).toEqual([
				expect.stringContaining(
					`/etc/apache2/sites-enabled/zz-op.conf (op.example.org) listens on ${REAL_CLAIMED}:443 itself`,
				),
			]);
		},
		300_000,
	);
	test.skipIf(!imageReady(IMAGE))(
		`nginx (${IMAGE}): an operator 443 server LOADED BEFORE the catch-all (conf.d/app.conf, no default_server) takes the nameless handshake — the trap, measured — and the Review refuses it from the REAL nginx -T; one loaded after (sites-enabled) leaves the claim working and passes (skipped without Docker or the image)`,
		() => {
			const dir = scratch();
			const { a } = pair(NGINX_DEBIAN);
			writeFileSync(join(dir, 'catch_all.conf'), catchAllText(a));
			writeFileSync(join(dir, 'site_a.conf'), siteText(a, certificatePaths(a)));
			const server = (name: string) =>
				`server {\n\tlisten 443 ssl;\n\tserver_name ${name};\n\tssl_certificate /op/${name}.pem;\n\tssl_certificate_key /op/${name}.key;\n\treturn 200 "${name}\\n";\n}\n`;
			writeFileSync(join(dir, 'late.conf'), server('late.example.org'));
			writeFileSync(join(dir, 'app.conf'), server('app.example.org'));
			const cert = (name: string) =>
				`openssl req -x509 -newkey rsa:2048 -nodes -keyout /op/${name}.key -out /op/${name}.pem -days 2 -subj /CN=${name} -addext subjectAltName=DNS:${name} 2>/dev/null`;
			const nameless = (tag: string) =>
				`echo "${tag}[$(echo | openssl s_client -connect ${REAL_CLAIMED}:443 -noservername -CAfile ${a.paths.tlsDir}/dedalo-local-ca.pem 2>/dev/null | grep -E '^(subject=|\s*Verify return code:)' | tr '\\n' ' ')]"`;
			const dump = (tag: string) => `echo ${tag}_BEGIN; nginx -T 2>/dev/null; echo ${tag}_END`;
			const out = inImage(
				dir,
				[
					'set -u',
					...addresses,
					...certificateScript(a),
					'mkdir -p /op',
					cert('late.example.org'),
					cert('app.example.org'),
					`mkdir -p /etc/nginx/dedalo/${a.paths.instance}`,
					`: > /etc/nginx/dedalo/${a.paths.instance}/media_protection.conf`,
					'cp /t/catch_all.conf /etc/nginx/conf.d/dedalo-00-default.conf',
					`cp /t/site_a.conf /etc/nginx/conf.d/dedalo-${a.paths.instance}.conf`,
					'cp /t/late.conf /etc/nginx/sites-enabled/late',
					'nginx -t 2>&1 | tail -1',
					dump('AFTER'),
					'nginx; sleep 1',
					nameless('AFTER_NAMELESS'),
					'cp /t/app.conf /etc/nginx/conf.d/app.conf',
					'nginx -t 2>&1 | tail -1; nginx -s reload; sleep 1',
					dump('BEFORE'),
					nameless('BEFORE_NAMELESS'),
				].join('\n'),
			);
			expect(out.match(/test is successful/g)?.length).toBe(2);
			// Loaded after (sites-enabled): the claim works — the instance's leaf, verified by its authority.
			expect(out).toMatch(/AFTER_NAMELESS\[[^\]]*Verify return code: 0 \(ok\)/);
			expect(out).not.toMatch(/AFTER_NAMELESS\[subject=CN\s?=\s?late/);
			// Loaded before (conf.d/app.conf sorts before dedalo-00-default.conf): THE TRAP.
			expect(out).toMatch(/BEFORE_NAMELESS\[subject=CN\s?=\s?app\.example\.org/);
			const between = (begin: string, end: string) =>
				out.slice(out.indexOf(begin) + begin.length, out.indexOf(end));
			const review = (tag: string) => {
				const text = between(`${tag}_BEGIN`, `${tag}_END`);
				return claimProblems(
					claimCtx(
						NGINX_DEBIAN,
						{ tls_extra_names: `demo.lan,${REAL_CLAIMED}` },
						{ addresses: [REAL_CLAIMED, REAL_UNCLAIMED, REAL_SECOND] },
						{ sites: nginxSites(text), includes: nginxIncludes(text), catchAll: 'ours' },
					),
				);
			};
			expect(review('AFTER')).toEqual([]);
			expect(review('BEFORE')).toEqual([
				expect.stringContaining(
					"/etc/nginx/conf.d/app.conf (app.example.org) listens on port 443 and is loaded before the installer's catch-all /etc/nginx/conf.d/dedalo-00-default.conf",
				),
			]);
		},
		300_000,
	);
});
