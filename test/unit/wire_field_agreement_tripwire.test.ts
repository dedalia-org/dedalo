/**
 * TRIPWIRE — a field the CLIENT consumes is a field the SERVER emits
 * (P2-26 / DEAD-05).
 *
 * Measured 2026-08-31: three fields the client reads off a data item were
 * mentioned nowhere in `src/` — PHP-era emissions the rewrite DROPPED. The
 * consequential one was `transliterate_value` (four client modules: the
 * sibling-language value hint of a transliterable component, and the
 * cross-language IRI id share that keeps an empty-but-existing IRI entry out of
 * the clear-all path, P0-8 / DATA-06). The parity ledger test lists it among the
 * PHP data-item fields and never FAILS (it reports), so the one place that
 * could have noticed was configured not to.
 *
 * A dropped emission is a SCOPE NARROWING, which this project's law forbids
 * doing silently. Ledger:
 * engineering/wire_contract/WC-2026-08-31-client-reads-three-fields-the-engine-never-emits.md
 *
 * SHRINK-ONLY: a new field is a new narrowing and reds this gate; removing one
 * — by emitting it, or by deciding to delete its readers — is the burn-down.
 * A field burnt down BY EMITTING IT moves to CLOSED, which pins the closure the
 * other way: still read, still ASSIGNED by the engine (an assignment, not a
 * mere mention — a comment naming the field would satisfy the generous
 * not-emitted census but must not satisfy this), and its closing WC entry still
 * names it. `transliterate_value` closed 2026-10-31
 * (WC-2026-10-31-transliterate-value-emitted: the `lang_versions` emit hook).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';

const REPO_ROOT = join(import.meta.dir, '..', '..');

/** A field read off a data item in the browser: `self.data.<field>`. */
const DATA_FIELD_READ = /\bself\.data\.([a-z_][a-z0-9_]*)/g;

/**
 * Fields the client reads that the engine never emits, each with what is lost.
 * ENUMERATED and shrink-only — never a category.
 */
const NOT_EMITTED: Record<string, string> = {
	q_lang: 'A search-language annotation the client is prepared to show and never receives.',
	permissions_indexation:
		'An indexation-permission hint the client branches on and never receives.',
};

/**
 * Narrowings CLOSED by emitting the field → the wire-contract entry that closed
 * it. Shrink-only too in spirit: an entry leaves only with its readers.
 */
const CLOSED: Record<string, string> = {
	transliterate_value: 'WC-2026-10-31-transliterate-value-emitted',
};

/** Every `self.data.<field>` the browser reads, outside comments. */
function clientDataFields(): Map<string, Set<string>> {
	const reads = new Map<string, Set<string>>();
	for (const match of new Glob('**/*.js').scanSync({ cwd: join(REPO_ROOT, 'client') })) {
		const file = `client/${match}`;
		for (const line of readFileSync(join(REPO_ROOT, file), 'utf8').split('\n')) {
			const trimmed = line.trim();
			// Prose ABOUT a field is not a read of it — two of these modules carry
			// long comments naming transliterate_value while describing the bug.
			if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
			for (const hit of line.matchAll(DATA_FIELD_READ)) {
				const field = hit[1] as string;
				if (!reads.has(field)) reads.set(field, new Set());
				(reads.get(field) as Set<string>).add(file);
			}
		}
	}
	return reads;
}

/** Everything the engine's source so much as mentions — deliberately generous. */
function engineSource(): string {
	const parts: string[] = [];
	for (const match of new Glob('**/*.ts').scanSync({ cwd: join(REPO_ROOT, 'src') })) {
		if (match.includes('.test.')) continue;
		parts.push(readFileSync(join(REPO_ROOT, 'src', match), 'utf8'));
	}
	return parts.join('\n');
}

describe('a field the client consumes is a field the server emits', () => {
	const reads = clientDataFields();
	const source = engineSource();

	test('both sides are actually read (anti-vacuity)', () => {
		// A set difference over an empty side proves nothing.
		expect(reads.size).toBeGreaterThan(20);
		expect(source.length).toBeGreaterThan(1_000_000);
		// A field the engine certainly emits must read as emitted, or the matcher
		// is broken and every field would look present.
		expect(reads.has('value') || reads.has('lang')).toBe(true);
	});

	test('no NEW field is read by the client and emitted by nothing', () => {
		const orphans = [...reads.keys()]
			.filter((field) => !new RegExp(`\\b${field}\\b`).test(source))
			.filter((field) => NOT_EMITTED[field] === undefined)
			.sort();
		expect(
			orphans,
			'The client reads these off a data item and the engine never emits them. That is a ' +
				'scope narrowing, which this project does not do silently: emit the field, or ' +
				'delete its readers AND ledger the narrowing in engineering/wire_contract/.\n  ' +
				orphans.join('\n  '),
		).toEqual([]);
	});

	test('the known list may only SHRINK, and every entry is still real', () => {
		for (const [field, reason] of Object.entries(NOT_EMITTED)) {
			expect(reason.length, `${field}: a narrowing needs a stated cost`).toBeGreaterThan(60);
			// Still read by the client? If not, the readers were deleted and the
			// entry must go with them.
			expect(
				reads.has(field),
				`${field} is no longer read by any client module — DELETE its entry`,
			).toBe(true);
			// Still un-emitted? If the engine now emits it, the narrowing is CLOSED
			// and leaving the entry here would hide the next one.
			expect(
				new RegExp(`\\b${field}\\b`).test(source),
				`${field} IS emitted now — the narrowing is closed, DELETE its entry`,
			).toBe(false);
		}
	});

	test('a CLOSED narrowing stays closed: still read, still assigned, still ledgered', () => {
		expect(Object.keys(CLOSED).length).toBeGreaterThan(0);
		for (const [field, entry] of Object.entries(CLOSED)) {
			expect(NOT_EMITTED[field], `${field} is CLOSED — it cannot also be NOT_EMITTED`).toBe(
				undefined,
			);
			expect(
				reads.has(field),
				`${field} is no longer read by any client module — DELETE its CLOSED entry`,
			).toBe(true);
			// An ASSIGNMENT (`.field =`), not a mention: the closure is an emission.
			expect(
				new RegExp(`\\.${field}\\s*=[^=]`).test(source),
				`${field} is no longer assigned anywhere in src/ — the narrowing REOPENED`,
			).toBe(true);
			const text = readFileSync(join(REPO_ROOT, `engineering/wire_contract/${entry}.md`), 'utf8');
			expect(text, `${entry} does not name ${field}`).toContain(field);
		}
	});

	test('the narrowing carries its wire-contract ledger line', () => {
		const ledger = join(
			REPO_ROOT,
			'engineering/wire_contract/WC-2026-08-31-client-reads-three-fields-the-engine-never-emits.md',
		);
		const text = readFileSync(ledger, 'utf8');
		for (const field of Object.keys(NOT_EMITTED)) {
			expect(text, `the ledger entry does not name ${field}`).toContain(field);
		}
	});
});
