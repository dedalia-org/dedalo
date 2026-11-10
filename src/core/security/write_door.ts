/**
 * THE WRITE DOOR — one shape for the authorization of every door that acts on a
 * (section, component, record) triple, or on a section target (closure Step 3,
 * SEC-05 one layer down; WC-2026-09-30-write-door).
 *
 * WHAT IT REPLACES. Every write door wrote its own subset of one rule: the
 * tool gate (`core/tools/security.ts`) read the RAW `getPermissions` (so the
 * dd128 own-record DOWNGRADE never applied at a tool door), inlined the admin
 * bypass ABOVE the non-positive-id refusal (so a global admin reached root's
 * dd128/-1 password through `record_tipo`), accepted `1.5` as a record id and
 * read a garbage id as "no record named"; the media door asked only the
 * SECTION; the MCP write tools had a private copy of the pair + scope. Five
 * doors, five re-implementations. This module is the rule, and it is the ONLY
 * place the order of its halves is written down.
 *
 * ── THE TWO QUESTIONS ────────────────────────────────────────────────────────
 *
 * {@link authorizeRecordAccess} — ONE component of ONE existing record, in a
 * fixed order that no caller can re-arrange:
 *
 *   1. GRAMMAR  both tipos pass the identifier gate; the id is an INTEGER
 *               ({@link parseRecordId}) — `1.5`, `'abc'`, `true` are refused
 *               as `request.invalid`, never read as "absent".
 *   2. SECTION  `getSectionPermissions >= sectionFloor`. The floor is REQUIRED
 *               (no default): every caller names it; 0 only for a door in
 *               SECTION_FLOOR_ZERO_DOORS (else internal.invariant). The other skip is an
 *               account's own self-service write (dd128 grants 0 to most
 *               profiles; `isSelfServiceAccountWrite` is the whole carve-out).
 *   3. PAIR     write: `getRecordComponentPermission >= level` (the dd128
 *               own-record downgrade AND upgrade applied) — for a FIXED
 *               dataframe slot (dd560) min(2, its MAIN's level), the main
 *               named by `frameOf` and validated, else `request.invalid_source`
 *               (T0-4); read: the read door's `authorizeComponentRead` (the
 *               read law has ONE home).
 *   4. SCOPE    write: `assertRecordWriteTarget`; read:
 *               `principalCanAccessRecord`. In BOTH the non-positive-id
 *               refusal runs BEFORE the global-admin bypass.
 *   5. GRANT    a frozen, branded {@link RecordGrant} — the effect is built
 *               from the grant, never from the request it was authorized from;
 *               it NAMES THE ACTOR it authorized (`userId`), so an effect typed
 *               on the grant audits as that actor and holds no principal.
 *
 * {@link authorizeSectionTarget} — a SECTION target that MAY name a record
 * (the tool kinds `tipo` / `section` / `targets`, and a create): the level on
 * the pair (dd128-aware) or on the section (always consultation-capped); an
 * ABSENT id is a create and the level is its whole authorization; a PRESENT id
 * must be an integer and in scope — 0 and negatives included, which is what
 * closes "`section_id: -1` skips the scope check".
 *
 * {@link authorizeSectionRecord} — the same door for a target that MUST name a
 * record (a whole-record effect: delete, duplicate, the tool `record` kind). An
 * absent id is refused as `request.invalid` BY THE DOOR — never read as a
 * create — so no record-lifecycle caller can turn a missing id into a
 * section-level authorization with a null target, whatever its schema layer
 * does or skips. Its grant's `sectionId` is a number by type.
 *
 * TWO CREATE RULES (T0-2, WC-2026-11-10-add-new-element-create-gate; owner
 * decisions D1/D4 2026-11-10, D4/D3 REVISED the same day). There is NO single
 * create rule engine-wide, by design — each door asks exactly one of these:
 *
 * {@link authorizeRecordCreate} — THE NEW-BUTTON PREDICATE, "may PRESS NEW in
 * S": the section level ≥ 2 (consultation-capped) AND the FIRST `button_new`
 * of S (section/buttons.ts `sectionButtonRows` — virtual + exclude_elements
 * aware, the same rows the section list's "New" and the portal "+" answer
 * from) ≥ 2. No button_new → refused, the superuser included (PHP
 * security::get_section_new_permissions: null < 2). Asked by: add_new_element
 * through a USER door (portal / select save, temporal, children "+" —
 * relations/save.ts applyAddNewElement, `create` access), the tree's add_child,
 * core + MCP duplicate, the MCP create / find_or_create, and the agent change
 * plan's dry-run of those ops.
 *
 * {@link authorizeSectionCreate} — THE SECTION-LEVEL CREATE, "may create in S"
 * where S is a FEATURE-OWNED target that ships no "New" (text-area / TM / index
 * notes, references, dataframe frames, presets) or an import: the section level
 * ≥ 2, consultation-capped — PHP dd_core_api::create parity. Asked by: core
 * `create`, and a TOOL-driven add_new_element (applyAddNewElement `tool`
 * access, minted server-side only). The tool import create doors and the
 * duplicate's dataframe re-mint ask the same section level through their own
 * section-target checks. Residual (as PHP): a crafted core `create` skips the
 * New button.
 *
 * ── REFUSAL CODES (the adapter in core/tools/security.ts maps them onto the
 *    legacy tool-envelope sentences; every other door relays them) ──────────
 *
 *   request.invalid     a target that is not a target (grammar)
 *   perm.denied         the section floor or the pair level is short
 *   perm.out_of_scope   the record is outside the caller's scope, or its id is
 *                       not a record address (non-positive), admins included
 *
 * No module-level state. Gate: test/unit/write_door_native.test.ts (every
 * half through the real resolver, no mocks) + authz_door_matrix_native.
 */

import { isValidTipo } from '../concepts/ontology.ts';
import { dataframePairingOf } from '../concepts/rqo.ts';
import { INT4_MAX, INT4_MIN } from '../concepts/section_id.ts';
import { DedaloError } from '../errors/dedalo_error.ts';
import {
	getModelByTipo,
	getRecursiveChildrenTipos,
	getSectionRealTipo,
	tipoBelongsToSection,
} from '../ontology/resolver.ts';
import { assertValidTipo } from '../search/identifier_gate.ts';
import { sectionButtonRows } from '../section/buttons.ts';
import {
	FIXED_FRAME_OWN_LEVEL,
	getPermissions,
	getRecordComponentPermission,
	getSectionPermissions,
	isFixedDataframeSlot,
	isSelfServiceAccountWrite,
	modelDeclaresFixedSlot,
	type Principal,
} from './permissions.ts';
import { authorizeComponentRead } from './read_door.ts';
import { assertRecordWriteTarget, principalCanAccessRecord } from './record_scope.ts';

declare const grantBrand: unique symbol;

/**
 * Proof that ONE component of ONE record was authorized. Only this module
 * mints it (the brand is not constructible elsewhere), so a function that
 * takes a RecordGrant cannot be handed the raw request instead.
 */
export type RecordGrant = Readonly<{
	[grantBrand]: true;
	sectionTipo: string;
	componentTipo: string;
	sectionId: number;
	mode: 'read' | 'write';
	level: 1 | 2;
	door: string;
	/** The principal the grant was minted for — the effect's audit actor. */
	userId: number;
}>;

/**
 * Proof that a SECTION target was authorized. `sectionId` is null for a
 * create (no record named); `componentTipo` equals `sectionTipo` when the
 * target named no component.
 */
export type SectionGrant = Readonly<{
	[grantBrand]: true;
	sectionTipo: string;
	componentTipo: string;
	sectionId: number | null;
	level: number;
	door: string;
}>;

/** What the caller's payload said about a record id. */
export type ParsedRecordId = { kind: 'absent' } | { kind: 'id'; id: number } | { kind: 'invalid' };

/** The spellings of "no record named". */
const ABSENT_IDS: ReadonlySet<unknown> = new Set([undefined, null, '']);

/**
 * The record-id GRAMMAR, stated once.
 *
 *   undefined / null / ''             → absent (no record named)
 *   an integer, or an integer string  → id (0 and negatives INCLUDED: whether
 *                                       they address a record is the scope
 *                                       step's question, not the parser's)
 *   anything else                     → invalid (1.5, NaN, 'abc', booleans,
 *                                       objects) — never coerced to absent
 *
 * An id is also an int4 (INT4_MIN..INT4_MAX, the matrix `section_id` columns'
 * range, and a safe integer): '99999999999999999999' rounds silently through
 * Number() and would reach SQL only to abort the statement — refused here as
 * invalid instead, with the rest of the grammar.
 */
export function parseRecordId(value: unknown): ParsedRecordId {
	if (ABSENT_IDS.has(value)) return { kind: 'absent' };
	const id = toIntegerId(value);
	return id === null ? { kind: 'invalid' } : { kind: 'id', id };
}

/** An int4 integer number, or a string of decimal digits (optionally signed) naming one. */
function toIntegerId(value: unknown): number | null {
	const id = idNumber(value);
	return id !== null && isInt4(id) ? id : null;
}

/** The number an id spells: a number as given, a decimal-digit string parsed, else null. */
function idNumber(value: unknown): number | null {
	if (typeof value === 'number') return value;
	return typeof value === 'string' && /^-?[0-9]+$/.test(value) ? Number(value) : null;
}

/** A safe integer inside the matrix `section_id` columns' range (INT4_MIN..INT4_MAX). */
function isInt4(id: number): boolean {
	return Number.isSafeInteger(id) && id >= INT4_MIN && id <= INT4_MAX;
}

/** The identifier gate, relayed as the write door's own grammar refusal. */
function gateTipo(value: unknown, door: string, key: string): string {
	try {
		return assertValidTipo(value, `${door}.${key}`);
	} catch {
		throw new DedaloError('request.invalid', {
			message: `${door}: ${key} is not a valid tipo (${JSON.stringify(value ?? null)})`,
			coordinates: { door, key },
		});
	}
}

/** An absent component key means "the section itself". */
function gateComponent(value: unknown, sectionTipo: string, door: string, key: string): string {
	return ABSENT_IDS.has(value) ? sectionTipo : gateTipo(value, door, key);
}

function invalidRecordId(door: string, value: unknown): DedaloError {
	return new DedaloError('request.invalid', {
		message: `${door}: section_id ${JSON.stringify(value ?? null)} is not a record id`,
		coordinates: { door, key: 'section_id' },
	});
}

/** A validated (section, component, record?) target — the grammar step's output. */
interface Target {
	readonly sectionTipo: string;
	readonly componentTipo: string;
	readonly sectionId: number | null;
}

/** The refusal of a short level on one half. */
function levelShortfall(
	door: string,
	target: Target,
	required: number,
	half: 'section' | 'component',
): DedaloError {
	return new DedaloError('perm.denied', {
		message: `${door}: the ${half} grant on (${target.sectionTipo}, ${target.componentTipo}) is below ${required}`,
		coordinates: {
			door,
			section_tipo: target.sectionTipo,
			tipo: target.componentTipo,
			...(target.sectionId === null ? {} : { section_id: target.sectionId }),
			required,
		},
	});
}

/** Options every record-addressed caller must state — nothing defaults. */
export interface RecordAccessOptions {
	readonly mode: 'read' | 'write';
	readonly level: 1 | 2;
	/** The concrete door, for the log line and the grant. */
	readonly door: string;
	/**
	 * The SECTION half's floor. 0 is a NAMED exception, accepted ONLY for a door
	 * listed in {@link SECTION_FLOOR_ZERO_DOORS} — any other door asking floor 0
	 * is refused as `internal.invariant` before anything is read.
	 */
	readonly sectionFloor: 0 | 1 | 2;
	/**
	 * The MAIN a FIXED dataframe slot write belongs to (T0-4, owner decision 1:
	 * the frame's level IS its main's). Consulted ONLY when the component is a
	 * fixed slot (`isFixedDataframeSlot`, dd560) — a caller may pass it on every
	 * write. `{ mainTipo }`: the one main the frame pairs with (the save door's
	 * `source.caller_dataframe.main_component_tipo`, raw — the door validates it).
	 * `{ everyMain: true }`: a whole-slot write (a section-record restore) — bound
	 * by EVERY component of the section whose model declares the slot. Absent on
	 * a fixed-slot write → `request.invalid_source`: never a silent 2.
	 */
	readonly frameOf?: FrameOf;
}

/** Which main(s) bound a fixed dataframe slot write — see {@link RecordAccessOptions.frameOf}. */
export type FrameOf = { readonly mainTipo: unknown } | { readonly everyMain: true };

/** What the fixed-slot bound reads of a door's options: the named main(s) and the door id. */
type FrameOptions = Pick<RecordAccessOptions, 'frameOf' | 'door'>;

/**
 * The ONLY doors that may skip the SECTION half (`sectionFloor: 0`) — the human
 * save door and its twin, the text_area tag delete (the same inline-edit write
 * on the same component: PHP component_common::save asks the component only,
 * and inline editing of a subdatum portal TARGET depends on it). Converging
 * them to 1 is an owner-review item of WC-2026-09-30-write-door; they change
 * together or not at all. SHRINK-ONLY: write_door_native pins this list, and
 * {@link authorizeRecordAccess} refuses floor 0 for every door not on it, so a
 * new caller cannot skip the section half silently.
 */
export const SECTION_FLOOR_ZERO_DOORS: readonly string[] = Object.freeze([
	'save',
	'dd_component_text_area_api.delete_tag',
]);

/** Floor 0 for an unlisted door is a programming error, refused loudly. */
function assertFloorAllowed(options: RecordAccessOptions): void {
	if (options.sectionFloor !== 0 || SECTION_FLOOR_ZERO_DOORS.includes(options.door)) return;
	throw new DedaloError('internal.invariant', {
		message: `${options.door}: sectionFloor 0 is reserved for the named doors (${SECTION_FLOOR_ZERO_DOORS.join(', ')})`,
		coordinates: { door: options.door },
	});
}

/** Step 1 of a record access: both tipos gated, the id an INTEGER (absent is refused). */
function parseRecordTarget(
	raw: { section_tipo: unknown; component_tipo?: unknown; section_id: unknown },
	door: string,
): Target & { sectionId: number } {
	const sectionTipo = gateTipo(raw.section_tipo, door, 'section_tipo');
	const componentTipo = gateComponent(raw.component_tipo, sectionTipo, door, 'component_tipo');
	const parsed = parseRecordId(raw.section_id);
	if (parsed.kind !== 'id') throw invalidRecordId(door, raw.section_id);
	return { sectionTipo, componentTipo, sectionId: parsed.id };
}

/** The ONE carve-out: an account editing its own self-editable components on its own record. */
function selfServiceOf(principal: Principal, target: Target): boolean {
	return (
		target.sectionId !== null &&
		isSelfServiceAccountWrite(principal, target.sectionTipo, target.componentTipo, target.sectionId)
	);
}

/** Step 2: the section grant at or above the floor (skipped for a self-service write). */
async function assertSectionFloor(
	principal: Principal,
	target: Target,
	floor: number,
	skip: boolean,
	door: string,
): Promise<void> {
	if (skip || floor <= 0) return;
	if ((await getSectionPermissions(principal, target.sectionTipo)) < floor) {
		throw levelShortfall(door, target, floor, 'section');
	}
}

/** Step 3: the pair — dd128-aware level on a write, the read door's law on a read. */
async function assertPair(
	principal: Principal,
	target: Target & { sectionId: number },
	options: RecordAccessOptions,
): Promise<void> {
	if (options.mode === 'read') {
		await authorizeComponentRead({ principal, door: options.door }, target);
		return;
	}
	const level = isFixedDataframeSlot(target.componentTipo)
		? await boundedFrameLevel(principal, target, options)
		: await getRecordComponentPermission(
				principal,
				target.sectionTipo,
				target.componentTipo,
				target.sectionId,
			);
	if (level < options.level) throw levelShortfall(options.door, target, options.level, 'component');
}

/** A value the identifier gate accepts as a tipo (no throw — the caller names the refusal). */
function isTipoSpelling(value: unknown): value is string {
	return typeof value === 'string' && isValidTipo(value);
}

/** The refusal of a fixed-slot write whose main is missing or not a valid main. */
function invalidFrameMain(door: string, target: Target, reason: string): DedaloError {
	return new DedaloError('request.invalid_source', {
		message: `${door}: the dataframe slot ${target.componentTipo} on ${target.sectionTipo} is written only through its main — ${reason}`,
		coordinates: { door, section_tipo: target.sectionTipo, tipo: target.componentTipo },
	});
}

/**
 * Is `mainTipo` a valid main of fixed slot `target.componentTipo` on this
 * section: a component OF the record's section (virtual-aware) whose model
 * declares the slot (a shared slot accepts any such model — F7).
 */
async function isValidFrameMain(mainTipo: string, target: Target): Promise<boolean> {
	if (!modelDeclaresFixedSlot(await getModelByTipo(mainTipo), target.componentTipo)) return false;
	return tipoBelongsToSection(mainTipo, target.sectionTipo);
}

/** Every component of the record's section that is a valid main of the slot. */
async function sectionMainsOfSlot(target: Target): Promise<string[]> {
	const realSection = await getSectionRealTipo(target.sectionTipo);
	const mains: string[] = [];
	for (const tipo of await getRecursiveChildrenTipos(realSection)) {
		if (modelDeclaresFixedSlot(await getModelByTipo(tipo), target.componentTipo)) mains.push(tipo);
	}
	return mains;
}

/** The main(s) `frameOf` names, validated — THROWS `request.invalid_source` otherwise. */
async function frameMainsOf(target: Target, options: FrameOptions): Promise<string[]> {
	const frameOf = options.frameOf;
	if (frameOf === undefined) throw invalidFrameMain(options.door, target, 'no main named');
	if ('everyMain' in frameOf) {
		const mains = await sectionMainsOfSlot(target);
		if (mains.length === 0) {
			throw invalidFrameMain(options.door, target, 'the section has no component declaring it');
		}
		return mains;
	}
	const mainTipo = frameOf.mainTipo;
	if (!isTipoSpelling(mainTipo) || !(await isValidFrameMain(mainTipo, target))) {
		throw invalidFrameMain(
			options.door,
			target,
			`main ${JSON.stringify(mainTipo ?? null)} is not a component of the section declaring the slot`,
		);
	}
	return [mainTipo];
}

/**
 * A FIXED dataframe slot's level: min(own 2, every main `options.frameOf` names,
 * validated) — the frame IS its main's level (T0-4, owner decision 1). The write
 * door's pair and the direct-read doors ({@link sourceComponentLevel}) share it.
 */
async function boundedFrameLevel(
	principal: Principal,
	target: Target,
	options: FrameOptions,
): Promise<number> {
	let level = FIXED_FRAME_OWN_LEVEL;
	for (const mainTipo of await frameMainsOf(target, options)) {
		const mainLevel = await getRecordComponentPermission(
			principal,
			target.sectionTipo,
			mainTipo,
			target.sectionId,
		);
		level = Math.min(level, mainLevel);
	}
	return level;
}

/**
 * THE LEVEL OF A RECORD-ADDRESSED SOURCE COMPONENT for a DIRECT READ door (Gate
 * A, dd_core_api.ts gateReadSource; the component get_data self-gate,
 * section/read_facade.ts; the get_data main stamp, section/read.ts) —
 * `getRecordComponentPermission`, except a FIXED dataframe slot (dd560), which
 * is bound by its MAIN exactly as the write door binds it (T0-4 A residual: the
 * slot's own 2 is a ceiling the main lowers, never a grant on its own):
 *   - a COMPLETE pairing (`source.caller_dataframe` main + id_key >= 1,
 *     `dataframePairingOf` — the read serves that main's frames only) → min(2,
 *     that main's level), the main validated first (`request.invalid_source`
 *     otherwise);
 *   - anything less (no main, a null main, a main without a valid id_key) — the
 *     read serves the WHOLE slot, every main's frames → min over EVERY main of
 *     the section declaring the slot (`everyMain`, the whole-slot bound).
 */
export async function sourceComponentLevel(
	principal: Principal,
	source: {
		section_tipo: string;
		tipo: string;
		section_id?: unknown;
		caller_dataframe?: unknown;
	},
	door: string,
): Promise<number> {
	const sectionId = source.section_id as number | string | null | undefined;
	if (!isFixedDataframeSlot(source.tipo)) {
		return getRecordComponentPermission(principal, source.section_tipo, source.tipo, sectionId);
	}
	// Only a COMPLETE pairing (main + id_key >= 1 — the read's own gate,
	// callerDataframePairing) narrows the read to ONE main's frames; anything
	// less serves the whole slot, every main's frames, so every main bounds it.
	const pairing = dataframePairingOf(
		source.caller_dataframe as { main_component_tipo?: unknown; id_key?: unknown } | null,
	);
	const frameOf: FrameOf =
		pairing === null ? { everyMain: true } : { mainTipo: pairing.main_component_tipo };
	const parsed = parseRecordId(sectionId);
	const target: Target = {
		sectionTipo: source.section_tipo,
		componentTipo: source.tipo,
		sectionId: parsed.kind === 'id' ? parsed.id : null,
	};
	return boundedFrameLevel(principal, target, { frameOf, door });
}

/** Step 4: the record scope — the non-positive-id refusal precedes the admin bypass in both modes. */
async function assertScope(
	principal: Principal,
	target: Target & { sectionId: number },
	mode: 'read' | 'write',
	selfService: boolean,
	door: string,
): Promise<void> {
	const { sectionTipo, sectionId } = target;
	if (mode === 'write') {
		await assertRecordWriteTarget(sectionTipo, sectionId, principal, door, {
			selfServiceAccountWrite: selfService,
		});
		return;
	}
	if (await principalCanAccessRecord(sectionTipo, sectionId, principal)) return;
	throw new DedaloError('perm.out_of_scope', {
		message: `${door}: ${sectionTipo}/${String(sectionId)} is not readable by the caller (out of scope, or not a record address)`,
		coordinates: { door, section_tipo: sectionTipo, section_id: sectionId },
	});
}

/**
 * Authorize ONE component of ONE existing record, in the fixed order of the
 * module header, and return the grant. THROWS on any refusal.
 */
export async function authorizeRecordAccess(
	principal: Principal,
	raw: { section_tipo: unknown; component_tipo?: unknown; section_id: unknown },
	options: RecordAccessOptions,
): Promise<RecordGrant> {
	const { door, mode, level } = options;
	assertFloorAllowed(options); // 0. the floor-0 exception is a closed list
	const target = parseRecordTarget(raw, door); // 1. grammar
	const selfService = mode === 'write' && selfServiceOf(principal, target);
	await assertSectionFloor(principal, target, options.sectionFloor, selfService, door); // 2.
	await assertPair(principal, target, options); // 3.
	await assertScope(principal, target, mode, selfService, door); // 4.
	// 5. Every grant field is TYPE-CHECKED before the brand is cast on: the cast
	// alone would accept a grant missing a field (e.g. its actor).
	const fields: Omit<RecordGrant, typeof grantBrand> = {
		...target,
		mode,
		level,
		door,
		userId: principal.userId,
	};
	return Object.freeze(fields) as RecordGrant;
}

/** Options for a section target. */
export interface SectionTargetOptions {
	/** The minimum level on the target (the pair when `tipo` is named, else the section). */
	readonly level: number;
	readonly door: string;
	/**
	 * The MAIN a FIXED dataframe slot target belongs to — as
	 * {@link RecordAccessOptions.frameOf}: consulted only when `tipo` is a fixed
	 * slot (dd560); absent there → `request.invalid_source` (an importer that
	 * KNOWS the frames' main — the CSV legacy envelope — names it; a door that
	 * cannot never gets a silent 2).
	 */
	readonly frameOf?: FrameOf;
}

/** The grammar of a section target: the id may be ABSENT (a create), never invalid. */
function parseSectionTarget(
	raw: { section_tipo: unknown; tipo?: unknown; section_id?: unknown },
	door: string,
): Target {
	const sectionTipo = gateTipo(raw.section_tipo, door, 'section_tipo');
	const componentTipo = gateComponent(raw.tipo, sectionTipo, door, 'tipo');
	const parsed = parseRecordId(raw.section_id);
	if (parsed.kind === 'invalid') throw invalidRecordId(door, raw.section_id);
	return { sectionTipo, componentTipo, sectionId: parsed.kind === 'id' ? parsed.id : null };
}

/**
 * The level a section target holds: a COMPONENT target needs the section at
 * least readable (the human read's Gate A/B) and is then judged on the pair —
 * dd128-aware when a record is named; a SECTION target on the section, ALWAYS
 * consultation-capped (`getSectionPermissions`): a create / duplicate / delete
 * / overwrite must not happen on a section the engine renders read-only
 * (Activity, Time Machine …), whichever door — tool kind, human or MCP — asks.
 * There is no uncapped variant: it was an option once, and the only callers
 * that declined it (the tool `tipo` / `targets` kinds) were the hole.
 */
async function sectionTargetLevel(
	principal: Principal,
	target: Target,
	options: SectionTargetOptions,
	selfService: boolean,
): Promise<number> {
	const { sectionTipo, componentTipo, sectionId } = target;
	if (componentTipo === sectionTipo) return getSectionPermissions(principal, sectionTipo);
	// A fixed dataframe slot is never a section target of its own: its level is
	// its main's (T0-4) — bound by the main the caller names (`frameOf`), else
	// refused, never a silent 2.
	if (isFixedDataframeSlot(componentTipo)) {
		if (options.frameOf === undefined) {
			throw invalidFrameMain(options.door, target, 'a section-target door names no main');
		}
		await assertSectionFloor(principal, target, 1, selfService, options.door);
		return boundedFrameLevel(principal, target, options);
	}
	await assertSectionFloor(principal, target, 1, selfService, options.door);
	return getRecordComponentPermission(principal, sectionTipo, componentTipo, sectionId);
}

/**
 * Authorize a SECTION target that may name a component (`tipo`) and may name a
 * record (`section_id`). An ABSENT id is a create: the level is its whole
 * authorization. A PRESENT id must be an integer and in scope — 0 and
 * negatives are refused by the scope step for every caller, admins included.
 * THROWS on any refusal.
 */
export async function authorizeSectionTarget(
	principal: Principal,
	raw: { section_tipo: unknown; tipo?: unknown; section_id?: unknown },
	options: SectionTargetOptions,
): Promise<SectionGrant> {
	return authorizeParsedSectionTarget(principal, parseSectionTarget(raw, options.door), options);
}

/** Proof that a section target naming ONE EXISTING record was authorized. */
export type SectionRecordGrant = SectionGrant & { readonly sectionId: number };

/**
 * Authorize a SECTION target that MUST name a record — a whole-record effect
 * (delete, duplicate, the tool `record` kind). The same level and scope as
 * {@link authorizeSectionTarget}, but an ABSENT id (undefined / null / '') is
 * refused as `request.invalid` here, by the door: a record-lifecycle door
 * cannot degrade into a section-level authorization with a null target when a
 * caller (or a skipped schema) drops the id. THROWS on any refusal.
 */
export async function authorizeSectionRecord(
	principal: Principal,
	raw: { section_tipo: unknown; tipo?: unknown; section_id: unknown },
	options: SectionTargetOptions,
): Promise<SectionRecordGrant> {
	const target = parseSectionTarget(raw, options.door);
	if (target.sectionId === null) throw invalidRecordId(options.door, raw.section_id);
	return (await authorizeParsedSectionTarget(principal, target, options)) as SectionRecordGrant;
}

/** The level, then the scope of a NAMED record — the shared body of both section-target doors. */
async function authorizeParsedSectionTarget(
	principal: Principal,
	target: Target,
	options: SectionTargetOptions,
): Promise<SectionGrant> {
	const { door, level: required } = options;
	const selfService = selfServiceOf(principal, target);
	const level = await sectionTargetLevel(principal, target, options, selfService);
	if (level < required) {
		const half = target.componentTipo === target.sectionTipo ? 'section' : 'component';
		throw levelShortfall(door, target, required, half);
	}
	if (target.sectionId !== null) {
		await assertScope(
			principal,
			{ ...target, sectionId: target.sectionId },
			'write',
			selfService,
			door,
		);
	}
	return Object.freeze({ ...target, level, door }) as SectionGrant;
}

/**
 * THE SECTION-LEVEL CREATE (see the header — the second create rule): the
 * consultation-capped SECTION level ≥ 2, nothing else. A thin, NAMED door over
 * {@link authorizeSectionTarget} with no record named, so the census
 * (create_door_census_tripwire, verdict `authorizes-section-create`) can see
 * which doors ask the section level as their create rule — never the New
 * button. Refusal: `perm.denied` 403 (or `request.invalid` on a bad tipo).
 */
export async function authorizeSectionCreate(
	principal: Principal,
	sectionTipo: unknown,
	options: { readonly door: string },
): Promise<SectionGrant> {
	return authorizeSectionTarget(
		principal,
		{ section_tipo: sectionTipo },
		{ level: 2, door: options.door },
	);
}

/**
 * Proof that a CREATE in a section was authorized ({@link authorizeRecordCreate}).
 * Names the button_new the decision read, so a refusal and a grant are both
 * traceable to one ontology node.
 */
export type SectionCreateGrant = Readonly<{
	[grantBrand]: true;
	sectionTipo: string;
	/** The section's first button_new (sectionButtonRows) — the create grant read. */
	buttonNewTipo: string;
	/** The section level (consultation-capped). */
	sectionLevel: number;
	/** The button_new level. */
	createLevel: number;
	door: string;
	/** The principal the grant was minted for — the created record's author. */
	userId: number;
}>;

/** The refusal of a create: one sentence per missing half, one code (perm.denied). */
function createRefused(
	door: string,
	sectionTipo: string,
	reason: string,
	coordinates: Record<string, unknown> = {},
): DedaloError {
	return new DedaloError('perm.denied', {
		message: `${door}: may not create a record in ${sectionTipo} — ${reason}`,
		coordinates: { door, section_tipo: sectionTipo, ...coordinates },
	});
}

/**
 * THE CREATE PREDICATE — "may `principal` create a record in `sectionTipo`?"
 * In this order, THROWING on the first refusal:
 *
 *   1. GRAMMAR  the tipo passes the identifier gate (`request.invalid`).
 *   2. SECTION  `getSectionPermissions >= 2` — consultation-capped, so Activity
 *               / Time Machine are refused here for everyone (D1 (b): a create
 *               the caller could not then edit is no create).
 *   3. BUTTON   the FIRST `button_new` of `sectionButtonRows(S)` exists — a
 *               section that offers no "New" admits no create, superuser
 *               INCLUDED (PHP null < 2);
 *   4. LEVEL    `getPermissions(principal, S, button_new) >= 2`.
 *
 * Every refusal is `perm.denied` (403). Two cached lookups (the ontology
 * button-row cache, the per-user permissions table). No module state.
 */
export async function authorizeRecordCreate(
	principal: Principal,
	sectionTipo: unknown,
	options: { readonly door: string },
): Promise<SectionCreateGrant> {
	const { door } = options;
	const tipo = gateTipo(sectionTipo, door, 'section_tipo');
	const sectionLevel = await getSectionPermissions(principal, tipo);
	if (sectionLevel < 2) {
		// Names the SECTION as the refused tipo (as levelShortfall's section half does).
		throw createRefused(door, tipo, 'the section grant is below 2', { tipo, required: 2 });
	}
	const buttonNewTipo =
		(await sectionButtonRows(tipo)).find((row) => row.model === 'button_new')?.tipo ?? null;
	if (buttonNewTipo === null) {
		throw createRefused(door, tipo, 'the section offers no button_new');
	}
	const createLevel = await getPermissions(principal, tipo, buttonNewTipo);
	if (createLevel < 2) {
		throw createRefused(door, tipo, `the button_new grant ${buttonNewTipo} is below 2`, {
			tipo: buttonNewTipo,
			required: 2,
		});
	}
	return Object.freeze({
		sectionTipo: tipo,
		buttonNewTipo,
		sectionLevel,
		createLevel,
		door,
		userId: principal.userId,
	}) as SectionCreateGrant;
}
