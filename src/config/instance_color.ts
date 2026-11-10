/**
 * The installation colour: an OPT-IN colour per install so people juggling
 * several installations tell them apart (menu logo tint, menu underline,
 * developer bar, tab favicon + title prefix — client:
 * page/css/layout/instance_identity.less + page.js).
 *
 * Active only when DEDALO_INSTANCE_COLOR is set to a valid `#rrggbb`. Pure (no
 * config import) — config.ts resolves it once at boot.
 */

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Resolve the installation colour, or null (feature off). A malformed value is
 * REFUSED loudly and leaves the feature off: it would be painted into page CSS
 * and an SVG favicon, so it is never passed through.
 */
export function resolveInstanceColor(configured: string | undefined): string | null {
	const value = configured?.trim();
	if (!value) return null;
	if (!HEX_COLOR.test(value)) {
		console.error(
			`[config] DEDALO_INSTANCE_COLOR must be a hex colour '#rrggbb' (got '${value}') — installation colour disabled.`,
		);
		return null;
	}
	return value.toLowerCase();
}
