/**
 * THE HOST-COMPONENT READ — a component's OWN get_data of ONE host record is a
 * read of that HOST, never a read of the component's target sections
 * (WC-2026-11-09-component-get-data-host-gate).
 *
 * THE PROBLEM. Gate B (api/handlers/dd_core_api.ts gateReadTargets) demands a
 * read grant on every `sqo.section_tipo`. For a portal's refresh / page read
 * (`source.action: 'get_data'`) those sections are only the component's TARGETS
 * — the client copies them from the component's context — while the data read
 * is the HOST record's component value. A user who reads the host record and
 * the component but holds no grant on one target section saw the portal rows
 * in the section read (the embedded slice, with the subdatum raise) and got
 * perm.denied on the very same component's own refresh.
 *
 * THE DECISION. Such a read is gated as a read of the host, and SERVED as the
 * host read serves the component: the component is the COLUMN NODE of the host
 * section's own map in the read's mode — the section read's ROOT
 * (relations/element_node.ts rootNodeFor, built by the verified section-root
 * chain: relations/caller_chain.ts sectionMapNode, STEP 11 applied) — with the
 * children that map injects into it. The admission does not shape data: it
 * hands the read a SERVER-DERIVED rqo (`HostComponentRead.rqo`) whose
 * `source.callers` is that section root and which carries no client config
 * (`show` / `search` / `choose` dropped), so the ONE get_data emission
 * (section/read_facade.ts → read.ts readComponentDataEmission) resolves the
 * same node the section read resolved: same columns, same nested targets, same
 * per-ddo levels / subdatum raise. What the client sent as `show` / `callers`
 * is IGNORED on this path — a borrowed chain (another component whose config
 * names this one) and the component's bare own config (wider than what its
 * section injects) are both replaced by the derived node.
 *
 * NEVER A DOOR TO A TARGET SECTION. Admitted ONLY when every fact below holds,
 * each re-derived on the server; anything else gets Gate B's refusal as before:
 *   - `source.type === 'component'`, `source.action === 'get_data'`;
 *   - the source addresses ONE real record of ours (a positive matrix id the
 *     principal can access — record_scope.ts principalCanAccessRecord); a
 *     synthetic / temporal / external / TM-preview source never qualifies, and
 *     no source key substitutes what is read (`properties`, `matrix_id`,
 *     `data_source`, `tm_surface`);
 *   - the mode is one a column renders in (`edit` | `list`, absent = `edit`)
 *     and the lang a non-empty one (absent = the request's data lang) — '' is
 *     refused, and the derived rqo carries the NORMALIZED pair, so the
 *     admission and the read resolve the same node;
 *   - `source.tipo` is a COMPONENT of `source.section_tipo` (virtual-aware
 *     tipoBelongsToSection) AND a column of the host section's map in that
 *     mode, gated STEP 11 as the section read gates it (the section-root chain
 *     verifies) — so a column the principal holds 0 on is refused at both
 *     doors (the count door has no Gate A);
 *   - every `sqo.section_tipo` is a DEDALO target of that derived node — EXACT
 *     (writer_chain_scope.ts dedaloTargetsOf, never the virtual ↔ real
 *     equivalence);
 *   - the sqo is a plain page of the host: `filter_by_locators` is EXACTLY the
 *     host locator, and no key beyond the page / order vocabulary carries a
 *     value (no filter, no mode — never a TM or related read —, no select…).
 *     The count door counts under this same sqo, so a count can only ever
 *     reach the host locator.
 *
 * Gate: test/unit/component_get_data_target_grant_native.test.ts.
 */

import type { Ddo } from '../concepts/ddo.ts';
import { compareLocators, type Locator } from '../concepts/locator.ts';
import { isTemporalSource, type Rqo, type RqoSource } from '../concepts/rqo.ts';
import { canonicalizeStoredSectionId } from '../concepts/section_id.ts';
import type { Principal } from './permissions.ts';

/** The sqo keys a host-component page may carry with a value (everything else must be empty). */
const PAGE_SQO_KEYS: ReadonlySet<string> = new Set([
	'id',
	'section_tipo',
	'limit',
	'offset',
	'total',
	'full_count',
	'order',
	'view_order',
	'filter_by_locators',
	'filter_by_locators_op',
	'parsed',
]);

/** The rqo source keys that substitute what the component reads (never admitted here). */
const OVERRIDE_SOURCE_KEYS = ['properties', 'matrix_id', 'data_source', 'tm_surface'] as const;

/** The rqo blocks a client config rides on — dropped from the derived rqo. */
const CLIENT_CONFIG_BLOCKS = ['show', 'search', 'choose'] as const;

/** The modes a column of a section map renders in (caller_chain.ts ROOT_MODES). */
const COLUMN_MODES: ReadonlySet<string> = new Set(['edit', 'list']);

/** The rqo pieces the admission reads. */
type HostReadRequest = Pick<Rqo, 'source' | 'sqo' | 'show' | 'search' | 'choose'>;

/** An admitted host-component read: the rqo the read door must serve instead of the client's. */
export interface HostComponentRead {
	readonly rqo: Rqo;
}

/** The host component a request addresses (its shape and sqo proven). */
interface HostComponent {
	readonly tipo: string;
	readonly sectionTipo: string;
	readonly sectionId: number;
	readonly mode: string;
	readonly lang: string;
}

/** A wire value that carries nothing (null, undefined, false, an empty array). */
function isEmptyValue(value: unknown): boolean {
	if (Array.isArray(value)) return value.length === 0;
	return value === null || value === undefined || value === false;
}

/** A non-empty string (a wire field that names something). */
function isNamed(value: unknown): value is string {
	return typeof value === 'string' && value !== '';
}

/** The source is a COMPONENT's get_data naming a component of a section (not the section itself). */
function isComponentGetDataSource(source: Record<string, unknown>): boolean {
	return [
		source.type === 'component',
		source.action === 'get_data',
		isNamed(source.tipo),
		isNamed(source.section_tipo),
		source.tipo !== source.section_tipo,
	].every(Boolean);
}

/** The request is a component's own get_data with no source key substituting what it reads. */
function isOwnGetDataShape(source: Record<string, unknown>): boolean {
	return [
		isComponentGetDataSource(source),
		// A TEMPORAL instance addresses no record (WC-059; its scratch scope rides it).
		!isTemporalSource(source as RqoSource),
		OVERRIDE_SOURCE_KEYS.every((key) => isEmptyValue(source[key])),
	].every(Boolean);
}

/** The read's mode, normalized (absent = 'edit'), or null: '' or a mode no column renders in. */
function columnModeOf(source: Record<string, unknown>): string | null {
	const mode = source.mode === undefined ? 'edit' : source.mode;
	return typeof mode === 'string' && COLUMN_MODES.has(mode) ? mode : null;
}

/** The read's data lang, normalized (absent = the request's), or null for ''. */
async function dataLangOf(source: Record<string, unknown>): Promise<string | null> {
	if (source.lang === undefined) {
		const { currentDataLang } = await import('../resolve/request_lang.ts');
		return currentDataLang();
	}
	return isNamed(source.lang) ? source.lang : null;
}

/** Every sqo key outside the page vocabulary carries nothing; the locator join is OR. */
function isPageVocabularyOnly(sqo: Record<string, unknown>): boolean {
	const op = sqo.filter_by_locators_op;
	return (
		Object.entries(sqo).every(([key, value]) => PAGE_SQO_KEYS.has(key) || isEmptyValue(value)) &&
		(isEmptyValue(op) || op === 'OR')
	);
}

/** The locator properties a host pin is matched on (the locator law, locator.ts). */
const HOST_PIN_PROPERTIES: readonly string[] = ['section_tipo', 'section_id'];

/**
 * `pin` is exactly `{section_tipo, section_id}` naming the host record. The
 * pin's id is canonicalized FIRST and must come out a record address (an int,
 * or its one strict decimal spelling '5'): the locator law then compares two
 * ints, so its loose-numeric rule cannot admit another spelling ('0x5', '5.0',
 * [5]) of the host id — the pin admits exactly what the section read emits.
 */
function isHostPin(pin: unknown, sectionTipo: string, sectionId: number): boolean {
	if (pin === null || typeof pin !== 'object') return false;
	const fields = pin as Record<string, unknown>;
	const pinnedId = canonicalizeStoredSectionId(fields.section_id);
	return [
		Object.keys(fields).every((key) => HOST_PIN_PROPERTIES.includes(key)),
		typeof pinnedId === 'number',
		compareLocators(
			{ section_tipo: fields.section_tipo, section_id: pinnedId } as Locator,
			{ section_tipo: sectionTipo, section_id: sectionId },
			HOST_PIN_PROPERTIES,
		),
	].every(Boolean);
}

/** The sqo pages the host record only: exact host pin, nothing but the page vocabulary. */
function isHostPageSqo(
	sqo: Record<string, unknown>,
	sectionTipo: string,
	sectionId: number,
): boolean {
	const pins = sqo.filter_by_locators;
	return (
		isPageVocabularyOnly(sqo) &&
		Array.isArray(pins) &&
		pins.length === 1 &&
		isHostPin(pins[0], sectionTipo, sectionId)
	);
}

/** The source's REAL record id (a positive matrix address), or null for any other kind. */
async function hostRecordId(sectionTipo: string, rawId: unknown): Promise<number | null> {
	const { classifyWireSectionId } = await import('../concepts/section_id.ts');
	const { isErrorInDomain } = await import('../errors/dedalo_error.ts');
	try {
		const classified = await classifyWireSectionId(
			rawId,
			sectionTipo,
			'rqo.get_data.host_component_read',
		);
		return classified.kind === 'record' && classified.id >= 1 ? classified.id : null;
	} catch (error) {
		// Probe catch (CONVENTIONS.md): an unusable id addresses no host record.
		if (isErrorInDomain(error, 'section_id')) return null;
		throw error;
	}
}

/** The normalized (mode, lang) pair the admission and the read share — null when either is refused. */
async function modeLangOf(
	source: Record<string, unknown>,
): Promise<{ mode: string; lang: string } | null> {
	const mode = columnModeOf(source);
	const lang = await dataLangOf(source);
	return mode === null || lang === null ? null : { mode, lang };
}

/** The host component the request pages, its mode / lang normalized — or null. */
async function addressedHost(request: HostReadRequest): Promise<HostComponent | null> {
	const source = (request.source ?? {}) as Record<string, unknown>;
	if (request.sqo === undefined || !isOwnGetDataShape(source)) return null;
	const modeLang = await modeLangOf(source);
	if (modeLang === null) return null;
	const { mode, lang } = modeLang;
	const sectionTipo = source.section_tipo as string;
	const sectionId = await pinnedHostRecordId(request, sectionTipo, source.section_id);
	if (sectionId === null) return null;
	return { tipo: source.tipo as string, sectionTipo, sectionId, mode, lang };
}

/** The source record id when the sqo pins exactly that record as its page — else null. */
async function pinnedHostRecordId(
	request: HostReadRequest,
	sectionTipo: string,
	rawSectionId: unknown,
): Promise<number | null> {
	const sectionId = await hostRecordId(sectionTipo, rawSectionId);
	if (sectionId === null) return null;
	return isHostPageSqo(request.sqo as Record<string, unknown>, sectionTipo, sectionId)
		? sectionId
		: null;
}

/**
 * `tipo` is a component of (possibly virtual) `sectionTipo`: its model, or
 * null. Its READ grant is not asked here: it is the host map's STEP 11 gate
 * (caller_chain.ts sectionMapNode drops every column the actor holds 0 on,
 * exactly as the section read does), so a component the read would not embed
 * has no column node and is refused by derivedTargetsOf — one decision, the
 * section read's, at both doors (the count door has no Gate A).
 */
async function hostComponentModel(host: HostComponent): Promise<string | null> {
	const { getModelByTipo, tipoBelongsToSection } = await import('../ontology/resolver.ts');
	const model = await getModelByTipo(host.tipo);
	if (model === null || !model.startsWith('component_')) return null;
	return (await tipoBelongsToSection(host.tipo, host.sectionTipo)) ? model : null;
}

/** The section-root chain the host read stands the component under (caller_chain.ts header). */
function sectionRootCallers(host: HostComponent): Record<string, string>[] {
	return [{ tipo: host.sectionTipo, section_tipo: host.sectionTipo, mode: host.mode }];
}

/**
 * The component's DEDALO target sections as the COLUMN NODE of the host
 * section's gated map — resolved exactly as the get_data door resolves it from
 * the derived rqo (read.ts readComponentDataUnflagged: the read's mode, lang,
 * owner record, the verified chain's parent node) — or null when the host map
 * has no column for it in that mode (the chain is refused).
 */
async function derivedTargetsOf(
	principal: Principal,
	host: HostComponent,
	model: string,
): Promise<string[] | null> {
	const { resolveCallerChain } = await import('../relations/caller_chain.ts');
	const chain = await resolveCallerChain({
		callers: sectionRootCallers(host),
		targetTipo: host.tipo,
		targetSectionTipo: host.sectionTipo,
		lang: host.lang,
		principal,
	});
	if (chain === null) return null;
	const { resolveElement } = await import('../relations/element_node.ts');
	const { ElementNodeRegistry } = await import('../relations/element_registry.ts');
	const node = await resolveElement({
		ddo: {
			tipo: host.tipo,
			section_tipo: host.sectionTipo,
			parent: 'self',
			mode: host.mode,
		} as Ddo,
		parentNode: chain.parentNode,
		ownerSectionTipo: host.sectionTipo,
		ownerSectionId: host.sectionId,
		mode: host.mode,
		lang: host.lang,
		registry: new ElementNodeRegistry(),
		model,
		principal,
	});
	const { dedaloTargetsOf } = await import('./writer_chain_scope.ts');
	return dedaloTargetsOf(node);
}

/**
 * The SERVER-DERIVED rqo of an admitted read (module header): the client's,
 * with the client config blocks dropped and the source re-rooted at the host
 * section's map, mode and lang normalized.
 */
function derivedRqo(request: HostReadRequest, host: HostComponent): Rqo {
	const rqo = structuredClone(request) as Rqo & Record<string, unknown>;
	for (const block of CLIENT_CONFIG_BLOCKS) delete rqo[block];
	rqo.source = {
		...rqo.source,
		mode: host.mode,
		lang: host.lang,
		callers: sectionRootCallers(host),
	};
	return rqo;
}

/**
 * Gate B's host-component admission (module header): the derived rqo the read
 * must serve, when the request is the component's own get_data of one
 * readable host record and every sqo section is a target of the component's
 * column node in the host's map — else null (Gate B refuses as before).
 */
export async function admitHostComponentRead(
	principal: Principal,
	request: HostReadRequest,
): Promise<HostComponentRead | null> {
	const host = await addressedHost(request);
	if (host === null || request.sqo === undefined) return null;
	const targets = await hostColumnTargets(principal, host);
	if (targets === null) return null;
	const { getSectionTipos } = await import('../concepts/sqo.ts');
	const requested = getSectionTipos(request.sqo);
	const admitted = requested.length > 0 && requested.every((section) => targets.includes(section));
	return admitted ? { rqo: derivedRqo(request, host) } : null;
}

/**
 * WHAT A HOST RECORD'S SECTION READ SHOWS FOR ONE RELATION COLUMN — the
 * export's display carve-out (frontier_scope.ts, owner decision D4,
 * WC-2026-11-09-export-relation-display): the records the read EXPANDED under
 * the column and the (section, component) pairs it emitted there.
 */
export interface HostColumnDisplay {
	/** True when the read emitted at least one item AT this record. */
	hasRecord(sectionTipo: string, sectionId: number | string): boolean;
	/**
	 * True when the read emitted this component AT THIS RECORD — per record,
	 * never per section: a component shown at one record of a section is not
	 * shown at another one (a record displayed in one position with its label
	 * is not displayed with a field the read shows only at its siblings).
	 */
	hasComponent(sectionTipo: string, sectionId: number | string, componentTipo: string): boolean;
	/**
	 * True when the read emitted, AT the owner record, this exact dataframe
	 * entry (frame slot, main component, pair key, frame target) — a frame is
	 * displayed per entry, never per slot: the read emits a slot item at an
	 * owner with only the frames paired to the main items it shows.
	 */
	hasFrame(sectionTipo: string, sectionId: number | string, frame: DisplayedFrame): boolean;
}

/** One dataframe entry as {@link HostColumnDisplay.hasFrame} is asked about it. */
export interface DisplayedFrame {
	readonly frameTipo: string;
	readonly mainTipo: string;
	readonly pairId: number | string;
	readonly sectionTipo: string;
	readonly sectionId: number | string;
}

/** One host column, addressed for {@link hostColumnDisplay}. */
export interface HostColumnAddress {
	readonly sectionTipo: string;
	readonly sectionId: number;
	readonly tipo: string;
	readonly lang: string;
}

/** A record's display key, on its CANONICAL address (an int; an external id verbatim). */
const displayKey = (sectionTipo: string, sectionId: unknown): string =>
	`${sectionTipo}\u0000${String(canonicalizeStoredSectionId(sectionId))}`;

/**
 * A frame entry's display key, at its owner record: (owner, main component,
 * frame slot, pair key, frame target).
 */
const frameKey = (owner: string, frame: DisplayedFrame): string =>
	[
		owner,
		frame.mainTipo,
		frame.frameTipo,
		pairKeyText(frame.pairId),
		displayKey(frame.sectionTipo, frame.sectionId),
	].join('\u0001');

/** A pair key as the pairing compares it (subdatum.ts: Number(id_key) === Number(id)). */
function pairKeyText(pairId: number | string): string {
	const numeric = Number(pairId);
	return Number.isFinite(numeric) ? String(numeric) : String(pairId);
}

/** An entry's pair key (`id_key`), or null when it carries none (not a frame). */
function pairKeyOf(entry: Record<string, unknown>): number | string | null {
	const pairId = entry.id_key;
	return typeof pairId === 'number' || typeof pairId === 'string' ? pairId : null;
}

/**
 * The record an entry targets, on its CANONICAL address (canonicalizeStoredSectionId:
 * an int; an external id verbatim) — or null when it names no record (no
 * section_tipo string, or an id that is neither an int nor a string).
 */
function frameTargetOf(
	entry: Record<string, unknown>,
): Pick<DisplayedFrame, 'sectionTipo' | 'sectionId'> | null {
	const sectionId = canonicalizeStoredSectionId(entry.section_id);
	const named = typeof sectionId === 'number' || typeof sectionId === 'string';
	return typeof entry.section_tipo === 'string' && named
		? { sectionTipo: entry.section_tipo, sectionId }
		: null;
}

/** One emitted entry as a displayed frame of slot `frameTipo`, or null. */
function asDisplayedFrame(frameTipo: string, entry: unknown): DisplayedFrame | null {
	if (entry === null || typeof entry !== 'object') return null;
	const frame = entry as Record<string, unknown>;
	const pairId = pairKeyOf(frame);
	const target = frameTargetOf(frame);
	if (pairId === null || target === null) return null;
	return { frameTipo, mainTipo: String(frame.main_component_tipo ?? ''), pairId, ...target };
}

/** The display key of the record an item was emitted AT, or null (no address / no tipo). */
function emittedAt(item: DisplayItem): string | null {
	if (typeof item.section_tipo !== 'string' || typeof item.tipo !== 'string') return null;
	if (item.section_id === null || item.section_id === undefined) return null;
	return displayKey(item.section_tipo, item.section_id);
}

/** The dataframe entries an emitted item carries (entries with a pair key). */
function emittedFrames(item: DisplayItem): DisplayedFrame[] {
	const entries = Array.isArray(item.entries) ? item.entries : [];
	return entries
		.map((entry) => asDisplayedFrame(String(item.tipo), entry))
		.filter((frame): frame is DisplayedFrame => frame !== null);
}

/**
 * THE DISPLAY OF ONE RELATION COLUMN, derived from the read itself — never a
 * second notion of "display" (WC-2026-11-09-export-relation-display). It runs
 * the SAME admission + emission the host-component get_data runs (module
 * header): the column node of the host section's EDIT map (STEP 11 gated, so a
 * column the principal holds 0 on has no display — null), served through the
 * one get_data emission (read.ts readComponentDataEmission) with the
 * server-derived rqo, paged to the end (pagination is presentation: the user
 * pages through every target). What it emitted IS the display: every record
 * an item was emitted AT (the targets the read expanded, at every depth it
 * expanded them — a target the read did not expand is not displayed), and
 * every (record, component) it emitted, keyed PER RECORD (a child the read
 * refused — component key 0 — emits nothing, so it is not displayed either),
 * and every dataframe ENTRY it emitted at its owner record.
 *
 * The read answers for the AMBIENT principal (read.ts reads currentPrincipal),
 * so the ambient principal MUST be `principal`: a mismatch is an invariant
 * breach, refused loudly rather than answered for the wrong user.
 */
export async function hostColumnDisplay(
	principal: Principal,
	column: HostColumnAddress,
): Promise<HostColumnDisplay | null> {
	const { currentPrincipal } = await import('./request_context.ts');
	const ambient = currentPrincipal();
	if (ambient?.userId !== principal.userId) {
		const { DedaloError } = await import('../errors/dedalo_error.ts');
		throw new DedaloError('internal.invariant', {
			message: `hostColumnDisplay: the ambient principal (${String(ambient?.userId)}) is not the asking principal (${principal.userId}) — the read would answer for another user`,
		});
	}
	const host: HostComponent = { ...column, mode: 'edit' };
	const targets = await hostColumnTargets(principal, host);
	if (targets === null) return null;
	const records = new Set<string>();
	const shown = new Set<string>();
	const frames = new Set<string>();
	await forEachDisplayPage(host, targets, (items) => {
		for (const item of items) {
			const record = emittedAt(item);
			if (record === null) continue;
			records.add(record);
			shown.add(`${record}\u0000${String(item.tipo)}`);
			for (const frame of emittedFrames(item)) frames.add(frameKey(record, frame));
		}
	});
	return {
		hasRecord: (sectionTipo, sectionId) => records.has(displayKey(sectionTipo, sectionId)),
		hasComponent: (sectionTipo, sectionId, componentTipo) =>
			shown.has(`${displayKey(sectionTipo, sectionId)}\u0000${componentTipo}`),
		hasFrame: (sectionTipo, sectionId, frame) =>
			frames.has(frameKey(displayKey(sectionTipo, sectionId), frame)),
	};
}

/** One emitted item, as {@link hostColumnDisplay} reads it. */
interface DisplayItem {
	readonly section_tipo?: unknown;
	readonly section_id?: unknown;
	readonly tipo?: unknown;
	readonly entries?: unknown;
	readonly pagination?: { total?: unknown };
}

/**
 * Page the host column's get_data to the end, handing each page's items to
 * `visit`. The page size is the client ceiling (the read clamps to it anyway);
 * the column's own item carries the total.
 */
async function forEachDisplayPage(
	host: HostComponent,
	targets: readonly string[],
	visit: (items: readonly DisplayItem[]) => void,
): Promise<void> {
	const { CLIENT_MAX_LIMIT } = await import('../concepts/sqo.ts');
	const { readComponentDataEmission } = await import('../section/read.ts');
	for (let offset = 0; ; offset += CLIENT_MAX_LIMIT) {
		const request = {
			source: {
				type: 'component',
				action: 'get_data',
				tipo: host.tipo,
				section_tipo: host.sectionTipo,
				section_id: host.sectionId,
			},
			sqo: {
				section_tipo: [...targets],
				filter_by_locators: [{ section_tipo: host.sectionTipo, section_id: host.sectionId }],
				limit: CLIENT_MAX_LIMIT,
				offset,
			},
		} as unknown as HostReadRequest;
		const produced = await readComponentDataEmission(derivedRqo(request, host));
		const items = produced.items as readonly DisplayItem[];
		visit(items);
		const own = items.find(
			(item) => item.tipo === host.tipo && item.section_tipo === host.sectionTipo,
		);
		const total = Number(own?.pagination?.total ?? 0);
		if (!Number.isFinite(total) || offset + CLIENT_MAX_LIMIT >= total) return;
	}
}

/**
 * The column node's targets when the principal can access the host record and
 * the tipo is a component of the host section with a node in its map — else null.
 */
async function hostColumnTargets(
	principal: Principal,
	host: HostComponent,
): Promise<string[] | null> {
	const { principalCanAccessRecord } = await import('./record_scope.ts');
	if (!(await principalCanAccessRecord(host.sectionTipo, host.sectionId, principal))) return null;
	const model = await hostComponentModel(host);
	return model === null ? null : derivedTargetsOf(principal, host, model);
}
