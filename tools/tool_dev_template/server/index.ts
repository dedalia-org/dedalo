/**
 * tool_dev_template — the EXEMPLAR tool server module. Copy this directory (or
 * run `bun run scripts/create_tool.ts`) to start a new tool. It demonstrates
 * every part of the ToolServerModule contract:
 *
 *  - apiActions in MAP form with EVERY permission kind the contract defines
 *    ('section', 'section_list' + its required sectionTipos extractor,
 *    'targets' + its required targets extractor, 'tipo', 'record',
 *    'record_tipo', 'developer') plus a null-spec (handler-gated) action;
 *  - `readOnly: true` (read_demo): the declaration of an action that writes
 *    nothing — it is not ledgered by the idempotency gate, runs inside the
 *    read-only request scope, and tool_read_only_action_tripwire proves it
 *    cannot reach a matrix / item-counter / Time Machine / activity / job write
 *    door. Media files, other stores and a psql child are NOT policed: they
 *    are the author's attestation (see its note on the action below). Its
 *    client call passes `retries: 1` (gated by client_idempotency_tripwire);
 *  - backgroundRunnable (the second allowlist for async execution) and the
 *    background-only context seams `publishProgress` / `signal`;
 *  - isAvailable (toolbar availability hook);
 *  - onRegister / onRemove (registration lifecycle hooks).
 *
 * `test/unit/tool_dev_template.test.ts` pins that list MECHANICALLY: it parses
 * the permission union out of src/core/tools/module.ts and fails if a kind the
 * contract declares is not demonstrated here. An exemplar that drifts from the
 * contract propagates the drift into every scaffolded tool.
 *
 * Handlers are `(context) => Promise<ToolResponse>`; the returned envelope
 * REPLACES the API response wholesale (own your result/msg/errors). The
 * declarative permission gate runs BEFORE the handler — inside the handler you
 * can trust that the caller cleared it.
 *
 * A tool's client half lives beside this dir (js/ css/ img/); the server/ dir is
 * never statically served. The same test asserts every action the client half
 * calls through `tool_request` exists in `apiActions` below.
 */

import { DedaloError, ok } from '../../../src/core/errors/index.ts';
import {
	type ToolActionContext,
	type ToolResponse,
	type ToolServerModule,
	toolRequestId,
} from '../../../src/core/tools/module.ts';

/** null-spec action: listed but gated inside the handler (here: always open). */
async function status(context: ToolActionContext): Promise<ToolResponse> {
	// THE SUCCESS SHAPE (engineering/ERRORS_SPEC.md §4): the payload goes in
	// `data`; a failure is a THROWN DedaloError, never a body.
	return ok({ tool: 'tool_dev_template' }, { requestId: toolRequestId(context) });
}

/** 'tipo' gate demo: level >= 1 on (section_tipo, tipo) was already asserted. */
async function readDemo(context: ToolActionContext): Promise<ToolResponse> {
	const { section_tipo, tipo } = context.options;
	return ok({ section_tipo, tipo, read: true }, { requestId: toolRequestId(context) });
}

/** 'record' gate demo: section write perm + record-in-scope already asserted. */
async function writeDemo(context: ToolActionContext): Promise<ToolResponse> {
	const { section_tipo, section_id } = context.options;
	return ok({ section_tipo, section_id, written: true }, { requestId: toolRequestId(context) });
}

/**
 * 'record_tipo' gate demo: the gate for an action targeting a COMPONENT OF A
 * RECORD. Both halves are already asserted here — level on the
 * (section_tipo, tipo) PAIR *and* the record's project scope.
 *
 * Reach for this instead of 'record' whenever the action names a component:
 * 'record' checks the SECTION level and never looks at the tipo, so a user
 * explicitly denied write on that one component would still pass. The component
 * key is `tipo`, with `component_tipo` accepted as its alias.
 */
async function componentWriteDemo(context: ToolActionContext): Promise<ToolResponse> {
	const { section_tipo, tipo, section_id } = context.options;
	return ok(
		{ section_tipo, tipo, section_id, component_written: true },
		{ requestId: toolRequestId(context) },
	);
}

/**
 * 'section_list' gate demo: a BATCH action whose targets ride INSIDE the payload
 * (here `items[].section_tipo`). The extractor lives on the SPEC, not in this
 * handler, so the per-target level check still runs before the background fork —
 * see sectionTipos below. By the time we get here every target cleared minLevel.
 */
async function batchDemo(context: ToolActionContext): Promise<ToolResponse> {
	const items = Array.isArray(context.options.items) ? context.options.items : [];
	return ok({ batch: items.length, gated: true }, { requestId: toolRequestId(context) });
}

/**
 * 'targets' gate demo: the kind for an action whose EFFECT TARGET is not a
 * top-level option — here the scope rides in `options.sqo` (the records the
 * batch will touch) and the components in `options.components_selection`, so
 * the extractor names every (sqo section × selected component) PAIR and the
 * gate asserts minLevel on each, before the handler and before any background
 * fork. Declaring 'section' on `options.section_tipo` here would authorize a
 * SIBLING field and leave the thing actually written ungated (audit CARRY-08).
 * A target may also carry a `section_id` (a positive record, scope-checked),
 * or pin a section by CONSTANT when the handler writes one by constant.
 */
async function scopedBatchDemo(context: ToolActionContext): Promise<ToolResponse> {
	// THE BATCH-SCOPE RULE (TOOLS_SPEC "a batch action takes its scope from the
	// REQUEST, or refuses"): an absent or malformed sqo is a refusal — never a
	// fallback to "every record of the section". The gate already refused an
	// sqo naming no section; this is the handler's own half of the same rule.
	const sqoRaw = context.options.sqo;
	if (sqoRaw === null || typeof sqoRaw !== 'object' || Array.isArray(sqoRaw)) {
		throw new DedaloError('request.invalid_options', {
			message: 'scoped_batch_demo: sqo is required (the scope to act on)',
			publicMessage: 'sqo is required',
		});
	}
	const sqo = sqoRaw as { section_tipo?: unknown };
	return ok(
		{ sqo_section_tipo: sqo.section_tipo ?? null, scoped: true },
		{ requestId: toolRequestId(context) },
	);
}

/** 'developer' gate demo: caller is a developer; no section target is asserted. */
async function developerDemo(context: ToolActionContext): Promise<ToolResponse> {
	return ok({ developer: true }, { requestId: toolRequestId(context) });
}

/**
 * background demo: allowed to run detached (see backgroundRunnable below), and
 * the reference for the two background-only context seams:
 *
 *  - `publishProgress` is ABSENT in a foreground call (there is no job record),
 *    so it is always called optionally. Each payload REPLACES the job frame's
 *    `data` and wakes every subscriber, and it also rewrites the pfile mirror —
 *    so a real handler throttles its own rate instead of publishing per row.
 *  - `signal` is the job's cooperative-cancellation handle. A long handler checks
 *    it at LOOP BOUNDARIES and returns a partial summary; the executor never
 *    kills work mid-write.
 *
 * The returned ToolResponse becomes the job's terminal frame `data` — that is
 * where the client reads its report from.
 */
async function longJob(context: ToolActionContext): Promise<ToolResponse> {
	const total = 3;
	let done = 0;
	for (let step = 1; step <= total; step++) {
		if (context.signal?.aborted === true) break;
		done = step;
		context.publishProgress?.({ step, total, label: `step ${step}/${total}` });
	}
	return ok(
		{
			started: true,
			ran_in_background: context.background,
			steps_done: done,
			aborted: context.signal?.aborted === true,
		},
		{ requestId: toolRequestId(context) },
	);
}

export const tool: ToolServerModule = {
	name: 'tool_dev_template',
	apiActions: {
		status: {
			permission: null,
			gatedInHandler:
				"UNGATED — the exemplar's demonstration of the null exemption: status() returns a constant literal, addresses no record and writes nothing, so any authenticated user granted tool_dev_template may call it. A tool author copying this file must replace this string with what THEIR handler actually does — or choose a declarative kind.",
			handler: status,
		},
		// READ-ONLY: the handler echoes its options and touches no record, history
		// row, activity row, job or file. `readOnly: true` is a CLAIM the dispatcher
		// acts on (a stamped resend re-executes instead of being ledgered; the
		// handler runs where the matrix / counter / history / activity / job write
		// doors refuse — files and other stores are on YOU), so it needs
		// `minLevel: 1` spelled out (the gated default is 2, write), no
		// backgroundRunnable entry, and a literal key here: the tripwire reads this
		// unit's reachable code. Its client call passes `retries: 1`.
		read_demo: { permission: 'tipo', minLevel: 1, readOnly: true, handler: readDemo },
		write_demo: { permission: 'record', minLevel: 2, handler: writeDemo },
		component_write_demo: {
			permission: 'record_tipo',
			minLevel: 2,
			handler: componentWriteDemo,
		},
		long_job: { permission: 'section', minLevel: 2, handler: longJob },
		developer_demo: { permission: 'developer', handler: developerDemo },
		batch_demo: {
			permission: 'section_list',
			minLevel: 2,
			// REQUIRED for 'section_list': pull the batch's targets out of the
			// payload. Every returned value is gated at minLevel; an empty list or
			// any invalid entry is a DENIAL (fail-closed), so a malformed payload
			// can never widen the batch.
			sectionTipos: (options) =>
				(Array.isArray(options.items) ? options.items : []).map(
					(item) => (item as { section_tipo?: unknown })?.section_tipo,
				),
			handler: batchDemo,
		},
		scoped_batch_demo: {
			permission: 'targets',
			minLevel: 2,
			// REQUIRED for 'targets': derive the WRITE TARGETS from the SAME keys
			// the handler reads. Every entry is gated at minLevel — the (section,
			// tipo) PAIR when a tipo is named, the record scope when a section_id
			// is — and an empty list, a malformed entry or a throwing extractor is
			// a DENIAL (fail-closed).
			targets: (options) => {
				const sqo = options.sqo as { section_tipo?: unknown } | undefined;
				const raw = sqo?.section_tipo;
				const sections = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
				const selection = Array.isArray(options.components_selection)
					? options.components_selection
					: [];
				return sections.flatMap((section_tipo) =>
					selection.map((item) => ({
						section_tipo,
						tipo: (item as { tipo?: unknown })?.tipo,
					})),
				);
			},
			handler: scopedBatchDemo,
		},
	},
	// Only long_job may be forked to the background executor.
	backgroundRunnable: ['long_job'],
	// The developer probe: operator work, so it exercises the same lane an
	// operator's own jobs use (PERF-11 lane declaration).
	backgroundLanes: { long_job: 'maintenance' },
	// Availability hook: hide the tool on relation-children callers (example rule).
	isAvailable: (context) => context.callerModel !== 'component_relation_children',
	// Lifecycle hooks (framework-called, never in apiActions). Failures are
	// logged, not fatal. Seed per-install config here if the tool needs it.
	onRegister: async () => {
		console.log('[tool_dev_template] registered');
	},
	onRemove: async () => {
		console.log('[tool_dev_template] removed');
	},
};
