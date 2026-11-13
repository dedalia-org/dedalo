/**
 * THE MIGRATION SEAL (owner ruling C31, 2026-11-13; T1-25 decision 1 (b)).
 *
 * The update process rules that the data model cannot move INSIDE one release
 * triple X.Y.Z (owner ruling 2026-11-11: a same-triple run — beta.7 → beta.8,
 * rc.1 → X.Y.Z — crosses no migration, so an automatic code rollback over it is
 * sound). Until this file that was a convention: `0015_dd_ontology_machine_names.sql`
 * (class `incompatible`, release 7.0.0) shipped between 7.0.0-beta.7 and -beta.8,
 * so a rollback from beta.8 to beta.7 put back a build that did not fit the
 * database. The seal makes the ruling MECHANICAL:
 *
 *   install/db/migrations.sealed.json
 *   { "format": 1, "triples": { "<X.Y.Z>": [ "<incompatible file>", … ] } }
 *
 * A triple is SEALED by the release cut (`bun run changelog release <version>`
 * → sealReleaseTriple): the FIRST build of X.Y.Z (its first prerelease, or the
 * release itself when it had none) freezes the set of `incompatible` migrations
 * the ledger (migrations.lock.json) assigns to that triple. From then on an
 * `incompatible` migration whose `release` names a sealed triple and that is
 * NOT in its seal set is a violation: it must move to the NEXT MINOR (D-4: an
 * incompatible class needs an incompatible release). A `compatible` migration
 * may still join a sealed triple — the previous build runs against it (D-2).
 *
 * 7.0.0 was sealed RETROACTIVELY on 2026-11-13, at beta.8, with the set as it
 * stood (0015 included): the seal law starts there, it does not rewrite the
 * betas that preceded it.
 *
 * Gate: test/unit/migration_content_hash_tripwire.test.ts (every sealed triple
 * holds its incompatible set; every triple with a release directory under
 * changes/ is sealed; planted violations).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	MIGRATION_LEDGER_PATH,
	type MigrationLedger,
	readMigrationLedger,
} from './migration_ledger.ts';

/** The seal file, beside the ledger it freezes. */
export const MIGRATION_SEAL_PATH = resolve(import.meta.dir, 'migrations.sealed.json');

export const MIGRATION_SEAL_FORMAT = 1;

export interface MigrationSeal {
	format: number;
	/** Sealed triple (`X.Y.Z`) → the `incompatible` files frozen at its first build, sorted. */
	triples: Readonly<Record<string, readonly string[]>>;
}

const TRIPLE_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** The `X.Y.Z` of a release (`7.0.1`, `7.0.1-beta.2` → `7.0.1`), or null when it names none. */
export function releaseTripleOf(version: string): string | null {
	const match = /^(\d+\.\d+\.\d+)(?:-|$)/.exec(version);
	return match === null ? null : (match[1] as string);
}

/** Read and shape-check the seal; throws naming the file on anything malformed. */
export function readMigrationSeal(path: string = MIGRATION_SEAL_PATH): MigrationSeal {
	const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MigrationSeal>;
	if (
		parsed.format !== MIGRATION_SEAL_FORMAT ||
		typeof parsed.triples !== 'object' ||
		parsed.triples === null
	) {
		throw new Error(`${path}: not a format-${MIGRATION_SEAL_FORMAT} migration seal`);
	}
	const malformed = Object.entries(parsed.triples).filter(
		([triple, files]) =>
			!TRIPLE_RE.test(triple) ||
			!Array.isArray(files) ||
			files.some((file) => typeof file !== 'string'),
	);
	if (malformed.length > 0) {
		throw new Error(
			`${path}: malformed triples: ${malformed.map(([triple]) => triple).join(', ')}`,
		);
	}
	return parsed as MigrationSeal;
}

/** The `incompatible` files the ledger assigns to `triple`, sorted — what a seal of it freezes. */
export function incompatibleFilesOf(ledger: MigrationLedger, triple: string): string[] {
	return Object.entries(ledger.migrations)
		.filter(([, entry]) => entry.class === 'incompatible' && entry.release === triple)
		.map(([file]) => file)
		.sort();
}

/**
 * Every disagreement between the ledger and the seal, as sentences; empty when
 * the seal holds:
 *  - an `incompatible` migration whose release triple is sealed and that is not
 *    in the seal set (it was added after the triple's first build);
 *  - a sealed file the ledger does not carry as `incompatible` of that triple
 *    (the seal names what the ledger no longer says).
 */
export function sealViolations(ledger: MigrationLedger, seal: MigrationSeal): string[] {
	const problems: string[] = [];
	for (const [file, entry] of Object.entries(ledger.migrations)) {
		if (entry.class !== 'incompatible') continue;
		const sealed = seal.triples[entry.release];
		if (sealed === undefined || sealed.includes(file)) continue;
		problems.push(
			`${file}: release ${entry.release} is SEALED (its first build shipped ${sealed.length} incompatible migration(s): ${sealed.join(', ') || 'none'}) — an incompatible migration added after that must move to the next minor (install/db/migration_seal.ts)`,
		);
	}
	for (const [triple, files] of Object.entries(seal.triples)) {
		for (const file of files) {
			const entry = ledger.migrations[file];
			if (entry === undefined || entry.class !== 'incompatible' || entry.release !== triple) {
				problems.push(
					`${file}: sealed under ${triple} but the ledger ${entry === undefined ? 'does not carry it' : `says ${entry.class} / ${entry.release}`} — the seal names a file the ledger no longer frozen there`,
				);
			}
		}
	}
	return problems;
}

/** `seal` with `triple` added (its current incompatible set); unchanged when already sealed. */
export function sealed(
	seal: MigrationSeal,
	ledger: MigrationLedger,
	triple: string,
): MigrationSeal {
	if (seal.triples[triple] !== undefined) return seal;
	const triples = Object.fromEntries(
		[...Object.entries(seal.triples), [triple, incompatibleFilesOf(ledger, triple)]].sort(
			([a], [b]) => compareTriples(a as string, b as string),
		),
	);
	return { format: seal.format, triples };
}

function compareTriples(a: string, b: string): number {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);
	for (let i = 0; i < 3; i += 1) {
		const diff = (left[i] as number) - (right[i] as number);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** The seal file's text (tab-indented, trailing newline — the ledger's spelling). */
export function renderMigrationSeal(seal: MigrationSeal): string {
	return `${JSON.stringify(seal, null, '\t')}\n`;
}

/**
 * THE RELEASE CUT'S HOOK: seal `version`'s triple when its first build is being
 * cut (nothing when it is sealed already). Returns what happened, for the cut's
 * transcript. The ledger and the seal are read from disk (the repo's files).
 */
export async function sealReleaseTriple(
	version: string,
	paths: { seal?: string; ledger?: string } = {},
): Promise<{ triple: string; wrote: boolean; files: readonly string[] }> {
	const triple = releaseTripleOf(version);
	if (triple === null) throw new Error(`'${version}' names no X.Y.Z release triple to seal`);
	const sealPath = paths.seal ?? MIGRATION_SEAL_PATH;
	const seal = readMigrationSeal(sealPath);
	if (seal.triples[triple] !== undefined) {
		return { triple, wrote: false, files: seal.triples[triple] as readonly string[] };
	}
	const ledger = await readMigrationLedger(paths.ledger ?? MIGRATION_LEDGER_PATH);
	const next = sealed(seal, ledger, triple);
	writeFileSync(sealPath, renderMigrationSeal(next));
	return { triple, wrote: true, files: next.triples[triple] as readonly string[] };
}
