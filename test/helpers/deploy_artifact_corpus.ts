/**
 * THE DEPLOY ARTIFACT CORPUS — the one lister that owns the roots of what the
 * engine SHIPS to an operator: the reverse-proxy configurations under `deploy/`
 * and the compose stacks at the repo root.
 *
 * `census_derivation_tripwire` refuses a gate that chooses its own walk root
 * in-file. The roots live HERE; a gate imports a shape and never names a
 * directory. Zero-argument on purpose — a parameterized lister hands the root
 * choice back to the caller.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** The deploy roots. The ONLY place they are named. */
export const DEPLOY_DIR = join(REPO_ROOT, 'deploy');

/** Every shipped nginx configuration or template under deploy/, by file NAME, sorted. */
export function nginxConfNames(): string[] {
	return readdirSync(DEPLOY_DIR)
		.filter((name) => name.startsWith('nginx'))
		.sort();
}

/** Every shipped nginx configuration or template under deploy/, absolute, sorted. */
export function nginxConfFiles(): string[] {
	return nginxConfNames().map((name) => join(DEPLOY_DIR, name));
}

/**
 * Every compose stack the repo TRACKS, repo-relative — git's view, so an
 * untracked local experiment is not a shipped stack.
 */
export function shippedComposeStacks(): string[] {
	const listed = Bun.spawnSync(['git', 'ls-files', 'docker-compose*.yml'], { cwd: REPO_ROOT });
	return new TextDecoder()
		.decode(listed.stdout)
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.sort();
}

/** Every shipped systemd unit under deploy/ (`*.service`, templates included), by NAME, sorted. */
export function systemdUnitNames(): string[] {
	return readdirSync(DEPLOY_DIR)
		.filter((name) => name.endsWith('.service'))
		.sort();
}

/**
 * Every compose file git TRACKS — the root stacks AND the ones under deploy/
 * (a developer/NAS variant is still a definition someone runs), repo-relative,
 * sorted.
 */
export function trackedComposeFiles(): string[] {
	const listed = Bun.spawnSync(
		['git', 'ls-files', 'docker-compose*.yml', 'deploy/docker-compose*.yml'],
		{
			cwd: REPO_ROOT,
		},
	);
	return new TextDecoder()
		.decode(listed.stdout)
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.sort();
}

/**
 * Every file in the git index, repo-relative, sorted — for gates that classify
 * operator artifacts by NAME wherever they live (every compose stack variant,
 * every Dockerfile / Containerfile spelling: operator_image_pin_tripwire).
 */
export function trackedRepoFiles(): string[] {
	const listed = Bun.spawnSync(['git', 'ls-files'], { cwd: REPO_ROOT });
	if (listed.exitCode !== 0) {
		throw new Error(`git ls-files failed: ${new TextDecoder().decode(listed.stderr)}`);
	}
	return new TextDecoder()
		.decode(listed.stdout)
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.sort();
}

// ---------------------------------------------------------------------------
// Compose files READ AS COMPOSE READS THEM (installer unification D2).
//
// The stacks name the product image through `${DEDALO_IMAGE:-localhost/dedalo}`
// and no longer build it, so a gate that keyed on the `build: .` SPELLING went
// vacuous the day the spelling left. These helpers parse a compose file and
// interpolate it with a given environment, and a gate asks the OUTCOME: does
// this service end up running the product image?
// ---------------------------------------------------------------------------

/** The environment a compose file is interpolated with (an operator's .dedalo.env, or none). */
export type ComposeEnv = Readonly<Record<string, string>>;

/** One compose service, as far as the deploy gates read it. */
export interface ComposeServiceShape {
	image?: string;
	build?: string | { context?: string; dockerfile?: string; target?: string };
	command?: string | string[];
	entrypoint?: string | string[];
	environment?: Record<string, unknown> | string[];
	volumes?: (string | Record<string, unknown>)[];
	[key: string]: unknown;
}

/** A parsed compose document. */
export interface ComposeDocument {
	services?: Record<string, ComposeServiceShape>;
	volumes?: Record<string, unknown>;
	[key: string]: unknown;
}

/** Where the product image's repository defaults to when DEDALO_IMAGE is unset. */
export const PRODUCT_IMAGE_DEFAULT_REPOSITORY = 'localhost/dedalo';

/** Index of the `}` closing the `${` at `open` (nesting-aware), or -1. */
function closingBrace(text: string, open: number): number {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === '{') depth++;
		if (text[i] === '}' && --depth === 0) return i;
	}
	return -1;
}

/** One `${…}` body resolved: NAME, NAME:-d, NAME-d, NAME:?e, NAME?e, NAME:+a, NAME+a. */
function resolveBraced(body: string, env: ComposeEnv): string {
	const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([\s\S]*))?$/.exec(body);
	if (match === null) throw new Error(`compose interpolation: invalid \${${body}}`);
	const value = env[match[1] as string];
	const operator = match[2] ?? '';
	const set = operator.startsWith(':') ? value !== undefined && value !== '' : value !== undefined;
	if (operator.endsWith('+')) return set ? interpolateCompose(match[3] ?? '', env) : '';
	if (operator.endsWith('-'))
		return set ? (value as string) : interpolateCompose(match[3] ?? '', env);
	return value ?? ''; // `?` forms: a missing required value reads as empty here
}

/**
 * Compose's variable interpolation of one string: `$$` is a literal `$`,
 * `${NAME…}` and `$NAME` are substituted from `env` (never from this
 * process's environment — a gate states the environment it means).
 */
export function interpolateCompose(text: string, env: ComposeEnv = {}): string {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const rest = text.slice(i);
		if (rest.startsWith('$$')) {
			out += '$';
			i += 2;
		} else if (rest.startsWith('${')) {
			const close = closingBrace(text, i + 1);
			if (close === -1) throw new Error(`compose interpolation: unclosed \${ in '${text}'`);
			out += resolveBraced(text.slice(i + 2, close), env);
			i = close + 1;
		} else {
			const bare = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
			out += bare === null ? (text[i] as string) : (env[bare[1] as string] ?? '');
			i += bare === null ? 1 : bare[0].length;
		}
	}
	return out;
}

/** Interpolate every string value of a parsed document (keys are never interpolated). */
function interpolateValues(value: unknown, env: ComposeEnv): unknown {
	if (typeof value === 'string') return interpolateCompose(value, env);
	if (Array.isArray(value)) return value.map((item) => interpolateValues(item, env));
	if (value === null || typeof value !== 'object') return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, interpolateValues(item, env)]),
	);
}

/** A compose file (repo-relative), parsed with Bun.YAML and interpolated with `env`. */
export function parseComposeFile(file: string, env: ComposeEnv = {}): ComposeDocument {
	const raw = Bun.YAML.parse(readFileSync(join(REPO_ROOT, file), 'utf8'));
	return interpolateValues(raw, env) as ComposeDocument;
}

/** The repository of an image reference: tag and digest removed (a registry port is kept). */
export function imageRepositoryOf(image: string): string {
	const withoutDigest = image.split('@')[0] as string;
	const lastSlash = withoutDigest.lastIndexOf('/');
	const colon = withoutDigest.indexOf(':', lastSlash + 1);
	return colon === -1 ? withoutDigest : withoutDigest.slice(0, colon);
}

/** The tag of an image reference, or null. */
export function imageTagOf(image: string): string | null {
	const withoutDigest = image.split('@')[0] as string;
	const colon = withoutDigest.indexOf(':', withoutDigest.lastIndexOf('/') + 1);
	return colon === -1 ? null : withoutDigest.slice(colon + 1);
}

/** The product image's repository under `env`: DEDALO_IMAGE, else the localhost default. */
export function productImageRepository(env: ComposeEnv = {}): string {
	const declared = env.DEDALO_IMAGE;
	return declared === undefined || declared === '' ? PRODUCT_IMAGE_DEFAULT_REPOSITORY : declared;
}

/** Does this (interpolated) service build the repo's Dockerfile from the project root? */
export function buildsRepoDockerfile(service: ComposeServiceShape): boolean {
	const build = service.build;
	if (build === undefined) return false;
	const spec = typeof build === 'string' ? { context: build } : build;
	const context = (spec.context ?? '.').replace(/\/+$/, '');
	const dockerfile = spec.dockerfile ?? 'Dockerfile';
	return (context === '.' || context === '') && dockerfile === 'Dockerfile';
}

/** Does this (interpolated) service run the product image? */
export function isProductImageService(service: ComposeServiceShape, env: ComposeEnv = {}): boolean {
	if (buildsRepoDockerfile(service)) return true;
	return (
		typeof service.image === 'string' &&
		imageRepositoryOf(service.image) === productImageRepository(env)
	);
}

/**
 * The services of a compose file (repo-relative) that run the PRODUCT image —
 * by outcome: their image, interpolated with `env`, resolves to the product
 * repository (DEDALO_IMAGE, localhost default), or they build the repo Dockerfile.
 */
export function productImageServices(stack: string, env: ComposeEnv = {}): string[] {
	const services = parseComposeFile(stack, env).services ?? {};
	return Object.entries(services)
		.filter(([, service]) => isProductImageService(service, env))
		.map(([name]) => name)
		.sort();
}
