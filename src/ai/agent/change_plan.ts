/**
 * CHANGE PLAN — the propose→confirm→apply write protocol (plan decision D2).
 *
 * The agent loop NEVER writes. In write mode the model proposes a ChangePlan:
 * an ordered list of ops, each op exactly one registry WRITE tool call
 * (`{op_id, tool, args, summary}`), with `{ref: <op_id>}` chaining later ops
 * onto records created earlier in the same plan. The plan is:
 *
 *   1. VALIDATED here (dry-run: tool exists+write, section allowlist, field
 *      labels resolved AND STAMPED to tipos, refs point at earlier create-ops,
 *      and every op authorized by THE WRITE DOOR its tool asks at apply —
 *      security/write_door.ts, closure Step 3 req 7: grammar, section floor,
 *      the dd128-aware pair, the write scope with the non-positive-id refusal
 *      ahead of the admin bypass) — the human confirms the RESOLVED plan, and
 *      never one its own apply would refuse;
 *   2. HASHED over canonical JSON (sorted keys) — apply recomputes the hash,
 *      so what executes is byte-what was confirmed (plan_hash_mismatch else);
 *   3. APPLIED statelessly: the client resends the full plan; every gate
 *      re-runs; ops execute sequentially THROUGH runTool (never engines
 *      directly — the write-scope tripwire counts on that), stop-on-first-
 *      error with an {applied, failed, skipped} report (D7). Each engine call
 *      is its own transaction and TM audit, exactly like a human edit.
 *
 * No server-held plan state exists between propose and apply
 * (module_state_tripwire): re-validation at apply is the security boundary,
 * the hash only protects the HUMAN's confirmation from accidental drift.
 */

import { z } from 'zod';
import { canonicalJson } from '../../core/concepts/canonical_json.ts';
import { toStructuredErr } from '../../core/errors/convert.ts';
import { DedaloError } from '../../core/errors/dedalo_error.ts';
import {
	authorizeRecordAccess,
	authorizeRecordCreate,
	authorizeSectionRecord,
	authorizeSectionTarget,
} from '../../core/security/write_door.ts';
import type { Structured } from '../mcp/envelope.ts';
import {
	getToolSpec,
	type RegistryGates,
	type RegistryPrincipal,
	runTool,
} from '../mcp/registry.ts';
import { resolveFieldReference } from '../mcp/tools/discovery.ts';

/** One op: exactly one registry write-tool call (+ ref chaining). */
export interface ChangeOp {
	/** Unique id within the plan; later ops reference it as {ref: op_id}. */
	op_id: string;
	/** A registry WRITE tool name, e.g. 'dedalo_find_or_create'. */
	tool: string;
	/** The tool's input; {ref: <op_id>} allowed wherever a section_id goes. */
	args: Record<string, unknown>;
	/** Human-readable one-liner shown in the confirmation UI. */
	summary: string;
}

export interface ChangePlan {
	plan_version: 1;
	/** What the whole plan does, for the confirmation dialog. */
	summary: string;
	ops: ChangeOp[];
}

export interface ValidatedChangePlan extends ChangePlan {
	/** SHA-256 over the canonical JSON of {plan_version, summary, ops}. */
	plan_hash: string;
}

export interface ApplyReport {
	applied: { op_id: string; result: unknown }[];
	failed?: { op_id: string; error: Structured };
	skipped: string[];
	/** section_ids of records created by create-ops, keyed by op_id. */
	created: Record<string, number>;
}

const changeOpSchema = z.object({
	op_id: z.string().min(1),
	tool: z.string().min(1),
	args: z.record(z.string(), z.unknown()),
	summary: z.string().min(1),
});

export const changePlanSchema = z.object({
	plan_version: z.literal(1),
	summary: z.string().min(1),
	ops: z.array(changeOpSchema).min(1).max(64),
});

/** Tools whose result mints a record other ops may {ref}. */
const CREATE_TOOLS: ReadonlySet<string> = new Set([
	'dedalo_create_record',
	'dedalo_find_or_create',
]);

// ---------------------------------------------------------------------------
// Canonical hash
// ---------------------------------------------------------------------------

/** SHA-256 hex of the plan's canonical JSON (plan_hash itself excluded). */
export function hashChangePlan(plan: ChangePlan): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(
		canonicalJson({ plan_version: plan.plan_version, summary: plan.summary, ops: plan.ops }),
	);
	return hasher.digest('hex');
}

// ---------------------------------------------------------------------------
// Ref plumbing
// ---------------------------------------------------------------------------

function isRef(value: unknown): value is { ref: string } {
	return (
		value !== null &&
		typeof value === 'object' &&
		typeof (value as { ref?: unknown }).ref === 'string' &&
		Object.keys(value as object).length === 1
	);
}

/** Collect every {ref} inside a value (deep). */
function collectRefs(value: unknown, into: string[]): void {
	if (isRef(value)) {
		into.push(value.ref);
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) collectRefs(entry, into);
		return;
	}
	if (value !== null && typeof value === 'object') {
		for (const entry of Object.values(value)) collectRefs(entry, into);
	}
}

/** Deep-substitute {ref: op_id} with the created section_id. */
function substituteRefs(value: unknown, created: Record<string, number>): unknown {
	if (isRef(value)) {
		const resolved = created[value.ref];
		if (resolved === undefined) {
			throw new DedaloError('request.invalid', {
				publicMessage: `Unresolved ref '${value.ref}' at apply time.`,
			});
		}
		return resolved;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => substituteRefs(entry, created));
	}
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			out[key] = substituteRefs(entry, created);
		}
		return out;
	}
	return value;
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

/**
 * WHAT EACH WRITE TOOL'S OP TOUCHES — the component its value lands in (`field`,
 * stamped to a tipo above, or save_component's `tipo`), or the whole record
 * (`record`), or a new record (`create`; find_or_create adds every match/set
 * field's pair, exactly its tool's own pre-flight), or a record AND the new copy
 * it births (`duplicate`: the record door, then the New-button predicate —
 * exactly what dedalo_duplicate_record asks at apply, T0-2 / D4). A write tool with no row is
 * REFUSED: a plan the validator cannot authorize is never confirmed (fail closed,
 * so a new registry write tool must be taught its target here first —
 * agent_change_plan's "every write tool has a plan target" leg).
 */
const OP_TARGET: Readonly<Record<string, 'field' | 'tipo' | 'record' | 'create' | 'duplicate'>> = {
	dedalo_set_field: 'field',
	dedalo_portal_link: 'field',
	dedalo_portal_unlink: 'field',
	dedalo_upload_media: 'field',
	dedalo_save_component: 'tipo',
	dedalo_delete_record: 'record',
	dedalo_duplicate_record: 'duplicate',
	dedalo_create_record: 'create',
	dedalo_find_or_create: 'create',
};

/** The write door's question for one op, at write level 2 (the door the tool itself asks at apply). */
async function authorizeOp(
	principal: RegistryPrincipal,
	op: ChangeOp,
	sectionTipo: string,
): Promise<void> {
	const door = `agent.change_plan.${op.tool}`;
	const shape = OP_TARGET[op.tool];
	try {
		if (shape === undefined) {
			throw new DedaloError('request.invalid', {
				publicMessage: `Op '${op.op_id}': '${op.tool}' has no plan target rule.`,
			});
		}
		if (shape === 'create') {
			await authorizeCreateOp(principal, op, sectionTipo, door);
			return;
		}
		const component = shape === 'record' || shape === 'duplicate' ? undefined : op.args[shape];
		await authorizeTargetOp(principal, sectionTipo, component, op.args.section_id, door);
		// A duplicate BIRTHS a record: the SAME New-button predicate its executor
		// (fields_write.ts duplicateRecord) asks, so a validated plan cannot
		// half-apply on it (T0-2 / D4).
		if (shape === 'duplicate') await authorizeRecordCreate(principal, sectionTipo, { door });
	} catch (error) {
		throw withOpId(error, op.op_id);
	}
}

/**
 * A record-addressed op. A {ref} id is a record THIS plan creates: it does not
 * exist yet, so its section / pair is the question now and the full door
 * (scope included) is re-asked by the tool at apply. Any other id — a string, a
 * non-integer, 0, a negative — goes to the door as given: grammar, the section
 * floor, the dd128-aware pair, the scope with the non-positive-id refusal ahead
 * of the admin bypass.
 */
async function authorizeTargetOp(
	principal: RegistryPrincipal,
	sectionTipo: string,
	component: unknown,
	sectionId: unknown,
	door: string,
): Promise<void> {
	if (isRef(sectionId)) {
		await authorizeSectionTarget(
			principal,
			{ section_tipo: sectionTipo, tipo: component },
			{ level: 2, door },
		);
		return;
	}
	if (component === undefined) {
		await authorizeSectionRecord(
			principal,
			{ section_tipo: sectionTipo, section_id: sectionId },
			{ level: 2, door },
		);
		return;
	}
	await authorizeRecordAccess(
		principal,
		{ section_tipo: sectionTipo, component_tipo: component, section_id: sectionId },
		{ mode: 'write', level: 2, sectionFloor: 1, door },
	);
}

/**
 * A create (create_record / find_or_create): THE NEW-BUTTON PREDICATE
 * (write_door.ts authorizeRecordCreate — section ≥ 2 AND its button_new ≥ 2),
 * the SAME predicate the MCP create executors ask (records_write.ts createRecord,
 * fields_write.ts findOrCreate; T0-2 / D4), plus every match/set field's pair.
 * A section-level-only dry-run here would validate a plan its own apply
 * refuses half-way (review finding F3).
 */
async function authorizeCreateOp(
	principal: RegistryPrincipal,
	op: ChangeOp,
	sectionTipo: string,
	door: string,
): Promise<void> {
	await authorizeRecordCreate(principal, sectionTipo, { door });
	const rules = [...ruleFields(op.args.match), ...ruleFields(op.args.set)];
	for (const field of rules) {
		const tipo = await resolveFieldReference(sectionTipo, field);
		await authorizeSectionTarget(
			principal,
			{ section_tipo: sectionTipo, tipo },
			{ level: 2, door },
		);
	}
}

/** The `field` of every {field, …} rule of a find_or_create match/set list. */
function ruleFields(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((rule) => (rule as { field?: unknown } | null)?.field)
		.filter((field): field is string => typeof field === 'string');
}

/** A refusal re-thrown with WHICH op it refused, as the extension key the model reads. */
function withOpId(error: unknown, opId: string): unknown {
	if (!(error instanceof DedaloError)) return error;
	return new DedaloError(error.code, {
		message: error.message,
		details: error.details,
		coordinates: error.coordinates,
		publicMessage: error.publicMessage,
		extend: { ...error.extend, op_id: opId },
		cause: error,
	});
}

/**
 * Dry-run the plan under the principal + gates: every failure throws a
 * DedaloError the caller envelopes (toStructuredErr). Returns the RESOLVED plan (field labels
 * stamped to tipos) with its hash — that is what the human confirms.
 */
export async function validateChangePlan(
	principal: RegistryPrincipal,
	rawPlan: unknown,
	gates: RegistryGates,
): Promise<ValidatedChangePlan> {
	if (gates.allowWrite !== true) {
		throw new DedaloError('mcp.write_disabled');
	}
	const parsed = changePlanSchema.safeParse(rawPlan);
	if (!parsed.success) {
		throw new DedaloError('request.invalid', {
			publicMessage: `Malformed change plan: ${parsed.error.message}`,
		});
	}
	const plan = parsed.data as ChangePlan;

	const seenOps = new Set<string>();
	const createOps = new Set<string>();
	for (const op of plan.ops) {
		if (seenOps.has(op.op_id)) {
			throw new DedaloError('request.invalid', { publicMessage: `Duplicate op_id '${op.op_id}'.` });
		}
		seenOps.add(op.op_id);

		const spec = getToolSpec(op.tool);
		if (spec === undefined || !spec.write) {
			throw new DedaloError('request.invalid', {
				publicMessage: `Op '${op.op_id}': '${op.tool}' is not a write tool.`,
			});
		}

		// Refs may only point at EARLIER create-ops (no cycles, no forward refs).
		const refs: string[] = [];
		collectRefs(op.args, refs);
		for (const ref of refs) {
			if (!createOps.has(ref)) {
				throw new DedaloError('request.invalid', {
					publicMessage: `Op '${op.op_id}' references '${ref}', which is not an earlier create-op.`,
				});
			}
		}

		// Section allowlist + permission gates (the same wall apply re-runs).
		const sectionTipo = op.args.section_tipo;
		if (typeof sectionTipo !== 'string' || sectionTipo === '') {
			throw new DedaloError('request.invalid', {
				publicMessage: `Op '${op.op_id}' needs args.section_tipo.`,
			});
		}
		if (
			gates.writableSections !== undefined &&
			gates.writableSections.size > 0 &&
			!gates.writableSections.has(sectionTipo)
		) {
			// perm.* codes are operator-disclosure: the model gets the registry
			// message + hint; WHICH op failed rides as an extension key.
			throw new DedaloError('perm.section_not_writable', {
				coordinates: { section_tipo: sectionTipo },
				extend: { op_id: op.op_id },
			});
		}

		// Resolve + STAMP field labels to tipos, so what the human confirms is
		// the exact component the apply will touch (never re-guessed later).
		if (typeof op.args.field === 'string') {
			op.args.field = await resolveFieldReference(sectionTipo, op.args.field);
		}

		// THE WRITE DOOR (closure Step 3 req 7): the op is authorized by the SAME
		// door its tool asks at apply — never a weaker preview of it.
		await authorizeOp(principal, op, sectionTipo);

		if (CREATE_TOOLS.has(op.tool)) createOps.add(op.op_id);
	}

	return { ...plan, plan_hash: hashChangePlan(plan) };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Apply a confirmed plan: hash recheck → full re-validation → sequential
 * execution through the registry write handlers. Stop-on-first-error; the
 * report names what ran, what failed, and what never started.
 */
export async function applyChangePlan(
	principal: RegistryPrincipal,
	rawPlan: unknown,
	planHash: string,
	gates: RegistryGates,
): Promise<ApplyReport> {
	const validated = await validateChangePlan(principal, rawPlan, gates);
	if (validated.plan_hash !== planHash) {
		throw new DedaloError('mcp.plan_hash_mismatch', {
			publicMessage: 'The plan differs from the one that was confirmed.',
		});
	}

	const report: ApplyReport = { applied: [], skipped: [], created: {} };
	for (let index = 0; index < validated.ops.length; index++) {
		const op = validated.ops[index] as ChangeOp;
		const spec = getToolSpec(op.tool);
		if (spec === undefined) {
			// Unreachable after validation; belt for the type system.
			report.failed = {
				op_id: op.op_id,
				error: toStructuredErr(
					new DedaloError('request.invalid', { publicMessage: 'unknown tool' }),
				),
			};
			report.skipped = validated.ops.slice(index + 1).map((rest) => rest.op_id);
			return report;
		}
		let envelope: Structured;
		try {
			const args = substituteRefs(op.args, report.created) as Record<string, unknown>;
			envelope = await runTool(spec, principal, args, gates);
		} catch (error) {
			envelope = toStructuredErr(error);
		}
		if (!envelope.ok) {
			report.failed = { op_id: op.op_id, error: envelope };
			report.skipped = validated.ops.slice(index + 1).map((rest) => rest.op_id);
			return report;
		}
		report.applied.push({ op_id: op.op_id, result: envelope.data });
		if (CREATE_TOOLS.has(op.tool)) {
			const createdId = (envelope.data as { section_id?: unknown } | null)?.section_id;
			if (typeof createdId === 'number') {
				report.created[op.op_id] = createdId;
			}
		}
	}
	return report;
}
