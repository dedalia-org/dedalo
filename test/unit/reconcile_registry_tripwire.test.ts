/**
 * RECONCILE REGISTRY — the census tripwire (audit 2026-08-26 S-10).
 *
 * THE INVARIANT. Every module that COMPARES TWO STORES and repairs the
 * disagreement is a registered `ReconcileDefinition` (src/core/reconcile/
 * registry.ts) with every facet — two distinct stores, a description, a
 * schedule, a `run` — or sits in the ENUMERATED exemption below with a reason.
 * An eighth reconcile cannot land as an eighth shape: a widget action here, a
 * CLI there, a boot fire-and-forget, an injected callback.
 *
 * HOW THE CENSUS IS DERIVED (never a hand list). Every `.ts` under src/ and
 * scripts/ (tests excluded) is a hit when, on comment-stripped source, it
 * DECLARES a function or method named `reconcile…` / `inspect…`, or when its
 * basename says `reconcile` / `repair`. A hit must be named in some registered
 * definition's `sources`, or be exempt. The classifier is exercised on a
 * synthetic offender (positive control) so a broken regex cannot go green, and
 * the corpus carries a floor so an empty walk cannot either.
 *
 * WHAT IS ALSO PINNED. The registry's assembly is COMPLETE (its live names
 * equal REGISTERED_NAMES, in order); the three doors exist and reach the
 * catalog (the `reconcile_status` widget with its `run_reconcile` action, the
 * `scripts/reconcile.ts` shell, the server boot + SIGTERM stop of the
 * scheduler); the gauge lists every name; every `sources` path exists; and the
 * scheduled applies are exactly media_index, media_copy and publication_probe, each with a reason.
 *
 * Hermetic: the catalog is imported (module wiring only, no query is issued);
 * the behavioural half is reconcile_registry_native.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ALL_WIDGET_MODULES } from '../../src/core/area_maintenance/widgets/registry.ts';
import { loadAllReconciles, registerAllReconciles } from '../../src/core/reconcile/catalog.ts';
import { POST_RESTORE_PLAN } from '../../src/core/reconcile/post_restore.ts';
import {
	REGISTERED_NAMES,
	type ReconcileDefinition,
	reconcileGauge,
	validateDefinition,
} from '../../src/core/reconcile/registry.ts';
import { stripComments } from '../helpers/strip_comments.ts';
import { WRITE_PATH_CORPUS_FLOOR, writePathSourceFiles } from '../helpers/write_path_corpus.ts';

const ROOT = join(import.meta.dir, '..', '..');

/**
 * ENUMERATED exemptions — a reconcile-shaped hit that is NOT a two-store data
 * reconcile, with the reason. SHRINK-ONLY: an entry that no longer hits is a
 * stale exemption and reds the gate; a new hit needs a definition, not a line
 * here, unless it genuinely has no second store.
 */
const EXEMPT: Readonly<Record<string, string>> = {
	'src/core/install/db_restore.ts':
		"inspectTargetDatabase: the terminal installer's PREFLIGHT over ONE store (the target database's own catalog — objects, extensions, stamp, sessions); it reconciles nothing and has no second store",
	'src/core/install/executor.ts':
		"ExecutorHost.inspectDatabase: the injectable seam over db_restore.ts inspectTargetDatabase (one store, the target's catalog) — the executor's preflight, not a two-store comparison",
	'src/core/media/jobs.ts':
		'reconcileProcessFiles: a PROCESS-LIFETIME sweep of pfile job markers against the live process table at boot — one store (the pfile dir) against the process itself, not a second store',
	'src/core/media/protection.ts':
		'reconcileAuthMarkers: SESSION-LIFETIME auth markers pruned against the live session set — cookie hygiene inside one subsystem, no second persistent store',
	'src/core/media/tools/files_info_persist.ts':
		'reconcileStoredFilesInfo: the PER-RECORD kernel the media tools call on one component (create-vs-refresh rule); the cross-corpus sweep over the same kernel is the registered `files_info` definition (files_info_reconcile.ts)',
	'src/core/db/db_assets.ts':
		'inspectSearchStores: a SCHEMA-PROVISIONING probe (declared triggers/tables vs the catalog), converged by ensureSearchStores at boot (DEC-19) — provisioning, not a data-store pair. reconcileSearchStoreDerivation: a store re-derived when its derivation STAMP is older than the code constant (a version check, not a second data store), run only by the update run (run/ancillary.ts)',
	'src/core/update/run/ancillary.ts':
		"the update run's ancillary SEQUENCER (reconcileTools / reconcileSearchStores / reconcileMediaRules): each step only calls an existing door — importTools, the registered observer_mirrors reconcile, db_assets.ts ensureSearchStores + reconcileSearchStoreDerivation, writeRuleFiles — in a fixed order after an update; it compares no two stores of its own",
	'scripts/repair_tm_timestamps.ts':
		'ONE-STORE data repair (matrix_time_machine timestamps rewritten in place under DEC-03), no second store is compared',
	'scripts/repair_geolocation_studio_default.ts':
		'ONE-STORE data repair (the geo column rewritten under the v6 migration rule), no second store is compared',
	'src/core/reconcile/registry.ts':
		'THE REGISTRY ITSELF (reconcileGauge is the ops gauge provider, not a reconcile)',
	'src/core/security/session_media.ts':
		"reconcileIsSafeHere: a configuration PREDICATE guarding the auth-marker prune (is MEDIA_PATH this process's own?) — decides whether protection.ts may prune, compares no stores",
	'scripts/repair_tm_test_tail.ts':
		'ONE-STORE data repair (matrix_time_machine timestamps of a measured id span, DEC-03), no second store is compared',
	'scripts/test_db_setup.ts':
		'inspectDropTarget: the suite-database builder asking a database for its own dedalo_test_marker before dropping it — a refusal probe, not a store comparison',
	'src/core/area_maintenance/widgets/reconcile_status.ts':
		'the maintenance DOOR onto the registry — lists and runs definitions, compares nothing',
	'scripts/reconcile.ts':
		'the CLI DOOR onto the registry — lists and runs definitions, compares nothing',
	'scripts/ci/image_release.ts':
		'inspectDigest: the RELEASE pipeline asking a container registry what digest one image reference resolves to (the tag-immutability refusal) — a CI probe of a remote manifest, no installation data store is compared or converged',
};

/** A declaration of a function/method named reconcileX / inspectX. */
const DECLARATION = /\bfunction\s+(reconcile|inspect)[A-Z]\w*\s*(?:<[^>]*>)?\s*\(/;
/** A class method: indented name, its parameter list, then the body brace. */
const METHOD =
	/^\s+(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(reconcile|inspect)[A-Z]\w*\s*\([^)]*\)\s*(?::\s*[^{]+)?\{/m;
const BASENAME = /reconcile|repair/i;

/** The classifier: is this source (at this path) reconcile-shaped? */
function isReconcileShaped(relPath: string, source: string): string | null {
	if (BASENAME.test(basename(relPath))) return `basename '${basename(relPath)}'`;
	const code = stripComments(source, { blankStrings: true });
	const declaration = DECLARATION.exec(code) ?? METHOD.exec(code);
	if (declaration !== null) return `declares ${declaration[0].trim()}`;
	return null;
}

interface Hit {
	path: string;
	why: string;
}

function walkCorpus(): { scanned: number; hits: Hit[] } {
	const hits: Hit[] = [];
	let scanned = 0;
	// The corpus is THE registered write-path lister (src/ + tools/ + scripts/):
	// roots are declared there, never chosen in this file (census_derivation).
	for (const path of writePathSourceFiles()) {
		if (path.endsWith('.d.ts')) continue;
		scanned++;
		const why = isReconcileShaped(path, readFileSync(join(ROOT, path), 'utf8'));
		if (why !== null) hits.push({ path, why });
	}
	return { scanned, hits: hits.sort((a, b) => a.path.localeCompare(b.path)) };
}

const CORPUS = walkCorpus();
const REGISTERED = await registerAllReconciles();
const ALL_RECONCILES = await loadAllReconciles();
const SOURCES = new Set(REGISTERED.flatMap((definition) => definition.sources));

describe('reconcile registry census (S-10)', () => {
	test('the classifier fires on a synthetic offender (positive control) and stays quiet on prose', () => {
		expect(
			isReconcileShaped(
				'src/x/foo.ts',
				'export async function reconcileFooBar(): Promise<void> {}',
			),
		).not.toBeNull();
		expect(
			isReconcileShaped('src/x/foo.ts', 'class X {\n\tasync inspectThing(a: string) {}\n}'),
		).not.toBeNull();
		expect(isReconcileShaped('src/x/foo_reconcile.ts', '')).not.toBeNull();
		expect(isReconcileShaped('src/x/foo_repair.ts', '')).not.toBeNull();
		// A comment or a string that merely TALKS about a reconcile is not one.
		expect(
			isReconcileShaped(
				'src/x/foo.ts',
				'// reconcileFooBar(\n/* inspectX( */\nconst s = "reconcileY(";',
			),
		).toBeNull();
		// Calling one is not declaring one.
		expect(isReconcileShaped('src/x/foo.ts', 'const r = await reconcileFooBar();')).toBeNull();
	});

	test('the corpus walk is real: a floor on files scanned and on hits', () => {
		expect(CORPUS.scanned).toBeGreaterThan(WRITE_PATH_CORPUS_FLOOR);
		expect(CORPUS.hits.length).toBeGreaterThan(5);
	});

	test('every reconcile-shaped module is a registered definition source, or an ENUMERATED exemption', () => {
		const unaccounted = CORPUS.hits.filter(
			(hit) => !SOURCES.has(hit.path) && EXEMPT[hit.path] === undefined,
		);
		expect(
			unaccounted.map((hit) => `${hit.path} (${hit.why})`),
			'A module that compares two stores must export a ReconcileDefinition (registered in src/core/reconcile/catalog.ts, its path in `sources`) — or carry a reasoned entry in EXEMPT above if it genuinely has no second store.',
		).toEqual([]);
	});

	test('the exemption list is shrink-only honest: every entry still hits, and none is also a registered source', () => {
		const hitPaths = new Set(CORPUS.hits.map((hit) => hit.path));
		const stale = Object.keys(EXEMPT).filter((path) => !hitPaths.has(path));
		expect(
			stale,
			'stale exemption: the file no longer looks like a reconcile — delete the entry',
		).toEqual([]);
		const doubled = Object.keys(EXEMPT).filter((path) => SOURCES.has(path));
		expect(doubled, 'a registered source needs no exemption').toEqual([]);
		for (const [path, reason] of Object.entries(EXEMPT)) {
			expect(reason.length, `${path}: exemption reason too short`).toBeGreaterThan(40);
		}
	});
});

describe('reconcile registry completeness (S-10)', () => {
	test('the live registry equals REGISTERED_NAMES exactly, in order, and every definition validates', () => {
		expect(REGISTERED.map((definition) => definition.name)).toEqual([...REGISTERED_NAMES]);
		expect(ALL_RECONCILES.map((definition) => definition.name)).toEqual([...REGISTERED_NAMES]);
		expect(REGISTERED_NAMES.length).toBeGreaterThanOrEqual(8);
		for (const definition of REGISTERED) expect(() => validateDefinition(definition)).not.toThrow();
	});

	test('every facet is present and honest: two DISTINCT stores, a sentence, a schedule, a run, existing sources', () => {
		for (const definition of REGISTERED) {
			expect(definition.stores[0]).not.toBe(definition.stores[1]);
			expect(definition.description.length).toBeGreaterThan(40);
			expect(typeof definition.run).toBe('function');
			expect(['operator', 'boot', 'interval']).toContain(
				typeof definition.schedule === 'string' ? definition.schedule : 'interval',
			);
			for (const source of definition.sources) {
				expect(
					existsSync(join(ROOT, source)),
					`${definition.name}: source '${source}' does not exist`,
				).toBe(true);
				expect(source.startsWith('src/') || source.startsWith('scripts/')).toBe(true);
			}
		}
	});

	test('the OWNER module of each definition is a registered source (the definition lives next to its logic)', () => {
		// The module that exports the definition constant must list itself: the
		// census maps a hit through `sources`, so a definition defined in a file
		// that is not among its own sources would leave its owner unaccounted.
		const owners: Record<string, string> = {
			counters_media: 'src/core/media/counter_reconcile.ts',
			files_info: 'src/core/media/files_info_reconcile.ts',
			observer_mirrors: 'src/core/section/record/observer_reconcile.ts',
			media_index: 'src/diffusion/api/reconcile.ts',
			rag_index: 'src/ai/rag/reconcile.ts',
			ontology: 'src/core/ontology/ontology_state.ts',
			ontology_identifiers: 'src/core/ontology/identifier_grammar.ts',
			hierarchy: 'src/core/ontology/hierarchy_state.ts',
			public_tier: 'src/diffusion/api/reconcile.ts',
			publication_apis: 'src/core/publication_host/api_reconcile.ts',
			media_copy: 'src/diffusion/api/reconcile.ts',
			publication_probe: 'src/core/publication_host/probe.ts',
			rich_text_images: 'src/core/media/rich_text_image_reconcile.ts',
			web_image_exposure: 'src/diffusion/api/reconcile.ts',
			portal_declared_order: 'src/core/relations/declared_order_reconcile.ts',
			ddo_self_depth: 'src/core/relations/request_config/self_depth_check.ts',
		};
		for (const definition of REGISTERED) {
			const owner = owners[definition.name];
			expect(owner, `${definition.name}: add its owner module to this map`).toBeDefined();
			expect(definition.sources).toContain(owner as string);
			const ownerSource = readFileSync(join(ROOT, owner as string), 'utf8');
			expect(ownerSource).toMatch(/export const [A-Z_]+_RECONCILE: ReconcileDefinition = \{/);
		}
	});

	test('a scheduled APPLY is the exception with a reason — media_index (the pub/ derivation), media_copy (pub/ ∩ public files onto copy hosts), publication_probe (records an observation, repairs nothing)', () => {
		const auto = REGISTERED.filter((definition) => definition.autoApply !== undefined);
		expect(auto.map((definition) => definition.name)).toEqual([
			'media_index',
			'media_copy',
			'publication_probe',
		]);
		expect(
			(REGISTERED.find((definition) => definition.name === 'media_copy') as ReconcileDefinition)
				.schedule,
		).toEqual({ everyMs: expect.any(Number) });
		for (const definition of auto) {
			expect(definition.schedule).not.toBe('operator');
			expect((definition.autoApply as { reason: string }).reason.length).toBeGreaterThan(40);
		}
		// Whole-store walks and destructive re-projections are never scheduled.
		for (const name of [
			'counters_media',
			'files_info',
			'observer_mirrors',
			'ontology',
			'hierarchy',
			'public_tier',
			'rich_text_images',
			'portal_declared_order',
			'ddo_self_depth',
		]) {
			expect((REGISTERED.find((d) => d.name === name) as ReconcileDefinition).schedule).toBe(
				'operator',
			);
		}
		// Publication API lockstep (phase 4): an INTERVAL dry check — code is never
		// pushed by a timer (its apply is refused at the registry: the applyRefused facet).
		const lockstep = REGISTERED.find((d) => d.name === 'publication_apis') as ReconcileDefinition;
		expect(typeof lockstep.schedule).toBe('object');
		expect(lockstep.autoApply).toBeUndefined();
		expect(lockstep.applyRefused?.reason.length).toBeGreaterThan(40);
		expect(REGISTERED.filter((d) => d.applyRefused !== undefined).map((d) => d.name)).toEqual([
			'publication_apis',
			'ddo_self_depth',
		]);
		// The level >= 2 'self' check (decision (c)): a DEFINITION check whose correction
		// is a master-ontology edit — its apply is refused at the registry, with a reason.
		const selfDepth = REGISTERED.find((d) => d.name === 'ddo_self_depth') as ReconcileDefinition;
		expect(selfDepth.applyRefused?.reason.length).toBeGreaterThan(40);
		// An operator APPLY that changes what the public can read is root-only at the widget
		// door (E10): media_copy (a public machine), rich_text_images (makes login-only files
		// public) and web_image_exposure (makes published files private), each with a reason;
		// reconcile_status enforces it.
		const rootOnly = REGISTERED.filter((d) => d.applyRootOnly !== undefined);
		expect(rootOnly.map((d) => d.name)).toEqual([
			'media_copy',
			'rich_text_images',
			'web_image_exposure',
		]);
		for (const definition of rootOnly) {
			expect((definition.applyRootOnly as { reason: string }).reason.length).toBeGreaterThan(40);
		}
		const widgetSource = readFileSync(
			join(ROOT, 'src/core/area_maintenance/widgets/reconcile_status.ts'),
			'utf8',
		);
		expect(widgetSource).toContain('requireApplyPrincipal(name, apply, principal)');
	});

	test('publication_probe is an INTERVAL observation whose scheduled apply only records it (phase 6, P3)', () => {
		const probe = REGISTERED.find((definition) => definition.name === 'publication_probe');
		expect(probe, 'publication_probe must be registered').toBeDefined();
		expect(typeof (probe as ReconcileDefinition).schedule).toBe('object');
		expect((probe as ReconcileDefinition).autoApply?.reason).toContain('runtime.probe');
		expect((probe as ReconcileDefinition).applyRootOnly).toBeUndefined();
		// The dry contract (ReconcileRunOptions: write nothing) is asserted behaviourally in
		// publication_host_probe_native.test.ts; here: the dry path never calls the writer.
		const source = stripComments(
			readFileSync(join(ROOT, 'src/core/publication_host/probe.ts'), 'utf8'),
		);
		expect(source).toContain(
			'return apply ? (host) => probeAndRecord(host, {}) : (host) => probeHostRecord(host);',
		);
	});
	test('the gauge publishes every registered name with the wire keys the ops doc names', () => {
		const gauge = reconcileGauge() as Record<string, Record<string, unknown>>;
		expect(Object.keys(gauge)).toEqual([...REGISTERED_NAMES]);
		for (const entry of Object.values(gauge)) {
			expect(Object.keys(entry).sort()).toEqual(
				[
					'auto_apply',
					'last_apply',
					'last_applied',
					'last_deferred',
					'last_drift',
					'last_error',
					'last_run_at',
					'schedule',
				].sort(),
			);
		}
	});
});

describe('the ops doc (PRODUCTION.md §6.5) names what the registry runs', () => {
	const doc = readFileSync(join(ROOT, 'engineering/PRODUCTION.md'), 'utf8');
	test('every registered name has a row in the registered-set table', () => {
		for (const name of REGISTERED_NAMES) {
			expect(doc, `${name}: add its §6.5 table row`).toMatch(
				new RegExp(`^\\| \`${name}\` \\|`, 'm'),
			);
		}
	});

	test('the gauge row names exactly the keys the gauge publishes', () => {
		const row = /^\| `GET \/api\/v1\/counters` → `gauges\.reconcile` \|(.*)\|$/m.exec(doc);
		expect(row).not.toBeNull();
		const named = [...(row?.[1] ?? '').matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).sort();
		const gauge = reconcileGauge() as Record<string, Record<string, unknown>>;
		const published = Object.keys(Object.values(gauge)[0] ?? {}).sort();
		expect(published.length).toBeGreaterThan(0);
		expect(named).toEqual(published);
	});

	test('the scheduled-apply sentence names exactly the autoApply set', () => {
		const sentence =
			/applies only when its definition says `autoApply` WITH a reason — today([\s\S]*?);/.exec(
				doc,
			);
		expect(sentence).not.toBeNull();
		const named = [...(sentence?.[1] ?? '').matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
		const auto = REGISTERED.filter((d) => d.autoApply !== undefined).map((d) => d.name);
		expect(
			named.filter((name) => (REGISTERED_NAMES as readonly string[]).includes(name as string)),
		).toEqual(auto);
	});

	test('the post-restore paragraph names every DRY plan entry', () => {
		const start = doc.indexOf('**After a data restore**');
		const paragraph = doc.slice(start, doc.indexOf('\n\n', start));
		for (const step of POST_RESTORE_PLAN) {
			expect(paragraph, `${step.name}: name it in the post-restore paragraph`).toContain(
				`\`${step.name}\``,
			);
		}
	});
});

describe('reconcile registry doors (S-10)', () => {
	test('the maintenance widget door is registered with run_reconcile, dry by default in source', () => {
		const widget = ALL_WIDGET_MODULES.find((module) => module.spec.id === 'reconcile_status');
		expect(widget).toBeDefined();
		expect(Object.keys(widget?.apiActions ?? {})).toEqual(['run_reconcile']);
		expect(typeof widget?.getValue).toBe('function');
		const source = stripComments(
			readFileSync(join(ROOT, 'src/core/area_maintenance/widgets/reconcile_status.ts'), 'utf8'),
		);
		expect(source).toMatch(/const apply = options\.apply === true;/);
		expect(source).toContain('registerAllReconciles');
	});

	test('the CLI door exists and lists/runs through the catalog + runReconcile', () => {
		const source = stripComments(readFileSync(join(ROOT, 'scripts/reconcile.ts'), 'utf8'));
		expect(source).toContain("from '../src/core/reconcile/catalog.ts'");
		expect(source).toMatch(/runReconcile\(name, \{\s*apply,/);
		expect(source).toMatch(/argv\.includes\('--apply'\)/);
	});

	test('the server boot registers the catalog, starts the scheduler behind its flag, stops it on shutdown and drains its run in flight', () => {
		const source = stripComments(readFileSync(join(ROOT, 'src/server.ts'), 'utf8'), {
			blankStrings: false,
		});
		expect(source).toContain("import('./core/reconcile/catalog.ts')");
		expect(source).toMatch(/readString\('DEDALO_RECONCILE_SCHEDULER_ENABLED'\) !== 'false'/);
		expect(source).toContain('startReconcileScheduler()');
		expect(source).toContain('stopReconcileScheduler()');
		// The shutdown WAITS for a run in flight (bounded by its deadline) BEFORE the
		// pool that run's fence unit lives on closes (scheduler.ts doc).
		const drainAt = source.indexOf('drainReconcileScheduler(deadline)');
		expect(drainAt, 'the shutdown never drains the reconcile scheduler').toBeGreaterThan(-1);
		expect(drainAt).toBeLessThan(source.indexOf('closeDatabasePool()'));
		// The old direct boot apply is gone: media_index heals through the registry only.
		expect(source).not.toMatch(/void reconcileMediaIndex\(\)/);
	});

	test('the scheduler flag is a catalogued config key (readEnv law) with its rendered doc', () => {
		const catalog = readFileSync(join(ROOT, 'src/config/catalog/ops.ts'), 'utf8');
		expect(catalog).toContain('DEDALO_RECONCILE_SCHEDULER_ENABLED: {');
		const doc = readFileSync(join(ROOT, 'docs/config/config.md'), 'utf8');
		expect(doc).toContain('DEDALO_RECONCILE_SCHEDULER_ENABLED');
	});
});
