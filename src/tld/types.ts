/**
 * TLD PACKAGE descriptor — what one `src/tld/<tld>/index.ts` exports.
 *
 * A package is DATA plus pure functions keyed the way the ontology names them:
 * `calculationModules['calculation/<module>']` is the fn table the ontology's
 * `process.file = '/<tld>/calculation/<module>.ts'` selects (the key is the
 * file minus the leading `/<tld>/` and the `.ts`). Nothing here is ever a
 * path: the registry matches the ontology string against these frozen keys.
 * Future facets (widgets, tool variable maps) are added here, never as a
 * second registry.
 */

import type { CalculationFn } from '../core/components/component_info/widgets/calculation/fn_kit.ts';

export interface TldPackage {
	/** The install TLD this code serves — equal to the package directory name. */
	readonly tld: string;
	/** `'calculation/<module>'` → fn name → fn. Names never shadow a generic fn. */
	readonly calculationModules: Readonly<Record<string, Readonly<Record<string, CalculationFn>>>>;
}
