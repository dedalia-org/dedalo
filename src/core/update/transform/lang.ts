/**
 * change_data_lang / lang_to_nolan (move_lang) executor — re-key one
 * component's data across languages, or to no-lang (UPDATE_PROCESS Phase 5).
 * PHP walks the legacy `datos.components`; here the component data lives in a
 * typed column keyed by component tipo — the port re-keys the lang inside that
 * column's per-tipo object AND the matrix_time_machine `lang` column
 * (WC-025 functional port). Activity/TM suppression is structural (no TM write).
 *
 * A row where BOTH languages already hold a value is REFUSED and reported, never
 * overwritten (defect ledger D5, fixed 2026-08-09 —
 * engineering/wire_contract/WC-2026-08-09-move-lang-collision-refused.md).
 */

import { config } from '../../../config/config.ts';
import { MATRIX_JSONB_COLUMNS, MATRIX_TABLE_ALLOWLIST } from '../../db/matrix.ts';
import { sql } from '../../db/postgres.ts';
import type { LangMoveItem } from './definitions.ts';
import type { TransformRecorder } from './report.ts';
import { scalarCount } from './sql_util.ts';

const TIPO_RE = /^[a-z]+[0-9]+$/;
const LANG_RE = /^lg-[a-z]{2,}$/;
const NOLAN = 'lg-nolan';

export async function executeMoveLang(
	rawItems: unknown,
	recorder: TransformRecorder,
): Promise<void> {
	const items = Array.isArray(rawItems) ? (rawItems as LangMoveItem[]) : [];
	// lang-law-exempt(update.move_lang.default_lang): an UPDATE transform runs with no request (the update runner); the legacy un-langed data it re-keys was written in the install main data lang
	const dataLangDefault = config.lang.dataLangDefault;

	for (const item of items) {
		const tipo = item.component_tipo;
		if (!TIPO_RE.test(tipo ?? '')) {
			recorder.error(`move_lang: invalid component tipo ${tipo}`);
			continue;
		}
		const fromLang = item.to_nolan ? dataLangDefault : (item.from_lang ?? dataLangDefault);
		const toLang = item.to_nolan ? NOLAN : (item.to_lang ?? NOLAN);
		if (!LANG_RE.test(fromLang) || (toLang !== NOLAN && !LANG_RE.test(toLang))) {
			recorder.error(`move_lang: invalid lang ${fromLang}→${toLang}`);
			continue;
		}

		// Component data lives in one of the typed columns keyed by tipo → lang.
		// Re-key the lang property inside that per-tipo object across every
		// matrix table that could carry it. jsonb path: <column> -> tipo -> lang.
		for (const table of MATRIX_TABLE_ALLOWLIST) {
			if (table === 'matrix_counter' || table === 'matrix_counter_dd') continue;
			for (const column of MATRIX_JSONB_COLUMNS) {
				await rekeyLang(table, column, tipo, fromLang, toLang, recorder);
			}
		}

		// matrix_time_machine lang column (PHP change_data_lang TM tail).
		await rekeyTimeMachineLang(tipo, fromLang, toLang, recorder);
	}
}

/** Re-label the moved component's Time Machine history rows (PHP TM tail). */
async function rekeyTimeMachineLang(
	tipo: string,
	fromLang: string,
	toLang: string,
	recorder: TransformRecorder,
): Promise<void> {
	const detail = (rows: number) => `lang ${fromLang}→${toLang} (${rows})`;
	if (recorder.dryRun) {
		const count = await scalarCount(
			'SELECT count(*)::int AS count FROM matrix_time_machine WHERE tipo = $1 AND lang = $2',
			[tipo, fromLang],
		);
		if (count > 0)
			recorder.record({
				op: 'update',
				table: 'matrix_time_machine',
				target: tipo,
				detail: detail(count),
			});
		return;
	}
	const rows = (await sql.unsafe(
		'UPDATE matrix_time_machine SET lang = $1 WHERE tipo = $2 AND lang = $3 RETURNING id',
		[toLang, tipo, fromLang],
	)) as unknown[];
	if (rows.length > 0)
		recorder.record({
			op: 'update',
			table: 'matrix_time_machine',
			target: tipo,
			detail: detail(rows.length),
		});
}

/**
 * Count, and REFUSE, the rows where BOTH languages are populated.
 *
 * D5 (FIXED 2026-08-09) — `jsonb_set(col #- [tipo,from], [tipo,to], …)` tested
 * only the SOURCE key, so an existing target-lang value was overwritten with no
 * error, no report line and (transforms suppress the Time Machine by
 * construction) no undo. On a multilingual install — exactly the case a lang
 * consolidation is run for — that silently destroyed the target language's
 * content for every record carrying both. REFUSAL, not merge, is the landing
 * point: per-language component payloads have no defined merge semantics, and
 * the portalize precedent (WC-2026-08-09-portalize-portal-merge) applies
 * verbatim — never destroy what the transform did not create; where it cannot
 * merge safely, refuse the row and say so.
 *
 * Reported identically in dry run and execute, so the preview an operator gates
 * on predicts exactly what the run will refuse.
 */
async function reportLangCollisions(
	table: string,
	column: string,
	tipo: string,
	fromLang: string,
	toLang: string,
	recorder: TransformRecorder,
): Promise<void> {
	const count = await scalarCount(
		`SELECT count(*)::int AS count FROM "${table}"
		 WHERE "${column}" IS NOT NULL
		   AND "${column}" -> $1 -> $2 IS NOT NULL AND "${column}" -> $1 -> $3 IS NOT NULL`,
		[tipo, fromLang, toLang],
	);
	if (count === 0) return;
	recorder.error(
		`move_lang: ${count} row(s) in ${table}.${column} already carry ${tipo} ${toLang} — ${fromLang}→${toLang} refused there, both values left in place`,
	);
	recorder.record({
		op: 'refuse_collision',
		table,
		target: `${column}.${tipo}`,
		detail: `lang ${fromLang}→${toLang} collision (${count})`,
	});
}

/**
 * Move the `fromLang` key to `toLang` inside `<column> -> tipo` for every row
 * that carries it AND does not already hold the target key (D5). jsonb_set the
 * new key + remove the old, in one UPDATE.
 */
async function rekeyLang(
	table: string,
	column: string,
	tipo: string,
	fromLang: string,
	toLang: string,
	recorder: TransformRecorder,
): Promise<void> {
	// A no-op item (same lang both ends) must not read as a collision with itself.
	if (fromLang === toLang) return;
	await reportLangCollisions(table, column, tipo, fromLang, toLang, recorder);
	const movable = `"${column}" IS NOT NULL
		 AND "${column}" -> $1 -> $2 IS NOT NULL AND "${column}" -> $1 -> $3 IS NULL`;
	if (recorder.dryRun) {
		const count = await scalarCount(
			`SELECT count(*)::int AS count FROM "${table}" WHERE ${movable}`,
			[tipo, fromLang, toLang],
		);
		if (count > 0)
			recorder.record({
				op: 'update',
				table,
				target: `${column}.${tipo}`,
				detail: `lang ${fromLang}→${toLang} (${count})`,
			});
		return;
	}
	const rows = (await sql.unsafe(
		`UPDATE "${table}"
		 SET "${column}" = jsonb_set("${column}" #- ARRAY[$1::text, $2::text], ARRAY[$1::text, $3::text], "${column}" -> $1::text -> $2::text)
		 WHERE ${movable} RETURNING id`,
		[tipo, fromLang, toLang],
	)) as unknown[];
	if (rows.length > 0)
		recorder.record({
			op: 'update',
			table,
			target: `${column}.${tipo}`,
			detail: `lang ${fromLang}→${toLang} (${rows.length})`,
		});
}
