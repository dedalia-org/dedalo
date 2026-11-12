/**
 * THE DOCKER / TRIAL STACK'S OWN FILES SAY WHAT THE CONTAINERS NEED
 * (install campaign 3, 2026-10-13; src/core/install/host/stack/ +
 * host/web/nginx.ts, docker-compose*.yml). Pure renders and the stack files,
 * parsed — plus, where this machine has Docker, Docker itself reading them.
 *
 * WHAT IS MEASURED (outcomes):
 *  (a) C3-2 — the full stack's generated nginx site includes EXACTLY the two
 *      rule files the engine writes into its media root (the names taken from
 *      the engine's own writer, src/core/media/protection.ts ruleFilePaths),
 *      under the container's /srv/dedalo/media: the map at http scope, the
 *      rules in the https server — and nothing under /etc/nginx/dedalo (the
 *      production host's root-owned copies, which do not exist in the
 *      container: nginx crash-looped on every docker install). The media gate
 *      off: neither include. A production site still includes its own copies,
 *      with the same lines as before. With Docker: `nginx -t` in nginx:alpine
 *      over rule files the ENGINE wrote accepts the rendered site.
 *  (b) C3-22 — the trial publishes only its HTTP port and mounts no
 *      certificate: its override REPLACES nginx's ports and volumes
 *      (`!override`), the volumes being the simple stack file's minus the three
 *      certificate ones; .dedalo.env carries no HTTPS port; with Docker,
 *      `compose config` resolves no 443 and no Let's Encrypt volume. Compose
 *      older than 2.24.4 (no `!override`) is refused at the System check.
 *  (c) C3-59 — every long-running shell loop a stack container runs as its
 *      foreground (the backup service, the certbot renewal) traps TERM: sh as
 *      PID 1 ignores a signal it has no handler for, and `compose stop` then
 *      kills it (exit 137).
 *  (d) C3-52 — the images an abort says it keeps are the stack files' own.
 *  (e) C3-48 — the image step says pull or build; deploy/certs is made once
 *      (by stack_tls when it writes a certificate there, else by stack_files
 *      on the docker route), never on the trial.
 *  (f) C3-13 — the chain walk (host/tls_trust.ts) over real openssl-minted
 *      chains: a leaf + CA trusted only when the store holds that CA (a CA
 *      with the same NAME but another key does not vouch for it), refused
 *      naming the CA and how to trust it; no system bundle: a warning.
 *
 * DB-FREE, network-free (the Docker checks run only where Docker answers, and
 * say so in their names).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { HostPlanCtx } from '../../src/core/install/host/contract.ts';
import { siteText } from '../../src/core/install/host/production/web.ts';
import { stackImages } from '../../src/core/install/host/stack/database.ts';
import {
	renderEnvFile,
	renderOverride,
	renderStackNginx,
} from '../../src/core/install/host/stack/files.ts';
import { imageLabel } from '../../src/core/install/host/stack/image.ts';
import { serviceImages, stackServiceImage } from '../../src/core/install/host/stack/images.ts';
import {
	CERT_DIR,
	CONTAINER,
	CONTAINER_MEDIA_RULES,
	TRIAL_NGINX_VOLUMES,
} from '../../src/core/install/host/stack/layout.ts';
import { composeAtLeast, MIN_COMPOSE } from '../../src/core/install/host/stack/preflight.ts';
import { STACK_HOST_STEPS } from '../../src/core/install/host/stack/table.ts';
import {
	chainTrustVerdict,
	pemCertificates,
	SYSTEM_CA_BUNDLES,
	TRUST_CA_HOWTO,
	untrustedIssuer,
} from '../../src/core/install/host/tls_trust.ts';
import { nginxRuleCopies } from '../../src/core/install/host/web/nginx.ts';
import type { StackHostStepId } from '../../src/core/install/install_plan.ts';
import {
	overrideMediaProtectionPathsForTests,
	ruleFilePaths,
	writeRuleFiles,
} from '../../src/core/media/protection.ts';
import {
	HOST_VARIANTS,
	mintCertificate,
	productionPlanCtx,
	REPO_ROOT,
	scratchFilePaths,
	stackPlanCtx,
} from '../helpers/install_host_scratch.ts';
import { PINNED_IDENTITY, pinInstallerIdentity } from '../helpers/installer_identity.ts';
import { scratchMediaRoot } from '../helpers/media_scratch_root.ts';

// The installer's release identity is the checkout's (a tagged commit says `-beta.N`, the
// next commit `.dev`) and the image decisions follow its kind: these cases are written for
// a STABLE installer, so they pin one (test/helpers/installer_identity.ts).
pinInstallerIdentity(PINNED_IDENTITY.stable);

const scratch = mkdtempSync(join(tmpdir(), 'dedalo_install_stack_nginx_'));
afterAll(() => {
	overrideMediaProtectionPathsForTests(null);
	rmSync(scratch, { recursive: true, force: true });
});

const NAME = 'dedalo.example.org';
const TRIAL = { route: 'trial', entity: 'trial_museum' };
const DOCKER_PLANS: readonly Record<string, unknown>[] = [
	{ route: 'docker', entity: 'museo', server_name: NAME, letsencrypt_email: 'ops@example.org' },
	{ route: 'docker', entity: 'museo', server_name: NAME, tls_mode: 'local_ca' },
	{
		route: 'docker',
		entity: 'museo',
		server_name: NAME,
		tls_mode: 'files',
		tls_cert_path: '/etc/ssl/museo/fullchain.pem',
		tls_key_path: '/etc/ssl/museo/privkey.pem',
	},
];

/** The include directives of a site, trimmed, in order. */
function includes(site: string): string[] {
	return site
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith('include '));
}

/** A scratch media root the ENGINE's rule writer may write (declared, marked). */
function engineMediaRoot(): string {
	const root = scratchMediaRoot('dedalo_stack_media_');
	overrideMediaProtectionPathsForTests({ mediaRoot: root, authStorePath: join(root, '.auth') });
	return root;
}

/** Does `docker` answer here (and, when named, is the image present)? */
function dockerReady(image?: string): boolean {
	const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 20_000 });
	if (info.status !== 0) return false;
	if (image === undefined) return true;
	return spawnSync('docker', ['image', 'inspect', image], { timeout: 20_000 }).status === 0;
}

// ── (a) C3-2 ─────────────────────────────────────────────────────────────────

describe("the full stack's nginx site includes the engine's own rule files (C3-2)", () => {
	test('the stack names exactly the files the engine writes (its writer, not a literal)', () => {
		engineMediaRoot();
		const engine = ruleFilePaths();
		overrideMediaProtectionPathsForTests(null);
		expect(engine).not.toBeNull();
		expect(String(CONTAINER_MEDIA_RULES.server)).toBe(
			`${CONTAINER.media}/${basename(engine?.nginx ?? '')}`,
		);
		expect(String(CONTAINER_MEDIA_RULES.map)).toBe(
			`${CONTAINER.media}/${basename(engine?.nginxMap ?? '')}`,
		);
	});

	for (const raw of DOCKER_PLANS) {
		test(`docker (${String(raw.tls_mode ?? 'letsencrypt')}): the map at http scope, the rules in the https server, nothing under /etc/nginx/dedalo`, () => {
			const site = renderStackNginx(stackPlanCtx(raw));
			expect(includes(site)).toEqual([
				`include ${CONTAINER_MEDIA_RULES.map};`,
				`include ${CONTAINER_MEDIA_RULES.server};`,
			]);
			expect(site).not.toContain('/etc/nginx/dedalo');
			const lines = site.split('\n');
			const map = lines.indexOf(`include ${CONTAINER_MEDIA_RULES.map};`);
			const https = lines.findIndex((line) => line.includes('listen 443 ssl;'));
			const rules = lines.indexOf(`\tinclude ${CONTAINER_MEDIA_RULES.server};`);
			expect(map).toBeLessThan(lines.indexOf('server {'));
			expect(rules).toBeGreaterThan(https);
		});
	}

	test('the media gate off: neither include (the engine writes no rule file then)', () => {
		const site = renderStackNginx(
			stackPlanCtx({ ...(DOCKER_PLANS[1] as Record<string, unknown>), media_access_mode: 'false' }),
		);
		expect(site).toContain('MEDIA ACCESS CONTROL IS OFF');
		expect(includes(site).length).toBe(0);
		expect(site).not.toContain('/etc/nginx/dedalo');
	});

	test('a production site still includes its root-owned copies, with its own lines', () => {
		const variant = HOST_VARIANTS.find((entry) => entry.web === 'nginx');
		expect(variant).toBeDefined();
		const ctx = productionPlanCtx(variant as (typeof HOST_VARIANTS)[number]);
		const site = siteText(ctx, { fullchain: '/x/fullchain.pem', key: '/x/privkey.pem' });
		const copy = nginxRuleCopies(ctx.paths.instance).server;
		expect(copy).toStartWith('/etc/nginx/dedalo/');
		expect(site).toContain(
			[
				'\t# The media gate: a root-owned, validated copy of the rules the engine generates',
				'\t# (deploy/dedalo-media-rules.sh — never the instance-writable file itself).',
				`\tinclude ${copy};`,
			].join('\n'),
		);
		expect(site).not.toContain('/srv/dedalo/media/dedalo_media_protection');
	});

	/** The full stack's own pinned nginx (T1-17: never a second spelling). */
	const NGINX_IMAGE = stackServiceImage(REPO_ROOT, 'docker-compose.yml', 'nginx');
	test.skipIf(!dockerReady(NGINX_IMAGE))(
		`nginx -t in ${NGINX_IMAGE} over rule files the engine wrote accepts the site (skipped without Docker or the image)`,
		() => {
			const media = engineMediaRoot();
			expect(writeRuleFiles('publication')).toBe(true);
			overrideMediaProtectionPathsForTests(null);
			const certs = join(scratch, 'certs');
			mkdirSync(certs, { recursive: true });
			const { cert, key } = mintCertificate(NAME);
			writeFileSync(join(certs, 'fullchain.pem'), cert);
			writeFileSync(join(certs, 'privkey.pem'), key);
			const site = join(scratch, 'site.conf');
			writeFileSync(
				site,
				renderStackNginx(stackPlanCtx(DOCKER_PLANS[1] as Record<string, unknown>)),
			);
			const run = spawnSync(
				'docker',
				[
					'run',
					'--rm',
					'-v',
					`${site}:/etc/nginx/conf.d/default.conf:ro`,
					'-v',
					`${media}:${CONTAINER.media}:ro`,
					'-v',
					`${certs}:/etc/dedalo/certs:ro`,
					NGINX_IMAGE,
					'nginx',
					'-t',
				],
				{ encoding: 'utf8', timeout: 120_000 },
			);
			expect(run.stderr).toContain('test is successful');
			expect(run.status).toBe(0);
		},
		150_000,
	);
});

// ── (b) C3-22 ────────────────────────────────────────────────────────────────

/** A compose file's services, parsed. */
function servicesOf(text: string): Record<string, Record<string, unknown>> {
	return (Bun.YAML.parse(text) as { services: Record<string, Record<string, unknown>> }).services;
}

/** Is a volume entry one of the certificate mounts the trial does without? */
function certificateVolume(entry: string): boolean {
	return /^(letsencrypt|certbot_www):|^\.\/deploy\/certs:/.test(entry);
}

describe('the trial publishes plain HTTP only (C3-22)', () => {
	const override = renderOverride(stackPlanCtx(TRIAL));
	const simple = readFileSync(join(REPO_ROOT, 'docker-compose.simple.yml'), 'utf8');

	test("its override REPLACES nginx's ports and volumes: the HTTP port, the stack file's volumes minus the certificate ones", () => {
		expect(override).toContain('    ports: !override\n');
		expect(override).toContain('    volumes: !override\n');
		const nginx = servicesOf(override).nginx ?? {};
		expect(nginx.ports).toEqual(['${DEDALO_HTTP_PORT:-80}:80']);
		const base = (servicesOf(simple).nginx?.volumes ?? []) as string[];
		const dropped = base.filter(certificateVolume);
		expect(dropped.length).toBe(3);
		expect(nginx.volumes).toEqual(base.filter((entry) => !certificateVolume(entry)));
		expect(nginx.volumes).toEqual([...TRIAL_NGINX_VOLUMES]);
	});

	test('.dedalo.env: no HTTPS port on the trial; the docker route keeps it', () => {
		expect(renderEnvFile(stackPlanCtx(TRIAL), 'pw')).not.toContain('DEDALO_HTTPS_PORT=');
		expect(renderEnvFile(stackPlanCtx(DOCKER_PLANS[0] as Record<string, unknown>), 'pw')).toContain(
			'DEDALO_HTTPS_PORT=443',
		);
	});

	test(`Compose ${MIN_COMPOSE.join('.')} or newer (the override's \`!override\` tag)`, () => {
		const cases: [string | null, boolean][] = [
			['2.24.3', false],
			['2.24.4', true],
			['2.39.1', true],
			['2.3', false],
			['5.5.1', true],
			['2.29.1-desktop.1', true],
			[null, false],
		];
		for (const [version, ok] of cases)
			expect([version, composeAtLeast(version, MIN_COMPOSE)]).toEqual([version, ok]);
	});

	test.skipIf(!dockerReady())(
		"compose config: the trial stack resolves no 443 and no Let's Encrypt volume (skipped without Docker)",
		() => {
			const dir = join(scratch, 'trial');
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, 'compose.override.yaml'), override);
			writeFileSync(join(dir, '.dedalo.env'), renderEnvFile(stackPlanCtx(TRIAL), 'pw'));
			const run = spawnSync(
				'docker',
				[
					'compose',
					'-f',
					join(REPO_ROOT, 'docker-compose.simple.yml'),
					'-f',
					join(dir, 'compose.override.yaml'),
					'--env-file',
					join(dir, '.dedalo.env'),
					'config',
					'--format',
					'json',
				],
				{ encoding: 'utf8', timeout: 60_000 },
			);
			expect(run.stderr).not.toContain('error');
			const config = JSON.parse(run.stdout) as {
				services: Record<string, { ports?: { target: number }[] }>;
				volumes: Record<string, unknown>;
			};
			expect((config.services.nginx?.ports ?? []).map((port) => port.target)).toEqual([80]);
			expect(Object.keys(config.volumes).sort()).toEqual([
				'backups',
				'client',
				'media',
				'pgdata',
				'private',
				'socket',
			]);
		},
		90_000,
	);
});

// ── (c) C3-59 ────────────────────────────────────────────────────────────────

/** The shell script of an entrypoint/command (`sh -c "<script>"` or [sh, -c, script]). */
function scriptOf(value: unknown): string {
	if (Array.isArray(value)) return String(value.at(-1) ?? '');
	return String(value ?? '')
		.replace(/^\s*sh -c "/, '')
		.replace(/"\s*$/, '');
}

/** Does a script run a loop as its FOREGROUND (it ends with the loop's `done`)? */
function loopsInForeground(script: string): boolean {
	const code = script
		.split('\n')
		.filter((line) => !line.trim().startsWith('#'))
		.join('\n')
		.trim();
	return /\bwhile\b/.test(code) && /\bdone;?$/.test(code);
}

describe('a long-running shell loop stops on SIGTERM (C3-59)', () => {
	const sources: [string, string][] = [
		['docker-compose.yml', readFileSync(join(REPO_ROOT, 'docker-compose.yml'), 'utf8')],
		[
			'docker-compose.simple.yml',
			readFileSync(join(REPO_ROOT, 'docker-compose.simple.yml'), 'utf8'),
		],
		[
			"the Let's Encrypt override",
			renderOverride(stackPlanCtx(DOCKER_PLANS[0] as Record<string, unknown>)),
		],
	];
	const loops = sources.flatMap(([file, text]) =>
		Object.entries(servicesOf(text)).flatMap(([service, spec]) =>
			[spec.entrypoint, spec.command]
				.map(scriptOf)
				.filter(loopsInForeground)
				.map((script) => ({ where: `${file} ${service}`, script })),
		),
	);

	test('the census finds the loops (backup in both stacks, the certbot renewals)', () => {
		expect(loops.map((loop) => loop.where).sort()).toEqual([
			'docker-compose.simple.yml backup',
			'docker-compose.simple.yml certbot',
			'docker-compose.yml backup',
			// T1-17: the full stack's renewal lives in the stack file (the override only enables it).
			'docker-compose.yml certbot',
		]);
	});

	test('each traps TERM', () => {
		const untrapped = loops.filter((loop) => !/\btrap\b[^\n;]*\bTERM\b/.test(loop.script));
		expect(untrapped.map((loop) => loop.where)).toEqual(
			loops.slice(0, 0).map((loop) => loop.where),
		);
		expect(loops.length).toBeGreaterThanOrEqual(4);
	});
});

// ── (d) C3-52, (e) C3-48 ─────────────────────────────────────────────────────

describe('the abort names the images it keeps (C3-52)', () => {
	test("the service images are the stack files' own (no profile, not the Dédalo image)", () => {
		const routes = {
			'docker-compose.yml': DOCKER_PLANS[1] as Record<string, unknown>,
			'docker-compose.simple.yml': TRIAL,
		};
		for (const [file, variant] of Object.entries(routes)) {
			const images = Object.values(servicesOf(readFileSync(join(REPO_ROOT, file), 'utf8')))
				.filter((spec) => spec.profiles === undefined)
				.map((spec) => String(spec.image ?? ''))
				.filter((image) => image !== '' && !image.includes('DEDALO_IMAGE'));
			const derived = serviceImages(stackPlanCtx(variant));
			expect(images.length).toBeGreaterThanOrEqual(2);
			expect([file, [...new Set(images)].sort()]).toEqual([file, [...derived].sort()]);
		}
		const kept = stackImages(stackPlanCtx(TRIAL));
		for (const image of serviceImages(stackPlanCtx(TRIAL))) expect(kept).toContain(image);
		expect(kept.join(' ')).not.toContain('certbot');
	});
});

/** The deploy/certs mkdirs among every planned stack step's commands. */
function certDirMakes(ctx: HostPlanCtx): number {
	return (ctx.plan.steps as StackHostStepId[])
		.flatMap((step) => STACK_HOST_STEPS[step].commands(ctx))
		.filter((command) => command.kind === 'mkdir' && command.path.endsWith(`/${CERT_DIR}`)).length;
}

describe('route- and source-specific steps (C3-48)', () => {
	test('deploy/certs: never on the trial, once on the docker route whatever the certificate source', () => {
		expect(certDirMakes(stackPlanCtx(TRIAL))).toBe(0);
		for (const raw of DOCKER_PLANS)
			expect([raw.tls_mode, certDirMakes(stackPlanCtx(raw))]).toEqual([raw.tls_mode, 1]);
	});

	test('the image step says pull and verify, pull from your registry, or build here', () => {
		const label = (raw: Record<string, unknown>) => imageLabel(stackPlanCtx(raw).answers);
		expect(label(TRIAL)).toStartWith('pull the image ');
		expect(label(TRIAL)).toContain("verify Dédalo's signature");
		expect(label({ ...TRIAL, image_source: 'build' })).toStartWith(
			'build the image localhost/dedalo:',
		);
		expect(
			label({
				...TRIAL,
				image_source: 'custom',
				image_repository: 'registry.example.org/heritage/dedalo',
			}),
		).toContain('from your registry (no Dédalo signature to check)');
	});

	test("the health step says it probes the engine's socket, then the published address", () => {
		const trial = stackPlanCtx(TRIAL);
		expect(STACK_HOST_STEPS.stack_health.label(trial.plan)).toBe(
			"/health on the engine's socket and through http://localhost (the trial stack: NO media protection)",
		);
		const docker = stackPlanCtx(DOCKER_PLANS[0] as Record<string, unknown>);
		expect(STACK_HOST_STEPS.stack_health.label(docker.plan)).toBe(
			`/health on the engine's socket and through https://${NAME}, and the media gate`,
		);
	});
});

// ── C3-13: the chain walk against a trust store ──────────────────────────────

/** A CA and a leaf it signed (openssl, in the scratch dir). */
function mintChain(caName: string, leafName: string): { ca: string; leaf: string } {
	const dir = mkdtempSync(join(scratch, 'chain_'));
	const run = (args: string[]) => {
		const result = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
		if (result.status !== 0) throw new Error(`openssl ${args[0]} failed: ${result.stderr}`);
	};
	const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
	run([
		'req',
		'-x509',
		...ec,
		'-keyout',
		'ca.key',
		'-out',
		'ca.pem',
		'-subj',
		`/CN=${caName}`,
		'-days',
		'30',
	]);
	run([
		'req',
		'-new',
		...ec,
		'-keyout',
		'leaf.key',
		'-out',
		'leaf.csr',
		'-subj',
		`/CN=${leafName}`,
	]);
	run([
		'x509',
		'-req',
		'-in',
		'leaf.csr',
		'-CA',
		'ca.pem',
		'-CAkey',
		'ca.key',
		'-CAcreateserial',
		'-out',
		'leaf.pem',
		'-days',
		'30',
	]);
	return {
		ca: readFileSync(join(dir, 'ca.pem'), 'utf8'),
		leaf: readFileSync(join(dir, 'leaf.pem'), 'utf8'),
	};
}

describe("tls_trust: does this machine's store vouch for the chain (C3-13)", () => {
	const { ca, leaf } = mintChain('Museo Internal CA', NAME);
	const stranger = mintChain('Some Other CA', 'other.example.org').ca;

	// The chains the trust tests read are real files openssl wrote into the scratch tree:
	// an empty listing would mean no fixture was minted and every verdict below vacuous.
	test('the minted chains are on disk (anti-vacuity)', () => {
		const listed = scratchFilePaths(scratch).filter((path) => path.endsWith('.pem'));
		expect(listed.length).toBeGreaterThan(3);
	});

	test('leaf + its CA, the CA in the store: trusted; not in the store: refused naming the CA', () => {
		expect(chainTrustVerdict(`${leaf}${ca}`, [`${stranger}${ca}`])).toEqual({
			problem: null,
			warning: null,
		});
		const refused = chainTrustVerdict(`${leaf}${ca}`, [stranger]).problem ?? '';
		expect(refused).toContain(
			'its chain ends at CN=Museo Internal CA, which this machine does not trust',
		);
		expect(refused).toContain(TRUST_CA_HOWTO);
	});

	test('a leaf alone, its issuer in the store: trusted (the anchor signs it)', () => {
		expect(untrustedIssuer(pemCertificates(leaf), pemCertificates(ca))).toBeNull();
		expect(untrustedIssuer(pemCertificates(leaf), pemCertificates(stranger))).toBe(
			'CN=Museo Internal CA',
		);
	});

	test('a CA NAMED like the issuer but holding another key does not vouch for it', () => {
		const impostor = mintChain('Museo Internal CA', 'x.example.org').ca;
		expect(untrustedIssuer(pemCertificates(leaf), pemCertificates(impostor))).toBe(
			'CN=Museo Internal CA',
		);
	});

	test('no system bundle at all: a warning, never a refusal', () => {
		const verdict = chainTrustVerdict(`${leaf}${ca}`, [null, null, null]);
		expect(verdict.problem).toBeNull();
		expect(verdict.warning).toContain('no system CA bundle found');
		expect(SYSTEM_CA_BUNDLES.length).toBe(3);
	});
});
