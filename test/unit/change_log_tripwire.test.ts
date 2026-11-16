/**
 * CHANGE LOG TRIPWIRE (DEC-12: every documented invariant has a mechanical gate).
 *
 * `docs/change_log.md` is GENERATED from `changes/` by scripts/changelog.ts (the model
 * and its reason: the header of scripts/lib/change_log.ts; the authoring rules:
 * changes/README.md). What this holds:
 *
 *   1. every fragment and every release.json parses (strict front matter, closed
 *      type/audience vocabularies, real dates, no headings in a body);
 *   2. the committed page is BYTE-IDENTICAL to a fresh render — a hand edit, or a
 *      fragment added without `bun run changelog`, is red;
 *   3. the releases form one chain: each release starts at its predecessor's tag, is not
 *      dated before it, and ships no fragment dated after its own release;
 *   4. every wire-contract id a fragment or a release names exists in the ledger, and no
 *      two releases claim the same id;
 *   5. every ledger entry adopted on or after WC_NOTE_FLOOR is cited by a fragment's
 *      `wc:` — a deliberate wire change is a reader-visible change, so it ships with a
 *      sentence a reader can use, not only an id;
 *   6. RELEASE NOTES (2026-10-09): a release.json's `notes` — what every installation's
 *      update panel shows for that release — equal `deriveReleaseNotes` of that release's
 *      own fragments, the closed `notes` shape refuses anything else, and the REAL
 *      `bun run changelog release` writes them (executed in a scratch copy of the
 *      program, against a scratch git repository).
 *
 * Hermetic: files only, no DB, no network — the page is a pure function of the tree;
 * leg 6 runs git only inside its own scratch repository.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	CHANGE_LOG_PAGE,
	compareVersions,
	deriveReleaseNotes,
	loadChangeSet,
	parseRelease,
	renderFromRepo,
	wireContractIds,
} from '../../scripts/lib/change_log.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/**
 * The day the gate was born. Ledger entries adopted before it were written before
 * fragments existed; the releases list their ids, and the prose that told readers about
 * them (where any did) was migrated into fragments by hand. From here on, no id alone.
 */
const WC_NOTE_FLOOR = '2026-09-26';

const set = loadChangeSet(REPO_ROOT);
const ledger = wireContractIds(REPO_ROOT);
const allFragments = [...set.unreleased, ...set.releases.flatMap((r) => r.fragments)];

describe('change log: generated from changes/, and complete', () => {
	test('the tree is populated (a gate over nothing asserts nothing)', () => {
		// 2026-09-26: the hand-written page's entries migrated into fragments across three
		// releases. Fewer means the loader stopped seeing them, not that history shrank.
		expect(allFragments.length).toBeGreaterThanOrEqual(40);
		expect(set.releases.length).toBeGreaterThanOrEqual(3);
		expect(ledger.length).toBeGreaterThan(200);
	});

	test('docs/change_log.md is byte-identical to a fresh render (run `bun run changelog`)', () => {
		const committed = readFileSync(join(REPO_ROOT, CHANGE_LOG_PAGE), 'utf8');
		expect(committed).toBe(renderFromRepo(REPO_ROOT));
	});

	test('releases chain: each starts at its predecessor tag and is not dated before it', () => {
		const ordered = [...set.releases].sort((a, b) =>
			compareVersions(a.release.version, b.release.version),
		);
		const breaks: string[] = [];
		for (let i = 1; i < ordered.length; i++) {
			const prev = ordered[i - 1]!.release;
			const cur = ordered[i]!.release;
			if (cur.from !== prev.to)
				breaks.push(`${cur.version}: from '${cur.from}', expected '${prev.to}'`);
			if (cur.date < prev.date)
				breaks.push(`${cur.version}: dated ${cur.date}, before ${prev.version} (${prev.date})`);
		}
		expect(breaks).toEqual([]);
	});

	test('a release ships no fragment dated after the release itself', () => {
		const late = set.releases.flatMap(({ release, fragments }) =>
			fragments
				.filter((f) => f.date > release.date)
				.map((f) => `${f.file} (${f.date} > ${release.date})`),
		);
		expect(late).toEqual([]);
	});

	test('every wire-contract id a fragment cites exists in the ledger', () => {
		const known = new Set(ledger);
		const dangling = allFragments.flatMap((f) =>
			f.wc.filter((id) => !known.has(id)).map((id) => `${f.file}: ${id}`),
		);
		expect(dangling).toEqual([]);
	});

	test('every id a release claims exists, and no id is claimed twice', () => {
		const known = new Set(ledger);
		const seen = new Map<string, string>();
		const problems: string[] = [];
		for (const { release } of set.releases) {
			for (const id of release.wire_contract) {
				if (!known.has(id)) problems.push(`${release.version}: ${id} is not in the ledger`);
				const other = seen.get(id);
				if (other !== undefined) problems.push(`${id}: claimed by ${other} and ${release.version}`);
				seen.set(id, release.version);
			}
		}
		expect(problems).toEqual([]);
	});

	test(`every ledger entry adopted on/after ${WC_NOTE_FLOOR} is told to a reader by a fragment`, () => {
		const cited = new Set(allFragments.flatMap((f) => f.wc));
		const untold = ledger.filter((id) => {
			const date = /^WC-(\d{4}-\d{2}-\d{2})-/.exec(id)?.[1];
			return date !== undefined && date >= WC_NOTE_FLOOR && !cited.has(id);
		});
		// Fix: add changes/unreleased/<slug>.md with `wc: <id>` (bun run changelog new <slug>).
		expect(untold).toEqual([]);
	});

	test('the floor check can see a dated id (anti-vacuity: the regex matches the grammar in use)', () => {
		expect(ledger.some((id) => /^WC-\d{4}-\d{2}-\d{2}-/.test(id))).toBe(true);
	});
});

describe('release notes: frozen at the cut, equal to the derivation, written by the real command', () => {
	test('every snapshot that carries notes carries exactly its fragments’ derivation', () => {
		const drift = set.releases
			.filter(({ release }) => release.notes !== undefined)
			.filter(({ release, fragments }) => {
				return JSON.stringify(release.notes) !== JSON.stringify(deriveReleaseNotes(fragments));
			})
			.map(({ release }) => release.version);
		// Fix: notes are DERIVED — re-cut them from the fragments, never hand-edit.
		expect(drift).toEqual([]);
	});

	test('the derivation over the real tree is populated and ordered as the page renders', () => {
		// anti-vacuity: the derivation sees every fragment of a real release
		const { fragments } = set.releases[0] as (typeof set.releases)[number];
		const notes = deriveReleaseNotes(fragments);
		expect(notes.entries.length).toBe(fragments.length);
		expect(notes.action_needed).toEqual(
			fragments
				.filter((f) => f.breaking)
				.map((f) => f.title)
				.sort((a, b) => {
					const fa = fragments.find((f) => f.title === a)!;
					const fb = fragments.find((f) => f.title === b)!;
					return fa.date === fb.date ? (fa.slug < fb.slug ? -1 : 1) : fa.date < fb.date ? 1 : -1;
				}),
		);
		// audience order, then type order — the page's own headings
		const audiences = ['user', 'admin', 'developer'];
		const order = notes.entries.map((entry) => audiences.indexOf(entry.audience));
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	test('the closed notes shape refuses anything else', () => {
		const base = {
			version: '7.0.1',
			date: '2026-10-09',
			from: 'v7.0.0',
			to: 'v7.0.1',
			commits: 1,
			wire_contract: [],
		};
		const good = {
			action_needed: ['Do X.'],
			entries: [{ type: 'fixed', audience: 'user', title: 'Y.' }],
		};
		expect(
			parseRelease('r.json', JSON.stringify({ ...base, notes: good })).notes as unknown,
		).toEqual(good);
		expect('notes' in parseRelease('r.json', JSON.stringify(base))).toBe(false);
		const bad: unknown[] = [
			{ ...good, extra: 1 },
			{ action_needed: good.action_needed },
			{ ...good, action_needed: [''] },
			{ ...good, entries: [{ type: 'improved', audience: 'user', title: 'Y.' }] },
			{ ...good, entries: [{ type: 'fixed', audience: 'everyone', title: 'Y.' }] },
			{ ...good, entries: [{ type: 'fixed', audience: 'user', title: 'Y.', body: 'z' }] },
			[],
		];
		for (const notes of bad) {
			expect(() => parseRelease('r.json', JSON.stringify({ ...base, notes }))).toThrow();
		}
	});

	const SCRATCH = mkdtempSync(join(tmpdir(), 'dedalo_changelog_release_'));
	afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

	function git(args: string[]): void {
		const run = Bun.spawnSync(
			[
				'git',
				'-C',
				SCRATCH,
				'-c',
				'user.name=gate',
				'-c',
				'user.email=gate@test.invalid',
				'-c',
				'commit.gpgsign=false',
				'-c',
				'tag.gpgsign=false',
				...args,
			],
			{ stdout: 'pipe', stderr: 'pipe' },
		);
		if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
	}

	function file(path: string, text: string): void {
		mkdirSync(join(SCRATCH, path, '..'), { recursive: true });
		writeFileSync(join(SCRATCH, path), text);
	}

	const front = (title: string, type: string, audience: string, date: string, breaking = false) =>
		`---\ntitle: ${title}\ntype: ${type}\naudience: ${audience}\ndate: ${date}\nbreaking: ${breaking}\n---\nBody of ${title}\n`;

	test('`bun run changelog release` (the real program, scratch copy) freezes the derived notes', () => {
		// the REAL program and its library, byte-for-byte (ROOT is relative to the script)
		cpSync(join(REPO_ROOT, 'scripts', 'changelog.ts'), join(SCRATCH, 'scripts', 'changelog.ts'));
		cpSync(
			join(REPO_ROOT, 'scripts', 'lib', 'change_log.ts'),
			join(SCRATCH, 'scripts', 'lib', 'change_log.ts'),
		);
		// …and the engine's release grammar + comparator the library imports (a pure leaf)
		cpSync(
			join(REPO_ROOT, 'src', 'core', 'update', 'release_identity.ts'),
			join(SCRATCH, 'src', 'core', 'update', 'release_identity.ts'),
		);
		// …and the migration seal the cut writes (C31): its module, the ledger reader it
		// imports, the REAL ledger, and a seal that knows nothing of 7.0.1 yet.
		for (const name of ['migration_seal.ts', 'migration_ledger.ts', 'migrations.lock.json']) {
			cpSync(join(REPO_ROOT, 'install', 'db', name), join(SCRATCH, 'install', 'db', name));
		}
		file(
			'install/db/migrations.sealed.json',
			`${JSON.stringify({ format: 1, triples: { '7.0.0': ['0001_baseline.sql'] } })}\n`,
		);
		file('changes/README.md', '# changes\n');
		file(
			'changes/7.0.0/release.json',
			`${JSON.stringify({ version: '7.0.0', date: '2026-09-01', from: null, to: 'v7.0.0', commits: 1, wire_contract: [] })}\n`,
		);
		file('changes/7.0.0/first.md', front('First release.', 'added', 'user', '2026-09-01'));
		file('engineering/wire_contract/WC-001-x.md', '# WC-001 — scratch entry\n');
		file('docs/.keep', '');
		git(['init', '-q']);
		git(['add', '-A']);
		git(['commit', '-q', '-m', 'v7.0.0']);
		git(['tag', 'v7.0.0']);
		file(
			'changes/unreleased/rename-key.md',
			front('Rename DEDALO_X to DEDALO_Y.', 'changed', 'admin', '2026-10-01', true),
		);
		file(
			'changes/unreleased/faster-search.md',
			front('Search is faster.', 'fixed', 'user', '2026-10-02'),
		);
		file(
			'changes/unreleased/new-api.md',
			front('A new API action.', 'added', 'developer', '2026-10-03'),
		);
		git(['add', '-A']);
		git(['commit', '-q', '-m', 'work']);
		const pending = loadChangeSet(SCRATCH).unreleased;
		expect(pending.length).toBe(3);

		const run = Bun.spawnSync(
			['bun', join(SCRATCH, 'scripts', 'changelog.ts'), 'release', '7.0.1', '--date', '2026-10-09'],
			{
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		expect(run.exitCode, run.stderr.toString()).toBe(0);
		// The cut SEALED the new triple (C31): 7.0.1's incompatible set — none in the ledger
		// today — joins the seal; the sealed 7.0.0 is untouched.
		expect(
			JSON.parse(readFileSync(join(SCRATCH, 'install', 'db', 'migrations.sealed.json'), 'utf8')),
		).toEqual({
			format: 1,
			triples: { '7.0.0': ['0001_baseline.sql'], '7.0.1': [] },
		});
		expect(run.stdout.toString()).toContain('Sealed the migration set of 7.0.1');
		const written = parseRelease(
			'release.json',
			readFileSync(join(SCRATCH, 'changes', '7.0.1', 'release.json'), 'utf8'),
		);
		expect(written.notes).toEqual(deriveReleaseNotes(pending));
		expect(written.notes?.action_needed).toEqual(['Rename DEDALO_X to DEDALO_Y.']);
		expect(written.notes?.entries.map((entry) => entry.audience)).toEqual([
			'user',
			'admin',
			'developer',
		]);
		// the cut tree is itself valid under this gate's rules
		const cut = loadChangeSet(SCRATCH);
		const release = cut.releases.find((r) => r.release.version === '7.0.1');
		expect(JSON.stringify(release?.release.notes)).toBe(
			JSON.stringify(deriveReleaseNotes(release?.fragments ?? [])),
		);
	}, 60_000);
});
