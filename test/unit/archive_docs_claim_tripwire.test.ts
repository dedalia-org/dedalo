/**
 * ARCHIVE DOCS CLAIM tripwire — the manual may not promise a round trip the CSV
 * door cannot deliver, and must point the operator at the door that can
 * (audit 2026-08-26 P1-10; DATA-10, DATA-11, DATA-13 — filed "because the
 * manual already makes the claim").
 *
 * THE DEFECT THIS PINS. `docs/using/tools/using_export.md` told a curator that the
 * Dédalo (Raw) CSV is "a re-importable backup", moves data "between
 * installations" and imports back "byte-for-byte"; the CSV import re-conforms
 * every cell as typed input (text_area markup rewritten, geolocation item ids
 * dropped, empty cells clearing values, locators checked for shape only, no
 * media bytes). The engine's lossless door is the archive (`src/core/archive/`,
 * `engineering/ARCHIVE_FORMAT.md`), proven by raw_roundtrip_native. The core
 * pages were corrected first and the user guides — the two-tier rule: a user
 * guide moves with its core page — were not; nothing mechanical noticed. This
 * gate is what notices.
 *
 * THREE LEGS:
 *   1. NO CSV ROUND-TRIP PROMISE anywhere in docs/: the formulations the manual
 *      used (each listed with its reason), scanned line by line over the WHOLE
 *      tree with a corpus floor and a planted positive control per phrase.
 *   2. THE TRUE DOOR IS NAMED where the raw format is sold as a backup: every
 *      page that names `dedalo_raw` and speaks of a backup links to the archive
 *      door anchor of the core export page, and that anchor exists there.
 *   3. THE FORMAT DOC MATCHES THE CODE: `engineering/ARCHIVE_FORMAT.md`'s
 *      "Not archived" list carries exactly the entries `NOT_ARCHIVED` in
 *      `src/core/archive/manifest.ts` writes into every manifest — the ONE
 *      list, so a reader of the doc and a reader of the artifact agree.
 *
 * HONEST LIMIT. Leg 1 catches the formulations, not every paraphrase — a new
 * wording of the same false promise passes it. What keeps the truth pinned is
 * leg 2 (the page must name the real door) and the behavioural gates on the
 * doors themselves; leg 1 is the regression net over the sentences that were
 * actually written.
 *
 * HERMETIC: reads docs/ and engineering/ and imports one constant module
 * (`manifest.ts` has no config, no DB). No network, no clock.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOT_ARCHIVED } from '../../src/core/archive/manifest.ts';
import { docsPages } from '../helpers/docs_corpus.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const EXPORT_PAGE = 'docs/using/exporting_data.md';
const ARCHIVE_ANCHOR = 'the-archive-door';
const FORMAT_DOC = 'engineering/ARCHIVE_FORMAT.md';

/** A promise the CSV door cannot keep; `where` narrows the scan to lines about that door. */
interface ForbiddenClaim {
	phrase: RegExp;
	where: RegExp | null;
	reason: string;
}

const FORBIDDEN_CLAIMS: readonly ForbiddenClaim[] = [
	{
		phrase: /re-importable backup/i,
		where: null,
		reason: 'a backup restores what was stored; the CSV import re-conforms typed input',
	},
	{
		phrase: /imports? back exactly/i,
		where: null,
		reason: 'text_area markup and geolocation item ids do not come back exactly',
	},
	{
		phrase: /reproduces the data exactly/i,
		where: null,
		reason: 'empty cells clear, locators are shape-checked, media bytes are absent',
	},
	{
		phrase: /byte-for-byte/i,
		where: /csv|dedalo_raw|raw\)|re-?import/i,
		reason: 'byte identity is the archive door’s property (raw_roundtrip_native), never the CSV’s',
	},
	{
		phrase: /between installations/i,
		where: /(?=.*(?:raw|csv))(?!.*\bnot\b)/i,
		reason: 'a locator’s section_id is a per-installation counter; the CSV door checks shape only',
	},
];

function read(relative: string): string {
	return readFileSync(join(REPO_ROOT, relative), 'utf8');
}

interface Hit {
	file: string;
	line: number;
	reason: string;
}

/** The scanner — shared by the tree sweep and the positive control. */
function claimsIn(file: string, text: string): Hit[] {
	const hits: Hit[] = [];
	text.split('\n').forEach((line, index) => {
		for (const claim of FORBIDDEN_CLAIMS) {
			if (!claim.phrase.test(line)) continue;
			if (claim.where !== null && !claim.where.test(line)) continue;
			hits.push({ file, line: index + 1, reason: claim.reason });
		}
	});
	return hits;
}

const PAGES = docsPages();

describe('archive docs claim tripwire', () => {
	test('1. no page of docs/ promises a CSV round trip, backup or move (corpus floored, positive control)', () => {
		expect(PAGES.length).toBeGreaterThan(200);
		const hits = PAGES.flatMap((file) => claimsIn(file, read(file)));
		expect(
			hits.map((h) => `${h.file}:${h.line} — ${h.reason}`),
			'The CSV door is not a round trip (see docs/using/exporting_data.md "Raw export and the import tool"). Reword the sentence and point at the archive door.',
		).toEqual([]);

		// Positive control: every listed formulation, as the manual once wrote it, is caught.
		const planted = [
			'Use the Dédalo (Raw) format for a re-importable backup of a section.',
			'its cells import back exactly, unlike a plain CSV',
			'the CSV import tool can read it back byte-for-byte',
			're-importing it unchanged reproduces the data exactly',
			'Use dedalo_raw to move data between installations.',
		].join('\n');
		const control = claimsIn('planted.md', planted);
		expect(control.map((h) => h.line)).toEqual([1, 2, 3, 4, 5]);
		// …and the negated, true sentence of the core page is NOT a hit.
		expect(
			claimsIn('ok.md', 'The raw CSV is **not** a way to move data between installations.'),
		).toEqual([]);
	});

	test('2. every page that sells the raw format as a backup names the archive door, and the anchor exists', () => {
		const exportPage = read(EXPORT_PAGE);
		expect(exportPage).toMatch(/^## The archive door$/m);
		expect(exportPage).toContain('scripts/archive.ts');
		const selling = PAGES.filter((file) => {
			const text = read(file);
			return /dedalo_raw|Dédalo \(Raw\)|Dédalo Raw/.test(text) && /backup/i.test(text);
		});
		expect(selling.length).toBeGreaterThan(2);
		expect(selling).toContain('docs/using/tools/using_export.md');
		const unlinked = selling.filter((file) => !read(file).includes(`#${ARCHIVE_ANCHOR}`));
		expect(
			unlinked,
			`Pages naming the raw format in backup terms must link ${EXPORT_PAGE}#${ARCHIVE_ANCHOR}`,
		).toEqual([]);
	});

	test('3. the format doc’s "Not archived" list is exactly what the manifest writes (NOT_ARCHIVED)', () => {
		expect(existsSync(join(REPO_ROOT, FORMAT_DOC))).toBe(true);
		const doc = read(FORMAT_DOC);
		const section = doc.split(/^## Not archived[^\n]*\n/m)[1]?.split(/^## /m)[0] ?? '';
		const bullets = section
			.split('\n')
			.filter((line) => line.startsWith('- '))
			.map((line) => line.replace(/`/g, ''));
		expect(NOT_ARCHIVED.length).toBeGreaterThan(2);
		expect(bullets.length).toBe(NOT_ARCHIVED.length);
		for (const entry of NOT_ARCHIVED) {
			const subject = entry.split(' (')[0] as string;
			expect(
				bullets.some((b) => b.includes(subject)),
				`${FORMAT_DOC} "Not archived" lacks the manifest entry: ${subject}`,
			).toBe(true);
		}
	});
});
