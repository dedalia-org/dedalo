/**
 * stack_tls — THE DOCKER ROUTE'S CERTIFICATE (terminal installer phase 4,
 * 2026-10-12). Planned on the docker route only (trial serves plain HTTP — its
 * own route). Three sources, one result nginx reads:
 *
 *  - letsencrypt: certbot in its own container, `--standalone` on the host's
 *    port 80 BEFORE nginx exists (no chicken-and-egg: nginx cannot start on
 *    443 without the certificate it is here to fetch), into the
 *    `dedalo_letsencrypt` volume as `live/dedalo/`; renewal later goes through
 *    the running nginx (the override's certbot service, webroot), so the
 *    proxy never stops. `--keep-until-expiring`: a resumed run never re-issues;
 *  - local_ca: deploy/dedalo-tls-rotate.sh --mode local-ca — the ONE generator
 *    of local-CA material, the same script a rotation runs (so the certificate
 *    an install gets and a rotation gets cannot drift in SAN, lifetime or modes;
 *    the authority is name-constrained to the install's names, its root key
 *    deleted at issue — engineering/PRODUCTION.md §13.2); skipped when its CA
 *    and certificate are already there — and REFUSED when that authority
 *    cannot serve the answered addresses (stackAuthorityConflict);
 *  - files: the institution's fullchain + key, CHECKED by stack_preflight
 *    (address, expiry, key), COPIED into deploy/certs (key 0600) — a later
 *    `compose up` cannot break on a path that moved.
 *
 * --abort removes only what this install created: the copied/generated files,
 * the Let's Encrypt volumes it created.
 */

import { resolve } from 'node:path';
import type { HostCommand, HostCtx, HostPlanCtx, HostStepDefinition } from '../contract.ts';
import { executeCommands } from '../execute.ts';
import { probeOk, ran, remember, verdictOf } from '../production/common.ts';
import { hostRefuse } from '../refuse.ts';
import { authorityConflict } from '../tls_authority.ts';
import { checkCertificateFiles } from '../tls_files.ts';
import { siteNames } from '../web/site.ts';
import { certDirCommand, inCheckout, rememberNewVolumes, stackCreated } from './common.ts';
import { dockerCommand, dockerProbe, stackExec } from './compose.ts';
import { STACK_BINARIES, stackFactsOf } from './facts.ts';
import { certbotImage } from './images.ts';
import {
	CERT_DIR,
	CONTAINER,
	LE_CERT_NAME,
	LE_VOLUME,
	LE_WEBROOT_VOLUME,
	LOCAL_CA_FILE,
} from './layout.ts';

/** The certificate files in deploy/certs (host paths). */
function certFiles(ctx: HostPlanCtx): { fullchain: string; key: string } {
	return {
		fullchain: inCheckout(ctx, `${CERT_DIR}/fullchain.pem`),
		key: inCheckout(ctx, `${CERT_DIR}/privkey.pem`),
	};
}

/** Let's Encrypt: certbot standalone on the host's port 80, into the stack's volumes. */
function letsEncryptCommands(ctx: HostPlanCtx): HostCommand[] {
	const { answers } = ctx;
	return [
		dockerCommand(
			ctx,
			[
				'run',
				'--rm',
				'-p',
				`${answers.http_port}:80`,
				'-v',
				`${LE_VOLUME}:${CONTAINER.letsencrypt}`,
				'-v',
				`${LE_WEBROOT_VOLUME}:${CONTAINER.acmeWebroot}`,
				certbotImage(ctx),
				'certonly',
				'--standalone',
				...(answers.letsencrypt_staging ? ['--staging'] : []),
				'--cert-name',
				LE_CERT_NAME,
				'-d',
				answers.server_name,
				'-m',
				answers.letsencrypt_email,
				'--agree-tos',
				'--no-eff-email',
				'--non-interactive',
				'--keep-until-expiring',
			],
			`request the certificate for ${answers.server_name} (the name must resolve to this machine and port 80 must be reachable from the internet)`,
			{ timeoutMs: 600_000 },
		),
	];
}

/** The local CA: the rotation script's generator (skipped when its files are there). */
function localCaCommands(ctx: HostPlanCtx): HostCommand[] {
	const files = certFiles(ctx);
	return [
		certDirCommand(ctx),
		stackExec(
			ctx,
			[
				STACK_BINARIES.bash,
				inCheckout(ctx, 'deploy/dedalo-tls-rotate.sh'),
				'--mode',
				'local-ca',
				// The server name first (the certificate's subject), then the extra addresses:
				// the authority is constrained to exactly this list.
				...siteNames(ctx.answers).flatMap((name) => ['--host', name]),
				'--dir',
				inCheckout(ctx, CERT_DIR),
				'--no-reload',
				'--quiet',
			],
			`create a local certificate authority and the certificate for ${siteNames(ctx.answers).join(', ')}`,
			{
				unless: stackExec(
					ctx,
					[STACK_BINARIES.test, '-s', files.fullchain, '-a', '-s', inCheckout(ctx, LOCAL_CA_FILE)],
					'the local CA and its certificate exist',
					{ mutates: false },
				),
			},
		),
	];
}

/**
 * The authority already in deploy/certs that cannot serve the answers (made for
 * other addresses; or a pre-2026-10-16 one whose certificate does not name
 * them all), or null — host/tls_authority.ts, ONE rule with the native route.
 * The issue above is skipped when its files exist, so without this a re-run
 * with new addresses completes on a certificate that does not name them.
 * stack_preflight refuses with it first; stack_tls again (a resume).
 */
export function stackAuthorityConflict(ctx: HostCtx): string | null {
	if (ctx.answers.tls_mode !== 'local_ca') return null;
	const dir = inCheckout(ctx, CERT_DIR);
	const wanted = siteNames(ctx.answers);
	return authorityConflict(
		ctx.fs,
		{
			dir,
			route: 'docker',
			rotate: `bash ${inCheckout(ctx, 'deploy/dedalo-tls-rotate.sh')} --mode local-ca --dir ${dir} --no-reload ${wanted.map((name) => `--host ${name}`).join(' ')}`,
		},
		wanted,
	);
}

/** One `install -m <mode> <from> <to>` (none when the answer already IS the destination). */
function copyCommand(ctx: HostPlanCtx, from: string, to: string, mode: string): HostCommand[] {
	if (resolve(from) === resolve(to)) return [];
	return [
		stackExec(
			ctx,
			[STACK_BINARIES.install, '-m', mode, from, to],
			`copy ${from} to ${to} (${mode})`,
		),
	];
}

/** The institution's files, copied in. */
function fileCommands(ctx: HostPlanCtx): HostCommand[] {
	const files = certFiles(ctx);
	return [
		certDirCommand(ctx),
		...copyCommand(ctx, ctx.answers.tls_cert_path, files.fullchain, '0644'),
		...copyCommand(ctx, ctx.answers.tls_key_path, files.key, '0600'),
	];
}

/** The commands of the chosen mode. */
export function tlsCommands(ctx: HostPlanCtx): HostCommand[] {
	if (ctx.answers.tls_mode === 'letsencrypt') return letsEncryptCommands(ctx);
	return ctx.answers.tls_mode === 'local_ca' ? localCaCommands(ctx) : fileCommands(ctx);
}

/** Let's Encrypt: the certificate is in the volume. */
async function letsEncryptIssued(ctx: HostCtx): Promise<boolean> {
	return probeOk(
		ctx,
		dockerProbe(
			ctx,
			[
				'run',
				'--rm',
				'-v',
				`${LE_VOLUME}:${CONTAINER.letsencrypt}:ro`,
				'--entrypoint',
				'test',
				certbotImage(ctx),
				'-s',
				`${CONTAINER.letsencrypt}/live/${LE_CERT_NAME}/fullchain.pem`,
			],
			'the issued certificate is in the volume',
		),
	);
}

/** deploy/certs holds a certificate and its key (files mode: still the checked pair). */
function filesInPlace(ctx: HostCtx): [boolean, string][] {
	const files = certFiles(ctx);
	const key = ctx.fs.stat(files.key);
	const checks: [boolean, string][] = [
		[ctx.fs.exists(files.fullchain), `${files.fullchain} is missing`],
		[key !== null && (key.mode & 0o077) === 0, `${files.key} is missing or readable by others`],
	];
	if (ctx.answers.tls_mode !== 'files') return checks;
	const verdict = checkCertificateFiles(
		ctx.fs.readText(files.fullchain),
		ctx.fs.readText(files.key),
		ctx.answers.server_name,
		ctx.now(),
	);
	return [...checks, ...verdict.problems.map((problem): [boolean, string] => [false, problem])];
}

async function verifyTls(ctx: HostCtx) {
	if (ctx.answers.tls_mode === 'letsencrypt') {
		return verdictOf(
			[[await letsEncryptIssued(ctx), `no certificate ${LE_CERT_NAME} in ${LE_VOLUME}`]],
			`Let's Encrypt certificate for ${ctx.answers.server_name} issued`,
		);
	}
	return verdictOf(filesInPlace(ctx), `certificate in ${inCheckout(ctx, CERT_DIR)}`);
}

/** Record, before the work, what it will create (only what is not there yet). */
function tlsIntent(ctx: HostCtx): void {
	const created = stackCreated(ctx);
	if (ctx.answers.tls_mode === 'letsencrypt') {
		rememberNewVolumes(ctx, [LE_VOLUME, LE_WEBROOT_VOLUME], stackFactsOf(ctx).volumes);
		return;
	}
	const files = certFiles(ctx);
	// Every file the generator can write: the two-tier constrained authority
	// (issuing CA + names list; the root key never persists) and the legacy
	// single-tier key/serial, so an undo removes exactly what this install made.
	const local = [
		'dedalo-local-ca.key',
		'dedalo-local-ca.srl',
		'dedalo-issuing-ca.key',
		'dedalo-issuing-ca.pem',
		'dedalo-issuing-ca.srl',
		'dedalo-local-ca.names',
	]
		.map((name) => inCheckout(ctx, `${CERT_DIR}/${name}`))
		.concat(inCheckout(ctx, LOCAL_CA_FILE));
	const candidates = [
		inCheckout(ctx, CERT_DIR),
		files.fullchain,
		files.key,
		...(ctx.answers.tls_mode === 'local_ca' ? local : []),
	];
	for (const path of candidates) if (!ctx.fs.exists(path)) remember(created.certs, path);
}

/** Remove the files this install created, then deploy/certs when it created it and it is empty. */
function removeCertFiles(ctx: HostCtx, paths: readonly string[]): void {
	const dir = inCheckout(ctx, CERT_DIR);
	for (const path of paths) if (path !== dir) ctx.fs.remove(path);
	if (paths.includes(dir)) ctx.fs.rmdirIfEmpty(dir);
}

/** Remove what this install created (files, deploy/certs when empty, the LE volumes). */
async function undoTls(ctx: HostCtx): Promise<string> {
	const created = stackCreated(ctx);
	const volumes: string[] = created.volumes.filter((name) =>
		[LE_VOLUME, LE_WEBROOT_VOLUME].includes(name),
	);
	removeCertFiles(ctx, created.certs);
	if (volumes.length > 0) {
		await executeCommands(
			[
				dockerCommand(
					ctx,
					['volume', 'rm', ...volumes],
					'remove the certificate volumes this install created',
					{
						okExit: [0, 1],
					},
				),
			],
			ctx,
		);
	}
	created.volumes = created.volumes.filter((name) => !volumes.includes(name));
	created.certs = [];
	return `certificate files removed${volumes.length > 0 ? `; volumes ${volumes.join(', ')} removed` : ''}`;
}

export const stack_tls: HostStepDefinition = {
	id: 'stack_tls',
	privilege: 'operator',
	kind: 'action',
	needs: [],
	label: (plan) =>
		`the certificate (${String(plan.answers.tls_mode)}) for ${String(plan.answers.server_name)}`,
	commands: tlsCommands,
	verify: verifyTls,
	run: async (ctx) => {
		const conflict = stackAuthorityConflict(ctx);
		if (conflict !== null) hostRefuse('install.state_conflict', conflict);
		await executeCommands(tlsCommands(ctx), ctx);
		return ran(`certificate (${ctx.answers.tls_mode}) in place for ${ctx.answers.server_name}`);
	},
	intent: tlsIntent,
	undo: undoTls,
};
