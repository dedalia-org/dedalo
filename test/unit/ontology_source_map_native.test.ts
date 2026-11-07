/**
 * ONE SOURCE PER SHARED TLD (update design §4, owner decision D-8):
 * src/core/ontology/ontology_update_source.ts assertSourceAssignment. Any
 * install may take ontology from several masters; each shared TLD comes from
 * exactly one, declared in ONTOLOGY_SERVERS `tlds`. Pure — no network, no DB.
 */

import { describe, expect, mock, test } from 'bun:test';
import { readOntologyServerList, warnCodeOnlyOntologyServers } from '../../src/config/readers.ts';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { assertSourceAssignment } from '../../src/core/ontology/ontology_update_source.ts';
import {
	pullServers,
	resolveUpdateTarget,
} from '../../src/core/ontology/ontology_update_target.ts';

const OURS = 'https://v7.master.example/dedalo/core/api/v1/json/';
const MUSEUM = 'https://ontology.museum.example/dedalo/core/api/v1/json/';
const target = (url: string) => ({ isLocal: false, configuredOrigin: new URL(url).origin });
const files = (...tlds: string[]) => tlds.map((tld) => ({ tld }));

/** The rule of the refusal, or 'passed'. */
function ruleOf(work: () => void): string {
	try {
		work();
		return 'passed';
	} catch (error) {
		if (!isDedaloError(error) || error.code !== 'update.refused') throw error;
		return String((error.coordinates as { rule?: string } | undefined)?.rule);
	}
}

describe('assertSourceAssignment', () => {
	test('one master, no tlds: everything comes from it', () => {
		const catalog = { servers: [{ code: 'c', url: OURS }], isOntologyServer: false };
		expect(
			ruleOf(() => assertSourceAssignment(files('dd', 'oh', 'matrix_dd'), target(OURS), catalog)),
		).toBe('passed');
	});

	test('a local target (this install is the master) is never sourced', () => {
		const catalog = {
			servers: [
				{ code: 'c', url: OURS },
				{ code: 'm', url: MUSEUM },
			],
			isOntologyServer: true,
		};
		expect(
			ruleOf(() =>
				assertSourceAssignment(files('mus'), { isLocal: true, configuredOrigin: null }, catalog),
			),
		).toBe('passed');
	});

	const both = {
		servers: [
			{ code: 'c', url: OURS, tlds: ['dd', 'oh', 'matrix_dd'] },
			{ code: 'm', url: MUSEUM, tlds: ['mus'] },
		],
		isOntologyServer: false,
	};

	test('several masters: each TLD only from the master that lists it', () => {
		expect(ruleOf(() => assertSourceAssignment(files('dd', 'matrix_dd'), target(OURS), both))).toBe(
			'passed',
		);
		expect(ruleOf(() => assertSourceAssignment(files('mus'), target(MUSEUM), both))).toBe('passed');
		expect(ruleOf(() => assertSourceAssignment(files('mus'), target(OURS), both))).toBe(
			'source_mismatch',
		);
		expect(ruleOf(() => assertSourceAssignment(files('dd'), target(MUSEUM), both))).toBe(
			'source_mismatch',
		);
		expect(ruleOf(() => assertSourceAssignment(files('xyz'), target(OURS), both))).toBe(
			'source_mismatch',
		);
	});

	test('a TLD listed by two masters is refused, naming both', () => {
		const twice = {
			servers: [
				{ code: 'c', url: OURS, tlds: ['dd', 'oh'] },
				{ code: 'm', url: MUSEUM, tlds: ['oh'] },
			],
			isOntologyServer: false,
		};
		expect(ruleOf(() => assertSourceAssignment(files('oh'), target(OURS), twice))).toBe(
			'source_ambiguous',
		);
	});

	test('several masters and one without tlds: the undeclared one is reachable by a pick only', () => {
		const partial = {
			servers: [
				{ code: 'c', url: OURS, tlds: ['dd'] },
				{ code: 'm', url: MUSEUM },
			],
			isOntologyServer: false,
		};
		expect(ruleOf(() => assertSourceAssignment(files('dd'), target(OURS), partial))).toBe('passed');
		expect(ruleOf(() => assertSourceAssignment(files('dd'), target(MUSEUM), partial))).toBe(
			'source_unassigned',
		);
		expect(ruleOf(() => assertSourceAssignment(files('dd'), target(MUSEUM), partial, true))).toBe(
			'passed',
		);
	});

	test('several masters, none declared: the FIRST is the unattended source, the rest by pick', () => {
		const undeclared = {
			servers: [
				{ code: 'c', url: OURS },
				{ code: 'm', url: MUSEUM },
			],
			isOntologyServer: false,
		};
		expect(ruleOf(() => assertSourceAssignment(files('dd', 'mus'), target(OURS), undeclared))).toBe(
			'passed',
		);
		expect(ruleOf(() => assertSourceAssignment(files('dd'), target(MUSEUM), undeclared))).toBe(
			'source_unassigned',
		);
		expect(
			ruleOf(() => assertSourceAssignment(files('dd'), target(MUSEUM), undeclared, true)),
		).toBe('passed');
	});

	test('an operator pick is not mapped: a TLD declared elsewhere may come from the picked master', () => {
		expect(ruleOf(() => assertSourceAssignment(files('dd'), target(MUSEUM), both, true))).toBe(
			'passed',
		);
	});
});

describe('an ontology SERVER pulling from a remote provider (promotion)', () => {
	const promoting = (tlds?: string[]) => ({
		servers: [{ code: 'beta', url: MUSEUM, ...(tlds === undefined ? {} : { tlds }) }],
		isOntologyServer: true,
	});

	test('only the TLDs the entry lists; everything else is source_mismatch', () => {
		const catalog = promoting(['dd', 'matrix_dd']);
		expect(
			ruleOf(() => assertSourceAssignment(files('dd', 'matrix_dd'), target(MUSEUM), catalog)),
		).toBe('passed');
		expect(ruleOf(() => assertSourceAssignment(files('oh'), target(MUSEUM), catalog))).toBe(
			'source_mismatch',
		);
	});

	test('an entry without tlds (absent or empty) is CODE-ONLY: not refused, but never a source', () => {
		for (const catalog of [promoting(), promoting([])]) {
			// not a pull source: refused as the selected master of an unattended
			// run (source_unassigned), never "everything from the first"
			expect(ruleOf(() => assertSourceAssignment(files('dd'), target(MUSEUM), catalog))).toBe(
				'source_unassigned',
			);
			// …and it is not refused as a configuration: the local export still passes
			expect(
				ruleOf(() =>
					assertSourceAssignment(files('dd'), { isLocal: true, configuredOrigin: null }, catalog),
				),
			).toBe('passed');
		}
	});

	test('mixed list: the provider keeps its TLDs, the code-only entry takes none', () => {
		const catalog = {
			servers: [
				{ code: 'client', url: OURS },
				{ code: 'beta', url: MUSEUM, tlds: ['dd'] },
			],
			isOntologyServer: true,
		};
		expect(ruleOf(() => assertSourceAssignment(files('dd'), target(MUSEUM), catalog))).toBe(
			'passed',
		);
		expect(ruleOf(() => assertSourceAssignment(files('dd'), target(OURS), catalog))).toBe(
			'source_unassigned',
		);
		// the same shape on an ORDINARY install: both entries are masters; an
		// unattended run takes from the DECLARING one (the tlds-less one is
		// reachable only by an operator's pick — unattendedSources)
		expect(
			ruleOf(() =>
				assertSourceAssignment(files('dd'), target(MUSEUM), {
					...catalog,
					isOntologyServer: false,
				}),
			),
		).toBe('passed');
	});

	test('two providers listing one TLD stay ambiguous', () => {
		const catalog = {
			servers: [
				{ code: 'a', url: OURS, tlds: ['dd'] },
				{ code: 'b', url: MUSEUM, tlds: ['dd'] },
			],
			isOntologyServer: true,
		};
		expect(ruleOf(() => assertSourceAssignment(files('dd'), target(OURS), catalog))).toBe(
			'source_ambiguous',
		);
	});

	test('the Local files target of a server is still never sourced, entries or not', () => {
		expect(
			ruleOf(() =>
				assertSourceAssignment(files('dd'), { isLocal: true, configuredOrigin: null }, promoting()),
			),
		).toBe('passed');
	});
});

describe('pull targets on an ontology server', () => {
	const mixed = {
		servers: [
			{ code: 'client', url: OURS },
			{ code: 'beta', url: MUSEUM, tlds: ['dd'] },
		],
		isOntologyServer: true,
	};

	test('pullServers keeps only providers on a server, everything on an ordinary install', () => {
		expect(pullServers(mixed).map((entry) => entry.url)).toEqual([MUSEUM]);
		expect(pullServers({ ...mixed, isOntologyServer: false })).toHaveLength(2);
	});

	test('a code-only entry cannot be picked as the update target; the provider can', () => {
		const pick = (url: string) => resolveUpdateTarget({ name: 'x', url, code: 'c' }, mixed);
		expect(pick(OURS)).toHaveProperty('error');
		expect(pick(MUSEUM)).toEqual({
			isLocal: false,
			configuredOrigin: new URL(MUSEUM).origin,
			configuredUrl: MUSEUM,
		});
	});
});

describe('the boot line for code-only entries', () => {
	const entries = [
		{ url: OURS, code: 'a' },
		{ url: MUSEUM, code: 'b', tlds: ['dd'] },
	];
	function lines(isServer: boolean, list = entries): string[] {
		const original = console.error;
		const out: string[] = [];
		console.error = mock((line: string) => out.push(String(line)));
		try {
			expect(warnCodeOnlyOntologyServers(isServer, list)).toBe(list);
		} finally {
			console.error = original;
		}
		return out;
	}

	test('ONE line naming only the code-only entries, on an ontology server only', () => {
		const out = lines(true);
		expect(out).toHaveLength(1);
		expect(out[0]).toContain(OURS);
		expect(out[0]).not.toContain(MUSEUM);
		expect(lines(false)).toEqual([]);
		expect(lines(true, [entries[1] as (typeof entries)[number]])).toEqual([]);
	});
});

describe('readOntologyServerList — the env → catalog read keeps each `tlds` with ITS master', () => {
	/** Read ONTOLOGY_SERVERS as `value`, capturing the drop lines; the key is restored after. */
	function readAs(value: unknown): {
		servers: ReturnType<typeof readOntologyServerList>;
		errors: string[];
	} {
		const previous = process.env.ONTOLOGY_SERVERS;
		const original = console.error;
		const errors: string[] = [];
		console.error = mock((line: string) => errors.push(String(line)));
		process.env.ONTOLOGY_SERVERS = JSON.stringify(value);
		try {
			return { servers: readOntologyServerList('ONTOLOGY_SERVERS'), errors };
		} finally {
			console.error = original;
			if (previous === undefined) delete process.env.ONTOLOGY_SERVERS;
			else process.env.ONTOLOGY_SERVERS = previous;
		}
	}

	test('tlds pair by url; an entry without tlds stays undeclared', () => {
		const { servers, errors } = readAs([
			{ name: 'A', url: 'https://a.example/api/', code: 'x', tlds: ['smapa', 'smapb'] },
			{ name: 'B', url: 'https://b.example/api/', code: 'y' },
		]);
		expect(servers.map((entry) => [entry.name, entry.tlds ?? null])).toEqual([
			['A', ['smapa', 'smapb']],
			['B', null],
		]);
		expect(errors).toEqual([]);
	});

	test('a malformed tlds drops ITS entry, loudly, and keeps the others', () => {
		const { servers, errors } = readAs([
			{ name: 'A', url: 'https://a.example/api/', code: 'x', tlds: 'smapa' },
			{ name: 'B', url: 'https://b.example/api/', code: 'y', tlds: ['smapb', 3] },
			{ name: 'C', url: 'https://c.example/api/', code: 'z', tlds: ['smapc'] },
		]);
		expect(servers.map((entry) => entry.name)).toEqual(['C']);
		expect(errors.filter((line) => line.includes('tlds must be an array of strings'))).toHaveLength(
			2,
		);
	});
});
