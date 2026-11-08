/**
 * A local --ontology-source the SERVICE USER cannot read is refused by the
 * production System check, before any change (install campaign C4 RHEL10 F1:
 * the plan accepted a source under a 0700 home, the run failed at host_engine
 * after packages, account, runtime and database were done, with a misleading
 * "no such file or directory"). And the catalog reader itself names a
 * permission error as one, never as a missing path.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostCtx, HostPlanCtx } from '../../src/core/install/host/contract.ts';
import type { HostStat } from '../../src/core/install/host/fs.ts';
import {
	grants,
	ontologySourceAccessProblems,
} from '../../src/core/install/host/production/ontology_source_access.ts';
import { resolveOntologyCatalog } from '../../src/core/install/ontology_catalog.ts';

type Entry = Partial<HostStat> & { mode: number; children?: string[] };

const dir = (mode: number, owner = 'root', group = 'root', children: string[] = []): Entry => ({
	mode,
	owner,
	group,
	isDirectory: true,
	isSymlink: false,
	children,
});
const file = (mode: number, owner = 'root', group = 'root'): Entry => ({
	mode,
	owner,
	group,
	isDirectory: false,
	isSymlink: false,
});

/** The RHEL default: /home/dedalo 0700, the checkout's own release inside it. */
const SOURCE = '/home/dedalo/dedalo/install/import/ontology/7.0';
function homeTree(homeMode: number): Record<string, Entry> {
	return {
		'/': dir(0o755),
		'/home': dir(0o755),
		'/home/dedalo': dir(homeMode, 'dedalo', 'dedalo'),
		'/home/dedalo/dedalo': dir(0o755, 'dedalo', 'dedalo'),
		'/home/dedalo/dedalo/install': dir(0o755, 'dedalo', 'dedalo'),
		'/home/dedalo/dedalo/install/import': dir(0o755, 'dedalo', 'dedalo'),
		'/home/dedalo/dedalo/install/import/ontology': dir(0o755, 'dedalo', 'dedalo'),
		[SOURCE]: dir(0o755, 'dedalo', 'dedalo', [
			'ontology.json',
			'oh.copy.gz',
			'tch.copy.gz',
			'README',
		]),
		[`${SOURCE}/ontology.json`]: file(0o644, 'dedalo', 'dedalo'),
		[`${SOURCE}/oh.copy.gz`]: file(0o644, 'dedalo', 'dedalo'),
		[`${SOURCE}/tch.copy.gz`]: file(0o644, 'dedalo', 'dedalo'),
		[`${SOURCE}/README`]: file(0o600, 'dedalo', 'dedalo'),
	};
}

function ctxOver(
	tree: Record<string, Entry>,
	ontologySource: string,
	account: {
		user: unknown;
		group?: unknown;
		memberOf: { name: string; gid: number }[];
	} = {
		user: null,
		memberOf: [],
	},
): HostPlanCtx & Pick<HostCtx, 'fs'> {
	return {
		answers: { ontology_source: ontologySource },
		paths: { user: 'ded_museo', group: 'ded_museo' },
		facts: { account },
		fs: {
			stat: (path: string) => (tree[path] as HostStat | undefined) ?? null,
			list: (path: string) => tree[path]?.children ?? [],
		},
	} as unknown as HostPlanCtx & Pick<HostCtx, 'fs'>;
}

describe('the System check refuses a local ontology source the service user cannot read', () => {
	test('no local source: nothing to check', () => {
		expect(ontologySourceAccessProblems(ctxOver(homeTree(0o700), ''))).toEqual([]);
	});

	test('a source behind a 0700 home is refused, naming the blocking directory and the user', () => {
		const problems = ontologySourceAccessProblems(ctxOver(homeTree(0o700), SOURCE));
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(
			'/home/dedalo (dedalo:dedalo, mode 700) is not traversable by ded_museo',
		);
		expect(problems[0]).toContain('as the service user ded_museo, never as root');
	});

	test('the same source behind a traversable home passes (files the engine does not read are not judged)', () => {
		expect(ontologySourceAccessProblems(ctxOver(homeTree(0o711), SOURCE))).toEqual([]);
	});

	test('an unreadable package inside a readable directory is refused, naming the file', () => {
		const tree = homeTree(0o711);
		tree[`${SOURCE}/tch.copy.gz`] = file(0o600, 'dedalo', 'dedalo');
		const problems = ontologySourceAccessProblems(ctxOver(tree, SOURCE));
		expect(problems[0]).toContain(
			`${SOURCE}/tch.copy.gz (dedalo:dedalo, mode 600) is not readable`,
		);
	});

	test('an archive source needs only the file read (and the path traversed)', () => {
		const tree = homeTree(0o711);
		tree['/home/dedalo/onto.tgz'] = file(0o640, 'dedalo', 'dedalo');
		tree['/home/dedalo'] = dir(0o711, 'dedalo', 'dedalo', ['onto.tgz']);
		expect(ontologySourceAccessProblems(ctxOver(tree, '/home/dedalo/onto.tgz'))[0]).toContain(
			'/home/dedalo/onto.tgz (dedalo:dedalo, mode 640) is not readable',
		);
	});

	test("the account's OTHER groups do not count: the engine runs `runuser -g <service group>` (one group)", () => {
		const tree = homeTree(0o750);
		const existing = {
			user: { name: 'ded_museo', uid: 1200 },
			group: { name: 'ded_museo', gid: 1200 },
			memberOf: [{ name: 'dedalo', gid: 1000 }],
		};
		// Member of the home's group, yet refused: runuser -g sets that one group only.
		expect(ontologySourceAccessProblems(ctxOver(tree, SOURCE, existing))).toHaveLength(1);
		// The service group itself owning the home: group bits apply.
		tree['/home/dedalo'] = dir(0o750, 'dedalo', 'ded_museo');
		expect(ontologySourceAccessProblems(ctxOver(tree, SOURCE, existing))).toEqual([]);
	});

	test('an LDAP/sssd owner reads as its number (local files only): matched by id, not refused', () => {
		const tree = homeTree(0o711);
		tree[SOURCE] = dir(0o700, '1200', '1200', ['ontology.json']);
		tree[`${SOURCE}/ontology.json`] = file(0o600, '1200', '1200');
		const existing = {
			user: { name: 'ded_museo', uid: 1200 },
			group: { name: 'ded_museo', gid: 1200 },
			memberOf: [],
		};
		expect(ontologySourceAccessProblems(ctxOver(tree, SOURCE, existing))).toEqual([]);
		// Positive control: a new account (no uid yet) owns nothing → refused.
		expect(ontologySourceAccessProblems(ctxOver(tree, SOURCE))).toHaveLength(1);
	});

	test('only the names the engine reads are judged (ontology.json, <tld>.copy.gz)', () => {
		const tree = homeTree(0o711);
		tree[SOURCE] = dir(0o755, 'dedalo', 'dedalo', ['ontology.json', 'Notes.copy.gz', 'x.copy.gz']);
		tree[`${SOURCE}/Notes.copy.gz`] = file(0o600, 'dedalo', 'dedalo');
		tree[`${SOURCE}/x.copy.gz`] = file(0o600, 'dedalo', 'dedalo');
		expect(ontologySourceAccessProblems(ctxOver(tree, SOURCE))).toEqual([]);
	});

	test('a symlinked component is not judged (no false refusal)', () => {
		const tree = homeTree(0o700);
		tree['/home/dedalo'] = { ...dir(0o777, 'dedalo', 'dedalo'), isSymlink: true };
		expect(ontologySourceAccessProblems(ctxOver(tree, SOURCE))).toEqual([]);
	});

	test('grants() reads exactly one class of bits: owner, else group, else others', () => {
		const reader = { user: 'u', uid: null, group: 'g', gid: null };
		const stat = (mode: number, owner: string, group: string) =>
			({ mode, owner, group }) as HostStat;
		expect(grants(stat(0o070, 'u', 'g'), reader, 4)).toBe(false); // owner bits rule for the owner
		expect(grants(stat(0o407, 'x', 'g'), reader, 4)).toBe(false); // group bits rule for a member
		expect(grants(stat(0o004, 'x', 'y'), reader, 4)).toBe(true);
		expect(grants(stat(0o005, 'x', 'y'), reader, 5)).toBe(true);
		expect(grants(stat(0o004, 'x', 'y'), reader, 5)).toBe(false);
	});
});

describe('the catalog reader names a permission error as one (never "no such file")', () => {
	const scratch = mkdtempSync(join(tmpdir(), 'dedalo_onto_access_'));
	const locked = join(scratch, 'home');
	const source = join(locked, '7.0');
	mkdirSync(source, { recursive: true });
	writeFileSync(join(source, 'ontology.json'), '{}');
	chmodSync(locked, 0o000);
	afterAll(() => {
		chmodSync(locked, 0o755);
		rmSync(scratch, { recursive: true, force: true });
	});

	const isRoot = process.getuid?.() === 0;
	test.skipIf(isRoot)('EACCES → "permission denied for <user>"', async () => {
		await expect(
			resolveOntologyCatalog({ kind: 'local', path: source }, { allowedServers: [] }),
		).rejects.toThrow(/permission denied for /);
	});

	test('a missing path is still "no such file or directory"', async () => {
		await expect(
			resolveOntologyCatalog(
				{ kind: 'local', path: join(scratch, 'absent') },
				{ allowedServers: [] },
			),
		).rejects.toThrow(/no such file or directory/);
	});
});

describe('a relative --ontology-source is made absolute where it is answered', () => {
	test('normalized against the current directory (the engine child runs in another one)', async () => {
		const { normalizeInstallAnswers } = await import('../../src/core/install/install_plan.ts');
		const { answers } = normalizeInstallAnswers({ route: 'developer', ontology_source: './onto' });
		expect(answers.ontology_source).toBe(join(process.cwd(), 'onto'));
		expect(normalizeInstallAnswers({ route: 'developer' }).answers.ontology_source).toBe('');
	});
});
