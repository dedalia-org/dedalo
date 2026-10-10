/**
 * The install step router (DEC-19). ONE entry point shared by the browser
 * handler (dd_utils_api `install`) and the CLI. It routes `options.action` to a
 * pure engine function and maps the result onto ENVELOPE v2
 * (engineering/ERRORS_SPEC.md §3-4): the step's own boolean/payload is `data`,
 * and every other field it answers with (`msg`, `dirs`, `generated`,
 * `responses`, `report`, the db-probe booleans) rides as an EXTENSION KEY,
 * because render_installer.js reads them at the top level by name.
 *
 * TWO KINDS OF STEP, and the difference is the whole design here:
 *  - a PROBE/REPORT step (test_*_connection, check_directories,
 *    verify_active_config, get_ontology_catalog, install_hierarchies,
 *    register_tools) answers a
 *    question; "the server is unreachable" / "3 of 5 tlds failed" IS the
 *    answer, so it returns ok:true with the report as extension keys and the
 *    compat mirror puts the boolean back on `result` where the wizard reads it;
 *  - an ACTION step (persist_config, stage_ontologies,
 *    install_db_from_default_file, install_ontologies, set_root_pw,
 *    install_finish) either does the thing or REFUSES — and a refusal THROWS a
 *    registered `install.*` code (./refuse.ts) that the dispatch catch converts.
 * Nothing here builds a failure body.
 *
 * Per-step auth: the dispatch gate (Gate 1b) already enforced unsealed +
 * IP-allowed for the whole surface; the two record-writing steps
 * (install_hierarchies, register_tools) additionally require a session here —
 * the client only reaches them after the in-wizard login. The three ontology
 * steps need none: they run before the login exists (the ontology import is the
 * same kind of machine-side install step as the seed restore it follows, and is
 * audited to -1 like it).
 */

import type { ApiRequestContext } from '../api/handler_context.ts';
import type { ApiResult } from '../api/response.ts';
import type { Rqo } from '../concepts/rqo.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import { ok } from '../errors/index.ts';

type StepOptions = { action?: string } & Record<string, unknown>;

/**
 * A step's answer. `ok` is the value the wizard reads as `result` (the compat
 * mirror of `data`); every other key is an extension key of the envelope.
 */
export interface StepOutcome {
	ok: boolean | unknown[] | Record<string, unknown>;
	msg?: string;
	[extra: string]: unknown;
}

/**
 * One step outcome → the v2 envelope (`data` = the step value, the rest =
 * extension keys). The parameter is the structural `{ ok }` (every step module
 * declares its own precise result interface, and an interface carries no index
 * signature) widened here to StepOutcome for the rest-spread.
 */
function stepResult(context: ApiRequestContext, outcome: { ok: unknown }): ApiResult {
	const { ok: value, ...extend } = outcome as StepOutcome;
	return { status: 200, body: ok(value, { requestId: context.requestId, extend }) };
}

type StepHandler = (options: StepOptions, context: ApiRequestContext) => Promise<ApiResult>;

/** The in-wizard root session, or the refusal (record-writing steps only). */
function requireSession(context: ApiRequestContext): NonNullable<ApiRequestContext['session']> {
	if (context.session === null) throw new DedaloError('auth.not_logged');
	return context.session;
}

/**
 * Every step, by its wire action name. The plan's step ids
 * (install_plan.ts INSTALL_STEP_IDS) are a subset of these keys — gated, so a
 * plan can never name a step the wizard cannot route. `to_update` and
 * `verify_active_config` are wizard-only affordances, not plan steps.
 */
const STEP_HANDLERS: Readonly<Record<string, StepHandler>> = Object.freeze({
	to_update: async () => {
		// The TS installer supports no in-place v5/v6 data migration (the client
		// only shows the button when db_data_version[0] < 6, which we never
		// emit). Defensive: refuse rather than pretend.
		throw new DedaloError('engine.uncovered_scope', {
			message: 'Update path not supported in the TS installer',
		});
	},

	test_db_connection: async (options, context) => {
		const { testDbConnection } = await import('./db_probe.ts');
		return stepResult(context, await testDbConnection(options));
	},

	test_diffusion_connection: async (options, context) => {
		const { testDiffusionConnection } = await import('./db_probe.ts');
		return stepResult(context, await testDiffusionConnection(options));
	},

	test_mailer_connection: async (options, context) => {
		const { testMailerConnection } = await import('./mailer_probe.ts');
		return stepResult(context, await testMailerConnection(options));
	},

	check_directories: async (options, context) => {
		const { checkDirectories } = await import('./directories.ts');
		return stepResult(context, checkDirectories({ create: options.create === true }));
	},

	persist_config: async (options, context) => {
		const { persistConfig, refuseWizardOnlyCliAnswers } = await import('./config_persist.ts');
		// The wizard door never takes a server filesystem path (`ontology_source`
		// is CLI-only — the CLI calls persistConfig itself): refused before any read.
		refuseWizardOnlyCliAnswers(options);
		// A failure THROWS out of persistConfig, so reaching the next line means
		// the .env is written: persisting config makes the current (install-mode)
		// process obsolete — schedule the restart AFTER the response flushes so
		// it boots with real config. No-op under DEDALO_INSTALL_NO_RESTART
		// (tests/CLI).
		const persisted = await persistConfig(options);
		const { scheduleServerRestart } = await import('./restart.ts');
		scheduleServerRestart('config persisted');
		return stepResult(context, persisted);
	},

	verify_active_config: async (options, context) => {
		const { verifyActiveConfig } = await import('./config_persist.ts');
		return stepResult(context, await verifyActiveConfig(options));
	},

	get_ontology_catalog: async (options, context) => {
		const { ontologyCatalogProbe } = await import('./ontology_catalog.ts');
		return stepResult(context, await ontologyCatalogProbe(options.update_servers !== false));
	},

	stage_ontologies: async (_options, context) => {
		const { ontologyRequestFromConfig, stageOntologies } = await import('./ontology_install.ts');
		// The request comes from the WRITTEN configuration (ACTIVE_ONTOLOGY_TLDS +
		// the configured ontology servers) — never from the client: this process
		// was restarted after persist_config.
		return stepResult(context, await stageOntologies(await ontologyRequestFromConfig()));
	},

	install_db_from_default_file: async (_options, context) => {
		const { installDbFromSeed } = await import('./db_restore.ts');
		return stepResult(context, await installDbFromSeed());
	},

	install_ontologies: async (_options, context) => {
		const { installOntologies } = await import('./ontology_install.ts');
		return stepResult(context, await installOntologies({ userId: -1 }));
	},

	set_root_pw: async (options, context) => {
		const { setRootPassword } = await import('./root_pw.ts');
		return stepResult(context, await setRootPassword(String(options.password ?? '')));
	},

	install_hierarchies: async (options, context) => {
		const session = requireSession(context);
		const { installHierarchies } = await import('./hierarchy_import.ts');
		const { normalizeHierarchyChoice } = await import('./install_plan.ts');
		const { refuseInstall } = await import('./refuse.ts');
		// The posted list goes through THE PLAN's thesaurus normalization — the one
		// the CLI's answer took (install_plan_parity_tripwire): a core tld (lg) is
		// dropped with a note (the seed restore already activated it,
		// db_restore.ts), an unvendored one refuses BEFORE any write. [] (or no
		// list) is a valid answer: no optional thesaurus.
		const choice = normalizeHierarchyChoice(
			Array.isArray(options.hierarchies) ? options.hierarchies : 'none',
		);
		// The MANDATORY thesauri the installed ontologies declare (hierarchy60
		// `main: 'hierarchy1'`, read back from their registry rows — this process
		// has no plan) are added whatever was posted: unticking one in the client
		// cannot decline it. A mandatory one that is not vendored refuses here,
		// before any write. Optional ones follow the posted list.
		const { installedHierarchyDependencies } = await import('./hierarchy_dependencies.ts');
		const { withMandatoryHierarchies } = await import('./ontology_choice.ts');
		const declared = await installedHierarchyDependencies();
		const required = withMandatoryHierarchies(choice.hierarchies, declared.dependencies);
		const errors = [...choice.errors, ...required.errors];
		if (errors.length > 0) {
			refuseInstall('install.invalid_input', `Install answers invalid: ${errors.join('; ')}`);
		}
		// The in-wizard root session owns the activation writes (registry flags,
		// the provisioned ontology records) — audited to a real actor, not to -1.
		const result = await installHierarchies(required.hierarchies, undefined, session.userId);
		const notes = [...choice.notes, ...required.notes, ...declared.warnings];
		if (notes.length > 0) result.msg = `${result.msg} (${notes.join('; ')})`;
		return stepResult(context, result);
	},

	register_tools: async (_options, context) => {
		requireSession(context);
		const { registerInstallTools } = await import('./register_tools.ts');
		return stepResult(context, await registerInstallTools());
	},

	install_finish: async (_options, context) => {
		const { installFinish } = await import('./finish.ts');
		// A refusal THROWS, so the next line means SEALED. This process booted
		// mid-wizard and therefore skipped every database boot step (migrations,
		// search stores, schedulers, caches — server.ts `databaseBoot`): restart
		// it into the sealed instance, after the response flushes. The client's
		// own countdown (5 s) then reloads into the app. No-op under
		// DEDALO_INSTALL_NO_RESTART (tests/CLI — the CLI's server boots after).
		const finished = await installFinish();
		const { scheduleServerRestart } = await import('./restart.ts');
		scheduleServerRestart('install sealed');
		return stepResult(context, finished);
	},
});

/** Every action name the router serves (the wire contract's step vocabulary). */
export const INSTALL_ROUTER_ACTIONS: readonly string[] = Object.freeze(Object.keys(STEP_HANDLERS));

/** Route one wizard step. */
export async function runInstallStep(rqo: Rqo, context: ApiRequestContext): Promise<ApiResult> {
	const options = (rqo.options ?? {}) as StepOptions;
	const step = options.action ?? '';
	const handler = Object.hasOwn(STEP_HANDLERS, step) ? STEP_HANDLERS[step] : undefined;
	if (handler === undefined) {
		throw new DedaloError('install.unknown_step', {
			message: `Unknown install step '${step}'`,
		});
	}
	return handler(options, context);
}
