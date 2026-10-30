/**
 * THE UPDATE DOCS' CHECKABLE CLAIMS EQUAL THE CODE (update audit 2026-10-29,
 * U-45, design Phase 3.2). The operator manual of the update run
 * (docs/management/updates/*.md) and its engineering twins (engineering/RELEASE.md,
 * engineering/PRODUCTION.md §12) state facts an operator acts on. Each claim
 * below is EXTRACTED from the prose and compared with what the code DOES —
 * measured by running the code (planner, executor with seams, rollback
 * predicate, the CLI as a subprocess, the door gate, the host shell library),
 * never by matching a spelling in the source:
 *
 *  C1 every arrow chain of phase kinds (`code` → `ontology` → …) equals the
 *     phase order the planner gives a release that declares no steps;
 *  C2 the states table names exactly the run's states; "ends the run" ⇔
 *     terminal; the maintenance column equals what the executor does to
 *     maintenance mode in each executor-reachable terminal state; every
 *     state-shaped name anywhere in the update docs is a real state;
 *  C3 the failure table: each scenario's documented end state equals
 *     rollback.ts failureExit for that scenario;
 *  C4 every documented `bun run update <cmd>` is accepted by scripts/update.ts
 *     (probed as a subprocess), and every command the CLI accepts is documented;
 *  C5 the door table's destructive / update-run sets equal DOOR_CLASSES, the
 *     dry-run marks equal the declared rehearsal, and each documented
 *     destructive door REFUSES a non-superuser through enterDoor;
 *  C6 any catalog-state claim ("empty", "no release carries a data step")
 *     agrees with the shipped catalog;
 *  C7 every image tag the docs present as installable is one the host library
 *     accepts and does not classify `-dev`; every "-dev is refused by the image
 *     tools" claim holds (dedalo_image_build refuses a -dev tag with its own
 *     status, distinct from a release tag's failure); RELEASE.md's tag commands
 *     are release tags and its "-dev is never a release tag" claim holds;
 *  C8 the ancillary list equals ANCILLARY_RECONCILERS, in order;
 *  C9 the post-verification lists equal RUN_VERIFY_PREDICATES, in order;
 *  C10 every claim about a declared `ontology` precondition (`min`, before the
 *     swap) agrees with the loader (accepted or refused) and the planner
 *     (hoisted before the code phase).
 *
 * Every extractor has an anti-vacuity floor, and every check has a planted
 * positive control: a mutated doc string must turn it red.
 *
 * DB-free: no database, no network (the `plan` probe runs with CODE_SERVERS=[]).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishedPagePaths } from '../../scripts/lib/docs_paths.ts';
import { releaseTagFault } from '../../scripts/lib/release_tag.ts';
import { CONFIG_CATALOG } from '../../src/config/catalog/index.ts';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { RELEASE_PLANS } from '../../src/core/update/catalog.ts';
import {
	CATALOG_FILE_FORMAT,
	parseCatalogFile,
	type ReleasePlan,
	type ReleaseStep,
	type ReleaseStepKind,
} from '../../src/core/update/catalog_file.ts';
import { DOOR_CLASSES, doorClassOf, enterDoor } from '../../src/core/update/door_class.ts';
import { releaseVersionOfTag } from '../../src/core/update/release_identity.ts';
import { ANCILLARY_RECONCILERS } from '../../src/core/update/run/ancillary.ts';
import { type RunEffects, startUpdateRun } from '../../src/core/update/run/executor.ts';
import { createRunJournal, type RunJournal } from '../../src/core/update/run/journal.ts';
import { planRun } from '../../src/core/update/run/plan.ts';
import { failureExit } from '../../src/core/update/run/rollback.ts';
import { happyPath, isTerminal, TERMINAL_STATES } from '../../src/core/update/run/states.ts';
import { RUN_VERIFY_PREDICATES } from '../../src/core/update/run/verify.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const UPDATES_DIR = 'docs/management/updates';
const INDEX = `${UPDATES_DIR}/index.md`;
const RELEASE = 'engineering/RELEASE.md';
const PRODUCTION = 'engineering/PRODUCTION.md#12';

const scratch: string[] = [];
afterAll(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
function scratchDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	scratch.push(dir);
	return dir;
}

// ---------------------------------------------------------------------------
// the corpus
// ---------------------------------------------------------------------------

type Corpus = Readonly<Record<string, string>>;

function read(path: string): string {
	return readFileSync(join(REPO_ROOT, path), 'utf8');
}

/**
 * The update manual's pages as the SITE serves them (scripts/lib/docs_paths.ts,
 * the registered docs lister): served path → its file under UPDATES_DIR.
 */
function updatePages(): string[] {
	const prefix = `${UPDATES_DIR.replace(/^docs\//, '')}/`;
	return publishedPagePaths(REPO_ROOT)
		.filter((page) => page.startsWith(prefix) && !page.slice(prefix.length).includes('/'))
		.map((page) => (page === prefix ? 'index.md' : `${page.slice(prefix.length)}.md`));
}

/** The update docs, RELEASE.md, and PRODUCTION.md's §12 (the code-update section). */
function loadCorpus(): Corpus {
	const corpus: Record<string, string> = {};
	for (const file of updatePages())
		corpus[`${UPDATES_DIR}/${file}`] = read(`${UPDATES_DIR}/${file}`);
	corpus[RELEASE] = read(RELEASE);
	const production = read('engineering/PRODUCTION.md');
	const from = production.indexOf('\n## 12.');
	const to = production.indexOf('\n## 13.', from);
	if (from === -1 || to === -1) throw new Error('PRODUCTION.md §12 not found');
	corpus[PRODUCTION] = production.slice(from, to);
	return corpus;
}

const CORPUS = loadCorpus();

function docsOnly(corpus: Corpus): string[] {
	return Object.keys(corpus).filter((key) => key.startsWith(UPDATES_DIR));
}

/** The lines under `heading` up to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
	const lines = text.split('\n');
	const at = lines.findIndex((line) => line.trim() === heading);
	if (at === -1) return '';
	const level = heading.match(/^#+/)?.[0].length ?? 0;
	const end = lines.findIndex(
		(line, index) =>
			index > at && /^#+ /.test(line) && (line.match(/^#+/)?.[0].length ?? 0) <= level,
	);
	return lines.slice(at + 1, end === -1 ? undefined : end).join('\n');
}

/** Body rows of the markdown tables in `text`: cells, trimmed (header + separator skipped). */
function tableRows(text: string): string[][] {
	const rows: string[][] = [];
	let inTable = false;
	let headerSeen = false;
	for (const line of text.split('\n')) {
		if (!line.trim().startsWith('|')) {
			inTable = false;
			headerSeen = false;
			continue;
		}
		const cells = line
			.trim()
			.replace(/^\||\|$/g, '')
			.split('|')
			.map((cell) => cell.trim());
		if (!inTable) {
			inTable = true;
			continue; // the header
		}
		if (!headerSeen && cells.every((cell) => /^:?-{3,}:?$/.test(cell))) {
			headerSeen = true;
			continue;
		}
		rows.push(cells);
	}
	return rows;
}

function backticked(text: string): string[] {
	return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string);
}

/** Sentences of `text` (paragraph lines joined first). */
function sentences(text: string): string[] {
	return text
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.replaceAll(/\s*\n\s*/g, ' '))
		.flatMap((paragraph) => paragraph.split(/(?<=[.!?])\s+(?=[A-Z*`(])/));
}

function mutate(corpus: Corpus, key: string, from: string, to: string): Corpus {
	const text = corpus[key];
	if (text === undefined || !text.includes(from))
		throw new Error(`positive control: '${from.slice(0, 60)}' is not in ${key}`);
	return { ...corpus, [key]: text.replace(from, to) };
}

// ---------------------------------------------------------------------------
// C1 — phase order chains
// ---------------------------------------------------------------------------

const KIND = '(?:code|ontology|schema|data|ancillary)';
const CHAIN = new RegExp(`\`?${KIND}\`?(?:\\s*→\\s*\`?${KIND}\`?){2,}`, 'g');

function orderChains(corpus: Corpus): { where: string; chain: string[] }[] {
	return Object.entries(corpus).flatMap(([where, text]) =>
		[...text.matchAll(CHAIN)].map((match) => ({
			where,
			chain: match[0].split('→').map((token) => token.replaceAll('`', '').trim()),
		})),
	);
}

/** The planner's phase order for a release that declares no steps (parsed from a planted catalog). */
function plannedDefaultOrder(): string[] {
	const parsed = parseCatalogFile(
		{ format: CATALOG_FILE_FORMAT, releases: { '7.0.1': {} } },
		() => null,
	);
	if (parsed.violations.length > 0) throw new Error(JSON.stringify(parsed.violations));
	const plan = planRun({
		installedRelease: '7.0.0',
		installedData: [7, 0, 0],
		target: '7.0.1',
		targetData: [7, 0, 0],
		plans: parsed.plans,
	});
	if (!plan.ok) throw new Error(plan.detail);
	return plan.plan.map((entry) => entry.step.kind);
}

function checkOrder(corpus: Corpus): string[] {
	const truth = plannedDefaultOrder().join(' → ');
	return orderChains(corpus)
		.filter(({ chain }) => chain.join(' → ') !== truth)
		.map(({ where, chain }) => `${where}: order ${chain.join(' → ')} ≠ planner ${truth}`);
}

// ---------------------------------------------------------------------------
// C2 — states
// ---------------------------------------------------------------------------

const ALL_KINDS: ReleaseStepKind[] = ['code', 'ontology', 'schema', 'data', 'ancillary'];
const RUN_STATES: ReadonlySet<string> = new Set([...happyPath(ALL_KINDS), ...TERMINAL_STATES]);

function stateRows(corpus: Corpus): { state: string; ends: string; maintenance: string }[] {
	return tableRows(section(corpus[INDEX] ?? '', '### States')).map((cells) => ({
		state: backticked(cells[0] ?? '')[0] ?? cells[0] ?? '',
		ends: cells[1] ?? '',
		maintenance: cells[2] ?? '',
	}));
}

function checkStateTable(corpus: Corpus): string[] {
	const rows = stateRows(corpus);
	const found: string[] = [];
	const named = new Set(rows.map((row) => row.state));
	for (const row of rows) {
		if (!RUN_STATES.has(row.state)) {
			found.push(`state ${row.state} is not a run state`);
			continue;
		}
		const ends = row.ends === 'yes';
		if (ends !== isTerminal(row.state as never))
			found.push(
				`state ${row.state}: "ends the run" = ${row.ends}, terminal = ${isTerminal(row.state as never)}`,
			);
	}
	for (const state of RUN_STATES)
		if (!named.has(state)) found.push(`state ${state} is not documented`);
	return found;
}

/** Names that look like states but are not: each with its reason. */
const NOT_STATES: Readonly<Record<string, string>> = {
	CONFIGURED: 'a pill text of the Serve Ontology panel',
	INVOCATION_ID: 'a systemd process variable the engine no longer reads',
	JOURNAL_STREAM: 'a systemd process variable the engine no longer reads',
	DEDALO_VERSION: 'the Docker host .dedalo.env pin, not an engine config key',
};

function checkStateNames(corpus: Corpus): string[] {
	const found: string[] = [];
	for (const where of docsOnly(corpus)) {
		const text = corpus[where] as string;
		for (const match of text.matchAll(
			/(?:`|\*\*)([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z]{4,})(?:`|\*\*)/g,
		)) {
			const name = match[1] as string;
			if (RUN_STATES.has(name) || Object.hasOwn(CONFIG_CATALOG, name) || name in NOT_STATES)
				continue;
			found.push(`${where}: '${name}' is neither a run state nor a config key`);
		}
	}
	return found;
}

/** What the executor does to maintenance mode for a run ending in `scenario`. */
async function maintenanceAfter(
	scenario: 'CONFIRMED' | 'REFUSED' | 'FAILED_PRE_SWAP' | 'ROLLED_BACK_CODE' | 'NEEDS_DB_RESTORE',
	before: boolean,
): Promise<{ state: string; word: string; final: boolean }> {
	const compat =
		scenario === 'ROLLED_BACK_CODE'
			? 'compatible'
			: scenario === 'NEEDS_DB_RESTORE'
				? 'incompatible'
				: null;
	const steps: ReleaseStep[] = [{ kind: 'code' }, { kind: 'schema' }, { kind: 'ancillary' }];
	const plans: Record<string, ReleasePlan> = {
		'7.0.1': { version: '7.0.1', compat, steps, declared: true },
	};
	let maintenance = before;
	const sets: boolean[] = [];
	const ok = async () => ({ outcome: 'ok' as const, evidence: {} });
	const schemaFails = scenario === 'ROLLED_BACK_CODE' || scenario === 'NEEDS_DB_RESTORE';
	const effects: RunEffects = {
		root: scratchDir('dedalo_docs_claims_runs_'),
		lock: async () => ({ release: async () => {} }),
		maintenance: {
			get: () => maintenance,
			set: (on) => {
				sets.push(on);
				maintenance = on;
			},
		},
		preflight: async () => (scenario === 'REFUSED' ? 'planted refusal' : null),
		backup: async () => {
			if (scenario === 'FAILED_PRE_SWAP') throw new Error('planted backup failure');
			return {
				path: '/backups/x.custom.backup',
				taken: '2026-10-30T10:00:00.000Z',
				waivedBy: null,
			};
		},
		runners: {
			code: ok,
			ontology: ok,
			schema: async () =>
				schemaFails ? { outcome: 'failed' as const, evidence: { summary: 'planted' } } : ok(),
			data: ok,
			ancillary: ok,
		},
		verify: async () => ({ verified: true, verdicts: [] }),
		confirm: async () => {},
		rollbackCode: async () => {},
		markNeedsRestore: async () => {},
		bootedRelease: () => '7.0.1',
		plans,
	};
	const outcome = await startUpdateRun(
		{ installedRelease: '7.0.0', installedData: [7, 0, 0], target: '7.0.1', targetData: [7, 0, 0] },
		effects,
	);
	const word =
		sets.length === 0
			? 'unchanged'
			: maintenance === before && sets.includes(true)
				? 'restored'
				: maintenance
					? 'on'
					: 'off';
	return { state: outcome.journal.state, word, final: maintenance };
}

const SIMULATED = [
	'CONFIRMED',
	'REFUSED',
	'FAILED_PRE_SWAP',
	'ROLLED_BACK_CODE',
	'NEEDS_DB_RESTORE',
] as const;

async function checkMaintenanceColumn(corpus: Corpus): Promise<string[]> {
	const rows = new Map(stateRows(corpus).map((row) => [row.state, row.maintenance]));
	const found: string[] = [];
	for (const scenario of SIMULATED) {
		const measured = await maintenanceAfter(scenario, false);
		if (measured.state !== scenario)
			throw new Error(`simulation of ${scenario} ended ${measured.state}`);
		const documented = rows.get(scenario);
		if (documented !== measured.word)
			found.push(
				`${scenario}: docs say maintenance '${documented ?? '(no row)'}', the executor leaves it '${measured.word}'`,
			);
	}
	// "restored" means as you had it: a run started with maintenance ON keeps it ON.
	const kept = await maintenanceAfter('CONFIRMED', true);
	if (rows.get('CONFIRMED') === 'restored' && !kept.final)
		found.push('CONFIRMED with maintenance ON before: the executor switched it OFF');
	return found;
}

// ---------------------------------------------------------------------------
// C3 — failure exits
// ---------------------------------------------------------------------------

type Scenario = 'pre' | 'compatible' | 'incompatible' | 'none';

function failureRows(
	corpus: Corpus,
): { scenario: Scenario | null; documented: string; row: string }[] {
	return tableRows(section(corpus[INDEX] ?? '', '### When a phase fails')).map((cells) => {
		const first = cells[0] ?? '';
		const scenario: Scenario | null = /\bbefore\b/.test(first)
			? 'pre'
			: first.includes('`incompatible`')
				? 'incompatible'
				: /no `compat`/.test(first)
					? 'none'
					: first.includes('`compatible`')
						? 'compatible'
						: null;
		return { scenario, documented: backticked(cells[1] ?? '')[0] ?? '', row: first };
	});
}

function measuredExit(scenario: Scenario): string {
	const compat =
		scenario === 'compatible' ? 'compatible' : scenario === 'incompatible' ? 'incompatible' : null;
	const plans: Record<string, ReleasePlan> = {
		'7.0.1': {
			version: '7.0.1',
			compat,
			steps: [{ kind: 'code' }, { kind: 'schema' }],
			declared: true,
		},
	};
	const journal: RunJournal = createRunJournal({
		from: { release: '7.0.0', data: '7.0.0', model: '7.0.0' },
		to: { release: '7.0.1', data: '7.0.0', model: '7.0.0' },
		plan: [],
		releasePlans: plans,
	});
	const record = (step: ReleaseStep, outcome: 'ok' | 'failed') => ({
		release: '7.0.1',
		step,
		started: journal.created,
		finished: journal.created,
		outcome,
		evidence: {},
	});
	const phases =
		scenario === 'pre'
			? [record({ kind: 'ontology', min: '7.0.0' }, 'failed')]
			: [record({ kind: 'code' }, 'ok'), record({ kind: 'schema' }, 'failed')];
	return failureExit({ ...journal, phases }, plans);
}

function checkFailureTable(corpus: Corpus): string[] {
	const rows = failureRows(corpus);
	const found: string[] = [];
	for (const row of rows) {
		if (row.scenario === null) {
			found.push(`failure row '${row.row}' names no scenario this gate can measure`);
			continue;
		}
		const truth = measuredExit(row.scenario);
		if (row.documented !== truth)
			found.push(`failure '${row.row}': docs say ${row.documented}, rollback.ts says ${truth}`);
	}
	const covered = new Set(rows.map((row) => row.scenario));
	for (const scenario of ['pre', 'compatible', 'incompatible', 'none'] as const)
		if (!covered.has(scenario)) found.push(`failure scenario '${scenario}' is not documented`);
	return found;
}

// ---------------------------------------------------------------------------
// C4 — the command line
// ---------------------------------------------------------------------------

const CLI_MENTION = /bun run update ([a-z]+)((?: (?:<[^>]+>|\[[^\]]+\]))*)/g;

function probeCli(word: string, args: string): string {
	const argv = [...args.matchAll(/<[^>]+>/g)].map(() => '0.0.0');
	const root = scratchDir('dedalo_docs_claims_cli_');
	const run = Bun.spawnSync(['bun', 'scripts/update.ts', word, ...argv, '--json', '--root', root], {
		cwd: REPO_ROOT,
		env: { ...process.env, CODE_SERVERS: '[]' },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	// A word the CLI does not know answers {"verdict":"usage"} (or "not_here" for
	// apply/resume). Anything else — a verdict, a refusal, even a handler that
	// throws because it needs the database (abort's lock probe) — means the
	// parser DISPATCHED the word to a command.
	const verdict = run.stdout.toString().match(/"verdict":"([a-z_]+)"/)?.[1];
	return verdict === 'usage' || verdict === 'not_here' ? verdict : 'accepted';
}

/** The commands the CLI names in its own usage line, each then probed. */
function cliVocabulary(): string[] {
	const run = Bun.spawnSync(['bun', 'scripts/update.ts'], {
		cwd: REPO_ROOT,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const usage = run.stdout.toString().match(/bun run update (.*?)(?: \[--|$)/m)?.[1] ?? '';
	return usage
		.split('|')
		.map((part) => part.trim().split(/\s/)[0] as string)
		.filter((w) => /^[a-z]+$/.test(w));
}

const probes = new Map<string, string>();
function probe(word: string, args: string): string {
	const key = `${word} ${args}`;
	if (!probes.has(key)) probes.set(key, probeCli(word, args));
	return probes.get(key) as string;
}

function tableCommands(corpus: Corpus): { word: string; args: string }[] {
	return tableRows(section(corpus[INDEX] ?? '', '### The command line')).flatMap((cells) =>
		[...(cells[0] ?? '').matchAll(CLI_MENTION)].map((m) => ({
			word: m[1] as string,
			args: m[2] ?? '',
		})),
	);
}

function checkCli(corpus: Corpus): string[] {
	const found: string[] = [];
	const table = tableCommands(corpus);
	for (const { word, args } of table) {
		const verdict = probe(word, args);
		if (verdict !== 'accepted')
			found.push(`documented command 'bun run update ${word}' → ${verdict}`);
	}
	for (const where of docsOnly(corpus)) {
		for (const m of (corpus[where] as string).matchAll(CLI_MENTION)) {
			const verdict = probe(m[1] as string, m[2] ?? '');
			if (verdict === 'usage')
				found.push(`${where}: 'bun run update ${m[1]}' is unknown to the CLI`);
		}
	}
	const documented = new Set(table.map((entry) => entry.word));
	for (const word of cliVocabulary()) {
		if (documented.has(word)) continue;
		const args = word === 'plan' ? ' <release>' : '';
		if (probe(word, args) === 'accepted')
			found.push(`the CLI accepts '${word}', the command table omits it`);
	}
	return found;
}

// ---------------------------------------------------------------------------
// C5 — door classes
// ---------------------------------------------------------------------------

const DOOR_HEADING =
	'### Which maintenance actions need the superuser, maintenance mode and a backup';

function doorRows(corpus: Corpus): { id: string; label: string }[] {
	return tableRows(section(corpus[INDEX] ?? '', DOOR_HEADING))
		.map((cells) => ({ id: backticked(cells[0] ?? '')[0] ?? '', label: cells[1] ?? '' }))
		.filter((row) => row.id.includes('.'));
}

function declaredSet(cls: string): Set<string> {
	return new Set(
		Object.entries(DOOR_CLASSES)
			.filter(([, d]) => d.class === cls)
			.map(([id]) => id),
	);
}

const NON_SUPERUSER: Principal = {
	userId: -9999,
	isGlobalAdmin: true,
	isDeveloper: false,
} as Principal;

async function checkDoors(corpus: Corpus): Promise<string[]> {
	const found: string[] = [];
	const rows = doorRows(corpus);
	const docDestructive = new Set(
		rows.filter((r) => r.label.startsWith('destructive')).map((r) => r.id),
	);
	const docRun = new Set(rows.filter((r) => r.label.startsWith('update run')).map((r) => r.id));
	const compare = (doc: Set<string>, cls: string) => {
		const truth = declaredSet(cls);
		for (const id of doc)
			if (!truth.has(id))
				found.push(
					`door ${id} documented as ${cls}, declared ${DOOR_CLASSES[id]?.class ?? 'nothing'}`,
				);
		for (const id of truth) if (!doc.has(id)) found.push(`${cls} door ${id} is not documented`);
	};
	compare(docDestructive, 'destructive_shared');
	compare(docRun, 'update_run');
	for (const row of rows) {
		const dryDocumented = row.label.includes('dry run');
		const declared = DOOR_CLASSES[row.id];
		if (declared === undefined) continue;
		if (dryDocumented !== (declared.dryRun !== undefined))
			found.push(
				`door ${row.id}: dry-run mark documented ${dryDocumented}, declared ${declared.dryRun !== undefined}`,
			);
		if (dryDocumented && declared.dryRun !== undefined) {
			const rehearsal = doorClassOf(row.id, {});
			const execute = doorClassOf(row.id, { [declared.dryRun.option]: false });
			if (rehearsal !== 'reversible_admin' || execute !== 'destructive_shared')
				found.push(`door ${row.id}: no-option class ${rehearsal}, execute class ${execute}`);
		}
	}
	// OUTCOME: every documented destructive door refuses a non-superuser at the gate.
	for (const id of docDestructive) {
		if (DOOR_CLASSES[id] === undefined) continue;
		const option = DOOR_CLASSES[id]?.dryRun?.option;
		const options = option === undefined ? {} : { [option]: false };
		try {
			const release = await enterDoor(id, NON_SUPERUSER, options);
			await release();
			found.push(`door ${id} documented destructive, but admitted a non-superuser`);
		} catch (error) {
			if (!isDedaloError(error) || error.code !== 'perm.superuser_required')
				found.push(`door ${id}: refused, but not for the superuser rule (${String(error)})`);
		}
	}
	// ids named in the section's prose exist
	const prose = section(corpus[INDEX] ?? '', DOOR_HEADING)
		.split('\n')
		.filter((l) => !l.trim().startsWith('|'));
	for (const id of backticked(prose.join('\n')).filter((t) => /^[a-z_]+\.[a-z_]+$/.test(t)))
		if (DOOR_CLASSES[id] === undefined) found.push(`door ${id} named in the prose is not a door`);
	return found;
}

// ---------------------------------------------------------------------------
// C6 — catalog-state claims
// ---------------------------------------------------------------------------

type CatalogClaim = { where: string; kind: 'empty' | 'no_data_step'; sentence: string };

function catalogClaims(corpus: Corpus): CatalogClaim[] {
	return Object.entries(corpus).flatMap(([where, text]) =>
		sentences(text).flatMap((sentence): CatalogClaim[] => {
			if (/\bno\s+(?:[\w.]+\s+)?releases? (?:yet )?carr(?:y|ies) a data step\b/i.test(sentence))
				return [{ where, kind: 'no_data_step', sentence }];
			if (/catalog/i.test(sentence) && /\b(?:is|currently|still) empty\b/i.test(sentence))
				return [{ where, kind: 'empty', sentence }];
			return [];
		}),
	);
}

function checkCatalogClaims(corpus: Corpus): string[] {
	const plans = Object.values(RELEASE_PLANS);
	const hasData = plans.some((plan) => plan.steps.some((step) => step.kind === 'data'));
	return catalogClaims(corpus)
		.filter((claim) => (claim.kind === 'empty' ? plans.length > 0 : hasData))
		.map(
			(claim) =>
				`${claim.where}: "${claim.sentence.slice(0, 120)}" — the shipped catalog holds ${plans.map((p) => p.version).join(', ')}${hasData ? ' (with a data step)' : ''}`,
		);
}

// ---------------------------------------------------------------------------
// C7 — -dev rules: image tags and release tags
// ---------------------------------------------------------------------------

function instantiate(form: string): string {
	const full = form.startsWith('-') ? `X.Y.Z${form}` : form;
	return full.replace('X.Y.Z', '7.0.1').replace(/\.N$/, '.1');
}

/** Tags the corpus presents as installable on an image install. */
function installableImageTags(corpus: Corpus): { where: string; tag: string }[] {
	const found: { where: string; tag: string }[] = [];
	for (const [where, text] of Object.entries(corpus)) {
		for (const m of text.matchAll(/dedalo-image-update\.sh --version ([^\s`]+)/g))
			if (!(m[1] as string).includes('<')) found.push({ where, tag: m[1] as string });
		for (const sentence of sentences(text))
			if (/tagged releases only/i.test(sentence))
				for (const token of backticked(sentence))
					if (/^\d+\.\d+\.\d+/.test(token)) found.push({ where, tag: token });
		const row = text.split('\n').find((line) => line.startsWith('| `DEDALO_VERSION` |'));
		if (row !== undefined) {
			const cell = row.split('|')[2] ?? '';
			const first = cell.split(/(?<=\.)\s/)[0] ?? cell; // the first sentence: the pinnable forms
			for (const token of backticked(first))
				if (/^(?:X\.Y\.Z|-)/.test(token)) found.push({ where, tag: instantiate(token) });
		}
	}
	return found;
}

function shell(script: string): { code: number; out: string } {
	const run = Bun.spawnSync(['bash', '-c', `. deploy/dedalo-image-lib.sh\n${script}`], {
		cwd: REPO_ROOT,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return { code: run.exitCode ?? -1, out: run.stdout.toString() };
}

function imageAccepts(tag: string): boolean {
	return shell(`dedalo_version_grammar '${tag}' && ! dedalo_is_dev_tag '${tag}'`).code === 0;
}

function devRefusalClaims(corpus: Corpus): string[] {
	return Object.entries(corpus).flatMap(([where, text]) =>
		sentences(text)
			.filter(
				(s) =>
					s.includes('`-dev`') &&
					/\b(?:refus|never|no host tool)/i.test(s) &&
					/\b(?:image|Docker|host)\b/.test(s),
			)
			.map((s) => `${where}: ${s.slice(0, 80)}`),
	);
}

/** dedalo_image_build's verdict on `tag` over a scratch checkout (docker = `false`). */
function buildStatus(tag: string): number {
	const repo = scratchDir('dedalo_docs_claims_repo_');
	const git = (args: string[]) =>
		Bun.spawnSync(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
			cwd: repo,
			stdout: 'ignore',
			stderr: 'ignore',
		});
	git(['init', '-q']);
	Bun.write(join(repo, 'f.txt'), 'x');
	git(['add', '.']);
	git(['commit', '-qm', 'x']);
	return shell(`dedalo_image_build '${repo}' 'localhost/dedalo:${tag}' false 2>/dev/null`).code;
}

let devBuildVerdict: { dev: number; release: number } | null = null;

function checkImageTags(corpus: Corpus): string[] {
	const found = installableImageTags(corpus)
		.filter(({ tag }) => !imageAccepts(tag))
		.map(
			({ where, tag }) =>
				`${where}: image tag ${tag} is presented as installable, the host library refuses or classifies it -dev`,
		);
	if (devRefusalClaims(corpus).length > 0) {
		devBuildVerdict ??= { dev: buildStatus('7.0.1-dev'), release: buildStatus('7.0.1') };
		const isDev = shell(`dedalo_is_dev_tag '7.0.1-dev'`).code === 0;
		if (!isDev || devBuildVerdict.dev !== 3 || devBuildVerdict.release === 3)
			found.push(
				`the docs say the image tools refuse -dev; measured: dedalo_is_dev_tag=${isDev}, build(-dev)=${devBuildVerdict.dev}, build(release)=${devBuildVerdict.release}`,
			);
	}
	return found;
}

function releaseTagCommands(corpus: Corpus): string[] {
	return [...(corpus[RELEASE] ?? '').matchAll(/git tag -a (v[^\s`]+)/g)].map((m) => m[1] as string);
}

function checkReleaseTags(corpus: Corpus): string[] {
	const found = releaseTagCommands(corpus)
		.filter((tag) => releaseVersionOfTag(tag) === null)
		.map((tag) => `RELEASE.md tags ${tag}, which is no release tag`);
	const claims = sentences(corpus[RELEASE] ?? '').filter(
		(s) => s.includes('`-dev`') && /never a release tag/.test(s),
	);
	if (claims.length === 0) found.push('RELEASE.md states no rule for -dev names');
	if (
		releaseVersionOfTag('v7.0.1-dev') !== null ||
		releaseTagFault('v7.0.1-dev', 'c', { fileAt: () => null }) === null
	)
		found.push(
			'RELEASE.md says a -dev name is never a release tag; release_tag.ts admits v7.0.1-dev',
		);
	return found;
}

// ---------------------------------------------------------------------------
// C8 / C9 — ancillary reconcilers, verify predicates
// ---------------------------------------------------------------------------

function bulletIds(text: string): string[] {
	return text
		.split('\n')
		.map((line) => line.match(/^- `([a-z_]+)`/)?.[1])
		.filter((id): id is string => id !== undefined);
}

function checkAncillary(corpus: Corpus): string[] {
	const documented = bulletIds(section(corpus[INDEX] ?? '', '### The ancillary phase'));
	const truth = ANCILLARY_RECONCILERS.map((r) => r.id);
	return documented.join(',') === truth.join(',')
		? []
		: [`ancillary docs ${documented.join(', ')} ≠ ANCILLARY_RECONCILERS ${truth.join(', ')}`];
}

function verifyLists(corpus: Corpus): { where: string; ids: string[] }[] {
	const lists = [{ where: INDEX, ids: bulletIds(section(corpus[INDEX] ?? '', '### States')) }];
	for (const m of (corpus[PRODUCTION] ?? '').matchAll(/post-verify \(([^)]*)\)/g))
		lists.push({ where: PRODUCTION, ids: backticked(m[1] as string) });
	return lists;
}

function checkVerify(corpus: Corpus): string[] {
	const truth = RUN_VERIFY_PREDICATES.map((p) => p.id).join(',');
	return verifyLists(corpus)
		.filter((list) => list.ids.join(',') !== truth)
		.map(
			(list) =>
				`${list.where}: verify list ${list.ids.join(', ')} ≠ RUN_VERIFY_PREDICATES ${truth}`,
		);
}

// ---------------------------------------------------------------------------
// C10 — the ontology precondition step
// ---------------------------------------------------------------------------

function preconditionClaims(
	corpus: Corpus,
): { where: string; refused: boolean; sentence: string }[] {
	return Object.entries(corpus).flatMap(([where, text]) =>
		sentences(text)
			.filter((s) => s.includes('`ontology`') && s.includes('`min`') && /\bbefore\b/i.test(s))
			.map((sentence) => ({ where, refused: /\brefus/i.test(sentence), sentence })),
	);
}

/** Does the loader accept a declared ontology precondition, and does the planner run it before the swap? */
function measuredPrecondition(): { accepted: boolean; beforeSwap: boolean } {
	const parsed = parseCatalogFile(
		{
			format: CATALOG_FILE_FORMAT,
			releases: {
				'7.0.1': {},
				'7.0.2': {
					compat: 'compatible',
					steps: [
						{ kind: 'ontology', min: '7.0.1' },
						{ kind: 'code' },
						{ kind: 'ontology' },
						{ kind: 'ancillary' },
					],
				},
			},
		},
		() => null,
	);
	if (parsed.violations.length > 0) return { accepted: false, beforeSwap: false };
	const plan = planRun({
		installedRelease: '7.0.1',
		installedData: [7, 0, 0],
		target: '7.0.2',
		targetData: [7, 0, 0],
		plans: parsed.plans,
	});
	const kinds = plan.ok ? plan.plan.map((entry) => entry.step) : [];
	return {
		accepted: true,
		beforeSwap:
			kinds[0]?.kind === 'ontology' && kinds[0]?.min === '7.0.1' && kinds[1]?.kind === 'code',
	};
}

function checkPrecondition(corpus: Corpus): string[] {
	const truth = measuredPrecondition();
	return preconditionClaims(corpus).flatMap(({ where, refused, sentence }) => {
		if (refused === !truth.accepted)
			return refused || truth.beforeSwap
				? []
				: [`${where}: the planner does not run the precondition before the swap`];
		return [
			`${where}: "${sentence.slice(0, 100)}" — the loader ${truth.accepted ? 'accepts' : 'refuses'} a declared ontology precondition`,
		];
	});
}

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

describe('anti-vacuity: the extractors find the claims', () => {
	test('floors', () => {
		expect(orderChains(CORPUS).length).toBeGreaterThanOrEqual(3);
		expect(stateRows(CORPUS).length).toBeGreaterThanOrEqual(RUN_STATES.size);
		expect(failureRows(CORPUS).length).toBeGreaterThanOrEqual(4);
		expect(tableCommands(CORPUS).length).toBeGreaterThanOrEqual(4);
		expect(cliVocabulary().length).toBeGreaterThanOrEqual(4);
		expect(probe('bogus', '')).toBe('usage'); // the probe can say "unknown"
		expect(doorRows(CORPUS).length).toBeGreaterThanOrEqual(declaredSet('destructive_shared').size);
		expect(catalogClaims(CORPUS).length).toBeGreaterThanOrEqual(1);
		expect(installableImageTags(CORPUS).length).toBeGreaterThanOrEqual(4);
		expect(devRefusalClaims(CORPUS).length).toBeGreaterThanOrEqual(2);
		expect(releaseTagCommands(CORPUS).length).toBeGreaterThanOrEqual(2);
		expect(
			bulletIds(section(CORPUS[INDEX] ?? '', '### The ancillary phase')).length,
		).toBeGreaterThanOrEqual(4);
		expect(verifyLists(CORPUS).length).toBeGreaterThanOrEqual(2);
		expect(preconditionClaims(CORPUS).length).toBeGreaterThanOrEqual(2);
	});
});

describe('the docs equal the code', () => {
	test('C1 phase order', () => expect(checkOrder(CORPUS)).toEqual([]));
	test('C2 states table', () => expect(checkStateTable(CORPUS)).toEqual([]));
	test('C2 state-shaped names', () => expect(checkStateNames(CORPUS)).toEqual([]));
	test('C2 maintenance column (executor)', async () =>
		expect(await checkMaintenanceColumn(CORPUS)).toEqual([]));
	test('C3 failure exits (rollback.ts)', () => expect(checkFailureTable(CORPUS)).toEqual([]));
	test('C4 command line (scripts/update.ts)', () => expect(checkCli(CORPUS)).toEqual([]), 60_000);
	test('C5 door classes', async () => expect(await checkDoors(CORPUS)).toEqual([]));
	test('C6 catalog-state claims', () => expect(checkCatalogClaims(CORPUS)).toEqual([]));
	test('C7 image tags (host library)', () => expect(checkImageTags(CORPUS)).toEqual([]), 30_000);
	test('C7 release tags (release_tag.ts)', () => expect(checkReleaseTags(CORPUS)).toEqual([]));
	test('C8 ancillary reconcilers', () => expect(checkAncillary(CORPUS)).toEqual([]));
	test('C9 verify predicates', () => expect(checkVerify(CORPUS)).toEqual([]));
	test('C10 ontology precondition (loader + planner)', () =>
		expect(checkPrecondition(CORPUS)).toEqual([]));
});

describe('positive controls: a planted drift is caught', () => {
	test('C1 swapped phases', () => {
		expect(
			checkOrder(mutate(CORPUS, INDEX, '`ontology` → `schema`', '`schema` → `ontology`')).length,
		).toBeGreaterThan(0);
	});
	test('C2 an invented state, a dropped terminal state, a wrong maintenance cell, a stray state name', async () => {
		expect(
			checkStateTable(
				mutate(
					CORPUS,
					INDEX,
					'| `VERIFIED` | no | on |',
					'| `VERIFIED` | no | on |\n| `BOOTING` | no | on |',
				),
			).length,
		).toBeGreaterThan(0);
		expect(
			checkStateTable(mutate(CORPUS, INDEX, '| `NEEDS_DB_RESTORE` | yes | on |\n', '')).length,
		).toBeGreaterThan(0);
		expect(
			checkStateTable(mutate(CORPUS, INDEX, '| `MANUAL` | yes |', '| `MANUAL` | no |')).length,
		).toBeGreaterThan(0);
		expect(
			(
				await checkMaintenanceColumn(
					mutate(
						CORPUS,
						INDEX,
						'| `NEEDS_DB_RESTORE` | yes | on |',
						'| `NEEDS_DB_RESTORE` | yes | restored |',
					),
				)
			).length,
		).toBeGreaterThan(0);
		expect(
			checkStateNames(
				mutate(
					CORPUS,
					INDEX,
					'A run moves through',
					'A run passes `CODE_STAGED` and moves through',
				),
			).length,
		).toBeGreaterThan(0);
	});
	test('C3 a wrong failure exit', () => {
		expect(
			checkFailureTable(
				mutate(
					CORPUS,
					INDEX,
					'releases ran on the database | `ROLLED_BACK_CODE` |',
					'releases ran on the database | `NEEDS_DB_RESTORE` |',
				),
			).length,
		).toBeGreaterThan(0);
	});
	test('C4 an absent command documented, an accepted one omitted', () => {
		expect(
			checkCli(mutate(CORPUS, INDEX, '| `bun run update check` |', '| `bun run update apply` |'))
				.length,
		).toBeGreaterThan(0);
	}, 60_000);
	test('C5 a missing destructive door, a misclassified one', async () => {
		expect(
			(
				await checkDoors(
					mutate(CORPUS, INDEX, '| `update_code.restore_code` | destructive |\n', ''),
				)
			).length,
		).toBeGreaterThan(0);
		expect(
			(
				await checkDoors(
					mutate(
						CORPUS,
						INDEX,
						'| `move_tld.move_tld` | destructive, unless it is a dry run |',
						'| `move_tld.move_tld` | update run |',
					),
				)
			).length,
		).toBeGreaterThan(0);
	});
	test('C6 an "empty catalog" claim', () => {
		expect(
			checkCatalogClaims(
				mutate(
					CORPUS,
					`${UPDATES_DIR}/updating_data.md`,
					'Updating data is the most delicate',
					'The update catalog is currently empty. Updating data is the most delicate',
				),
			).length,
		).toBeGreaterThan(0);
	});
	test('C7 a -dev image pin, a -dev image update, a -dev release tag', () => {
		expect(
			checkImageTags(
				mutate(
					CORPUS,
					PRODUCTION,
					'`-rc.N` for a prerelease image.',
					'`-rc.N` for a prerelease image, or `X.Y.Z-dev` for a developer image.',
				),
			).length,
		).toBeGreaterThan(0);
		expect(
			checkImageTags(
				mutate(
					CORPUS,
					`${UPDATES_DIR}/updating_code.md`,
					'dedalo-image-update.sh --version 7.0.2',
					'dedalo-image-update.sh --version 7.0.2-dev',
				),
			).length,
		).toBeGreaterThan(0);
		expect(
			checkReleaseTags(mutate(CORPUS, RELEASE, 'git tag -a v7.0.1 ', 'git tag -a v7.0.1-dev '))
				.length,
		).toBeGreaterThan(0);
	}, 30_000);
	test('C8 reordered ancillary reconcilers', () => {
		const text = CORPUS[INDEX] as string;
		const tools = text.split('\n').find((l) => l.startsWith('- `tools`')) as string;
		const media = text.split('\n').find((l) => l.startsWith('- `media_rules`')) as string;
		const swapped = text.replace(tools, '@@').replace(media, tools).replace('@@', media);
		expect(checkAncillary({ ...CORPUS, [INDEX]: swapped }).length).toBeGreaterThan(0);
	});
	test('C10 a "declared ontology precondition is refused" claim', () => {
		expect(
			checkPrecondition(
				mutate(
					CORPUS,
					INDEX,
					'the run executes such a precondition **before** the code swap.',
					'the catalog refuses such a precondition, which would run **before** the code swap.',
				),
			).length,
		).toBeGreaterThan(0);
	});
	test('C9 a dropped verify predicate', () => {
		expect(
			checkVerify(
				mutate(
					CORPUS,
					PRODUCTION,
					'`schema_clean`, `data_version`, `data_model`',
					'`schema_clean`, `data_version`',
				),
			).length,
		).toBeGreaterThan(0);
	});
});
