/**
 * stack_files — THE STACK'S OWN FILES (terminal installer phase 4, 2026-10-12),
 * written into the checkout, owned by the operator:
 *
 *  - `.dedalo.env` (0600): the compose environment — the database credentials
 *    (the password GENERATED here, never shown, never in argv: the Review
 *    shows the file with a placeholder in its place, and its hash), the TLS
 *    decision (which nginx config, whether the session cookie is Secure — the
 *    two values ONE decision, compose_invocation_tripwire), the published
 *    ports, and the image contract deploy/dedalo-image-lib.sh reads
 *    (DEDALO_COMPOSE_FILE, DEDALO_IMAGE, DEDALO_VERSION, DEDALO_IMAGE_MODE,
 *    DEDALO_IMAGE_VERIFY) — so the image updater takes its image from where
 *    this install took it;
 *  - `compose.override.yaml`: what the stack files cannot say through a
 *    variable — the Let's Encrypt renewal service and its volumes (docker +
 *    Let's Encrypt), the trial's plain-HTTP nginx (trial), else an empty override. The host library adds it to every
 *    compose call, so the updater drives the SAME stack;
 *  - the full stack's nginx site (docker): host/web/nginx.ts's renderer — the
 *    same routes, headers and media gate as a production site — for the
 *    container's paths (root /srv, MEDIA_PATH /srv/dedalo/media, the client
 *    volume, the socket volume), with the media gate's http-scope map include
 *    — both includes name the ENGINE'S OWN rule files in the media volume
 *    (layout.ts CONTAINER_MEDIA_RULES, campaign 3 C3-2), and both are left out
 *    together when the media access mode is off — listening on the
 *    container's 80/443 and redirecting to the PUBLISHED https port.
 *
 * Trial mounts the shipped plain-HTTP deploy/nginx.simple.conf (no certificate,
 * no media gate — its own route); its override publishes only the HTTP port and
 * mounts no certificate (C3-22). --abort removes only what this install wrote.
 */

import type {
	HostCommand,
	HostCtx,
	HostPlanCtx,
	HostStepDefinition,
	WriteCommand,
} from '../contract.ts';
import { executeCommands } from '../execute.ts';
import { answersDigest, ran, remember, verdictOf } from '../production/common.ts';
import { hostRefuse } from '../refuse.ts';
import { dropinStamp } from '../systemd/render.ts';
import { renderNginxSite } from '../web/nginx.ts';
import { mediaGated } from '../web/site.ts';
import {
	certDirCommand,
	databasePassword,
	envFileValue,
	generatedPassword,
	inCheckout,
	stackCreated,
} from './common.ts';
import { stackFactsOf } from './facts.ts';
import {
	CERT_DIR,
	CERT_MOUNT,
	CONTAINER,
	CONTAINER_MEDIA_RULES,
	certPathsOf,
	ENV_FILE,
	GENERATED_CONF,
	imageModeOf,
	imageRepositoryOf,
	imageVerifyOf,
	imageVersionOf,
	nginxConfOf,
	OVERRIDE_FILE,
	servesTls,
	stackFileOf,
	TRIAL_NGINX_VOLUMES,
} from './layout.ts';

/** What the Review shows (and the digest hashes) in place of the generated password. */
export const PASSWORD_PLACEHOLDER = '@@GENERATED_AT_INSTALL_NEVER_SHOWN@@';

/** The stamp every file this install writes starts with. */
function stampOf(ctx: HostPlanCtx): string {
	return dropinStamp(ctx.answers.route, answersDigest(ctx.plan));
}

/** The TLS half of .dedalo.env (ONE decision: the proxy config and the cookie's Secure flag). */
function tlsLines(ctx: HostPlanCtx): string[] {
	const { answers } = ctx;
	return [
		`# TLS: ${answers.route === 'trial' ? 'none — the trial stack serves plain HTTP' : answers.tls_mode}`,
		`DEDALO_NGINX_CONF=${nginxConfOf(answers)}`,
		`SESSION_COOKIE_SECURE=${servesTls(answers) ? 'true' : 'false'}`,
		`DEDALO_CERT_MOUNT=${CERT_MOUNT}`,
		`DEDALO_HTTP_PORT=${answers.http_port}`,
		// Trial publishes no HTTPS port (its override replaces nginx's ports — C3-22).
		...(answers.route === 'docker' ? [`DEDALO_HTTPS_PORT=${answers.https_port}`] : []),
		...(answers.route === 'docker' && answers.media_access_mode !== ''
			? [`DEDALO_MEDIA_ACCESS_MODE=${answers.media_access_mode}`]
			: []),
	];
}

/** The image half: deploy/dedalo-image-lib.sh's contract (its key order). */
function imageLines(ctx: HostPlanCtx): string[] {
	const { answers } = ctx;
	return [
		'# Where the Dédalo image comes from — read by compose (the image the dedalo and',
		'# backup services run) and, through deploy/dedalo-image-lib.sh, by the image',
		'# updater. Only the image updater rewrites it, and only DEDALO_VERSION.',
		`DEDALO_COMPOSE_FILE=${stackFileOf(answers)}`,
		`DEDALO_IMAGE=${imageRepositoryOf(answers)}`,
		// The image TAG of the installer's release identity (`7.0.0`, `7.0.0-beta.7`, `7.0.0-dev`):
		// a beta's stack is pinned to its own image, never to the bare `7.0.0` (C3i-F1).
		`DEDALO_VERSION=${imageVersionOf(answers)}`,
		`DEDALO_IMAGE_MODE=${imageModeOf(answers)}`,
		`DEDALO_IMAGE_VERIFY=${imageVerifyOf(answers)}`,
	];
}

/** .dedalo.env with `password` in its place (the placeholder for the Review). */
export function renderEnvFile(ctx: HostPlanCtx, password: string = PASSWORD_PLACEHOLDER): string {
	const { answers } = ctx;
	return [
		stampOf(ctx),
		`# Written by the installer (scripts/install.ts, ${answers.route} route) — compose variable`,
		"# substitution only. The engine's own configuration lives in the 'private' volume,",
		'# at /private/.env. Holds the database password: 0600, never committed.',
		`POSTGRES_DB=${answers.db_database}`,
		`POSTGRES_USER=${answers.db_username}`,
		`POSTGRES_PASSWORD=${password}`,
		...tlsLines(ctx),
		...imageLines(ctx),
		'',
	].join('\n');
}

/**
 * The Let's Encrypt renewal: the full stack's `certbot` service switched ON
 * (`profiles: !reset []` — Compose >= 2.24.4, which stack_preflight requires),
 * nginx mounting the certificate volumes and reloading to pick renewals up. The
 * certbot image, volumes and renewal loop come from docker-compose.yml itself:
 * this override spells NO image (T1-17 — a second spelling is the unpinned
 * `certbot/certbot` it used to carry).
 */
function letsEncryptOverride(): string[] {
	return [
		'services:',
		'  nginx:',
		'    command: >',
		`      sh -c "addgroup -g 1000 dedalo 2>/dev/null; addgroup nginx dedalo 2>/dev/null; while :; do sleep 6h & wait $\${!}; nginx -s reload; done & exec /docker-entrypoint.sh nginx -g 'daemon off;'"`,
		'    volumes:',
		`      - letsencrypt:${CONTAINER.letsencrypt}:ro`,
		`      - certbot_www:${CONTAINER.acmeWebroot}:ro`,
		'  certbot:',
		"    # Enabled here; image, volumes and renewal loop are docker-compose.yml's.",
		'    profiles: !reset []',
	];
}

/**
 * The trial's plain-HTTP nginx (campaign 3 C3-22): the simple stack file
 * publishes 443 and mounts the certificate volumes for its own TLS variant
 * (deploy/nginx.simple-tls.conf.tpl); the trial serves neither, so its nginx
 * gets ONLY the HTTP port and the volumes plain HTTP needs (`!override`
 * replaces the list — Compose >= 2.24.4, which stack_preflight requires).
 * Unused, the certificate volumes are never created.
 */
function trialOverride(): string[] {
	return [
		'services:',
		'  nginx:',
		'    # Plain HTTP only: no 443, no certificate volumes (the trial has no TLS).',
		'    ports: !override',
		'      - "${DEDALO_HTTP_PORT:-80}:80"',
		'    volumes: !override',
		...TRIAL_NGINX_VOLUMES.map((volume) => `      - ${volume}`),
	];
}

/** The override's body for this route and certificate source. */
function overrideBody(ctx: HostPlanCtx): string[] {
	if (ctx.answers.route === 'trial') return trialOverride();
	return ctx.answers.tls_mode === 'letsencrypt' ? letsEncryptOverride() : ['services: {}'];
}

/** compose.override.yaml (the renewal service, the trial's plain-HTTP nginx, or nothing to add). */
export function renderOverride(ctx: HostPlanCtx): string {
	return [
		stampOf(ctx),
		`# WRITTEN BY THE INSTALLER (scripts/install.ts, ${ctx.answers.route} route). deploy/dedalo-image-lib.sh`,
		'# adds this file to every compose call when it exists, so the image updater and your own',
		'# commands drive the stack this install built. Re-run the installer rather than editing it.',
		...overrideBody(ctx),
		'',
	].join('\n');
}

/** The redirect the renderer writes (to https on the container's 443). */
const REDIRECT = 'return 301 https://$host$request_uri;';

/** The full stack's site: the production renderer, for the container's places. */
export function renderStackNginx(ctx: HostPlanCtx): string {
	const { answers } = ctx;
	const site = renderNginxSite({
		paths: {
			...ctx.paths,
			instance: 'docker',
			socket: CONTAINER.socket,
			media: CONTAINER.media,
			webRoot: CONTAINER.webRoot,
			mediaDir: CONTAINER.mediaDir,
			clientPublish: CONTAINER.client,
			acmeDir: CONTAINER.acmeWebroot,
		},
		answers: { ...answers, http_port: '80', https_port: '443' },
		stamp: stampOf(ctx),
		cert: certPathsOf(answers),
		acme: answers.tls_mode === 'letsencrypt',
		logDir: '/var/log/nginx',
		mediaRules: {
			...CONTAINER_MEDIA_RULES,
			note: [
				'The media gate: the rules the engine generates into the shared media volume',
				'(mounted read-only here; the engine writes them at boot, before nginx starts).',
			],
		},
	});
	const map = mediaGated(answers) ? CONTAINER_MEDIA_RULES.map : null;
	return withMapInclude(dockerHeader(ctx, site), map).replace(
		REDIRECT,
		`return 301 https://$host${answers.https_port === '443' ? '' : `:${answers.https_port}`}$request_uri;`,
	);
}

/** The site with the renderer's header (a production site's words) replaced by this stack's. */
function dockerHeader(ctx: HostPlanCtx, site: string): string {
	const lines = site.split('\n');
	const body = lines.indexOf('');
	return [
		stampOf(ctx),
		"# The full stack's nginx site — WRITTEN BY THE INSTALLER (scripts/install.ts, docker route),",
		'# mounted by docker-compose.yml through DEDALO_NGINX_CONF in .dedalo.env. Change the answers and',
		'# re-run the installer rather than editing it: a resume compares it with its own render.',
		...lines.slice(body),
	].join('\n');
}

/**
 * The media gate's http-scope map include, before the first http-scope
 * directive — whenever the server-scope rules are included (the gate on: both
 * or neither; with DEDALO_MEDIA_ACCESS_MODE false the engine writes no rule
 * file, so an include of the map would stop nginx). The renderer's shape is
 * asserted, never assumed.
 */
function withMapInclude(site: string, map: string | null): string {
	const lines = site.split('\n');
	const at = lines.findIndex((line) => line.startsWith('limit_req_zone '));
	if (at < 0 || !site.includes(REDIRECT)) {
		hostRefuse(
			'install.step_failed',
			'the nginx renderer no longer writes the shape this step adapts (limit_req_zone, the https redirect)',
		);
	}
	return [...lines.slice(0, at), ...mapLines(map), ...lines.slice(at)].join('\n');
}

/** The http-scope lines of the media gate (or why there are none). */
function mapLines(map: string | null): string[] {
	if (map === null) {
		return ['# MEDIA ACCESS CONTROL IS OFF: no media gate, so no http-scope map to include.'];
	}
	return [
		"# THE MEDIA GATE: its http-scope map (generated by the engine at boot) — the server's",
		'# rule file is included in the https server below. Both or neither.',
		`include ${map};`,
	];
}

/** One write, owned by the operator. */
function operatorWrite(
	ctx: HostPlanCtx,
	relative: string,
	mode: number,
	content: string,
	label: string,
): WriteCommand {
	const facts = stackFactsOf(ctx);
	return {
		kind: 'write',
		path: inCheckout(ctx, relative),
		mode,
		owner: facts.user,
		group: facts.group,
		content,
		label,
	};
}

/** The env file's write (the placeholder in the password's place). */
function envWrite(ctx: HostPlanCtx): WriteCommand {
	return operatorWrite(
		ctx,
		ENV_FILE,
		0o600,
		renderEnvFile(ctx),
		`${ENV_FILE}: the stack's environment (the database password generated, never shown)`,
	);
}

/**
 * Does this step make deploy/certs? Only on the docker route, and only when
 * stack_tls does not (it makes it for a local CA and the institution's files);
 * Let's Encrypt keeps its certificate in a volume, but docker-compose.yml still
 * bind-mounts the directory, and compose would create a missing one as root.
 * The trial mounts no certificate (its override), so it gets none (C3-48).
 */
function makesCertDir(ctx: HostPlanCtx): boolean {
	return ctx.answers.route === 'docker' && !['local_ca', 'files'].includes(ctx.answers.tls_mode);
}

/** The writes after the env file (the override, the full stack's site) and deploy/certs. */
function otherCommands(ctx: HostPlanCtx): HostCommand[] {
	const docker = ctx.answers.route === 'docker';
	return [
		operatorWrite(
			ctx,
			OVERRIDE_FILE,
			0o644,
			renderOverride(ctx),
			`${OVERRIDE_FILE}: the installer's compose override`,
		),
		...(docker
			? [
					operatorWrite(
						ctx,
						`deploy/${GENERATED_CONF}`,
						0o644,
						renderStackNginx(ctx),
						'the nginx site of the full stack (media gate on)',
					),
				]
			: []),
		...(makesCertDir(ctx) ? [certDirCommand(ctx)] : []),
	];
}

export function filesCommands(ctx: HostPlanCtx): HostCommand[] {
	return [envWrite(ctx), ...otherCommands(ctx)];
}

/** The password: the one .dedalo.env already holds (a resumed run), else a new one. */
function passwordFor(ctx: HostCtx): string {
	return databasePassword(ctx) || generatedPassword();
}

async function runFiles(ctx: HostCtx) {
	const env = envWrite(ctx);
	const password = passwordFor(ctx);
	ctx.fs.write(env.path, renderEnvFile(ctx, password), env.mode, env.owner, env.group);
	await executeCommands(otherCommands(ctx), ctx);
	return ran(
		`${ENV_FILE} (0600), ${OVERRIDE_FILE}${ctx.answers.route === 'docker' ? `, deploy/${GENERATED_CONF}` : ''} written`,
	);
}

/** The env file holds the render with ITS password, at 0600. */
function envChecks(ctx: HostCtx): [boolean, string][] {
	const path = inCheckout(ctx, ENV_FILE);
	const text = ctx.fs.readText(path);
	const password = envFileValue(text, 'POSTGRES_PASSWORD');
	return [
		[/^[A-Za-z0-9]{32}$/.test(password), `${path} holds no generated database password`],
		[text === renderEnvFile(ctx, password), `${path} differs from the installer's render`],
		[(ctx.fs.stat(path)?.mode ?? 0) === 0o600, `${path} is not mode 0600`],
	];
}

/** Every other write in place, byte-equal. */
function writeChecks(ctx: HostCtx): [boolean, string][] {
	return otherCommands(ctx)
		.filter((command): command is WriteCommand => command.kind === 'write')
		.map((write) => [
			ctx.fs.readText(write.path) === write.content,
			`${write.path} differs from the installer's render`,
		]);
}

function filesIntent(ctx: HostCtx): void {
	const created = stackCreated(ctx);
	created.env_file ||= !ctx.fs.exists(inCheckout(ctx, ENV_FILE));
	created.override ||= !ctx.fs.exists(inCheckout(ctx, OVERRIDE_FILE));
	if (makesCertDir(ctx) && !ctx.fs.exists(inCheckout(ctx, CERT_DIR))) {
		remember(created.certs, inCheckout(ctx, CERT_DIR));
	}
	if (ctx.answers.route !== 'docker') return;
	created.generated_conf ||= !ctx.fs.exists(inCheckout(ctx, `deploy/${GENERATED_CONF}`));
}

/** The files this install wrote (checkout-relative), by its record. */
function writtenFiles(ctx: HostCtx): string[] {
	const created = stackCreated(ctx);
	const files: [boolean, string][] = [
		[created.env_file, ENV_FILE],
		[created.override, OVERRIDE_FILE],
		[created.generated_conf, `deploy/${GENERATED_CONF}`],
	];
	return files.filter(([wrote]) => wrote).map(([, relative]) => relative);
}

async function undoFiles(ctx: HostCtx): Promise<string> {
	const created = stackCreated(ctx);
	const removed = writtenFiles(ctx);
	for (const relative of removed) ctx.fs.remove(inCheckout(ctx, relative));
	const certDir = inCheckout(ctx, CERT_DIR);
	if (created.certs.includes(certDir) && ctx.fs.rmdirIfEmpty(certDir)) {
		created.certs = created.certs.filter((path) => path !== certDir);
	}
	return removed.length === 0 ? 'nothing was written' : `removed ${removed.join(', ')}`;
}

export const stack_files: HostStepDefinition = {
	id: 'stack_files',
	privilege: 'operator',
	kind: 'action',
	needs: [],
	label: (plan) =>
		`${ENV_FILE}, ${OVERRIDE_FILE}${plan.answers.route === 'docker' ? `, deploy/${GENERATED_CONF}` : ''}`,
	commands: filesCommands,
	verify: async (ctx) =>
		verdictOf([...envChecks(ctx), ...writeChecks(ctx)], 'the stack files are in place'),
	run: runFiles,
	intent: filesIntent,
	undo: undoFiles,
};
