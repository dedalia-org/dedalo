#!/usr/bin/env bun
/**
 * DERIVATION VERSIONS — the bank of every hand-bumped derivation version
 * (update audit 2026-10-29, U-38 + U-30): engineering/derivation_versions.json
 * holds, per surface, `{version, hash}` where `hash` is measured from what the
 * surface actually PRODUCES for fixed inputs, never from its spelling.
 *
 *   media_rules    TEMPLATE_VERSION (media/protection.ts) vs the rendered
 *                  .htaccess / nginx conf / nginx map for a fixed root, every
 *                  mode, fixed qualities and addons. TEMPLATE_VERSION is folded
 *                  into the rule files' config hash, so it is what makes an
 *                  install REGENERATE — a template edit without a bump ships
 *                  rules no install ever rewrites.
 *   search_stores  SEARCH_STORE_DERIVATION_VERSION (db/db_assets.ts) vs the
 *                  declared derivation (sync function bodies + backfill
 *                  templates, searchStoreDerivationHash). The version is folded
 *                  into the store stamp the update's ancillary phase compares.
 *
 * The law (release_manifest_completeness_tripwire): the bank equals what the
 * tree measures. A hash that moved under an unchanged version is the forgotten
 * bump; a version that moved without a re-record is a bank nobody updated.
 *
 *   bun run scripts/derivation_versions.ts            check (exit 1 on drift)
 *   bun run scripts/derivation_versions.ts --update   re-record — REFUSES a hash
 *                                                     that moved while its version
 *                                                     did not (bump it first), and a
 *                                                     version that went backwards
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { config } from '../src/config/config.ts';
import {
	SEARCH_STORE_DERIVATION_VERSION,
	searchStoreDerivationHash,
} from '../src/core/db/db_assets.ts';
import {
	buildHtaccess,
	buildNginxConf,
	buildNginxMap,
	escapeRegexLiteral,
	overrideMediaProtectionPathsForTests,
	TEMPLATE_VERSION,
} from '../src/core/media/protection.ts';
import { TEST_MEDIA_MARKER } from '../src/core/media/test_media_root.ts';

export const BANK_PATH = resolve(import.meta.dir, '../engineering/derivation_versions.json');

export type Surface = 'media_rules' | 'search_stores';
export interface Derivation {
	version: number;
	hash: string;
}
export type Derivations = Record<Surface, Derivation>;

/** The FIXED render inputs: qualities with the regex-hostile characters, one addon. */
const FIXED_QUALITIES = ['image/1.5MB', 'av/404', 'pdf/web'];
const FIXED_ADDONS = ['RewriteRule ^fixed-addon$ - [L]'];

/** Replace every spelling of a machine-dependent value with its placeholder. */
function normalize(text: string, root: string): string {
	const url = `/dedalo/${config.mediaDir}`;
	const folder = config.media.image.folder.replace(/^\/+/, '').replace(/\/+$/, '');
	return text
		.replaceAll(/# config-hash: [0-9a-f]{64}/g, '# config-hash: <HASH>')
		.replaceAll(escapeRegexLiteral(root), '<ROOT>')
		.replaceAll(root, '<ROOT>')
		.replaceAll(escapeRegexLiteral(url), '/dedalo/<MEDIA_DIR>')
		.replaceAll(url, '/dedalo/<MEDIA_DIR>')
		.replaceAll(`<MEDIA_DIR>/${escapeRegexLiteral(folder)}/`, '<MEDIA_DIR>/<IMAGE>/');
}

/**
 * Every rule artifact for the fixed inputs, normalized. The root is a DECLARED
 * scratch media root (the test-media guard refuses an unmarked one when armed);
 * rendering is pure — nothing is written into it but the marker.
 */
export function renderMediaRules(): string {
	// mkdtemp: an unpredictable, freshly created private dir (predictable_tmp)
	const scratch = mkdtempSync(join(tmpdir(), 'dedalo_derivation_render_'));
	const root = join(scratch, 'media');
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, TEST_MEDIA_MARKER), 'derivation_versions render root\n');
	overrideMediaProtectionPathsForTests({ mediaRoot: root, authStorePath: join(scratch, 'auth') });
	try {
		const parts = [
			buildHtaccess('off'),
			buildHtaccess('private', [], FIXED_ADDONS),
			buildHtaccess('publication', FIXED_QUALITIES, FIXED_ADDONS),
			buildNginxConf('off'),
			buildNginxConf('private'),
			buildNginxConf('publication', FIXED_QUALITIES),
			buildNginxMap(),
		];
		return normalize(parts.join('\n<ARTIFACT>\n'), root);
	} finally {
		overrideMediaProtectionPathsForTests(null);
		rmSync(scratch, { recursive: true, force: true });
	}
}

function sha256(text: string): string {
	return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

/** What the tree measures today. */
export function currentDerivations(): Derivations {
	return {
		media_rules: { version: TEMPLATE_VERSION, hash: sha256(renderMediaRules()) },
		search_stores: {
			version: SEARCH_STORE_DERIVATION_VERSION,
			hash: searchStoreDerivationHash(),
		},
	};
}

export function readBank(path: string = BANK_PATH): Derivations {
	const parsed = JSON.parse(readFileSync(path, 'utf8')) as { surfaces: Derivations };
	return parsed.surfaces;
}

/** The constant a surface's version lives in (for the messages). */
const VERSION_HOME: Record<Surface, string> = {
	media_rules: 'TEMPLATE_VERSION in src/core/media/protection.ts',
	search_stores: 'SEARCH_STORE_DERIVATION_VERSION in src/core/db/db_assets.ts',
};

/** PURE: one surface's verdict — null when the bank equals the tree. */
export function judgeSurface(
	surface: Surface,
	current: Derivation,
	banked: Derivation | undefined,
): string | null {
	if (banked === undefined) return `${surface}: not banked — run --update`;
	if (current.version === banked.version && current.hash === banked.hash) return null;
	if (current.version === banked.version) {
		return `${surface}: the derivation changed (hash ${banked.hash.slice(0, 12)} → ${current.hash.slice(0, 12)}) but its version did not — bump ${VERSION_HOME[surface]}, then run scripts/derivation_versions.ts --update`;
	}
	if (current.version < banked.version) {
		return `${surface}: version went BACKWARDS (${banked.version} → ${current.version}) — a version only moves up`;
	}
	return `${surface}: version moved ${banked.version} → ${current.version} but the bank was not re-recorded — run scripts/derivation_versions.ts --update`;
}

/** PURE: every surface's verdict (empty = the bank equals the tree). */
export function judgeBank(current: Derivations, banked: Partial<Derivations>): string[] {
	return (Object.keys(current) as Surface[])
		.map((surface) => judgeSurface(surface, current[surface], banked[surface]))
		.filter((problem): problem is string => problem !== null);
}

/** PURE: the refusals --update owes (a moved hash under the same version, a backwards version). */
export function updateRefusals(current: Derivations, banked: Partial<Derivations>): string[] {
	return judgeBank(current, banked).filter(
		(problem) => problem.includes('but its version did not') || problem.includes('BACKWARDS'),
	);
}

function writeBank(current: Derivations): void {
	const body = {
		_: 'GENERATED by scripts/derivation_versions.ts --update — do not hand-edit. Per surface: the hand-bumped derivation version and the sha256 of what the surface PRODUCES for fixed inputs. release_manifest_completeness_tripwire reds when the tree measures anything else (a hash moved under an unchanged version = a forgotten bump).',
		surfaces: current,
	};
	writeFileSync(BANK_PATH, `${JSON.stringify(body, null, '\t')}\n`);
}

function main(): void {
	const current = currentDerivations();
	let banked: Partial<Derivations> = {};
	let unreadable: string | null = null;
	try {
		banked = readBank();
	} catch (error) {
		banked = {};
		unreadable = error instanceof Error ? error.message : String(error);
	}
	if (process.argv.includes('--update')) {
		// An unreadable bank (merge-conflicted, truncated) is NOT an empty one: read as
		// empty, every surface would look unbanked and the write would launder a moved
		// hash under an unchanged version. Restore the file first, then re-record.
		if (unreadable !== null && existsSync(BANK_PATH)) {
			console.error(
				`REFUSED: ${BANK_PATH} exists but cannot be read (${unreadable}) — restore it (git checkout) before --update`,
			);
			process.exit(1);
		}
		const refusals = updateRefusals(current, banked);
		if (refusals.length > 0) {
			console.error(`REFUSED:\n  ${refusals.join('\n  ')}`);
			process.exit(1);
		}
		writeBank(current);
		console.log(`derivation_versions: recorded ${JSON.stringify(current)}`);
		return;
	}
	const problems = judgeBank(current, banked);
	if (problems.length > 0) {
		console.error(problems.join('\n'));
		process.exit(1);
	}
	console.log('derivation_versions: bank equals the tree');
}

if (import.meta.main) main();
