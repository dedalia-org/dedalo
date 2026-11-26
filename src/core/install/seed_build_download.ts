/**
 * GET /dedalo/install/seed_build/<file> — the newest PRIVATE install-seed build
 * (`<private>/seed_builds/<stamp>/`, seed_panel.ts) for the maintenance panel's
 * Download buttons.
 *
 * Who: a caller who may use the maintenance area NOW (the same rule as the build
 * action: security/permissions.ts canAccessMaintenanceArea), resolved per request
 * through security/session_gate.ts sessionPrincipalFromCookie — which also applies
 * the maintenance-mode refusal. What: exactly the three files a build writes, of the
 * newest build only; no other name, no path, no older stamp. Anything else is `null`
 * (the router answers 404 — never 403, so an outsider cannot confirm the surface).
 */

import { join } from 'node:path';
import { SECURITY_HEADERS } from '../api/static_asset.ts';
import { canAccessMaintenanceArea } from '../security/permissions.ts';
import { sessionPrincipalFromCookie } from '../security/session_gate.ts';

export const SEED_BUILD_URL_PREFIX = '/dedalo/install/seed_build/';

const SERVED: Readonly<Record<string, string>> = Object.freeze({
	'dedalo_install.pgsql.gz': 'application/gzip',
	'dedalo_install.pgsql.gz.manifest.json': 'application/json; charset=utf-8',
	'build.json': 'application/json; charset=utf-8',
});

export async function serveSeedBuildFile(
	pathname: string,
	cookieHeader: string | null,
	/** Test seam; default the panel's `<private>/seed_builds`. */
	buildsDir?: string,
): Promise<Response | null> {
	const name = pathname.slice(SEED_BUILD_URL_PREFIX.length);
	const contentType = SERVED[name];
	if (!pathname.startsWith(SEED_BUILD_URL_PREFIX) || contentType === undefined) return null;
	if (!(await mayDownload(cookieHeader))) return null;
	// Loaded on use: the router imports this module at boot, the seed compiler stays out of it.
	const { latestPrivateBuild } = await import('./seed_panel.ts');
	const latest = await latestPrivateBuild(buildsDir);
	if (latest === null) return null;
	const file = Bun.file(join(latest.dir, name));
	if (!(await file.exists())) return null;
	return new Response(file, {
		headers: {
			...SECURITY_HEADERS,
			'Content-Type': contentType,
			'Content-Disposition': `attachment; filename="${name}"`,
			'Content-Length': String(file.size),
			'Cache-Control': 'no-store',
		},
	});
}

/** A session whose principal may use the maintenance area NOW. */
async function mayDownload(cookieHeader: string | null): Promise<boolean> {
	const caller = await sessionPrincipalFromCookie(cookieHeader);
	return caller !== null && (await canAccessMaintenanceArea(caller.principal));
}
