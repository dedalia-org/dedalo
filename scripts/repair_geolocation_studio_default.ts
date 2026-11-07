/**
 * ============================================================================
 * GEOLOCATION STUDIO-DEFAULT REPAIR — removes the map VIEW the CLIENT
 * fabricated from its factory map position.
 * ============================================================================
 *
 * THE RULE THIS SCRIPT IMPLEMENTS (the v6 migration's rule, stated plainly):
 *
 *   - item is ONLY the studio default (no features) → REMOVE it; the record
 *     ends with no geolocation at all.
 *   - item has features and its VIEW is the studio default → FIT THE VIEW TO
 *     THE GEOMETRY: rewrite lat/lon to the bbox centre of the item's own
 *     features. Features, zoom, alt, id and every other key are untouched.
 *   - item carries a MAP DEFINITION (a `sources` or a `legend` that is PRESENT —
 *     anything but the gate's own "none": absent, null, `[]`, an empty legend —
 *     whatever its type; geo/geo_entry_keys.ts carriesMapDefinition) → UNTOUCHED,
 *     whatever its view: it is content somebody wrote, never a fabrication.
 *   - anything else → UNTOUCHED. `alt` is real data some installs use; it is
 *     removed only as part of removing a default-only item.
 *
 * THE MODEL
 * component_geolocation stores, per item, {id?, lat, lon, zoom, alt?, lib_data?}
 * in the matrix `geo` column. lat/lon/zoom are THE VIEW — the map framing, and
 * nothing more; `lib_data` holds the FEATURES — drawn geometry. The two are
 * INDEPENDENT: features do not determine the view, and a view asserts no
 * feature. An operator pans and zooms to frame the space they need to see, so
 * the useful view is often nowhere near any single feature.
 *
 * WHAT IS BROKEN
 * Until the client fix, the edit view SEEDED self.current_value[0] at render
 * with a hardcoded map centre — the STUDIO DEFAULT, lat 39.462571 /
 * lon -0.376295, the Dédalo facilities' own position shipped as the client's
 * factory map position — and the save button consulted no dirty signal. So
 * merely OPENING a record and pressing save stored a view nobody chose.
 * Publication withholds exactly that pair (isStudioDefault, one door only), but
 * the fabricated view is still in the store, edited and migrated like real data.
 * This script takes it out.
 *
 * This script imports NOTHING from src/diffusion, so it can run before or after
 * any diffusion change; the coordinate normalization it needs is inlined below,
 * for the same reason the studio-default literals are.
 *
 * FITTING THE VIEW IS NOT AUTHORING A LOCATION
 * When a fabricated view sits on an item that carries features, clearing the
 * view would discard framing for work that exists, and keeping it frames the
 * studio instead of the work. So the repair FITS THE VIEW TO THE GEOMETRY: the
 * bbox centre of every feature across the item's lib_data layers. That is what
 * a view is for. It asserts no feature and claims no location — it is the frame
 * the operator would have landed on. For a single drawn Point — the commonest
 * case by far — the fitted view is EXACTLY that point (a one-position bbox has
 * its own coordinate as its centre; the code returns the position verbatim,
 * unrounded, when min === max). If the geometry yields no usable position the
 * item is HELD, never guessed.
 *
 * WHY A SCRIPT, NOT ONE UPDATE
 * The pair alone does not tell you what to DO with an item. A real share of the
 * items whose view is the studio default carry hand-drawn features (a lib_data
 * layer with a non-empty FeatureCollection — e.g. an 11-vertex LineString), and
 * that work must survive the repair. A blanket `WHERE lat = 39.462571` DESTROYS
 * it. The candidate test must inspect lib_data per item — and coordinates are
 * stored MIXED, as strings AND as numbers in the same column, so every
 * comparison normalizes first. The predicates are exported and gated:
 * test/unit/geolocation_studio_default_repair.test.ts.
 *
 * NOT REVERSIBLE — BE HONEST
 * One recordTimeMachine row per repaired component records the TRANSITION. It
 * does NOT make the old value restorable: on the development copy this was
 * built against, matrix_time_machine held NO row carrying the studio default.
 * Do not read that as a guarantee for other installs — assume there is nothing
 * to restore from, and nothing to purge (hence no --purge-tm flag). Removal is
 * irreversible and that is the intent.
 *
 * ============================================================================
 * (!) THERE IS NO ACCIDENTAL TRUE POSITIVE
 * ============================================================================
 * 39.462571/-0.376295 is NOT "the city of Valencia". It is the STUDIO DEFAULT:
 * the coordinates of the Dédalo facilities, shipped as the client's factory map
 * position. An item holding EXACTLY that pair is therefore always fabricated —
 * nobody frames a map on the studio to six decimals — and exact equality is a
 * sound fabrication test. A record merely NAMED after the studio's city is
 * fabricated like any other: the pair is a factory default, not a place. There
 * is no place-name test here, and there must never be one again.
 *
 * MODIFIED STAMPS — DELIBERATELY NOT WRITTEN
 * Every component write through the save pipeline also stamps the record's
 * dd197/dd201 modified-by/modified-date. This repair does NOT, and that is a
 * decision, not an oversight. A mechanical sweep is not an edit: stamping it
 * would overwrite the real curation signal ("who last worked this record, and
 * when") on every repaired record with a bulk timestamp, which is precisely
 * the harm save_component's own `skipModifiedStamp` flag exists to avoid on
 * the import path. The transition IS audited — one matrix_time_machine row per
 * repaired component, attributed to the MANDATORY --user (there is no default:
 * a falsified actor on an irreversible sweep is worse than a refusal to run).
 *
 * ============================================================================
 * WHAT THIS SCRIPT DELIBERATELY DOES NOT TOUCH
 * ============================================================================
 * The ZERO CLUSTER: es1 hierarchy31 items stored at lat 0 / lon 0 (about a
 * thousand on the development copy this was built against — treat the figure as
 * illustrative, not as a population count). That is a SECOND fabrication
 * cluster (Null Island, published through tp_spain), and 0 is a LEGAL
 * coordinate — so it is indistinguishable, mechanically, from a deliberate one.
 * It is NOT in the studio-default predicate and never will be: conflating two
 * fabrications is how the first one stayed hidden for years. It is a separate
 * curatorial decision, ledgered as a known-open gap (rewrite/LEDGER.md,
 * "geolocation zero cluster").
 *
 * SCOPE + SAFETY
 * - `--table` and `--user` are BOTH MANDATORY. There is no "sweep everything"
 *   invocation. Only tables in APPLY_ADJUDICATED accept --apply; every
 *   allowlisted table accepts the read-only dry-run, which is how the evidence
 *   for an adjudication gets gathered.
 * - Tipos come from the ONTOLOGY (dd_ontology model='component_geolocation'),
 *   never a hardcoded list.
 * - HELD, never touched: a default-only item sharing the component with a real
 *   item (MIXED — key removal is all-or-nothing), and features from which no
 *   position can be extracted (NO_POSITION).
 * - Writes go through updateMatrixKeysData(…, 'geo', tipo, …): the `#-`
 *   key-removal form (CLEAR) and the single-key set form (FIT_VIEW) touch ONLY
 *   this component's key, so a concurrent write to another component in the
 *   same column is never clobbered. NEVER updateMatrixRecord.
 * - TOCTOU CLOSED: discovery is an unlocked scan, so the verdict it produces is
 *   a PLAN, never an authority to write. Inside the per-record transaction the
 *   key is re-read under a FOR UPDATE row lock (readMatrixKeyForUpdate) and
 *   adjudicated AGAIN on the freshly locked value; the write uses the locked
 *   items, not the scanned ones. A coordinate committed between the scan and
 *   the write makes the verdict change, and the record is SKIPPED and reported
 *   as "changed under us" — never silently destroyed.
 * - 0 affected rows = the record was deleted underneath us: FAIL LOUD.
 * - After --apply the discovery re-runs and the gate compares held/fitted
 *   IDENTITIES, not counts. Not green ⇒ EXIT 1 (a printed warning is not a gate).
 *
 * USAGE (dry-run is the default; it lists every candidate, fit and hold):
 *
 *     bun scripts/repair_geolocation_studio_default.ts --table matrix --user 1
 *     bun scripts/repair_geolocation_studio_default.ts --table matrix --user 1 --apply
 */

// Side-effect: registers the component-model lookup the ontology resolver
// requires (standalone scripts must do what the server entrypoint does).
import '../src/core/components/registry.ts';
import { dbTimestamp } from '../src/core/db/db_timestamp.ts';
import { searchDdOntology } from '../src/core/db/dd_ontology.ts';
import { MATRIX_TABLE_ALLOWLIST } from '../src/core/db/matrix.ts';
import { readMatrixKeyForUpdate, updateMatrixKeysData } from '../src/core/db/matrix_write.ts';
import { sql, withTransaction } from '../src/core/db/postgres.ts';
import { recordTimeMachine } from '../src/core/db/time_machine.ts';
import { carriesMapDefinition } from '../src/core/geo/geo_entry_keys.ts';

/**
 * The ex-factory client map position. Defined HERE, not imported from the core
 * leaf: this one-shot repair must keep matching the historical fabricated value
 * independently of anything the engine later does with the pair.
 */
const STUDIO_DEFAULT_LAT = 39.462571;
const STUDIO_DEFAULT_LON = -0.376295;

/** geolocation is not translatable — its TM rows are stamped lg-nolan. */
const GEO_LANG = 'lg-nolan';

/**
 * Tables this script is allowed to WRITE. Membership is a decision about the
 * SHAPE of the data (which tipos hold geolocation values, and that the studio
 * default is fabricated wherever it appears) — never about a count.
 *
 *  - `matrix` — the record store: numisdata264 / tchi25 / numisdata213 / rsc900.
 *  - `matrix_hierarchy` — the thesaurus store, all under the single tipo
 *    `hierarchy31`, which every thesaurus section inherits from the shared
 *    section_group hierarchy29 (which is why "kneeling" and "Alabama" carry
 *    coordinates at all). Owner-authorised 2026-08-09.
 *
 * (!) COUNTS ARE NOT AN AUTHORISATION, AND NO FIGURE HERE IS A FACT ABOUT ANY
 * OTHER INSTALL. Every figure in this file's history was measured against
 * `dedalo_mib_v7`, which the owner has identified as a DIRTY DEVELOPMENT COPY:
 * a site copy carrying local edits, not a canonical install. Those numbers
 * described that one database on that one day. They are not a population
 * characterisation, not an expected value, and not a gate: another install will
 * differ, and a differing count is information, not a failure. Read the
 * dry-run, do not reconcile it against a remembered number.
 */
const APPLY_ADJUDICATED: readonly string[] = ['matrix', 'matrix_hierarchy'];

interface Args {
	apply: boolean;
	userId: number;
	table: string;
}

function usage(message: string): never {
	console.error(`repair_geolocation_studio_default: ${message}`);
	console.error(
		'usage: bun scripts/repair_geolocation_studio_default.ts --table <name> --user <id> [--apply]',
	);
	console.error(`  --table  MANDATORY, one of: ${MATRIX_TABLE_ALLOWLIST.join(', ')}`);
	console.error(`           --apply is accepted only for: ${APPLY_ADJUDICATED.join(', ')}`);
	console.error('  --user   MANDATORY, the operator id stamped on every time-machine row');
	process.exit(1);
}

export function parseArgs(argv: string[]): Args {
	let apply = false;
	let userId: number | null = null;
	let table: string | null = null;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		switch (arg) {
			case '--apply':
				apply = true;
				break;
			case '--user': {
				const value = Number(argv[++index]);
				if (!Number.isInteger(value) || value <= 0) usage('--user must be a positive integer');
				userId = value;
				break;
			}
			case '--table': {
				const value = argv[++index] ?? usage('--table needs a table name');
				if (!MATRIX_TABLE_ALLOWLIST.includes(value)) usage(`table '${value}' is not allowlisted`);
				table = value;
				break;
			}
			default:
				usage(`unknown argument '${arg}'`);
		}
	}
	// MANDATORY, both. There is no implicit scope and no implicit actor on a
	// sweep that destroys heritage data irreversibly.
	if (table === null) usage('--table is mandatory (there is no sweep-everything invocation)');
	if (userId === null) usage('--user is mandatory (time-machine attribution is never guessed)');
	if (apply && !APPLY_ADJUDICATED.includes(table)) {
		// NOT "edit the constant". Editing it is the LAST step of an adjudication,
		// and the constant carries the evidence for every table already in it —
		// an entry without that provenance block is the refusal defeating itself.
		usage(
			`--apply is not authorised for table '${table}': its studio-default population has not ` +
				'been adjudicated. An adjudication is a written, measured artifact — the population ' +
				'shape, the geometry/mixed/time-machine counts, what publishes today — reviewed by a ' +
				'human and recorded as the provenance block beside APPLY_ADJUDICATED, with the ' +
				'expected clear/fit/held split. Until that exists, dry-run only: it is how the ' +
				'evidence gets gathered.',
		);
	}
	return { apply, userId, table };
}

// ---------------------------------------------------------------------------
// THE CANDIDATE TEST — the load-bearing part. A false positive here is
// unrecoverable data loss (every item of hand-drawn geometry depends on it).
// Exported and gated by test/unit/geolocation_studio_default_repair.test.ts.
// ---------------------------------------------------------------------------

/**
 * Comma-decimal → dot, as text; non string/number → null. Inlined (not imported
 * from a core leaf) for the same reason the studio-default literals are.
 */
function normalizeCoordinate(raw: unknown): string | null {
	if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null;
	if (typeof raw !== 'string') return null;
	const text = raw.trim().replace(/,/g, '.');
	return text === '' ? null : text;
}

/** Canonical decimal text of a stored coordinate, or null when there is none. */
export function coordKey(raw: unknown): string | null {
	const text = normalizeCoordinate(raw);
	if (text === null) return null;
	const value = Number(text);
	return Number.isFinite(value) ? String(value) : null;
}

const STUDIO_DEFAULT_LAT_KEY = String(STUDIO_DEFAULT_LAT);
const STUDIO_DEFAULT_LON_KEY = String(STUDIO_DEFAULT_LON);

/** True iff the item's VIEW normalizes to exactly the fabricated pair. */
export function isStudioDefaultView(item: Record<string, unknown>): boolean {
	return (
		coordKey(item.lat) === STUDIO_DEFAULT_LAT_KEY && coordKey(item.lon) === STUDIO_DEFAULT_LON_KEY
	);
}

/**
 * True iff the item carries operator-drawn FEATURES: a lib_data layer whose
 * layer_data is a FeatureCollection with at least one feature.
 * (A lib_data layer with layer_data:null is NOT geometry — such items are
 * default-only and clear like any other.)
 */
export function hasDrawnGeometry(item: Record<string, unknown>): boolean {
	const libData = item.lib_data;
	if (!Array.isArray(libData)) return false;
	for (const layer of libData) {
		const layerData = (layer as { layer_data?: { features?: unknown } } | null)?.layer_data;
		const features = layerData?.features;
		if (Array.isArray(features) && features.length > 0) return true;
	}
	return false;
}

/** Every [lon, lat] position reachable from a GeoJSON coordinates/geometry tree. */
function collectPositions(node: unknown, out: [number, number][]): void {
	if (!Array.isArray(node)) return;
	const lon = coordKey(node[0]);
	const lat = coordKey(node[1]);
	if (lon !== null && lat !== null && !Array.isArray(node[0]) && !Array.isArray(node[1])) {
		out.push([Number(lon), Number(lat)]);
		return;
	}
	for (const child of node) collectPositions(child, out);
}

function collectGeometryPositions(geometry: unknown, out: [number, number][]): void {
	if (geometry === null || typeof geometry !== 'object') return;
	const node = geometry as { coordinates?: unknown; geometries?: unknown };
	collectPositions(node.coordinates, out);
	if (Array.isArray(node.geometries)) {
		for (const child of node.geometries) collectGeometryPositions(child, out);
	}
}

/** Every position of every feature across every lib_data layer of one item. */
export function itemPositions(item: Record<string, unknown>): [number, number][] {
	const out: [number, number][] = [];
	const libData = item.lib_data;
	if (!Array.isArray(libData)) return out;
	for (const layer of libData) {
		const features = (layer as { layer_data?: { features?: unknown } } | null)?.layer_data
			?.features;
		if (!Array.isArray(features)) continue;
		for (const feature of features) {
			collectGeometryPositions((feature as { geometry?: unknown } | null)?.geometry, out);
		}
	}
	return out;
}

/** Half a degree-millionth ≈ 0.1 m — the precision the client itself stores. */
function round6(value: number): number {
	return Number(value.toFixed(6));
}

/**
 * FIT THE VIEW TO THE GEOMETRY: the bbox centre of every position of every
 * feature across the item's lib_data layers, or null when no position can be
 * extracted (⇒ the item is HELD, never guessed). An axis whose min equals its
 * max is returned VERBATIM and unrounded, so a single drawn Point fits to
 * exactly itself.
 *
 * This is a VIEW, not a location claim: the map frame that shows the work.
 */
export function fitViewToGeometry(
	item: Record<string, unknown>,
): { lat: number; lon: number } | null {
	const positions = itemPositions(item);
	if (positions.length === 0) return null;
	let minLon = Number.POSITIVE_INFINITY;
	let maxLon = Number.NEGATIVE_INFINITY;
	let minLat = Number.POSITIVE_INFINITY;
	let maxLat = Number.NEGATIVE_INFINITY;
	for (const [lon, lat] of positions) {
		if (lon < minLon) minLon = lon;
		if (lon > maxLon) maxLon = lon;
		if (lat < minLat) minLat = lat;
		if (lat > maxLat) maxLat = lat;
	}
	return {
		lat: minLat === maxLat ? minLat : round6((minLat + maxLat) / 2),
		lon: minLon === maxLon ? minLon : round6((minLon + maxLon) / 2),
	};
}

/**
 * Human evidence for a FIT_VIEW/HOLD: what was actually drawn (geometry types +
 * vertex counts) and the view the studio default encoded. The dry-run must let
 * a reviewer SEE the user work being handled, not just count it.
 */
export function describeGeometry(item: Record<string, unknown>): string {
	const shapes: string[] = [];
	const libData = Array.isArray(item.lib_data) ? item.lib_data : [];
	for (const layer of libData as { layer_data?: { features?: unknown[] } }[]) {
		for (const raw of layer?.layer_data?.features ?? []) {
			const geometry = (raw as { geometry?: { type?: string; coordinates?: unknown } } | null)
				?.geometry;
			const positions: [number, number][] = [];
			collectGeometryPositions(geometry, positions);
			shapes.push(`${geometry?.type ?? '?'}(${positions.length} vertices)`);
		}
	}
	return `drawn ${shapes.join(' + ')}; the studio default was the stored view (zoom ${String(item.zoom)}, alt ${String(item.alt)})`;
}

export type Verdict = 'CLEAR' | 'FIT_VIEW' | 'HOLD';
export type HoldReason = 'MIXED' | 'NO_POSITION';

export interface Outcome {
	verdict: Verdict;
	reason?: HoldReason;
	detail?: string;
	/** FIT_VIEW only: the rewritten item array to store. */
	value?: unknown[];
}

/**
 * Adjudicate ONE component's item array. Item classes: BARE (studio-default
 * view, no features, no map definition), GEO (studio-default view + features),
 * OTHER (anything else — an item carrying `sources` / `legend` included).
 *
 *  - null     : no studio-default view at all — not our business.
 *  - CLEAR    : every item is BARE ⇒ remove the whole key.
 *  - FIT_VIEW : GEO items and no BARE item ⇒ rewrite the array, fitting each
 *               GEO item's lat/lon to the bbox centre of its own features and
 *               leaving OTHER items and every other key untouched.
 *  - HOLD/NO_POSITION : a GEO item whose features yield no position — never
 *               guess, never clear.
 *  - HOLD/MIXED       : a BARE item sits beside anything else. Key removal is
 *               all-or-nothing, and dropping array elements would renumber the
 *               survivors, so this needs a human.
 */
export function adjudicate(items: unknown[]): Outcome | null {
	let bare = 0;
	let geo = 0;
	let other = 0;
	let detail = '';
	const value: unknown[] = [];

	for (const raw of items) {
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
			other++;
			value.push(raw);
			continue;
		}
		const item = raw as Record<string, unknown>;
		if (!isStudioDefaultView(item)) {
			other++;
			value.push(item);
			continue;
		}
		// A map definition (`sources` / `legend`) is content the operator WROTE, never a
		// fabrication (WC-2026-11-06-geolocation-map-sources-legend): an item that
		// carries one is not default-only, so CLEAR can never delete it. It is left
		// exactly as it is (its fabricated view, if any, stays a human decision —
		// publication still refuses the pair).
		if (carriesMapDefinition(item)) {
			other++;
			value.push(item);
			continue;
		}
		if (!hasDrawnGeometry(item)) {
			bare++;
			value.push(item);
			continue;
		}
		geo++;
		const view = fitViewToGeometry(item);
		if (view === null) {
			return {
				verdict: 'HOLD',
				reason: 'NO_POSITION',
				detail: `studio-default view on an item whose features yield no position — ${describeGeometry(item)}`,
			};
		}
		if (detail === '') {
			detail = `${describeGeometry(item)}; view fitted to ${view.lat}/${view.lon}`;
		}
		value.push({ ...item, lat: view.lat, lon: view.lon });
	}

	if (bare === 0 && geo === 0) return null;
	if (bare > 0 && (geo > 0 || other > 0)) {
		return {
			verdict: 'HOLD',
			reason: 'MIXED',
			detail: `${bare} default-only item(s) share the component with ${geo + other} other item(s); key removal is all-or-nothing`,
		};
	}
	if (geo > 0) return { verdict: 'FIT_VIEW', detail, value };
	return { verdict: 'CLEAR' };
}

// ---------------------------------------------------------------------------
// Discovery + apply
// ---------------------------------------------------------------------------

export interface Unit {
	table: string;
	sectionTipo: string;
	sectionId: number;
	componentTipo: string;
	itemCount: number;
	verdict: Verdict;
	reason?: HoldReason;
	detail?: string;
	/** FIT_VIEW only, PLAN ONLY — the apply path recomputes under the row lock. */
	plannedValue?: unknown[];
}

interface Discovery {
	clear: Unit[];
	fit: Unit[];
	held: Unit[];
	scannedRows: number;
	scannedItems: number;
}

async function discover(geoTipos: Set<string>, table: string): Promise<Discovery> {
	const clear: Unit[] = [];
	const fit: Unit[] = [];
	const held: Unit[] = [];
	let scannedRows = 0;
	let scannedItems = 0;

	const rows = (await sql.unsafe(
		`SELECT section_tipo, section_id, geo::text AS geo_text
		 FROM "${table}" WHERE geo IS NOT NULL AND geo::text NOT IN ('{}', 'null')
		 ORDER BY section_tipo, section_id`,
	)) as unknown as {
		section_tipo: string;
		section_id: number;
		geo_text: string;
	}[];

	for (const row of rows) {
		scannedRows++;
		let geo: Record<string, unknown>;
		try {
			geo = JSON.parse(row.geo_text) as Record<string, unknown>;
		} catch {
			console.log(`  note: ${table} ${row.section_tipo}/${row.section_id}: unparseable geo column`);
			continue;
		}
		for (const [componentTipo, rawItems] of Object.entries(geo)) {
			if (!geoTipos.has(componentTipo)) continue;
			const items = Array.isArray(rawItems) ? rawItems : [rawItems];
			if (items.length === 0) continue;
			scannedItems += items.length;
			const outcome = adjudicate(items);
			if (outcome === null) continue;
			const unit: Unit = {
				table,
				sectionTipo: row.section_tipo,
				sectionId: Number(row.section_id),
				componentTipo,
				itemCount: items.length,
				verdict: outcome.verdict,
				reason: outcome.reason,
				detail: outcome.detail,
				plannedValue: outcome.value,
			};
			if (outcome.verdict === 'CLEAR') clear.push(unit);
			else if (outcome.verdict === 'FIT_VIEW') fit.push(unit);
			else held.push(unit);
		}
	}
	return { clear, fit, held, scannedRows, scannedItems };
}

function label(unit: Unit): string {
	return `${unit.table} ${unit.sectionTipo}/${unit.sectionId} ${unit.componentTipo} (${unit.itemCount} item(s))`;
}

function identities(units: Unit[]): string[] {
	return units.map(label).sort();
}

function sameIdentities(a: Unit[], b: Unit[]): boolean {
	const left = identities(a);
	const right = identities(b);
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Repair ONE unit inside its own transaction, re-adjudicating the value under a
 * FOR UPDATE row lock (TOCTOU: the scan's verdict is a plan, not an authority).
 * Returns what actually happened.
 *
 * Exported for the destructive-half gate
 * (test/unit/geolocation_studio_default_repair_apply.test.ts), which drives it on a
 * scratch surface — the row lock, the re-adjudication, the fail-loud aborts and
 * the FIT_VIEW array write are the most destructive code in the change and are
 * tripwired, not described.
 */
export async function repairUnit(unit: Unit, userId: number): Promise<'done' | 'changed'> {
	return await withTransaction(async () => {
		const locked = await readMatrixKeyForUpdate(
			unit.table,
			unit.sectionTipo,
			unit.sectionId,
			'geo',
			unit.componentTipo,
		);
		if (locked === null) {
			// Record deleted underneath us — never continue silently (S2-02).
			throw new Error(
				`repair_geolocation_studio_default: record vanished mid-run for ${label(unit)}; ABORTING`,
			);
		}
		// Re-run the SAME adjudication on the freshly locked value. Anything that
		// changed since the scan (a coordinate saved by an operator, the key
		// emptied, a non-array value the lock read flattens) changes the verdict.
		const outcome = adjudicate(locked);
		if (outcome === null || outcome.verdict !== unit.verdict) return 'changed';

		const write =
			outcome.verdict === 'CLEAR'
				? { column: 'geo' as const, key: unit.componentTipo, value: null }
				: { column: 'geo' as const, key: unit.componentTipo, value: outcome.value };
		const affected = await updateMatrixKeysData(unit.table, unit.sectionTipo, unit.sectionId, [
			write,
		]);
		if (affected === 0) {
			throw new Error(
				`repair_geolocation_studio_default: 0 rows affected for ${label(unit)} — the record vanished mid-run; ABORTING`,
			);
		}
		// Audit the transition. NOT the record's dd197/dd201 stamps — see header.
		await recordTimeMachine(
			{
				sectionTipo: unit.sectionTipo,
				sectionId: unit.sectionId,
				componentTipo: unit.componentTipo,
				lang: GEO_LANG,
				userId,
				data: outcome.verdict === 'CLEAR' ? [] : (outcome.value ?? []),
			},
			dbTimestamp(),
		);
		return 'done';
	});
}

/** Returns the process exit code: 0 green, 1 not green. */
async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));

	// DISCOVERY: the tipo set comes from the ontology, never a literal list.
	const geoTipos = new Set(await searchDdOntology({ model: 'component_geolocation' }));
	if (geoTipos.size === 0) {
		usage("no dd_ontology rows with model='component_geolocation' — wrong database?");
	}

	console.log(
		`repair_geolocation_studio_default — studio default ${STUDIO_DEFAULT_LAT}/${STUDIO_DEFAULT_LON}, ` +
			`${geoTipos.size} geolocation tipo(s), table ${args.table}, user ${args.userId}, ` +
			`mode ${args.apply ? 'APPLY' : 'DRY-RUN'}`,
	);

	const found = await discover(geoTipos, args.table);
	console.log(
		`\nscanned ${found.scannedRows} record(s) with a geo column / ${found.scannedItems} geolocation item(s)`,
	);

	console.log(`\nHELD — needs a human, never touched (${found.held.length}):`);
	for (const unit of found.held) {
		console.log(`  HOLD ${unit.reason} ${label(unit)}: ${unit.detail}`);
	}

	console.log(
		`\nFIT_VIEW — fabricated view refitted to the item's own features (${found.fit.length}):`,
	);
	for (const unit of found.fit) {
		console.log(`  FIT_VIEW ${label(unit)}: ${unit.detail}`);
	}

	console.log(`\nCLEAR — fabricated view, no features: removable (${found.clear.length}):`);
	for (const unit of found.clear) {
		console.log(`  CLEAR ${label(unit)}`);
	}

	// Per-tipo summary: the listings above are thousands of lines on a populated
	// surface, and the blast radius per component is what a reviewer signs off.
	const summary = new Map<string, { clear: number; fit: number; hold: number }>();
	for (const [units, field] of [
		[found.clear, 'clear'],
		[found.fit, 'fit'],
		[found.held, 'hold'],
	] as const) {
		for (const unit of units) {
			const key = `${unit.table} ${unit.componentTipo}`;
			const row = summary.get(key) ?? { clear: 0, fit: 0, hold: 0 };
			row[field]++;
			summary.set(key, row);
		}
	}
	console.log('\nBY TABLE + COMPONENT TIPO (clear / fit_view / held):');
	for (const [key, row] of [...summary].sort((a, b) => b[1].clear - a[1].clear)) {
		console.log(`  ${key}: ${row.clear} / ${row.fit} / ${row.hold}`);
	}

	if (!args.apply) {
		console.log(
			`\nDRY-RUN complete: ${found.clear.length} would be removed, ${found.fit.length} would have ` +
				`the view fitted to their features, ${found.held.length} held. Re-run with --apply.`,
		);
		return 0;
	}

	// --- APPLY -------------------------------------------------------------
	let cleared = 0;
	let fitted = 0;
	const changedUnderUs: Unit[] = [];
	for (const unit of [...found.clear, ...found.fit]) {
		const result = await repairUnit(unit, args.userId);
		if (result === 'changed') {
			changedUnderUs.push(unit);
			console.log(`  SKIPPED (changed under us) ${label(unit)}`);
			continue;
		}
		if (unit.verdict === 'CLEAR') cleared++;
		else fitted++;
		console.log(`  APPLIED ${unit.verdict} ${label(unit)}`);
	}
	console.log(
		`\ncleared ${cleared}, fitted ${fitted}, held ${found.held.length}, ` +
			`skipped ${changedUnderUs.length}.`,
	);

	// Post-repair gate — IDENTITIES, not counts.
	const after = await discover(geoTipos, args.table);
	// A fit whose view IS the studio default (features drawn exactly on the
	// ex-factory position) is already correct and legitimately re-appears.
	const expectedFit = found.fit.filter(
		(unit) => adjudicate(unit.plannedValue ?? [])?.verdict === 'FIT_VIEW',
	);
	const clearGreen = after.clear.length === 0;
	const fitGreen = sameIdentities(after.fit, expectedFit);
	const heldGreen = sameIdentities(after.held, found.held);
	const skipGreen = changedUnderUs.length === 0;
	const green = clearGreen && fitGreen && heldGreen && skipGreen;
	console.log(
		`post-repair audit: ${after.clear.length} fabricated view(s) remaining (want 0), ` +
			`${after.fit.length} fittable remaining (want ${expectedFit.length}), ` +
			`held identities ${heldGreen ? 'unchanged' : 'CHANGED'}, ` +
			`${changedUnderUs.length} skipped — ${green ? 'GATE GREEN' : 'GATE RED, investigate'}`,
	);
	if (!green) {
		for (const unit of changedUnderUs) console.error(`  RED changed-under-us: ${label(unit)}`);
		for (const identity of identities(after.held)) {
			if (!identities(found.held).includes(identity)) console.error(`  RED new hold: ${identity}`);
		}
		for (const identity of identities(found.held)) {
			if (!identities(after.held).includes(identity)) console.error(`  RED lost hold: ${identity}`);
		}
	}
	return green ? 0 : 1;
}

// Entrypoint only — importing this module (the predicate gate does) must not run
// the sweep.
if (import.meta.main) {
	process.exit(await main());
}
