/**
 * config_areas widget — TS-NATIVE persistence (the runtime deny/allow lists
 * live in the TS server's own state store; the PHP widget writes
 * config.local.php, which this server must not touch) behind the
 * byte-identical client contract: the `areas` catalog is the UNfiltered walk
 * (PHP area::get_all_areas — denied nodes INCLUDED, or the widget's own
 * chips/search lose them).
 */

import { AREAS_DENY_GUARDED_MODELS } from '../../concepts/area.ts';
import { sql } from '../../db/postgres.ts';
import { getModelByTipo } from '../../ontology/resolver.ts';
import { failAction, type WidgetModule, type WidgetResponse } from './support.ts';

/**
 * Root/admin/maintenance area tipos that may never be denied (anti-lockout).
 *
 * COVERAGE-EXEMPT, this reader and the `configAreasGetValue` panel spread below
 * (coverage plan §5.1; reason registered in engineering/crap_coverage_exempt.json):
 * a single-predicate `dd_ontology` model lookup and its panel projection. The
 * DECISIONS they feed — anti-lockout stripping, dedup and invalid classification —
 * are gated as PURE functions over an INJECTED guarded list
 * (`classifyAreaLists` / `configAreasMessage`, test/unit/area_lockout_lists_native.test.ts).
 * Asserting the query results instead would pin INSTALLED ontology content.
 */
async function getGuardedAreaTipos(): Promise<string[]> {
	// the guarded MODELS are the deny law's own list (concepts/area.ts) — the
	// static AREAS_DENY is guarded by the same one in applyAreasDeny
	const rows = (await sql.unsafe('SELECT tipo FROM dd_ontology WHERE model = ANY($1::text[])', [
		[...AREAS_DENY_GUARDED_MODELS],
	])) as { tipo: string }[];
	return rows.map((row) => row.tipo);
}

export interface AreaListClassification {
	areas_deny: string[];
	areas_allow: string[];
	invalid: string[];
	removed_guarded: string[];
}

/**
 * THE ANTI-LOCKOUT CLASSIFIER — pure, with the guarded list and the tipo
 * validity INJECTED (querying dd_ontology from a gate would pin installed
 * content instead of the decision).
 *
 * The two loops are ASYMMETRIC ON PURPOSE and must stay that way:
 *  - DENY: a guarded tipo (AREAS_DENY_GUARDED_MODELS: area_root /
 *    area_maintenance / area_admin) is diverted into `removed_guarded` and
 *    never reaches `areas_deny` (the walk's applyAreasDeny ignores one in the
 *    static AREAS_DENY too).
 *    Denying `area_maintenance` removes the very dashboard that could undo
 *    the denial — recovery is hand-editing ts_state.json on the server.
 *  - ALLOW: the SAME tipo survives into `areas_allow`. Allow-listing a
 *    guarded area is legitimate; a "cleanup" that unifies the loops breaks it.
 *
 * Every entry is coerced with String() BEFORE dedup, so the client's `12` and
 * `'12'` are one tipo, not two.
 */
export function classifyAreaLists(
	areasDeny: unknown[],
	areasAllow: unknown[],
	guarded: string[],
	isValidTipo: (tipo: string) => boolean,
): AreaListClassification {
	const out: AreaListClassification = {
		areas_deny: [],
		areas_allow: [],
		invalid: [],
		removed_guarded: [],
	};
	for (const raw of [...new Set(areasDeny.map(String))]) {
		if (!isValidTipo(raw)) {
			out.invalid.push(raw);
			continue;
		}
		if (guarded.includes(raw)) {
			out.removed_guarded.push(raw);
			continue;
		}
		out.areas_deny.push(raw);
	}
	for (const raw of [...new Set(areasAllow.map(String))]) {
		if (!isValidTipo(raw)) {
			out.invalid.push(raw);
			continue;
		}
		out.areas_allow.push(raw);
	}
	return out;
}

/** The save envelope's operator feedback — the suffixes are the only signal
 * that a requested denial was refused. */
export function configAreasMessage(removedGuarded: string[], invalid: string[]): string {
	return `OK. Configuration saved. Changes apply on the next request${
		removedGuarded.length === 0 ? '' : '. Protected areas cannot be denied and were kept enabled.'
	}${invalid.length === 0 ? '' : '. Invalid tipos were ignored.'}`;
}

/** PHP config_areas::prepare_lists — validate, strip guarded, dedup. */
async function prepareAreaLists(
	areasDeny: unknown[],
	areasAllow: unknown[],
): Promise<AreaListClassification> {
	const guarded = await getGuardedAreaTipos();
	// Resolve validity for every candidate up front so the classifier itself
	// stays synchronous and pure.
	const validTipos = new Set<string>();
	for (const tipo of new Set([...areasDeny, ...areasAllow].map(String))) {
		if ((await getModelByTipo(tipo)) !== null) validTipos.add(tipo);
	}
	return classifyAreaLists(areasDeny, areasAllow, guarded, (tipo) => validTipos.has(tipo));
}

async function configAreasGetValue(): Promise<WidgetResponse> {
	try {
		const { getAllAreas } = await import('../../api/handlers/menu.ts');
		const { getEffectiveAreasDeny, getEffectiveAreasAllow, isStateWritable } = await import(
			'../../resolve/server_state.ts'
		);
		const { config } = await import('../../../config/config.ts');
		return {
			data: {
				areas: await getAllAreas(),
				areas_deny: getEffectiveAreasDeny(config.menu.areasDeny),
				areas_allow: getEffectiveAreasAllow(),
				writable: isStateWritable(),
			},
		};
	} catch (error) {
		// The reason travels as `cause` (log / debug block), never on the wire.
		failAction('Error building the config_areas panel value', { cause: error });
	}
}

async function configAreasSave(options: Record<string, unknown>): Promise<WidgetResponse> {
	const prepared = await prepareAreaLists(
		Array.isArray(options.areas_deny) ? options.areas_deny : [],
		Array.isArray(options.areas_allow) ? options.areas_allow : [],
	);
	const { setServerState } = await import('../../resolve/server_state.ts');
	setServerState({ areas_deny: prepared.areas_deny, areas_allow: prepared.areas_allow });
	return { data: prepared, msg: configAreasMessage(prepared.removed_guarded, prepared.invalid) };
}

export const widget: WidgetModule = {
	spec: {
		id: 'config_areas',
		category: 'config',
		label: {
			kind: 'label_mark_fallback',
			key: 'config_areas',
			literal: 'Config areas (allow/deny)',
		},
	},
	apiActions: {
		save_config_areas: configAreasSave,
	},
	getValue: configAreasGetValue,
};
