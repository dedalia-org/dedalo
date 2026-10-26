/**
 * Pin the installer's release identity for a gate (src/core/install/installer_identity.ts,
 * the DEDALO_INSTALL_RELEASE_IDENTITY test seam).
 *
 * Why: the identity is the checkout's — `7.0.0-beta.6` on the tagged commit,
 * `7.0.1-dev` one commit later — and the Docker/trial decisions differ per kind
 * (the image tag, the official-image decision, the preselected source). A gate
 * that does not pin it tests whatever HEAD happens to be.
 *
 * The seam is the PROCESS environment (the run's children inherit it: the probe
 * child, the engine child), so a pin is set and restored around the code that
 * needs it — never left behind for the next file of the same `bun test` process.
 */

import { afterAll } from 'bun:test';
import { INSTALLER_IDENTITY_SEAM } from '../../src/core/install/installer_identity.ts';
import { DEDALO_NEXT_DEV_TRIPLE, DEDALO_VERSION } from '../../src/core/update/version.ts';

/** The three identity kinds of THIS data version (the seam refuses another triple). */
export const PINNED_IDENTITY = Object.freeze({
	stable: DEDALO_VERSION,
	prerelease: `${DEDALO_VERSION}-beta.7`,
	dev: `${DEDALO_NEXT_DEV_TRIPLE.join('.')}-dev`,
});

/** Run `fn` with the identity pinned; the previous value is restored after (also on a throw). */
export async function withInstallerIdentity<T>(
	version: string,
	fn: () => T | Promise<T>,
): Promise<T> {
	const previous = process.env[INSTALLER_IDENTITY_SEAM];
	process.env[INSTALLER_IDENTITY_SEAM] = version;
	try {
		return await fn();
	} finally {
		if (previous === undefined) delete process.env[INSTALLER_IDENTITY_SEAM];
		else process.env[INSTALLER_IDENTITY_SEAM] = previous;
	}
}

/**
 * Pin the identity for the whole calling file: set NOW (call it at the top level
 * of the file, before anything derives from the identity — describe bodies run
 * at collection, before any beforeAll), restored after the file's last test.
 * `bun test` runs one file at a time, so the pin never reaches another file.
 */
export function pinInstallerIdentity(version: string): void {
	const previous = process.env[INSTALLER_IDENTITY_SEAM];
	process.env[INSTALLER_IDENTITY_SEAM] = version;
	afterAll(() => {
		if (previous === undefined) delete process.env[INSTALLER_IDENTITY_SEAM];
		else process.env[INSTALLER_IDENTITY_SEAM] = previous;
	});
}
