/**
 * THE STACK'S THIRD-PARTY IMAGES, READ FROM THE STACK FILES (T1-17 / S11,
 * 2026-11-12). The stack files (docker-compose.yml, docker-compose.simple.yml)
 * are the ONE place an operator image is spelled: `name:<version>@sha256:<index
 * digest>`, a readable tag plus the exact bytes, refreshed by Dependabot's
 * `docker-compose` entry for `/`. The installer runs, probes and names those
 * same images — so it DERIVES them here instead of keeping a copy: a copy is
 * what left `certbot/certbot` (no tag, no digest) in the Let's Encrypt
 * issuance after the YAML was pinned, and what would turn every updater PR red
 * until a human edited TypeScript.
 *
 * Read on every call (no module cache: the checkout is the source, and a test
 * points `source` at its own tree). A stack file without the service, or a
 * service without a pinned image, is refused loudly — never a fallback tag.
 *
 * Gate: test/unit/operator_image_pin_tripwire.test.ts (the pins, the
 * derivation, the generated override spells no image).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InstallAnswers } from '../../install_plan.ts';
import { hostRefuse } from '../refuse.ts';
import { stackFileOf } from './layout.ts';

/** A pinned image reference: `name:tag@sha256:<64 hex>`, the tag never `latest`. */
export const PINNED_IMAGE = /^[^@\s:]+:(?!latest@)[^@\s:/]+@sha256:[0-9a-f]{64}$/;

/** Whether `image` is a pinned reference (PINNED_IMAGE). */
export function isPinnedImage(image: string): boolean {
	return PINNED_IMAGE.test(image);
}

interface StackService {
	readonly image?: unknown;
	readonly profiles?: unknown;
}

/** The services of a stack file of the checkout at `source`. */
function stackServices(source: string, stackFile: string): Record<string, StackService> {
	const path = join(source, stackFile);
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		hostRefuse(
			'install.state_conflict',
			`the stack file ${stackFile} could not be read or parsed in ${source} (${(error as { code?: string }).code ?? 'invalid YAML'})`,
		);
	}
	const services = (parsed as { services?: unknown } | null)?.services;
	if (services === null || typeof services !== 'object') {
		hostRefuse('install.state_conflict', `the stack file ${stackFile} declares no services`);
	}
	return services as Record<string, StackService>;
}

/** The product image's services interpolate DEDALO_IMAGE — built and signed elsewhere, not pinned here. */
function isProductImage(image: string): boolean {
	return image.includes('${DEDALO_IMAGE');
}

/** The pinned image of one service of a stack file — refused when absent or not pinned. */
export function stackServiceImage(source: string, stackFile: string, service: string): string {
	const image = stackServices(source, stackFile)[service]?.image;
	if (typeof image !== 'string' || !isPinnedImage(image)) {
		hostRefuse(
			'install.state_conflict',
			`the stack file ${stackFile} has no pinned image for the ${service} service (expected name:version@sha256:<digest>, found ${typeof image === 'string' ? image : 'none'})`,
		);
	}
	return image;
}

/**
 * The third-party images a stack file runs WITHOUT a profile (postgres, nginx —
 * not the Dédalo image, not the opt-in services), in file order.
 */
export function stackFileServiceImages(source: string, stackFile: string): string[] {
	const images: string[] = [];
	for (const [name, spec] of Object.entries(stackServices(source, stackFile))) {
		if (spec.profiles !== undefined) continue;
		if (typeof spec.image !== 'string' || isProductImage(spec.image)) continue;
		images.push(stackServiceImage(source, stackFile, name));
	}
	return [...new Set(images)];
}

interface StackImageCtx {
	readonly answers: InstallAnswers;
	readonly source: string;
}

/** The route's service images (stackFileServiceImages of its stack file). */
export function serviceImages(ctx: StackImageCtx): string[] {
	return stackFileServiceImages(ctx.source, stackFileOf(ctx.answers));
}

/** PostgreSQL's image — the one a served abort keeps RUNNING (its container holds the data). */
export function postgresImage(ctx: StackImageCtx): string {
	return stackServiceImage(ctx.source, stackFileOf(ctx.answers), 'postgres');
}

/** The image certbot runs from: the route's stack file `certbot` service (profile letsencrypt). */
export function certbotImage(ctx: StackImageCtx): string {
	return stackServiceImage(ctx.source, stackFileOf(ctx.answers), 'certbot');
}
