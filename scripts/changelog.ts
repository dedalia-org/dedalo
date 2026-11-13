/**
 * CHANGE LOG CLI — renders docs/change_log.md from changes/, scaffolds a fragment, cuts a
 * release. The model and why it exists: scripts/lib/change_log.ts. Authoring rules:
 * changes/README.md. Gate: test/unit/change_log_tripwire.test.ts.
 *
 *   bun run changelog                        re-render docs/change_log.md
 *   bun run changelog --check                exit 1 if the page is stale (writes nothing)
 *   bun run changelog new <slug> [--type t] [--audience a] [--title "…"]
 *                                            scaffold changes/unreleased/<slug>.md
 *   bun run changelog release <version> [--from <tag>] [--date yyyy-mm-dd] [--allow-empty]
 *                                            move unreleased/ into changes/<version>/, freeze
 *                                            release.json (git is read HERE, once; the notes
 *                                            the update panel shows are derived HERE), re-render
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sealReleaseTriple } from '../install/db/migration_seal.ts';
import {
	AUDIENCES,
	CHANGE_LOG_PAGE,
	compareVersions,
	deriveReleaseNotes,
	loadChangeSet,
	parseRelease,
	type Release,
	renderFromRepo,
	TYPES,
	UNRELEASED_DIR,
	unreleasedWireContract,
	wireContractIds,
} from './lib/change_log.ts';

const ROOT = join(import.meta.dir, '..');

function die(message: string): never {
	console.error(`changelog: ${message}`);
	process.exit(1);
}

function option(args: string[], name: string): string | undefined {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return undefined;
	const value = args[i + 1];
	if (value === undefined || value.startsWith('--')) die(`--${name} needs a value`);
	return value;
}

function today(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function git(args: string[]): string {
	const r = Bun.spawnSync(['git', '-C', ROOT, ...args], { stdout: 'pipe', stderr: 'pipe' });
	if (r.exitCode !== 0) die(`git ${args.join(' ')} failed: ${r.stderr.toString().trim()}`);
	return r.stdout.toString().trim();
}

function tagExists(tag: string): boolean {
	return (
		Bun.spawnSync(['git', '-C', ROOT, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}`])
			.exitCode === 0
	);
}

function render(check: boolean): void {
	const page = join(ROOT, CHANGE_LOG_PAGE);
	const next = renderFromRepo(ROOT);
	const current = existsSync(page) ? readFileSync(page, 'utf8') : '';
	if (current === next) {
		console.log(`${CHANGE_LOG_PAGE} is current.`);
		return;
	}
	if (check) die(`${CHANGE_LOG_PAGE} is stale — run \`bun run changelog\``);
	writeFileSync(page, next);
	console.log(`${CHANGE_LOG_PAGE} rendered.`);
}

function scaffold(args: string[]): void {
	const slug = args[0];
	if (slug === undefined || slug.startsWith('--'))
		die('usage: changelog new <slug> [--type t] [--audience a] [--title "…"]');
	const file = join(ROOT, 'changes', UNRELEASED_DIR, `${slug}.md`);
	if (existsSync(file)) die(`changes/${UNRELEASED_DIR}/${slug}.md already exists`);
	mkdirSync(join(ROOT, 'changes', UNRELEASED_DIR), { recursive: true });
	const text = [
		'---',
		`title: ${option(args, 'title') ?? ''}`,
		`type: ${option(args, 'type') ?? ''}`,
		`audience: ${option(args, 'audience') ?? ''}`,
		`date: ${today()}`,
		'---',
		'',
	].join('\n');
	writeFileSync(file, text);
	console.log(
		`changes/${UNRELEASED_DIR}/${slug}.md created — fill title, type (${TYPES.join('|')}),`,
	);
	console.log(`audience (${AUDIENCES.join('|')}) and the body, then run \`bun run changelog\`.`);
}

async function release(args: string[]): Promise<void> {
	const version = args[0];
	if (version === undefined || version.startsWith('--')) {
		die('usage: changelog release <version> [--from <tag>] [--date yyyy-mm-dd] [--allow-empty]');
	}
	const set = loadChangeSet(ROOT);
	const dir = join(ROOT, 'changes', version);
	if (existsSync(dir)) die(`changes/${version}/ already exists`);
	if (set.unreleased.length === 0 && !args.includes('--allow-empty')) {
		die(
			'changes/unreleased/ is empty — a release with nothing to tell its readers needs --allow-empty',
		);
	}

	const previous = [...set.releases].sort((a, b) =>
		compareVersions(b.release.version, a.release.version),
	)[0];
	if (previous !== undefined && compareVersions(version, previous.release.version) <= 0) {
		die(`${version} is not after the last release, ${previous.release.version}`);
	}
	const from = option(args, 'from') ?? previous?.release.to;
	if (from === undefined) die('no earlier release to start from — pass --from <tag>');
	if (!tagExists(from)) die(`tag '${from}' does not exist`);

	const to = `v${version}`;
	// Before tagging (the normal order) the range ends at HEAD; a re-cut of an existing tag uses the tag.
	const end = tagExists(to) ? to : 'HEAD';
	const commits = Number(git(['rev-list', '--count', '--no-merges', `${from}..${end}`]));

	const record: Release = {
		version,
		date: option(args, 'date') ?? today(),
		from,
		to,
		commits,
		wire_contract: unreleasedWireContract(set, wireContractIds(ROOT)),
		// the machine-read notes every installation's update panel shows for this
		// release (code_manifest.ts reads them; change_log_tripwire holds them equal
		// to this derivation)
		notes: deriveReleaseNotes(set.unreleased),
	};
	const json = `${JSON.stringify(record, null, '\t')}\n`;
	parseRelease(`changes/${version}/release.json`, json); // refuse a bad --date before moving anything

	mkdirSync(dir);
	for (const f of set.unreleased) renameSync(join(ROOT, f.file), join(dir, `${f.slug}.md`));
	writeFileSync(join(dir, 'release.json'), json);
	render(false);
	// THE MIGRATION SEAL (owner ruling C31, 2026-11-13): the FIRST build of a triple
	// X.Y.Z (its first prerelease, or the release itself) freezes the set of
	// `incompatible` migrations the ledger assigns to it — install/db/migration_seal.ts.
	// From then on an incompatible migration added to that triple is red
	// (migration_content_hash_tripwire): it must move to the next minor.
	const seal = await sealReleaseTriple(version);
	console.log(
		`Release ${version}: ${set.unreleased.length} notes, ${record.wire_contract.length} wire-contract ids, ${commits} commits since ${from}.`,
	);
	console.log(
		seal.wrote
			? `Sealed the migration set of ${seal.triple} (install/db/migrations.sealed.json: ${seal.files.length} incompatible file(s)${seal.files.length > 0 ? ` — ${seal.files.join(', ')}` : ''}).`
			: `Triple ${seal.triple} was sealed by its first build (${seal.files.length} incompatible file(s)) — unchanged.`,
	);
	console.log(
		`Next: commit changes/, ${CHANGE_LOG_PAGE}${seal.wrote ? ' and install/db/migrations.sealed.json' : ''}, then tag ${to} on that commit.`,
	);
}

const [command, ...rest] = process.argv.slice(2);
try {
	if (command === undefined) render(false);
	else if (command === '--check') render(true);
	else if (command === 'new') scaffold(rest);
	else if (command === 'release') await release(rest);
	else die(`unknown command '${command}' (render | --check | new | release)`);
} catch (error) {
	// A refused fragment or release.json names its file; the stack adds nothing for an author.
	die((error as Error).message);
}
