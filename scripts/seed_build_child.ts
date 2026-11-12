/**
 * The install seed compiler's SCRATCH-ENGINE CHILD (src/core/install/seed_build.ts).
 *
 *   bun run scripts/seed_build_child.ts <plan.json>
 *
 * Spawned by the compiler only — never by hand. It runs the ENGINE (pool-bound
 * doors: the ontology update door's per-package body, installDbFromSeed, the
 * boot migrations, the ontology/hierarchy inspectors) against a scratch
 * database the compiler created, because those doors read `config.db` and the
 * compiler's own process is bound to the installation. The compiler sets
 * DB_NAME (process env wins over ../private/.env — src/config/env.ts readEnv).
 *
 * THE GUARD, before anything that writes: the bound database must be the
 * plan's, must carry `dedalo_seed_build_marker`, and must not be the
 * installation's own DB_NAME. A mis-set environment can therefore never point
 * these doors at an installation.
 *
 * Tasks (plan.task):
 *  - compile: over the parser scaffold the compiler loaded, import every
 *    package's rows and derive dd_ontology to a fixpoint; then apply the release
 *    ontology packages in full (ontology_update.ts
 *    importOntologyPackage — the update's own per-file body), the private
 *    lists; derive dd_ontology; every shipped TLD
 *    must come out in sync. The clock is PINNED to the release date, so every
 *    stamp the engine writes is the same on every machine (reproducible seed).
 *  - verify: the whole fresh install of a compiled seed (installDbFromSeed →
 *    completeFreshInstall), the boot migrations, then the checks.
 * Answers ONE JSON line last on stdout: {ok, checks, errors}.
 */

import { readFileSync } from 'node:fs';
import type { ChildAnswer, CompilePlan, VerifyPlan } from '../src/core/install/seed_build.ts';

const answer: ChildAnswer = { ok: false, checks: [], errors: [] };

function finish(code: number): never {
	console.log(JSON.stringify(answer));
	process.exit(code);
}

/** The guard's refusal: answered, never thrown — nothing below it runs. */
function refuse(reason: string): never {
	answer.errors.push(`refused: ${reason}`);
	finish(1);
}

/** Every `new Date()` / `Date.now()` answers the release instant (compile only). */
function pinClock(iso: string): void {
	const fixed = new Date(iso).getTime();
	const RealDate = Date;
	class PinnedDate extends RealDate {
		constructor(...args: unknown[]) {
			if (args.length === 0) super(fixed);
			else super(...(args as [string | number | Date]));
		}
		static override now(): number {
			return fixed;
		}
	}
	globalThis.Date = PinnedDate as DateConstructor;
}

async function guard(plan: CompilePlan | VerifyPlan): Promise<void> {
	const { config } = await import('../src/config/config.ts');
	if (config.db.database !== plan.database) {
		refuse(`bound to '${config.db.database}', plan names '${plan.database}'`);
	}
	// The child's own private dir is an empty scratch dir (seed_build.ts
	// childEnv), so the installation's DB_NAME comes from the parent's plan.
	if (plan.installationDatabase !== null && plan.installationDatabase === plan.database) {
		refuse(`'${plan.database}' is the installation's own database`);
	}
	const { connFromConfig, runPsql } = await import('../src/core/install/pg_exec.ts');
	const { SEED_BUILD_MARKER_TABLE } = await import('../src/core/install/seed_sources.ts');
	const probe = await runPsql(connFromConfig(), [
		'-X',
		'-tAc',
		`SELECT to_regclass('public.${SEED_BUILD_MARKER_TABLE}') IS NOT NULL`,
	]);
	if (probe.exitCode !== 0 || probe.stdout.trim() !== 't') {
		refuse(`'${plan.database}' carries no ${SEED_BUILD_MARKER_TABLE} — refusing to write`);
	}
}

/** Every listed TLD's dd_ontology equals the projection of its source records. */
async function requireInSync(tlds: readonly string[]): Promise<void> {
	const { inspectOntology } = await import('../src/core/ontology/ontology_state.ts');
	for (const tld of tlds) {
		const state = await inspectOntology(tld);
		if (state.inSync && state.storedNodes > 0) {
			answer.checks.push(`ontology ${tld} in sync (${state.storedNodes} nodes)`);
		} else {
			answer.errors.push(
				`ontology ${tld} NOT in sync: ${state.storedNodes} stored, ${state.matrixNodes} source, ${state.drift.length} drift item(s), main node ${state.mainNodeOk ? 'ok' : 'missing'}`,
			);
		}
	}
}

async function compile(plan: CompilePlan): Promise<void> {
	pinClock(plan.clock);
	const { connFromConfig } = await import('../src/core/install/pg_exec.ts');
	const { importOntologyPackage, deriveOntologyPackages } = await import(
		'../src/core/ontology/ontology_update.ts'
	);
	const { importPrivateListsFile } = await import('../src/core/ontology/data_io_import.ts');
	const conn = connFromConfig();
	// Pass 1 — BOOTSTRAP: the rows of every package, then the derive. An empty
	// database has no ontology to resolve the registry section (ontology35)
	// with; after this pass it has the release's.
	for (const file of plan.packages) {
		const rows = await importOntologyPackage(file, -1, conn, { provision: false });
		answer.errors.push(...rows.errors);
		if (rows.fatal !== null) return;
	}
	// Derive TWICE: the first pass parses over the SCAFFOLD's component/model
	// rows, the second over the packages' own projection — the fixpoint the
	// in-sync check below proves (a scaffold row the packages do not produce is
	// stale drift, and refused).
	for (let pass = 1; pass <= 2; pass++) {
		const derived = await deriveOntologyPackages(plan.packages, -1);
		answer.errors.push(...derived.errors);
		if (answer.errors.length > 0) return;
	}
	answer.checks.push(`bootstrap: ${plan.packages.length} packages' rows + derive to a fixpoint`);
	// Pass 2 — THE UPDATE DOOR, in full, on top: registry record + root node +
	// rows, per package — what a client's ontology update does.
	for (const file of plan.packages) {
		const imported = await importOntologyPackage(file, -1, conn);
		answer.errors.push(...imported.errors);
		if (imported.fatal !== null) return;
		answer.checks.push(`package ${file.tld} applied`);
	}
	const lists = await importPrivateListsFile(plan.privateListsPath, conn);
	if (lists.ok !== true) {
		answer.errors.push(...lists.errors, lists.msg);
		return;
	}
	answer.checks.push('private lists imported');
	const derived = await deriveOntologyPackages(plan.packages, -1);
	answer.errors.push(...derived.errors);
	await requireInSync(plan.driftTlds);
}

async function verify(plan: VerifyPlan): Promise<void> {
	const { installDbFromSeed } = await import('../src/core/install/db_restore.ts');
	const restored = await installDbFromSeed(undefined, plan.seedPath);
	answer.checks.push(restored.msg);
	const { runMigrations, runOnlineMigrations } = await import('../install/db/migrate.ts');
	const boot = await runMigrations();
	const online = await runOnlineMigrations();
	answer.checks.push(
		`boot migrations: ${boot.applied.length} applied, ${boot.skipped} skipped; online: ${online.applied.length} applied`,
	);
	await requireInSync(plan.driftTlds);
	// The search stores ship EMPTY (seed_build.ts SEED_EMPTY_STORES); the boot
	// self-heal must fill them from the shipped rows, in THIS database's locale.
	const { declaredSearchStoreDerivations, ensureSearchStores, readSearchStoreStamp } = await import(
		'../src/core/db/db_assets.ts'
	);
	await ensureSearchStores();
	const { sql } = await import('../src/core/db/postgres.ts');
	for (const { store, stamp } of declaredSearchStoreDerivations()) {
		const [row] = (await sql.unsafe(`SELECT count(*)::int AS n FROM "${store}"`, [])) as {
			n: number;
		}[];
		if ((row?.n ?? 0) > 0)
			answer.checks.push(`${store} filled by the boot self-heal (${row?.n} rows)`);
		else answer.errors.push(`${store} still empty after the boot self-heal`);
		// T1-25: the fresh install stamps what it filled (completeFreshInstall), so
		// the first update re-derives nothing.
		const found = await readSearchStoreStamp(store);
		if (found === stamp) answer.checks.push(`${store} stamped with its declared derivation`);
		else answer.errors.push(`${store} not stamped by the install (${found ?? 'no stamp'})`);
	}
	const lg = (await sql.unsafe(
		`SELECT relation->'hierarchy4'->0->>'section_id' AS active FROM matrix_hierarchy_main
		 WHERE section_tipo = 'hierarchy1' AND lower(string->'hierarchy6'->0->>'value') = 'lg'`,
		[],
	)) as { active: string | null }[];
	if (lg[0]?.active === '1') answer.checks.push('lg (Languages) active');
	else
		answer.errors.push(
			`lg not active after the install (hierarchy4 → ${lg[0]?.active ?? 'no record'})`,
		);
	const { setRootPassword } = await import('../src/core/install/root_pw.ts');
	await setRootPassword(plan.rootPassword);
	const root = (await sql.unsafe(
		`SELECT string->'dd133'->0->>'value' AS hash FROM matrix_users WHERE section_tipo = 'dd128' AND section_id = -1`,
		[],
	)) as { hash: string | null }[];
	const hash = root[0]?.hash ?? '';
	if (hash !== '' && (await Bun.password.verify(plan.rootPassword, hash))) {
		answer.checks.push('root password set and verified');
	} else {
		answer.errors.push('root password did not verify after the install');
	}
}

const planPath = process.argv[2];
if (planPath === undefined) {
	answer.errors.push('usage: seed_build_child.ts <plan.json>');
	finish(2);
}
const plan = JSON.parse(readFileSync(planPath, 'utf8')) as CompilePlan | VerifyPlan;
try {
	await guard(plan);
	if (plan.task === 'compile') await compile(plan);
	else await verify(plan);
	answer.ok = answer.errors.length === 0;
} catch (error) {
	// The engine's own sentence when it has one; the class name otherwise.
	answer.errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}
finish(answer.ok ? 0 : 1);
