/**
 * THE TLD PACKAGE REGISTRY — tld → package, frozen at module load, and the ONE
 * calculation dispatcher the engine uses (widgets/calculation/calculation.ts
 * is its only importer outside src/tld/: engine_install_tld_tripwire leg 3).
 *
 * `process.file` / `process.fn` / `process.engine` are EDITABLE ONTOLOGY DATA.
 * Here they are LOOKUP KEYS matched against frozen tables — nothing is ever
 * resolved as a path, imported or read from disk (the earlier engine's
 * include-by-path, SEC-052, cannot exist here by construction). A key that
 * does not match THROWS `ontology.invalid_node` with coordinates an operator
 * can act on; it never returns null and never `[]`, because a typo in the
 * ontology must not look like "this record has no value".
 *
 * Adding a package: one directory under src/tld/, one import line here (the
 * src/external/registry.ts shape); leg 5 of the tripwire keeps the census and
 * this map equal.
 */

import type { CalculationFn } from '../core/components/component_info/widgets/calculation/fn_kit.ts';
import { CALCULATION_FUNCTIONS } from '../core/components/component_info/widgets/calculation/functions.ts';
import { DedaloError } from '../core/errors/dedalo_error.ts';
import { mdcat } from './mdcat/index.ts';
import type { TldPackage } from './types.ts';

/** ReadonlyMap: a frozen dispatch table, not a cache (module_state_tripwire). */
export const TLD_PACKAGES: ReadonlyMap<string, TldPackage> = new Map([[mdcat.tld, mdcat]]);

/** The ontology `process.file` of the GENERIC table (widgets/calculation/functions.ts). */
export const GENERIC_CALCULATION_FILE = '/calculation/formulas.ts';

/** The only `process.engine` this engine runs. */
export const CALCULATION_ENGINE = 'ts';

/**
 * A package fn may not shadow a generic name: `/calculation/formulas.ts` +
 * `final_total` and `/mdcat/…/mdcat.ts` + `summarize` must both refuse, which
 * only holds when the two name sets are disjoint. Asserted at load (a boot
 * refusal, the posture every registry takes); the tripwire's leg 4 catches it
 * statically first.
 */
function assertNoShadowing(packages: ReadonlyMap<string, TldPackage>): void {
	const generic = new Set(Object.keys(CALCULATION_FUNCTIONS));
	for (const pkg of packages.values()) {
		for (const [module, fns] of Object.entries(pkg.calculationModules)) {
			const shadowed = Object.keys(fns).filter((name) => generic.has(name));
			if (shadowed.length === 0) continue;
			throw new DedaloError('internal.invariant', {
				message: `TLD package '${pkg.tld}' module '${module}' shadows generic calculation fn(s): ${shadowed.join(', ')}`,
				coordinates: { tld: pkg.tld, module, fns: shadowed.join(',') },
			});
		}
	}
}
assertNoShadowing(TLD_PACKAGES);

/** The ontology-authored `process` block of one calculation ipo entry (unknown shape). */
export interface CalculationProcess {
	fn?: unknown;
	file?: unknown;
	engine?: unknown;
	options?: unknown;
}

/** Where the block sits, for the refusal's coordinates. */
export interface CalculationProcessAt {
	ipo_key: number;
}

function refuse(message: string, at: CalculationProcessAt, process: CalculationProcess): never {
	const coordinates: Record<string, string | number> = { ipo_key: at.ipo_key };
	for (const key of ['fn', 'file', 'engine'] as const) {
		const value = process[key];
		if (typeof value === 'string') coordinates[key] = value;
	}
	throw new DedaloError('ontology.invalid_node', {
		message: `calculation ipo[${at.ipo_key}]: ${message}`,
		coordinates,
	});
}

/** `/calculation/formulas.ts` → the generic table; `/<tld>/<module>.ts` → the package module. */
function selectTable(
	file: string,
	at: CalculationProcessAt,
	process: CalculationProcess,
): Readonly<Record<string, CalculationFn>> {
	if (file === GENERIC_CALCULATION_FILE) return CALCULATION_FUNCTIONS;
	const segments = file.slice(1, -'.ts'.length).split('/');
	const tld = segments[0] ?? '';
	const module = segments.slice(1).join('/');
	const pkg = TLD_PACKAGES.get(tld);
	if (pkg === undefined) {
		refuse(`process.file '${file}' names no TLD package '${tld}'`, at, process);
	}
	const table = pkg.calculationModules[module];
	if (table === undefined) {
		refuse(`process.file '${file}': package '${tld}' has no module '${module}'`, at, process);
	}
	return table;
}

/**
 * THE calculation dispatcher: the registered fn an ipo `process` block names,
 * or a loud refusal (ontology.invalid_node). Order:
 *  1. `fn` must be a string;
 *  2. `engine` must be `'ts'` — a PHP-era block (`engine:'php'`, or none) is
 *     refused: the ontology must be updated, there is no alias;
 *  3. `file` must be `/<…>.ts`;
 *  4. the file selects a table (generic, or a package's module);
 *  5. `fn` must be a key of THAT table — a generic file naming a TLD fn, or a
 *     TLD file naming a generic fn, lands here (no fallthrough).
 */
export function resolveCalculationFn(
	process: CalculationProcess,
	at: CalculationProcessAt,
): CalculationFn {
	const { fn, engine, file } = process;
	if (typeof fn !== 'string') refuse('declares no process.fn', at, process);
	if (engine !== CALCULATION_ENGINE) {
		refuse(
			`process.engine '${String(engine)}' is not '${CALCULATION_ENGINE}' — a PHP-era calculation definition is refused; update the ontology`,
			at,
			process,
		);
	}
	if (
		typeof file !== 'string' ||
		!file.startsWith('/') ||
		!file.endsWith('.ts') ||
		file.length < 5
	) {
		refuse(
			`process.file '${String(file)}' is not a '/<package>/…/<module>.ts' name (generic: '${GENERIC_CALCULATION_FILE}')`,
			at,
			process,
		);
	}
	const table = selectTable(file, at, process);
	if (!Object.hasOwn(table, fn)) {
		refuse(`process fn '${fn}' is not registered in '${file}'`, at, process);
	}
	return table[fn] as CalculationFn;
}
