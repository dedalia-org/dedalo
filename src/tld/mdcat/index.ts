/**
 * The `mdcat` TLD package (see ./README.md for the institution and the
 * process it serves). ONE descriptor; src/tld/registry.ts is the only importer
 * outside this directory (engine_install_tld_tripwire leg 3).
 */

import type { TldPackage } from '../types.ts';
import { MDCAT_CALCULATION_FUNCTIONS } from './calculation.ts';

export const mdcat: TldPackage = {
	tld: 'mdcat',
	calculationModules: {
		'calculation/mdcat': MDCAT_CALCULATION_FUNCTIONS,
	},
};
