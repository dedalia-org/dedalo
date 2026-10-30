/**
 * The RELEASE IDENTITY of a tree on disk that is NOT this process — a restore
 * point, a quarantine (audit 2026-10-29 U-07).
 *
 * A restore point used to be named, listed and compared by the DATA triple its
 * version.ts declares. Every beta of one triple declares the same one, so
 * beta.5 held over a running beta.7 read as "same version" and the restore
 * needed no confirmation. The identity tells them apart; the digest
 * (install_stamp.ts) tells two builds of one identity apart.
 *
 * Read from THAT tree's own evidence exactly as the tree reads itself at boot
 * (build_stamp.ts readReleaseIdentityOf, against its own version.ts triples),
 * so what the panel lists is what /health answers once the tree is restored.
 * Async read — this runs on the maintenance panel's request path.
 */

import { join } from 'node:path';
import { readReleaseIdentityOf } from './build_stamp.ts';
import {
	parseDeclaredDataTriple,
	parseDeclaredReleaseTriple,
	VERSION_TS_PATH,
} from './code_build_plan.ts';
import { parseVersionString } from './version.ts';

type Triple = [number, number, number];

/** A declared `X.Y.Z` as the resolver's triple, or null when absent. */
function tripleOf(declared: string | null): Triple | null {
	return declared === null ? null : (parseVersionString(declared) as Triple);
}

/** The tree's version.ts source, or null when it cannot be read. */
async function versionSourceOf(treeRoot: string): Promise<string | null> {
	try {
		return await Bun.file(join(treeRoot, VERSION_TS_PATH)).text();
	} catch {
		return null;
	}
}

/**
 * What the tree at `treeRoot` calls itself (`7.0.0-beta.5`, `7.0.0`,
 * `7.0.1-dev`), or null when its version.ts is unreadable or declares no data
 * triple — no provenance, no identity.
 */
export async function releaseIdentityOfTree(treeRoot: string): Promise<string | null> {
	const source = await versionSourceOf(treeRoot);
	if (source === null) return null;
	const triple = tripleOf(parseDeclaredDataTriple(source));
	if (triple === null) return null;
	const nextDevTriple = tripleOf(parseDeclaredReleaseTriple(source)) ?? triple;
	const identity = await readReleaseIdentityOf(treeRoot, { triple, nextDevTriple });
	return identity.version;
}
