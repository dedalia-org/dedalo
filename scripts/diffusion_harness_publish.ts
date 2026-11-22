/**
 * ============================================================================
 * FULL-ELEMENT DIFFUSION PUBLISHER (harness) — the v7 twin of the v6
 * `run_v6_diffusion.php` full-element driver.
 * ============================================================================
 *
 * The shipped v7 entrypoints publish ONE section per job: the runner
 * (src/diffusion/runner.ts) takes `spec.section_tipo` from a job row, and the
 * e2e gate (test/integration/diffusion_publish_e2e.test.ts) clones the plan
 * down to a single section. The v6→v7 diffusion-ontology parity loop needs the
 * OTHER shape: publish EVERY section of a compiled element, in plan order,
 * against a pinned run timestamp, so the resulting MariaDB tables can be dumped
 * and diffed byte-for-byte against the tables the v6 engine published.
 *
 * This script is that driver. It is a DEV/OPS tool: it drives the real,
 * unmodified pipeline (bumpOntologyRevision → getCompiledPlan →
 * resolvePublication → format writer) and adds nothing but a section loop, the
 * operator print-out, and a machine-readable summary.
 *
 * USAGE:
 *
 *     bun scripts/diffusion_harness_publish.ts --element mht2 \
 *         --database dedalo_harness_scratch \
 *         --run-started-at 1751700000 \
 *         --run-info /tmp/publish_v7.json
 *
 *     # one section, deeper frontier, v6-style gate bypass
 *     bun scripts/diffusion_harness_publish.ts mht2 \
 *         --database dedalo_harness_scratch \
 *         --run-started-at 1751700000 --section mht4 --max-levels 3 \
 *         --skip-publication-state-check
 *
 * FLAGS
 *   --element <tipo>                REQUIRED. The dd1190 diffusion element. May
 *                                   also be given as the single positional
 *                                   argument (the v6 twin's shape).
 *   --database <name>               REQUIRED (or env HARNESS_DB). The database
 *                                   this run is ALLOWED to write — see TARGET
 *                                   DATABASE SAFETY BELT below.
 *   --run-started-at <unix>         REQUIRED, epoch SECONDS. No Date.now()
 *                                   fallback ON PURPOSE: this value lands in
 *                                   every parser_global::publication_unix_timestamp
 *                                   column, so pinning it is what makes those
 *                                   columns COMPARABLE against the v6 dump
 *                                   instead of a column both sides must ignore.
 *                                   The v6 pass runs FIRST and reports the value
 *                                   its process-static memo actually chose; that
 *                                   value is what belongs here.
 *   --section <tipo>                Repeatable. Also --sections=a,b. Default:
 *                                   every plan section. A restricted smoke run
 *                                   uses the SAME --section list on both sides;
 *                                   there is deliberately NO per-record limit,
 *                                   because a limit cannot be made symmetric
 *                                   across the frontier-hop resolver and an
 *                                   asymmetric one buries the real findings in a
 *                                   bogus diff.
 *   --batch-size <n>                Default: the resolver's own default.
 *   --max-levels <n>                Default: plan.recursion.maxLevels. NOT 0 —
 *                                   the e2e test passes 0 only because it clones
 *                                   the plan to a single section and wants
 *                                   primaries only; a full-element run must
 *                                   walk the frontier exactly like v6 does.
 *   --skip-publication-state-check  Default OFF (matches v6's default gate).
 *   --principal <id>                Default -1 (superuser: unscoped selection).
 *   --media-markers off|real        Default 'off' — see MEDIA MARKERS below.
 *   --run-info <path>               Machine-readable run summary (--json is an
 *                                   accepted alias).
 *
 * ANY unrecognised `--flag` is a LOUD exit 2, and no flag value may itself start
 * with `--`. Silently dropping an unknown flag is exactly what produced an
 * asymmetric v6/v7 smoke run once already: one side honoured a restriction the
 * other side ignored, and the resulting whole-element diff hid every real finding.
 *
 * TARGET DATABASE SAFETY BELT. writer.open(plan) connects to whatever database
 * the ONTOLOGY names and immediately runs ensureSchema() DDL plus row upserts;
 * there is no runtime redirection on either side. So before the writer is opened
 * the run REFUSES unless plan.target.database equals the expected database
 * (--database, falling back to env HARNESS_DB). A MISSING expectation is also a
 * refusal: "trust the ontology" is precisely the failure mode the belt exists for.
 *
 * MEDIA MARKERS. MEDIA_PATH is set in the live ../private/.env, so an unguarded
 * full-element run would write one real `.publication` marker per published
 * record into the live media tree — silently changing what the web server
 * serves anonymously (src/core/media/protection.ts). Unless the operator asks
 * for `--media-markers real`, the marker store base is redirected to a fresh
 * mkdtemp directory and the effective base is printed. That directory is REMOVED
 * again on every exit path: a full element writes one marker file per published
 * record per table, and this loop is meant to be re-run until it is green.
 *
 * KNOWN, DELIBERATE v6/v7 DIVERGENCE — LAST WRITE WINS.
 * The resolver's `usedRecords` dedupe set is scoped to ONE resolvePublication
 * call. A record reached as a FRONTIER hop while section A is primary is
 * therefore re-published later, as a PRIMARY, when its own section's turn comes
 * (a second, independent call). v6 dedupes process-wide through a static, so v6
 * is "first write wins" and this driver is "last write wins". Writes are
 * idempotent upserts keyed by (section_id, lang), so the FINAL table state is
 * stable and deterministic either way — but if a record's frontier projection
 * ever differed from its primary projection, the two engines would disagree on
 * which of the two survives. This is documented, not worked around: working
 * around it would mean a cross-call dedupe set, i.e. changing resolver
 * semantics, which is out of scope for a harness.
 */

// Boot registration (mandatory): standalone processes must register the
// component-model lookup before plan compilation touches component models —
// exactly what src/diffusion/runner.ts does at its top.
import '../src/core/components/registry.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config/config.ts';
import { closeDatabasePool } from '../src/core/db/postgres.ts';
import { isDedaloError } from '../src/core/errors/index.ts';
import { type RequestLangs, runWithRequestLangs } from '../src/core/resolve/request_lang.ts';
import { type Principal, resolvePrincipal } from '../src/core/security/permissions.ts';
import { runWithRequestContext } from '../src/core/security/request_context.ts';
import { assertPublishableElement } from '../src/diffusion/api/excluded_elements.ts';
import { bumpOntologyRevision, getCompiledPlan } from '../src/diffusion/plan/cache.ts';
import type { PublicationPlan } from '../src/diffusion/plan/types.ts';
import { resolvePublication } from '../src/diffusion/resolve/resolver.ts';
import { closeAllTargetPools } from '../src/diffusion/targets/mariadb/db.ts';
import { overrideMediaIndexBaseForTests } from '../src/diffusion/targets/mediastore/media_index.ts';
import { getDiffusionWriter } from '../src/diffusion/writers/registry.ts';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = Bun.argv.slice(2);

const USAGE =
	'Usage: bun scripts/diffusion_harness_publish.ts --element <tipo> --database <name>\n' +
	'       --run-started-at <unix> [--section <tipo>]... [--sections=a,b]\n' +
	'       [--batch-size <n>] [--max-levels <n>] [--skip-publication-state-check]\n' +
	'       [--principal <id>] [--media-markers off|real] [--run-info <path>]';

/**
 * Flags taking a value. The list is CLOSED: anything else starting with `--` is
 * refused instead of ignored, so an orchestrator that passes a flag this script
 * does not implement can never produce a run that silently differs from the v6
 * one it is being diffed against.
 */
const VALUE_FLAGS = new Set([
	'--element',
	'--database',
	'--run-started-at',
	'--section',
	'--sections',
	'--batch-size',
	'--max-levels',
	'--principal',
	'--media-markers',
	'--run-info',
	'--json', // accepted alias of --run-info
]);
const BOOLEAN_FLAGS = new Set(['--skip-publication-state-check']);

const flagValues = new Map<string, string[]>();
const flagsPresent = new Set<string>();
const positionals: string[] = [];

for (let index = 0; index < argv.length; index++) {
	const argument = argv[index] as string;
	// Only a token that is not dash-prefixed at all can be a positional. A single-dash
	// token would otherwise be filed as the element tipo and fail much later, in the
	// plan compiler, instead of here.
	if (!argument.startsWith('-') || argument === '-') {
		positionals.push(argument);
		continue;
	}
	const equals = argument.indexOf('=');
	const flag = equals === -1 ? argument : argument.slice(0, equals);

	if (BOOLEAN_FLAGS.has(flag)) {
		if (equals !== -1) {
			console.error(`${flag} takes no value.\n${USAGE}`);
			process.exit(2);
		}
		flagsPresent.add(flag);
		continue;
	}
	if (!VALUE_FLAGS.has(flag)) {
		console.error(
			`REFUSED: unknown option '${flag}'. This script never ignores a flag it does not ` +
				`implement — a dropped flag is how an asymmetric v6/v7 run gets published.\n${USAGE}`,
		);
		process.exit(2);
	}
	// A value is never allowed to LOOK like a flag: `--run-info --skip-…` must
	// fail, not write a file named after the next flag.
	const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
	if (value === undefined || value.startsWith('--')) {
		console.error(
			`${flag} requires a value (got ${value === undefined ? 'end of arguments' : JSON.stringify(value)}).\n${USAGE}`,
		);
		process.exit(2);
	}
	flagsPresent.add(flag);
	const bucket = flagValues.get(flag);
	if (bucket === undefined) flagValues.set(flag, [value]);
	else bucket.push(value);
}

/** Last occurrence of `--flag <value>` / `--flag=<value>`, or null when absent. */
function argValue(flag: string): string | null {
	const values = flagValues.get(flag);
	return values === undefined ? null : (values[values.length - 1] as string);
}

/** Every occurrence of a repeatable `--flag <value>`, in command-line order. */
function argValues(flag: string): string[] {
	return flagValues.get(flag) ?? [];
}

/** Integer flag, or null when absent. Fails loudly on garbage. */
function intArg(flag: string): number | null {
	const raw = argValue(flag);
	if (raw === null) return null;
	const value = Number(raw);
	if (!Number.isInteger(value)) {
		console.error(`${flag} must be an integer (got ${JSON.stringify(raw)})`);
		process.exit(2);
	}
	return value;
}

if (positionals.length > 1) {
	console.error(`Unexpected argument '${positionals[1]}'.\n${USAGE}`);
	process.exit(2);
}
// The element may be named either way; the v6 twin takes it positionally and the
// orchestrator passes --element, so both shapes must resolve to the same run.
const elementFlag = argValue('--element');
const elementPositional = positionals[0] ?? null;
if (elementFlag !== null && elementPositional !== null && elementFlag !== elementPositional) {
	console.error(
		`--element '${elementFlag}' contradicts the positional element ` +
			`'${elementPositional}'. Give the element once.\n${USAGE}`,
	);
	process.exit(2);
}
const elementTipo = elementFlag ?? elementPositional;
if (elementTipo === null || elementTipo === '') {
	console.error(`--element is required (or give the element as the positional).\n${USAGE}`);
	process.exit(2);
}

// The database this run is ALLOWED to write. Resolved here, ENFORCED against the
// compiled plan below (the plan is what the writer actually connects to).
const expectedDatabaseRaw = argValue('--database') ?? process.env.HARNESS_DB ?? '';
const expectedDatabase = expectedDatabaseRaw.trim();
if (expectedDatabase === '') {
	console.error(
		'REFUSED: no expected publication database. Pass --database <name> (or set HARNESS_DB).\n' +
			'  This run opens a writer against the database the ONTOLOGY names and immediately runs\n' +
			'  DDL plus row upserts there. A missing expectation is a REFUSAL, never "trust the\n' +
			`  ontology": that is the only thing between this harness and a production database.\n${USAGE}`,
	);
	process.exit(2);
}

const runStartedAt = intArg('--run-started-at');
if (runStartedAt === null || runStartedAt <= 0) {
	console.error(
		'--run-started-at <unix seconds> is REQUIRED (it pins every publication_unix_timestamp ' +
			`column so the v6/v7 dumps stay comparable).\n${USAGE}`,
	);
	process.exit(2);
}

// --section is repeatable, --sections=a,b is the v6 twin's comma list; both feed
// one selection so an orchestrator may use either spelling.
const requestedSections = [
	...argValues('--section'),
	...argValues('--sections').flatMap((raw) =>
		raw
			.split(',')
			.map((tipo) => tipo.trim())
			.filter((tipo) => tipo !== ''),
	),
];
const batchSize = intArg('--batch-size');
const maxLevelsFlag = intArg('--max-levels');
const skipPublicationStateCheck = flagsPresent.has('--skip-publication-state-check');
const principalId = intArg('--principal') ?? -1;
const mediaMarkers = argValue('--media-markers') ?? 'off';
if (mediaMarkers !== 'off' && mediaMarkers !== 'real') {
	console.error(`--media-markers must be 'off' or 'real' (got ${JSON.stringify(mediaMarkers)})`);
	process.exit(2);
}
const jsonPath = argValue('--run-info') ?? argValue('--json');

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

// The PHP migration writes dd_ontology OUT OF PROCESS, so nothing in this
// process has seen an invalidation event: bump the revision by hand before
// compiling, or a plan cached earlier in this same process would be served.
bumpOntologyRevision();

// THE PUBLICATION GUARD (re-review INFO-6): tool_diffusion's
// EXCLUDE_DIFFUSION_ELEMENTS withdraws an element from publication at every door
// that starts a run (src/diffusion/api/excluded_elements.ts) — this harness is
// one, so it asks the same question before compiling or writing anything. The
// v6 twin never consulted the list (v6 filtered it in the tool UI only), so a
// parity run of a listed element is refused here: remove it from the list on the
// harness database first. A malformed list refuses as tool.config_invalid.
try {
	await assertPublishableElement(elementTipo);
} catch (error) {
	const code = isDedaloError(error) ? error.code : 'internal.unexpected';
	console.error(
		`REFUSED (${code}): element '${elementTipo}' may not be published on this installation.\n` +
			`  ${error instanceof Error ? error.message : String(error)}\n` +
			'  tool_diffusion EXCLUDE_DIFFUSION_ELEMENTS (Tools configuration, dd996) governs every\n' +
			'  publication door, this harness included.',
	);
	await closeDatabasePool();
	process.exit(2);
}

const plan: PublicationPlan = await getCompiledPlan(elementTipo);

if (plan.target.kind !== 'table') {
	console.error(
		`REFUSED: element '${elementTipo}' publishes to a '${plan.target.kind}' target ` +
			`(format '${plan.format}'). This harness drives the TABLE pipeline only — the ` +
			'v6/v7 parity loop diffs published MariaDB tables.',
	);
	await closeDatabasePool();
	process.exit(2);
}

// --- TARGET DATABASE SAFETY BELT ---
// There is no runtime redirection in the writer: session.open(plan) connects to
// plan.target.database and immediately issues DDL + upserts. So the ONLY guard is
// to read where this element actually writes and refuse when that is not the
// database the operator declared. Both names are printed, like the v6 twin does.
if (plan.target.database !== expectedDatabase) {
	console.error(
		'REFUSING TO RUN.\n' +
			`  element '${elementTipo}' publishes into: ${plan.target.database}\n` +
			`  expected database (--database)   : ${expectedDatabase}\n` +
			'  These must be identical. v7 writes to the database declared in the ontology;\n' +
			"  there is no runtime redirection. Point --database/HARNESS_DB at the element's\n" +
			'  database, or point the element at a scratch database, before re-running.',
	);
	await closeDatabasePool();
	process.exit(2);
}

const planSectionTipos = plan.sections.map((section) => section.sectionTipo);
const sectionTipos = requestedSections.length > 0 ? [...requestedSections] : planSectionTipos;
const unknownSections = sectionTipos.filter((tipo) => !planSectionTipos.includes(tipo));
if (unknownSections.length > 0) {
	console.error(
		`REFUSED: element '${elementTipo}' has no plan section(s): ${unknownSections.join(', ')}. ` +
			`Plan sections: ${planSectionTipos.join(', ')}`,
	);
	await closeDatabasePool();
	process.exit(2);
}
// Selected sections ALWAYS run in ASCII order of section tipo, whatever order
// --section was given in — and NOT in plan order. The v6 twin iterates the keys
// of its tables map after sort(), and execution order is the concrete mechanism
// that decides WHICH projection of a record survives, given the first-write-wins
// (v6) vs last-write-wins (v7) divergence documented in the module header. Two
// engines walking the same sections in different orders would manufacture diffs
// that say nothing about the parsers under test.
const selectedSections = plan.sections
	.filter((section) => sectionTipos.includes(section.sectionTipo))
	.sort((a, b) => (a.sectionTipo < b.sectionTipo ? -1 : a.sectionTipo > b.sectionTipo ? 1 : 0));

const maxLevels = maxLevelsFlag ?? plan.recursion.maxLevels;

// ---------------------------------------------------------------------------
// Operator print-out (BEFORE anything is written)
// ---------------------------------------------------------------------------

console.log(`element:      ${plan.elementTipo}  (planId ${plan.planId}, format '${plan.format}')`);
console.log(
	`target:       ${plan.target.kind} → ${plan.target.database} (expected '${expectedDatabase}' — belt passed)`,
);
// LOAD-BEARING: the v6 install resolves DEDALO_DIFFUSION_LANGS to the project
// default langs while the v7 .env may carry a shorter list. Printing the
// effective policy here is how the operator SEES that mismatch, instead of
// meeting it later as an unexplained N× row-count difference in the diff.
console.log(
	`langPolicy:   ${plan.langPolicy.langs.length} lang(s) [${plan.langPolicy.langs.join(', ')}], ` +
		`mainLang ${plan.langPolicy.mainLang ?? '(none)'}`,
);
// Same reason as langPolicy: v6's DEDALO_MEDIA_URL and v7's derived
// '/dedalo/<mediaDir>' are configured independently, and a mismatch shows up in
// the dump as every media column differing by its prefix. Print it, don't discover it.
const mediaUrl = `/dedalo/${config.mediaDir}`;
console.log(`mediaUrl:     ${mediaUrl}  (root ${config.media.rootPath ?? '(unconfigured)'})`);
console.log(
	`maxLevels:    ${maxLevels}${maxLevelsFlag === null ? ' (plan default)' : ' (--max-levels)'}`,
);
console.log(`runStartedAt: ${runStartedAt}`);
console.log(
	`principal:    ${principalId}${principalId === -1 ? ' (superuser — unscoped selection)' : ''}` +
		`, publication-state gate ${skipPublicationStateCheck ? 'SKIPPED' : 'enforced'}`,
);
console.log(
	`sections (${selectedSections.length} of ${plan.sections.length}, ASCII order of section tipo):`,
);
for (const section of selectedSections) {
	console.log(
		`  ${section.sectionTipo} -> ${section.tableName} (${section.fields.length} field(s))`,
	);
}
console.log(`warnings:     ${plan.warnings.length}`);
for (const warning of plan.warnings) console.log(`  ! ${warning}`);

// ---------------------------------------------------------------------------
// Media markers
// ---------------------------------------------------------------------------

let markerBase: string | null = null;
if (mediaMarkers === 'real') {
	console.log('markers:      REAL media tree (--media-markers real)');
} else {
	markerBase = await mkdtemp(join(tmpdir(), 'dedalo_diffusion_markers_'));
	overrideMediaIndexBaseForTests(markerBase);
	console.log(
		`markers:      redirected to ${markerBase} (live media tree untouched; removed on exit)`,
	);
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

interface SectionSummary {
	sectionTipo: string;
	tableName: string;
	batches: number;
	rows: number;
	unpublished: number;
	errors: string[];
	/** The section aborted mid-publish; its table holds a PARTIAL publication. */
	failed?: boolean;
}

/**
 * The run's effective langs. The projection itself is driven by
 * plan.langPolicy (per-lang rows), NOT by these — this scope only feeds the
 * backstop accessors (labels, page globals) that would otherwise fall back to
 * the installation defaults mid-run. mainLang is the plan's own notion of "the"
 * language; the installation default is the last resort for a plan with none.
 */
const runLangs: RequestLangs = {
	applicationLang:
		// lang-law-exempt(harness.publish.application): a CLI run has no request — the plan's langs first, the install default only as the documented last resort
		plan.langPolicy.mainLang ?? plan.langPolicy.langs[0] ?? config.menu.applicationLang,
	// lang-law-exempt(harness.publish.data): a CLI run has no request — the plan's langs first, the install default only as the documented last resort
	dataLang: plan.langPolicy.mainLang ?? plan.langPolicy.langs[0] ?? config.menu.dataLang,
};

const principal: Principal = await resolvePrincipal(principalId);
const writer = getDiffusionWriter(plan.format);
let session: Awaited<ReturnType<typeof writer.open>> | null = null;
const sectionSummaries: SectionSummary[] = [];
const allErrors: string[] = [];
let exitCode = 0;

// EVERY exit path goes through the finally below — process.exit() inside the try
// or the catch would skip it, leaving the MariaDB target pools and the Postgres
// pool open (the process then dies on an unhandled rejection AFTER the tables
// were already written) and leaving the marker directory behind.
try {
	// writer.open() probes the target database and throws a loud
	// DiffusionTargetUnreachableError for an unreachable or ungranted MariaDB —
	// which is exactly why it belongs INSIDE the guarded region: opening it above
	// would leak the marker directory and both pools on the commonest failure.
	session = await writer.open(plan);
	// Local non-null binding: `session` stays nullable so the catch/finally can guard it,
	// but TS cannot narrow it inside the nested async closures below.
	const activeSession = session;

	// Schema ONCE for the whole plan, before any row transaction: MariaDB DDL
	// auto-commits, so it must never interleave with a batch transaction.
	await activeSession.ensureSchema();

	// One ALS scope for the whole run, like the request chokepoint opens per
	// RQO: leaf resolvers that read the current principal / current langs as a
	// backstop must see this run's identity, not the installation defaults.
	await runWithRequestContext(
		{
			principal,
			session: null,
			requestId: `diffusion_harness_publish:${elementTipo}:${runStartedAt}`,
			clientIp: '127.0.0.1',
		},
		() =>
			runWithRequestLangs(runLangs, async () => {
				for (const section of selectedSections) {
					const summary: SectionSummary = {
						sectionTipo: section.sectionTipo,
						tableName: section.tableName,
						batches: 0,
						rows: 0,
						unpublished: 0,
						errors: [],
					};
					sectionSummaries.push(summary);
					console.log(`\n[publish] ${section.sectionTipo} -> ${section.tableName}`);

					// PER-SECTION ERROR CONTAINMENT. A publish error is fatal to ITS SECTION
					// only: without this the first bad column (a value longer than the width
					// the v6 ontology declared, say) aborts the whole run and hides the state
					// of every other table, so each defect costs a full re-run to find the
					// next. The run still exits non-zero, failed sections are listed loudly
					// and flagged in the run info, and the comparator's own guards (non-empty
					// snapshot assertion, NOTHING COMPARED) keep a partially published table
					// from ever being read as parity.
					try {
						// NO sqo: the resolver's default selection ({ section_tipo }) means
						// EVERY record of the section, which is what a full-element v6 run does.
						const batches = resolvePublication(plan, {
							sectionTipo: section.sectionTipo,
							runStartedAt,
							...(batchSize !== null ? { batchSize } : {}),
							maxLevels,
							skipPublicationStateCheck,
							principal,
						});
						for await (const batch of batches) {
							if (batch.rows.length > 0) {
								await activeSession.writeRows(batch.section, batch.rows);
								summary.rows += batch.rows.length;
							}
							if (batch.unpublishIds.length > 0) {
								await activeSession.removeRecords(batch.section, batch.unpublishIds);
								summary.unpublished += batch.unpublishIds.length;
							}
							for (const fieldError of batch.errors) {
								const message = `${fieldError.sectionTipo}:${fieldError.sectionId} ${fieldError.columnName}: ${fieldError.message}`;
								summary.errors.push(message);
								allErrors.push(message);
								console.error(`  ERROR ${message}`);
							}
							summary.batches += 1;
							console.log(
								`  batch ${summary.batches}: level ${batch.level}, ${batch.section.sectionTipo} → ${batch.section.tableName}, ` +
									`${batch.rows.length} row(s), ${batch.unpublishIds.length} unpublish, cursor ${batch.cursor}`,
							);
						}
						console.log(
							`  DONE ${section.sectionTipo}: ${summary.batches} batch(es), ${summary.rows} row(s), ` +
								`${summary.unpublished} unpublished, ${summary.errors.length} error(s)`,
						);
					} catch (sectionError) {
						const raw = sectionError instanceof Error ? sectionError.message : String(sectionError);
						const message = `${section.sectionTipo} -> ${section.tableName}: ${raw}`;
						summary.errors.push(message);
						summary.failed = true;
						allErrors.push(message);
						console.error(`  SECTION FAILED ${message}`);
						// A width overflow names the column but never the value, which is the one
						// thing needed to diagnose it.
						const overflow = /Data too long for column '([^']+)'/.exec(raw);
						if (overflow !== null) {
							console.error(
								`  the value v7 resolved for '${overflow[1]}' exceeds the width the v6 ontology declared for it`,
							);
						}
					}
				}
			}),
	);

	const runSummary = await activeSession.close();
	allErrors.push(...runSummary.errors);

	console.log('\ntables written:');
	for (const entry of runSummary.tables) {
		console.log(
			`  ${entry.table_name}: ${entry.records_affected} affected, ${entry.records_count} total`,
		);
	}
	const totals = {
		sections: sectionSummaries.length,
		batches: sectionSummaries.reduce((sum, entry) => sum + entry.batches, 0),
		rows: sectionSummaries.reduce((sum, entry) => sum + entry.rows, 0),
		unpublished: sectionSummaries.reduce((sum, entry) => sum + entry.unpublished, 0),
		errors: allErrors.length,
	};
	console.log(
		`\nTOTAL: ${totals.sections} section(s), ${totals.batches} batch(es), ${totals.rows} row(s), ` +
			`${totals.unpublished} unpublished, ${totals.errors} error(s)`,
	);

	if (jsonPath !== null && jsonPath !== '') {
		await Bun.write(
			jsonPath,
			`${JSON.stringify(
				{
					element: plan.elementTipo,
					planId: plan.planId,
					format: plan.format,
					target: plan.target,
					expectedDatabase,
					langPolicy: plan.langPolicy,
					// The v6 install and this one derive their media prefix from separate
					// config, and every media column carries it: report it so the comparator
					// can attribute a whole-column diff instead of flagging 2364 rows.
					mediaUrl,
					mediaRootPath: config.media.rootPath,
					maxLevels,
					runStartedAt,
					principal: principalId,
					skipPublicationStateCheck,
					batchSize,
					markerBase,
					mediaMarkers,
					// ensureSchema() is deliberately PLAN-WIDE (frontier hops write into
					// sections that were never selected), so a restricted run CREATES tables
					// it never fills, while v6 creates a table on its first row only. Emitting
					// both lists lets the comparator classify those as 'created but not
					// selected' instead of meeting an empty table it has to guess about —
					// and empty==empty must never be read as parity.
					planSections: planSectionTipos,
					executedSectionOrder: selectedSections.map((section) => section.sectionTipo),
					sections: sectionSummaries,
					tables: runSummary.tables,
					warnings: plan.warnings,
					errors: allErrors,
					totals,
				},
				null,
				2,
			)}\n`,
		);
		console.log(`run info: ${jsonPath}`);
	}

	exitCode = allErrors.length === 0 ? 0 : 1;
} catch (error) {
	await session?.abort().catch(() => {});
	console.error(`\nFAILED: ${error instanceof Error ? error.stack : String(error)}`);
	exitCode = 1;
} finally {
	if (markerBase !== null) {
		await rm(markerBase, { recursive: true, force: true }).catch(() => {});
	}
	await closeAllTargetPools().catch(() => {});
	await closeDatabasePool().catch(() => {});
}

process.exit(exitCode);
