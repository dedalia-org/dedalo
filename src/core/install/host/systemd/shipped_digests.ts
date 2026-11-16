/**
 * THE SHIPPED-TEMPLATE DIGEST LEDGER (owner ruling C33, 2026-11-13) —
 * deploy/systemd/shipped_digests.json: for every unit template the installer
 * writes (render.ts UNIT_TEMPLATES), the sha256 of EVERY render a release ever
 * shipped (one per OS row's `@@PG_SERVICE@@` substitution, deduplicated), oldest
 * first, this release's render last.
 *
 * Why it exists: the installer never overwrites a template it did not write
 * (units.ts assertNoForeignTemplate), and a code update never touches
 * /etc/systemd. Without a memory of what earlier releases wrote, a host
 * installed before a template changed kept the OLD unit for ever AND refused a
 * second instance as "foreign". With the ledger, a template whose on-disk bytes
 * hash to a shipped digest is the installer's own — an EARLIER release's — and
 * is UPGRADED in place (host_units run, scripts/ops/host_units_refresh.ts); a
 * digest no release shipped (a hand edit, another installer) is still refused.
 *
 * The ledger is APPEND-ONLY: every template edit adds the new render's digests
 * (`bun run scripts/shipped_digests_update.ts`) and keeps every old one
 * (install_host_render_tripwire (j): the current render and the committed
 * HEAD's render of every template × OS row are in it).
 *
 * PURE: text → ledger; no I/O but the one `sourceText` read of the source tree.
 */

import { hostRefuse } from '../refuse.ts';
import { sourceText } from '../source.ts';
import type { UnitTemplate } from './render.ts';

export const SHIPPED_DIGESTS_FILE = 'deploy/systemd/shipped_digests.json';
export const SHIPPED_DIGESTS_FORMAT = 1;

export interface ShippedDigests {
	format: number;
	/** template name → every shipped render's sha256 hex, oldest first. */
	templates: Record<string, string[]>;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** The JSON of the ledger, or null when the text is not JSON. */
function parsedJson(text: string): Partial<ShippedDigests> | null {
	try {
		return JSON.parse(text) as Partial<ShippedDigests>;
	} catch {
		return null;
	}
}

/** Is `value` a list of sha256 hex digests? */
function isDigestList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((d) => typeof d === 'string' && HEX64.test(d));
}

/** Why `templates` is not a name → digest-list map, or null when it is one. */
function templatesProblem(templates: unknown): string | null {
	if (templates === null || typeof templates !== 'object') return 'no templates map';
	const bad = Object.entries(templates as Record<string, unknown>).find(
		([, digests]) => !isDigestList(digests),
	);
	return bad === undefined ? null : `${bad[0]}: not a list of sha256 hex digests`;
}

/** The ledger's shape, or the reason the text is not one. */
export function parseShippedDigests(text: string): ShippedDigests | string {
	const parsed = parsedJson(text);
	if (parsed === null) return 'not JSON';
	if (typeof parsed !== 'object') return 'not an object';
	if (parsed.format !== SHIPPED_DIGESTS_FORMAT) {
		return `format ${String(parsed.format)}, expected ${SHIPPED_DIGESTS_FORMAT}`;
	}
	const problem = templatesProblem(parsed.templates);
	if (problem !== null) return problem;
	return { format: parsed.format, templates: parsed.templates as Record<string, string[]> };
}

/** The ledger of a source tree (a malformed or missing one is a release defect: refused). */
export function readShippedDigests(source?: string): ShippedDigests {
	const text = sourceText(SHIPPED_DIGESTS_FILE, source);
	const ledger = parseShippedDigests(text);
	if (typeof ledger === 'string') {
		hostRefuse(
			'install.step_failed',
			`${SHIPPED_DIGESTS_FILE} is malformed (${ledger}) — the release is incomplete`,
		);
	}
	return ledger;
}

/** Did a release ship a render of `name` hashing to `digest`? */
export function isShippedDigest(
	ledger: ShippedDigests,
	name: UnitTemplate,
	digest: string,
): boolean {
	return (ledger.templates[name] ?? []).includes(digest);
}
