/**
 * THE AUDIT'S OWN OPEN QUESTIONS STAY ANSWERED OR STAY NAMED (CLOSURE-openquestions).
 *
 * The 2026-08-26 deep audit closed with fourteen questions its filed severities
 * depend on (`raw/canonical_register.md` §5.2) and three measurements it OWES
 * rather than defers. A closure record that answers twelve of them and quietly
 * drops two reads as complete — which is the exact failure mode the register
 * warned about when it wrote the list down.
 *
 * THE CENSUS IS TOTAL AND IT IS DERIVED FROM THE REGISTER, not from a hand list
 * here: the questions are parsed out of §5.2's own bullets, so a bullet ADDED
 * there and not answered in CLOSURE.md reds this gate, and a hand list cannot
 * drift from the source. The floor refuses a parse that collapses (a heading
 * rename, a reformat) to zero or to fewer than the fourteen of record.
 *
 * WHAT EACH ENTRY MUST CARRY, and why each leg exists:
 *  - a VERDICT token, ANSWERED or OPEN. A paragraph with neither is prose, not
 *    a decision input.
 *  - ANSWERED ⇒ at least one CITATION that resolves on disk. "Answered" without
 *    evidence is an assertion; a citation that names a deleted file is worse
 *    than none, because it reads as evidence.
 *  - OPEN ⇒ a "What would answer it" line. An open question with no stated
 *    resolution path is an excuse.
 *  - EVERY citation in the block must resolve, ANSWERED or not — a dead path
 *    anywhere in the section is a stale record.
 *  - the three OWED measurements must each be named in the block.
 *
 * The detectors are pure functions over text, and the whole record check is ONE
 * function ({@link auditVerdicts}) over ONE reader ({@link readAuditRecord}), so
 * every leg runs twice through the SAME code: once against the real record, and
 * once against a SITUATION this gate BUILDS — a synthetic audit tree (a register
 * with a §5.2 of fourteen bullets, a CLOSURE.md with its delimited block, the
 * evidence files it cites) written into a scratch directory. The clean situation
 * must pass every leg; each planted offence (a collapsed parse, a lost block, an
 * unanswered bullet, a register bullet added later, an evidence-less ANSWERED,
 * a resolution-less OPEN, a dead citation elsewhere, an unnamed owed
 * measurement) must red EXACTLY its own leg. The situation legs run EVERYWHERE,
 * because they need no artifact — the gate's LOGIC is verified on every host.
 *
 * (!) THE ARTIFACT IS LOCAL-ONLY. `audits/` is gitignored, exactly like
 * `rewrite/`, so on a clone neither the register nor CLOSURE.md exists. This
 * gate therefore reads them DEFENSIVELY (never at import, never throwing) and
 * declares itself skipped, with the reason in the test name, when the audit
 * tree is absent — instead of dying at module load on every checkout that is
 * not the maintainer's. Where the artifact IS present, every leg below is
 * enforced in full. What cannot be honestly claimed is that the REAL register is
 * checked on CI: the artifact it gates does not ship. The built situation proves
 * the checker; only the maintainer's tree proves the record.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { absentScratchPath } from '../helpers/scratch_dir.ts';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const AUDIT_DIR = `${REPO_ROOT}audits/2026-08-26_deep/`;
const REGISTER_REL = 'raw/canonical_register.md';
const CLOSURE_REL = 'CLOSURE.md';
const REGISTER = `${AUDIT_DIR}${REGISTER_REL}`;
const CLOSURE = `${AUDIT_DIR}${CLOSURE_REL}`;

/** The delimiters this item owns; the rest of CLOSURE.md is another lane's. */
const BLOCK_START = '<!-- BEGIN open-questions -->';
const BLOCK_END = '<!-- END open-questions -->';

/** Fourteen bullets of record. A parse below this floor is a broken parse. */
const QUESTION_FLOOR = 14;
/** A block shorter than this is a stub, not the section. */
const BLOCK_MIN_CHARS = 500;
/** A block citing this few paths (or fewer) is unevidenced prose. */
const CITATION_FLOOR = 10;

/** The measurements REMEDIATION §"does NOT cover" (2) says the audit owes. */
const OWED_MEASUREMENTS = [
	'client retention slope',
	'Write-path query counts',
	'CLI-26 step 5',
] as const;

/** §5.2's bullets, by their own bold labels (trailing period stripped). */
function parseQuestionLabels(registerText: string): string[] {
	const start = registerText.indexOf('### 5.2 Open questions');
	if (start < 0) return [];
	const rest = registerText.slice(start);
	const end = rest.indexOf('\n### ', 1);
	const section = end < 0 ? rest : rest.slice(0, end);
	const labels: string[] = [];
	for (const line of section.split('\n')) {
		const hit = /^- \*\*(.+?)\*\*/.exec(line);
		const label = hit?.[1];
		if (label !== undefined) labels.push(label.replace(/\.$/, ''));
	}
	return labels;
}

/** The delimited block this item owns ('' when the markers are absent). */
function extractBlock(closureText: string): string {
	const from = closureText.indexOf(BLOCK_START);
	const to = closureText.indexOf(BLOCK_END);
	if (from < 0 || to < 0 || to < from) return '';
	return closureText.slice(from + BLOCK_START.length, to);
}

interface AnsweredEntry {
	label: string;
	verdict: string;
	body: string;
}

/** One entry per label: its verdict token and everything up to the next entry. */
function findEntry(block: string, label: string): AnsweredEntry | null {
	const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const head = new RegExp(`^\\*\\*${escaped}\\*\\* — (ANSWERED|OPEN)\\b`, 'm');
	const hit = head.exec(block);
	if (hit === null) return null;
	const after = block.slice(hit.index + hit[0].length);
	const next = /^\*\*[^*\n]+\*\* — (ANSWERED|OPEN)\b/m.exec(after);
	return {
		label,
		verdict: hit[1] ?? '',
		body: next === null ? after : after.slice(0, next.index),
	};
}

/** Backticked tokens that look like a repo path (a `:line` suffix is dropped). */
function citationsIn(text: string): string[] {
	const out: string[] = [];
	for (const hit of text.matchAll(/`([^`\s]+\/[^`\s]+)`/g)) {
		const raw = (hit[1] ?? '').replace(/:[0-9]+(-[0-9]+)?$/, '');
		if (/\.(ts|js|md|sh|json|yml|yaml|html|css)$/.test(raw)) out.push(raw);
	}
	return out;
}

/** A citation resolves from the repo root or from the audit directory. */
function citationResolves(citation: string, auditDir: string): boolean {
	return existsSync(`${REPO_ROOT}${citation}`) || existsSync(join(auditDir, citation));
}

/** One audit tree as read off disk: the register, the closure record, where they live. */
interface AuditRecord {
	auditDir: string;
	registerText: string;
	closureText: string;
}

/** Both artifacts of an audit tree, or null when either is absent (never throws). */
function readAuditRecord(auditDir: string): AuditRecord | null {
	const register = join(auditDir, REGISTER_REL);
	const closure = join(auditDir, CLOSURE_REL);
	if (!existsSync(register) || !existsSync(closure)) return null;
	return {
		auditDir,
		registerText: readFileSync(register, 'utf8'),
		closureText: readFileSync(closure, 'utf8'),
	};
}

/** What every leg measures, computed ONCE per record by the same code. */
interface AuditVerdicts {
	labels: string[];
	block: string;
	/** §5.2 labels with no verdict entry. */
	missing: string[];
	/** ANSWERED entries with no resolving citation. */
	bare: string[];
	/** OPEN entries with no "What would answer it". */
	silent: string[];
	/** Every citation in the block. */
	cited: string[];
	/** Citations in the block that resolve nowhere (deduplicated). */
	dead: string[];
	/** Owed measurements not named in the block. */
	absentOwed: string[];
}

function auditVerdicts(record: AuditRecord): AuditVerdicts {
	const labels = parseQuestionLabels(record.registerText);
	const block = extractBlock(record.closureText);
	const resolves = (citation: string) => citationResolves(citation, record.auditDir);
	const missing: string[] = [];
	const bare: string[] = [];
	const silent: string[] = [];
	for (const label of labels) {
		const entry = findEntry(block, label);
		if (entry === null) missing.push(label);
		else if (entry.verdict === 'ANSWERED') {
			if (citationsIn(entry.body).filter(resolves).length === 0) bare.push(label);
		} else if (!/What would answer it/i.test(entry.body)) silent.push(label);
	}
	const cited = citationsIn(block);
	return {
		labels,
		block,
		missing,
		bare,
		silent,
		cited,
		dead: [...new Set(cited.filter((c) => !resolves(c)))],
		absentOwed: OWED_MEASUREMENTS.filter((m) => !block.includes(m)),
	};
}

/** The legs a record FAILS, by name — the same thresholds the real legs assert. */
type Leg = 'census' | 'block' | 'verdict' | 'answered' | 'open' | 'citations' | 'owed';
function failingLegs(v: AuditVerdicts): Leg[] {
	const failing: Leg[] = [];
	if (v.labels.length < QUESTION_FLOOR) failing.push('census');
	if (v.block.trim().length <= BLOCK_MIN_CHARS) failing.push('block');
	if (v.missing.length > 0) failing.push('verdict');
	if (v.bare.length > 0) failing.push('answered');
	if (v.silent.length > 0) failing.push('open');
	if (v.cited.length <= CITATION_FLOOR || v.dead.length > 0) failing.push('citations');
	if (v.absentOwed.length > 0) failing.push('owed');
	return failing;
}

/** Both artifacts present? (`audits/` is gitignored — absent on a clone.) */
const realRecord = readAuditRecord(AUDIT_DIR);
const auditTreePresent = realRecord !== null;
const real: AuditVerdicts | null = realRecord === null ? null : auditVerdicts(realRecord);
const labels = real?.labels ?? [];
const block = real?.block ?? '';

describe.if(!auditTreePresent)('the audit artifact is absent on this checkout', () => {
	test.skip('SKIPPED — audits/ is gitignored, so the 2026-08-26 register and CLOSURE.md are not on this checkout; the built-situation and detector legs below still run', () => {});
});

describe.if(auditTreePresent)(
	'the register’s open questions are answered or named in CLOSURE.md',
	() => {
		test('CENSUS TOTAL: §5.2’s bullets parse, at or above the fourteen of record', () => {
			expect(
				labels.length,
				`parsed ${labels.length} question labels out of ${REGISTER} §5.2 — the section moved, ` +
					'was renamed or was reformatted, and this gate is measuring nothing.',
			).toBeGreaterThanOrEqual(QUESTION_FLOOR);
		});

		test('the delimited block exists and is not empty', () => {
			expect(
				block.trim().length,
				`${CLOSURE} carries no ${BLOCK_START} … ${BLOCK_END} block — the open-questions section ` +
					'was removed or its markers were edited away.',
			).toBeGreaterThan(BLOCK_MIN_CHARS);
		});

		test('every question of §5.2 has an entry carrying a verdict', () => {
			const missing = real?.missing ?? [];
			expect(
				missing,
				`${missing.length} question(s) of §5.2 have no verdict entry in the block: ` +
					`${missing.join(' | ')}. Every bullet needs "**<label>** — ANSWERED|OPEN".`,
			).toEqual([]);
		});

		test('every ANSWERED entry cites evidence that resolves on disk', () => {
			const bare = real?.bare ?? [];
			expect(
				bare,
				`ANSWERED without a resolving citation: ${bare.join(' | ')}. An answer with no path, ` +
					'gate or measured artefact is an assertion.',
			).toEqual([]);
		});

		test('every OPEN entry states what would answer it', () => {
			const silent = real?.silent ?? [];
			expect(
				silent,
				`OPEN with no resolution path: ${silent.join(' | ')}. An open question that does not ` +
					'say what would close it cannot be picked up by anyone.',
			).toEqual([]);
		});

		test('CENSUS TOTAL: every citation in the block resolves', () => {
			expect(
				real?.cited.length ?? 0,
				'the block cites no repo path at all — the whole section is unevidenced prose.',
			).toBeGreaterThan(CITATION_FLOOR);
			const dead = real?.dead ?? [];
			expect(
				dead,
				`dead citation(s) in the open-questions block: ${dead.join(' | ')}. A path that no ` +
					'longer exists reads as evidence and is not.',
			).toEqual([]);
		});

		test('the three owed measurements are each named', () => {
			const absent = real?.absentOwed ?? [];
			expect(absent, `owed measurement(s) not named in the block: ${absent.join(' | ')}.`).toEqual(
				[],
			);
		});
	},
);

// ── THE BUILT SITUATION ─────────────────────────────────────────────────────
// A synthetic audit tree, written to a scratch directory and read back through
// readAuditRecord → auditVerdicts: the SAME reader and checker the real legs use.

/** The offences a situation can be planted with — one per leg, plus the drift case. */
type Offence =
	| 'collapsed-register'
	| 'no-block'
	| 'unanswered'
	| 'bullet-added-later'
	| 'answered-dead-citation'
	| 'open-silent'
	| 'dead-citation-elsewhere'
	| 'owed-unnamed';

const SITUATION_QUESTIONS = Array.from(
	{ length: QUESTION_FLOOR },
	(_, i) => `Synthetic question ${i + 1}`,
);
const scratchRoots: string[] = [];

/** Write one audit tree into a fresh scratch dir, planted with at most one offence. */
function buildSituation(offence?: Offence): string {
	const dir = mkdtempSync(join(tmpdir(), 'dd-closure-oq-'));
	scratchRoots.push(dir);
	mkdirSync(join(dir, 'raw'), { recursive: true });
	mkdirSync(join(dir, 'evidence'), { recursive: true });

	const bullets = SITUATION_QUESTIONS.map(
		(q) => `- **${q}.** Whether the filed severity holds depends on this.\n  A continuation line.`,
	);
	if (offence === 'bullet-added-later') bullets.push('- **A bullet added after closure.** New.');
	const heading =
		offence === 'collapsed-register'
			? '### 5.2 Questions, renamed'
			: '### 5.2 Open questions the surviving findings depend on';
	writeFileSync(
		join(dir, REGISTER_REL),
		[
			'# Canonical register',
			'',
			'### 5.1 Something before',
			'- **Not a question.** Outside §5.2, never parsed.',
			'',
			heading,
			'',
			...bullets,
			'',
			'### 5.3 Something after',
			'- **Also not a question.** Outside §5.2.',
			'',
		].join('\n'),
	);

	const entries: string[] = [];
	for (const [i, q] of SITUATION_QUESTIONS.entries()) {
		if (offence === 'unanswered' && i === 3) continue;
		const evidence = `evidence/q${i + 1}.md`;
		writeFileSync(join(dir, evidence), `evidence for ${q}\n`);
		if (i % 2 === 0) {
			const cite =
				offence === 'answered-dead-citation' && i === 0 ? 'evidence/never_written.md' : evidence;
			entries.push(`**${q}** — ANSWERED.`, `Measured; the record is \`${cite}\`.`, '');
		} else {
			const answerLine =
				offence === 'open-silent' && i === 1
					? 'Nobody says how this closes.'
					: 'What would answer it: one measured run on the runner.';
			const extra =
				offence === 'dead-citation-elsewhere' && i === 1
					? ' See also `src/core/db/no_such_file_here.ts`.'
					: '';
			entries.push(
				`**${q}** — OPEN.`,
				`${answerLine} Context: \`${evidence}\` and \`src/core/db/query_tap.ts\`.${extra}`,
				'',
			);
		}
	}
	const owed = OWED_MEASUREMENTS.filter(
		(m) => !(offence === 'owed-unnamed' && m === 'CLI-26 step 5'),
	);
	const blockBody = [
		'',
		'## The register’s open questions, answered or restated',
		'',
		...entries,
		'### Owed measurements',
		...owed.map((m) => `- ${m}: named here, owed by the audit.`),
		'',
	].join('\n');
	writeFileSync(
		join(dir, CLOSURE_REL),
		[
			'# Closure',
			'',
			'Another lane’s prose, outside the block: `src/core/db/no_such_file_either.ts`.',
			'',
			offence === 'no-block' ? blockBody : `${BLOCK_START}\n${blockBody}\n${BLOCK_END}`,
			'',
		].join('\n'),
	);
	return dir;
}

afterAll(() => {
	for (const dir of scratchRoots) rmSync(dir, { recursive: true, force: true });
});

function situationVerdicts(offence?: Offence): AuditVerdicts {
	const record = readAuditRecord(buildSituation(offence));
	expect(record, 'the built situation must read back as a record').not.toBeNull();
	return auditVerdicts(record as AuditRecord);
}

describe('THE BUILT SITUATION: the record checker, run on a synthetic audit tree', () => {
	test('a clean situation passes every leg — and is not vacuous', () => {
		const v = situationVerdicts();
		expect(v.labels).toEqual(SITUATION_QUESTIONS);
		expect(v.block.trim().length).toBeGreaterThan(BLOCK_MIN_CHARS);
		expect(v.cited.length).toBeGreaterThan(CITATION_FLOOR);
		expect(failingLegs(v)).toEqual([]);
	});

	test('a missing tree reads as absent, never throws', () => {
		expect(readAuditRecord(absentScratchPath('closure_oq_never_created'))).toBeNull();
	});

	const CASES: [Offence, Leg[], (v: AuditVerdicts) => void][] = [
		// A collapsed parse yields NO labels, so the per-label legs see nothing to
		// check — exactly why the census floor exists: it alone reds here.
		['collapsed-register', ['census'], (v) => expect(v.labels).toEqual([])],
		// The block exists only between its markers: unmarked, nothing is read —
		// the entries vanish, so the verdict, citation and owed legs fall with it.
		['no-block', ['block', 'verdict', 'citations', 'owed'], (v) => expect(v.block).toBe('')],
		['unanswered', ['verdict'], (v) => expect(v.missing).toEqual(['Synthetic question 4'])],
		[
			'bullet-added-later',
			['verdict'],
			(v) => expect(v.missing).toEqual(['A bullet added after closure']),
		],
		[
			'answered-dead-citation',
			['answered', 'citations'],
			(v) => {
				expect(v.bare).toEqual(['Synthetic question 1']);
				expect(v.dead).toEqual(['evidence/never_written.md']);
			},
		],
		['open-silent', ['open'], (v) => expect(v.silent).toEqual(['Synthetic question 2'])],
		[
			'dead-citation-elsewhere',
			['citations'],
			(v) => {
				expect(v.dead).toEqual(['src/core/db/no_such_file_here.ts']);
				expect(v.bare).toHaveLength(0);
			},
		],
		['owed-unnamed', ['owed'], (v) => expect(v.absentOwed).toEqual(['CLI-26 step 5'])],
	];
	for (const [offence, legs, detail] of CASES) {
		test(`planted offence '${offence}' reds exactly: ${legs.join(', ')}`, () => {
			const v = situationVerdicts(offence);
			expect(failingLegs(v)).toEqual(legs);
			detail(v);
		});
	}
});

describe('POSITIVE CONTROLS: the detectors fire on planted offences', () => {
	const SYNTHETIC = [
		BLOCK_START,
		'**Answered question** — ANSWERED.',
		'Evidence: `src/core/db/query_tap.ts`.',
		'',
		'**Fabricated question** — ANSWERED.',
		'Evidence: `src/core/db/no_such_file_here.ts`.',
		'',
		'**Silent question** — OPEN.',
		'Nothing is said about how to close it.',
		'',
		'Verdictless question — the entry that forgot its token.',
		BLOCK_END,
	].join('\n');
	const synthetic = extractBlock(SYNTHETIC);

	test('a verdict-less entry is not found', () => {
		expect(findEntry(synthetic, 'Verdictless question')).toBeNull();
		expect(findEntry(synthetic, 'Answered question')?.verdict).toBe('ANSWERED');
	});

	test('a fabricated citation does not resolve', () => {
		const entry = findEntry(synthetic, 'Fabricated question');
		expect(entry).not.toBeNull();
		const cites = citationsIn(entry?.body ?? '');
		expect(cites.length).toBeGreaterThan(0);
		expect(cites.filter((c) => citationResolves(c, AUDIT_DIR))).toEqual([]);
		// and the real one does
		expect(
			citationsIn(findEntry(synthetic, 'Answered question')?.body ?? '').filter((c) =>
				citationResolves(c, AUDIT_DIR),
			),
		).toEqual(['src/core/db/query_tap.ts']);
	});

	test('an OPEN entry with no resolution path is detected', () => {
		const entry = findEntry(synthetic, 'Silent question');
		expect(entry?.verdict).toBe('OPEN');
		expect(/What would answer it/i.test(entry?.body ?? '')).toBe(false);
	});

	test('a block without markers extracts as empty', () => {
		expect(extractBlock('no markers here')).toBe('');
	});
});
