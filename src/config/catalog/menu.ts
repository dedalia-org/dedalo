/**
 * CONFIG CATALOG — domain: menu
 *
 * GENERATED SCAFFOLD (probe_emit_catalog.ts). Hand-edit from here on.
 */

import type { CatalogEntry } from '../catalog_types.ts';

export const MENU_KEYS = {
	AREAS_DENY: {
		// 'json_array': read with readJsonArray (config.ts), which REFUSES a comma
		// list — declaring 'string_list' promised a grammar the reader rejects.
		type: 'json_array',
		scope: 'operator',
		default: ['dd137', 'rsc1', 'hierarchy20'],
		heading: 'Defining denied areas',
		typeLabel: 'array',
		doc: `This parameter defines the areas that are removed from the installation.

Areas are the top-level parts of the ontology (Thesaurus, Resources, Tools, …), each with its own tipo. A denied area disappears from the menu and from the profile permissions tree — for every user, the root user included — and so does EVERYTHING under it, at any depth: its child areas and the sections they hold. Denial is absolute: there is no allow-list that can give it back.

The root, administration and maintenance areas can never be denied: a tipo of one of them in this list is ignored, because denying it would remove the very page where the list is changed.

By default Dédalo denies the areas that exist as internal lists of values rather than as places a user works in — the Yes/No list, for one — and those should stay denied. Add a tipo here to take a whole area out of an installation that does not use it. To hide an area from the menu while leaving it reachable, use MENU_SKIP_TIPOS instead. The maintenance area can also persist this list at runtime, and that override wins over the value set here.

\`\`\`bash
AREAS_DENY=["dd137","rsc1","hierarchy20"]
\`\`\``,
	},
	MENU_SKIP_TIPOS: {
		// 'json_array': same inverse defect as AREAS_DENY — readJsonArray only.
		type: 'json_array',
		scope: 'operator',
		default: [],
		heading: 'Defining skip tipos from menu',
		typeLabel: 'array',
		doc: `This parameter defines the tipos to be skipped from the menu.

The ontology sometimes defines a long hierarchy to reach the sections, and it can be convenient to remove some tipo from the menu to get to them more quickly. Add the tipo to the array to remove it from the menu.

It is EMPTY by default. The default used to carry four tipos, two of them belonging to specific installations' ontologies — menu shortcuts of one project applied to every project, in a key whose own example already showed an empty array. Declare the skips your own ontology needs.

\`\`\`bash
MENU_SKIP_TIPOS=[]
\`\`\``,
	},
} as const satisfies Record<string, CatalogEntry>;
