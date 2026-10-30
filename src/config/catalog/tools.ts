/**
 * CONFIG CATALOG — domain: tools
 *
 * GENERATED SCAFFOLD (probe_emit_catalog.ts). Hand-edit from here on.
 */

import type { CatalogEntry } from '../catalog_types.ts';
import { legacyAwareDefaultDir } from './media.ts';

export const TOOLS_KEYS = {
	DEDALO_ADDITIONAL_TOOLS: {
		type: 'tool_roots',
		scope: 'operator',
		default: undefined,
		heading: 'Defining additional tool roots',
		typeLabel: 'array of objects',
		typeSuffix: '*optional*',
		doc: `This parameter defines extra directories where Dédalo will look for tools, besides the \`tools/\` directory of the installation itself.

Tools kept outside the Dédalo directory survive an update of the code and can be versioned on their own, which is what an institution developing its own tools wants. Every entry is an object with a \`path\` (the directory on disk holding the tool packages) and a \`url\` (the address the web server publishes that directory at, because the browser loads the tool's own interface code from there). The url must be an address of THIS site — a full address pointing at another host is rejected — and serving the directory at that address is your job, not Dédalo's.

The list is empty by default. The installation's own \`tools/\` directory is always searched first and always wins a name collision, so an additional root can never quietly replace a tool that ships with Dédalo; a root that does not exist, is not a directory, or sits in a system temporary directory is refused and reported at boot.

\`\`\`bash
DEDALO_ADDITIONAL_TOOLS=[{"path":"/srv/custom_tools","url":"/custom_tools"}]
\`\`\``,
	},
	DEDALO_TRANSFORM_DEFINITIONS_DIR: {
		type: 'string',
		scope: 'operator',
		default: () =>
			legacyAwareDefaultDir(
				'DEDALO_TRANSFORM_DEFINITIONS_DIR',
				['install', 'transform_definition_files'],
				['transform_definition_files'],
			),
		defaultDoc:
			'`<private dir>/transform_definition_files` — a legacy `<install dir>/install/transform_definition_files` holding files keeps being used so nothing moves',
		heading: 'Defining the transform definitions directory',
		typeLabel: 'string',
		doc: `This parameter defines the directory holding the transform definition files — the JSON declarations that drive the \`move_*\` maintenance widgets (move a tipo, move a locator, move data into a portal or into a table, move a language).

A transformation of this kind is written down before it is run: the file lists, item by item, what is moved where. The widget reads the files of its own subdirectory (\`<dir>/move_tld/\`, \`<dir>/move_locator/\`, …) and offers them to the operator; only \`.json\` files sitting directly in that subdirectory are read, never a path that climbs out of it.

Unset, Dédalo reads them from \`transform_definition_files\` inside the private directory — OUTSIDE the code tree, because a code update replaces the whole install directory and your transformations are institution-specific data an update must not touch. An install that still keeps files at the legacy in-tree \`install/transform_definition_files\` location is not moved: while that directory holds files and this key is unset, it keeps being used. Point the key at a directory of your own to place them anywhere else.

\`\`\`bash
DEDALO_TRANSFORM_DEFINITIONS_DIR="/srv/dedalo_transforms"
\`\`\``,
	},
	// TOOLS_ENABLE_REGISTRY_IMPORT retired 2026-10-30 (update audit 2026-10-29,
	// U-39): a PHP-coexistence write switch no caller consulted any more — the
	// installer, the Register tools widget and the update run write explicitly. A
	// leftover line in .env configures nothing.
	TOOLS_REGISTRY_CACHE_TTL_MS: {
		type: 'number',
		scope: 'operator',
		// NOTHING reads it, and that is the documented state: the registry TTL was
		// deleted at the cutover, so the key is recognized only so an existing
		// configuration carrying it still starts. Until 2026-08-31 a typed field
		// `config.tools.registryCacheTtlMs` was materialized from it and read by
		// nothing — a value the catalog itself calls inert, given a place in the
		// object the engine is configured through (P2-27 / DEAD-09).
		consumer: 'nothing — retained ONLY for backward compatibility; see typeSuffix',
		default: 60000,
		heading: 'Tools registry cache expiry',
		typeLabel: 'int',
		typeSuffix: '*no longer consulted*',
		doc: `This parameter defined how long, in milliseconds, the server kept the tools registry in memory before reading it from the database again.

It is no longer consulted. The expiry existed because a second engine could write the tools registry behind this server's back, so the cache had to be assumed stale after a while. Dédalo is now the only writer of those records, and every write clears the cache the moment it happens — so the data can never be stale and there is nothing to expire.

The key is still recognized, so an existing configuration carrying it still starts, but setting it has no effect and it can be removed.

\`\`\`bash
TOOLS_REGISTRY_CACHE_TTL_MS=60000
\`\`\``,
	},
} as const satisfies Record<string, CatalogEntry>;
