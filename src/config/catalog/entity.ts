/**
 * CONFIG CATALOG — domain: entity
 *
 * GENERATED SCAFFOLD (probe_emit_catalog.ts). Hand-edit from here on.
 */

import type { CatalogEntry, CatalogGet } from '../catalog_types.ts';

export const ENTITY_KEYS = {
	DEDALO_ENTITY_ID: {
		type: 'number',
		scope: 'operator',
		default: 0,
		heading: 'Entity id',
		typeLabel: 'int',
		doc: `This parameter defines the normalized id for the entity. The id of the entity could be used to create a locator to obtain information between Dédalo installations, the id will be added to the locator with the key: "entity_id" when the locator point to external resource.

\`\`\`bash
DEDALO_ENTITY_ID=0
\`\`\``,
	},
	DEDALO_ENTITY_LABEL: {
		placeholder: { value: 'Dédalo install version' },
		type: 'string',
		scope: 'operator',
		default: (get: CatalogGet) => get('ENTITY'),
		defaultDoc: 'the value of `ENTITY`',
		heading: 'Defining entity label',
		typeLabel: 'string',
		doc: `Defines the entity label, the real name of the entity. Due the entity definition is use to encrypt passwords or access to databases, sometimes you will need define the real name of the entity with characters such as 'ñ' or accents.

\`\`\`bash
DEDALO_ENTITY_LABEL="Museu de Prehistòria de València"
\`\`\`

> When unset, \`DEDALO_ENTITY_LABEL\` defaults to the value of \`ENTITY\`.`,
	},
	DEDALO_INSTANCE_COLOR: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Defining the installation colour',
		typeLabel: 'string',
		typeSuffix: '(optional)',
		doc: `Defines the colour that identifies this installation, so that people working with several installations can tell them apart at a glance. The colour tints the Dédalo logo in the menu, draws a thin line under the menu bar, colours the developer information bar and is used for the browser tab icon. The tab title is prefixed with \`[DEDALO_ENTITY_LABEL]\`.

When unset, none of this is shown. The value must be a hex colour in the form \`#rrggbb\`; any other value is reported in the server log at boot and the colour stays off. Choose a mid-tone, saturated colour: the menu is dark, so a very dark colour hardly shows, and the developer bar carries white text, so a very light one is hard to read.

\`\`\`bash
DEDALO_INSTANCE_COLOR="#b23838"
\`\`\``,
	},
	ENTITY: {
		required: true,
		installGate: true,
		installSentinel: 'install',
		placeholder: { value: 'my_entity_name' },
		type: 'string',
		scope: 'operator',
		default: 'install',
		heading: 'Defining entity',
		typeLabel: 'string',
		doc: `This parameter defines the name of the entity proprietary of the Dédalo installation. Dédalo entity will be used to access to databases, to encrypt passwords or to publish data into the specific publication ontology and should NOT be changed after installation.

\`\`\`bash
ENTITY="my_entity_name"
\`\`\`

> Use secure characters to define the entity, without spaces, accents or other special characters that could create conflicts with other server parts, such as database connection. If you want define the full name of the entity, use DEDALO_ENTITY_LABEL definition.`,
	},
} as const satisfies Record<string, CatalogEntry>;
