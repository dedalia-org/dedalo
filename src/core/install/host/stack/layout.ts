/**
 * THE COMPOSE STACK'S PLACES AND NAMES (terminal installer phase 4,
 * 2026-10-12) — every file, volume and image the docker/trial host steps
 * write, run or remove, derived in ONE module from the answers:
 *
 *   <checkout>/.dedalo.env                 the stack's environment (0600 — the database
 *                                          password); the CONTRACT of deploy/dedalo-image-lib.sh
 *   <checkout>/compose.override.yaml       the installer's override (the Let's Encrypt
 *                                          renewal service and volumes); the host library
 *                                          adds it to every compose call when it exists
 *   <checkout>/deploy/nginx.docker.generated.conf   the full stack's site (media gate on)
 *   <checkout>/deploy/certs/               the certificate nginx mounts (local CA / own files)
 *   volumes dedalo_<name>                  compose project `dedalo`
 *
 * The routes: docker = the FULL stack (docker-compose.yml: the engine-enforced
 * media gate, a certificate); trial = the SIMPLE stack (docker-compose.simple.yml,
 * plain HTTP, NO media access control — its own route, so it says so).
 *
 * The image: official (a registry of engineering/image_registries.json —
 * verified with cosign against the signing identity of THAT list, never one
 * from the environment), custom (a registry of the operator's: trusted as
 * pulled, said so) or build (here, from this checkout). Its version is this
 * installer's (owner question Q7: the delegated engine steps and their request
 * format must be the installer's own) — its RELEASE IDENTITY's image tag
 * (installer_identity.ts): `7.0.0`, `7.0.0-beta.7`, `7.0.0-dev`.
 *
 * PURE.
 */

import {
	loadImageRegistries,
	normalizeRepository,
	provisionedRegistries,
} from '../../../update/image_registries.ts';
import {
	imageTagOf,
	nightlyImageMessage,
	type ReleaseIdentity,
} from '../../../update/release_identity.ts';

export { nightlyImageMessage };

import type { InstallAnswers } from '../../install_plan.ts';
import { installerIdentity } from '../../installer_identity.ts';

/**
 * How long a local image build takes — the ONE estimate (campaign 3b N11: the
 * Image screen, the Review and the docs said three different things). Measured
 * in campaign 3b on 2 vCPU VMs: 2 to 6 minutes for a first build. The Review
 * (stack_image's label, the install sentence) says it; the docs repeat it
 * verbatim (gate: install_stack_steps_native).
 */
export const BUILD_DURATION =
	'a first build takes about 2 to 6 minutes on 2 CPUs, longer on a slow network or disk';

/** The compose project name both stack files declare (`name: dedalo`). */
export const STACK_PROJECT = 'dedalo';

/** NOT `.env`: the engine's own loader reads that from a working directory. */
export const ENV_FILE = '.dedalo.env';
export const OVERRIDE_FILE = 'compose.override.yaml';
export const BUILD_OVERRIDE = 'deploy/compose.build.yml';
export const CERT_DIR = 'deploy/certs';
/** Where nginx sees deploy/certs (DEDALO_CERT_MOUNT in both stack files). */
export const CERT_MOUNT = '/etc/dedalo/certs';
/** The full stack's generated site (deploy/ is the stack files' nginx config directory). */
export const GENERATED_CONF = 'nginx.docker.generated.conf';
/** The trial stack's plain-HTTP site (shipped). */
export const TRIAL_CONF = 'nginx.simple.conf';
/** The Let's Encrypt certificate name (live/<name>/ in the dedalo_letsencrypt volume). */
export const LE_CERT_NAME = 'dedalo';
export const LE_VOLUME = `${STACK_PROJECT}_letsencrypt`;
export const LE_WEBROOT_VOLUME = `${STACK_PROJECT}_certbot_www`;
/** The image certbot runs from (the simple stack's renewal service uses the same). */
export const CERTBOT_IMAGE = 'certbot/certbot';
/** The local build's repository (deploy/compose.build.yml tags the build with it). */
export const LOCAL_REPOSITORY = 'localhost/dedalo';
/** The label the release workflow stamps with the version it publishes under. */
export const VERSION_LABEL = 'org.opencontainers.image.version';

/** Inside the containers (the stack files' constants). */
export const CONTAINER = Object.freeze({
	socket: '/run/dedalo/dedalo_ts.sock',
	media: '/srv/dedalo/media',
	webRoot: '/srv',
	mediaDir: 'media',
	/** Where nginx mounts the engine's published client volume. */
	client: '/opt/dedalo/master_dedalo/client',
	acmeWebroot: '/var/www/certbot',
	letsencrypt: '/etc/letsencrypt',
});

/**
 * The media gate's two nginx rule files AS THE ENGINE WRITES THEM into its
 * media root (src/core/media/protection.ts ruleFilePaths — the names are
 * cross-checked against it by install_stack_nginx_native; this module stays
 * config-free). The full stack's nginx mounts the media volume read-only and
 * includes them where they are: inside its own container, the instance-writable
 * file is the stack's documented design (docs/install/docker.md, problem 3),
 * not the production host's root-owned copies (campaign 3 C3-2).
 */
export const CONTAINER_MEDIA_RULES = Object.freeze({
	server: `${CONTAINER.media}/dedalo_media_protection.nginx.conf`,
	map: `${CONTAINER.media}/dedalo_media_protection_map.nginx.conf`,
});

/**
 * The images the stack files run besides the Dédalo image (both stack files'
 * `image:` lines — gate: install_stack_nginx_native). An abort names them:
 * they stay on the machine as a cache.
 */
export const STACK_SERVICE_IMAGES: readonly string[] = Object.freeze([
	'postgres:18',
	'nginx:alpine',
]);

/** PostgreSQL's image — the one a served abort keeps RUNNING (its container holds the data). */
export const POSTGRES_IMAGE = STACK_SERVICE_IMAGES[0] as string;

/**
 * The trial nginx's volumes (docker-compose.simple.yml's nginx volumes WITHOUT
 * the certificate ones — the Let's Encrypt volumes and deploy/certs): the trial
 * serves plain HTTP, so its override replaces the list (campaign 3 C3-22). The
 * gate holds it equal to the stack file's list minus those three.
 */
export const TRIAL_NGINX_VOLUMES: readonly string[] = Object.freeze([
	'./deploy/${DEDALO_NGINX_CONF:-nginx.simple.conf}:/etc/nginx/conf.d/default.conf:ro',
	`client:${CONTAINER.client}:ro`,
	`media:${CONTAINER.media}:ro`,
	'socket:/run/dedalo',
]);

/** The volumes the engine's services use (created by `compose run`/`up`). */
export const ENGINE_VOLUMES: readonly string[] = Object.freeze(
	['private', 'media', 'socket', 'client', 'backups'].map((name) => `${STACK_PROJECT}_${name}`),
);
export const DATABASE_VOLUME = `${STACK_PROJECT}_pgdata`;
/** The volume whose presence means "an instance exists here". */
export const PRIVATE_VOLUME = `${STACK_PROJECT}_private`;

/** The stack file of a route. */
export function stackFileOf(answers: InstallAnswers): string {
	return answers.route === 'trial' ? 'docker-compose.simple.yml' : 'docker-compose.yml';
}

/** The nginx config the stack mounts (deploy/<name>). */
export function nginxConfOf(answers: InstallAnswers): string {
	return answers.route === 'trial' ? TRIAL_CONF : GENERATED_CONF;
}

/**
 * The image version: the tag of the installer's own release identity (the plan
 * may only repeat it). A beta asks for
 * `:7.0.0-beta.7`, never `:7.0.0` — after the stable release that tag is
 * another image, and its label would refuse it (C3i-F1).
 */
export function imageVersionOf(
	answers: InstallAnswers,
	identity: ReleaseIdentity = installerIdentity(),
): string {
	return answers.image_version === '' ? imageTagOf(identity.version) : answers.image_version;
}

/**
 * The ONLY version an image install of this installer accepts: its identity's own
 * tag (`7.0.0`, `7.0.0-beta.7`). Docker images are immutable and every tag names one
 * fixed image, so nothing else is accepted: no other release, no nightly. A stable
 * install never takes the next nightly; the nightly reaches an installation through
 * the code update path (tree archives), never through docker.
 *
 * A DEV identity (`X.Y.Z-dev`) has no image at all (the dev channel publishes none):
 * nothing is accepted (`[]`), so every caller refuses its tag on the existing
 * "not this installer's" path, and devHasNoImageMessage says why.
 */
export function acceptedImageVersions(identity: ReleaseIdentity = installerIdentity()): string[] {
	if (identity.kind === 'dev') return [];
	return [imageTagOf(identity.version)];
}

/**
 * The refusal for a nightly (`X.Y.Z-dev`) image or a development identity: Docker has
 * no nightly images (VERSIONING_SPEC §7 S3). `nightly` names the version refused.
 */

/** The reason a DEV identity has no image: Docker has no nightly images. */
export function devHasNoImageMessage(identity: ReleaseIdentity = installerIdentity()): string {
	return nightlyImageMessage(identity.version);
}

/**
 * The one refusal sentence for an image tag this installer does not accept: a `-dev`
 * tag, or any tag on a development identity, gets the nightly sentence (S3); every
 * other refusal names the accepted tags and carries the caller's own advice `tail`.
 */
export function imageRefusalMessage(
	version: string,
	tail: string,
	identity: ReleaseIdentity = installerIdentity(),
): string {
	if (version.endsWith('-dev')) return nightlyImageMessage(version);
	const accepted =
		identity.kind === 'dev'
			? 'none: Docker has no nightly images, and a development build has no image'
			: acceptedImageVersions(identity).join(' or ');
	return `image version ${version} is not this installer's (${accepted}) — ${tail}`;
}

/** The official repositories, primary first (the ONE list — never an environment value). */
export function officialRepositories(): string[] {
	return provisionedRegistries(loadImageRegistries()).map((entry) => entry.repository as string);
}

/** Is `repository` one of the official ones? */
export function isOfficialRepository(repository: string): boolean {
	const wanted = normalizeRepository(repository);
	return officialRepositories().some((entry) => normalizeRepository(entry) === wanted);
}

/** The repository the image comes from (official: the answer, else the first provisioned registry). */
export function imageRepositoryOf(answers: InstallAnswers): string {
	if (answers.image_source === 'build') return LOCAL_REPOSITORY;
	if (answers.image_repository !== '') return answers.image_repository;
	return officialRepositories()[0] ?? '';
}

/** `<repository>:<version>`. */
export function imageRefOf(answers: InstallAnswers): string {
	return `${imageRepositoryOf(answers)}:${imageVersionOf(answers)}`;
}

/** The .dedalo.env image mode: pull | build. */
export function imageModeOf(answers: InstallAnswers): 'pull' | 'build' {
	return answers.image_source === 'build' ? 'build' : 'pull';
}

/**
 * The .dedalo.env verification: an image from an OFFICIAL repository is always
 * cosign-verified, whichever source named it (preflight refuses one without
 * cosign); a registry of the operator's own has no Dédalo signature to check.
 */
export function imageVerifyOf(answers: InstallAnswers): 'cosign' | 'none' {
	const pulled = answers.image_source !== 'build';
	return pulled && isOfficialRepository(imageRepositoryOf(answers)) ? 'cosign' : 'none';
}

/**
 * Does this install carry a certificate (docker), or serve plain HTTP (trial)?
 * The ONE function every route's SESSION_COOKIE_SECURE is written from (the
 * developer route's listener included — dev_listener.ts), re-exported here for
 * the stack's own files.
 */
export { servesTls } from '../../dev_listener.ts';

/** The certificate files nginx reads (inside its container). */
export function certPathsOf(answers: InstallAnswers): { fullchain: string; key: string } {
	const dir =
		answers.tls_mode === 'letsencrypt'
			? `${CONTAINER.letsencrypt}/live/${LE_CERT_NAME}`
			: CERT_MOUNT;
	return { fullchain: `${dir}/fullchain.pem`, key: `${dir}/privkey.pem` };
}

/** The local CA file the operator installs on every workstation (local_ca). */
export const LOCAL_CA_FILE = `${CERT_DIR}/dedalo-local-ca.pem`;
