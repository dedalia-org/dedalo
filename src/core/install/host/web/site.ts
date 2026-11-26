/**
 * WHAT EVERY SITE FILE THE INSTALLER WRITES SHARES (terminal installer phase 4,
 * 2026-10-12): its input, its stamp, the dynamic routes the engine serves under
 * /dedalo/, and the security headers — ONE constant, repeated in every place a
 * web server would otherwise drop them (nginx: a location with its own
 * add_header inherits NONE of the server's — campaign 2 L5/L55).
 */

import type { InstallAnswers } from '../../install_plan.ts';
import type { InstancePaths } from '../layout.ts';

export interface SiteInput {
	readonly paths: InstancePaths;
	readonly answers: InstallAnswers;
	/** The stamp line (`# dedalo-install <i> <hash>`), always the file's first line. */
	readonly stamp: string;
	/** null = stage 1 (Let's Encrypt not issued yet): the plain-HTTP server only. */
	readonly cert: { fullchain: string; key: string } | null;
	/** Serve the HTTP-01 challenge root on the plain-HTTP server (Let's Encrypt). */
	readonly acme: boolean;
	/** The web server's log directory (this instance's own log files go there). */
	readonly logDir: string;
	/**
	 * The media gate's two nginx rule files the site includes — GIVEN by the
	 * caller, never derived from the instance name (campaign 3 C3-2: the docker
	 * stack once inherited the production copy layout and included files that
	 * do not exist in its container): production, the root-owned copies
	 * (web/nginx.ts productionMediaRules); the docker stack, the engine's own
	 * files in the shared media volume. Apache ignores it (its gate is the
	 * generated .htaccess in the media directory).
	 */
	readonly mediaRules: NginxMediaRules;
}

/** Where a site's nginx media gate comes from: the two files, and why those (the site's comment). */
export interface NginxMediaRules {
	/** The server-scope rule file. */
	readonly server: string;
	/** The http-scope map file. */
	readonly map: string;
	/** Comment sentences written above the server-scope include. */
	readonly note: readonly string[];
}

/** The security headers (name, value) — the ONE list both renderers emit. */
export const SECURITY_HEADERS: readonly (readonly [string, string])[] = Object.freeze([
	['Strict-Transport-Security', 'max-age=31536000; includeSubDomains'],
	['X-Content-Type-Options', 'nosniff'],
	['X-Frame-Options', 'SAMEORIGIN'],
	['Referrer-Policy', 'strict-origin-when-cross-origin'],
]);

/** The engine's own routes under /dedalo/ (proxied, never served from the client tree). */
export const ENGINE_PREFIXES: readonly string[] = Object.freeze([
	'/dedalo/lib/',
	'/dedalo/tools/',
	'/dedalo/core/tools_common/',
	'/dedalo/install/import/ontology/',
	'/dedalo/install/code/',
	'/dedalo/install/import/hierarchy/',
	'/dedalo/install/seed_build/',
	'/dedalo/ai_models/',
	'/dedalo/upload_tmp/',
]);

/** The https origin as the redirect writes it (the port only when it is not 443). */
export function httpsOrigin(answers: InstallAnswers): string {
	return answers.https_port === '443' ? '' : `:${answers.https_port}`;
}

/**
 * The site file's header: the stamp, then who writes it and how it changes.
 * TWO writers print these bytes — the installer and docs/install/manual_install.md
 * (whose by-hand host edits the certificate lines in) — so the header names both,
 * as the unit templates' does (campaign 3b N22).
 */
export function siteHeader(input: SiteInput): string[] {
	return [
		input.stamp,
		`# Dédalo instance ${input.paths.instance} — WRITTEN BY THE INSTALLER (scripts/install.ts, production`,
		'# route) or by docs/install/manual_install.md, which renders the same bytes. Every other',
		'# site, the default site and the global configuration are untouched. An installer resume',
		'# compares this file with its own render: change the answers and re-run the installer;',
		'# a by-hand host edits it only where manual_install.md says.',
		'',
	];
}

/**
 * Every address the site answers to: the server name, then the local CA's
 * extra addresses (tls_extra_names — a LAN name or an IPv4 address; '' on
 * every other mode). The certificate names exactly these, so the site must
 * too: nginx's catch-all would otherwise reject the handshake of an extra
 * name, and Apache's name guard refuse it (421). An IPv4 address is reached
 * WITHOUT a server name (no SNI for an IP literal): on the docker route this
 * site is its nginx's one HTTPS server and so the address's default; on a
 * native host the installer's catch-all hands the handshake this instance's
 * certificate (web/catch_all.ts, CLAIMED) and the request's Host — the
 * address — then selects this site by the name listed here.
 */
export function siteNames(
	answers: Pick<InstallAnswers, 'server_name' | 'tls_extra_names'>,
): string[] {
	// `?? ''`: the plan file of a run recorded before the answer existed lacks it.
	const listed = answers.tls_extra_names ?? '';
	const extra = listed === '' ? [] : listed.split(',');
	return [answers.server_name, ...extra.filter((name) => name !== answers.server_name)];
}

/** Is the media gate on (DEDALO_MEDIA_ACCESS_MODE not false/off/0)? Off: the media is served open. */
export function mediaGated(answers: InstallAnswers): boolean {
	return !['false', 'off', '0'].includes(answers.media_access_mode);
}
