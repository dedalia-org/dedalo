/**
 * CONFIG CATALOG — domain: maintenance
 *
 * GENERATED SCAFFOLD (probe_emit_catalog.ts). Hand-edit from here on.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogEntry } from '../catalog_types.ts';
import { privateDir, readEnv } from '../env.ts';
import { type LegacyDirProbe, legacyAwareDefaultDir } from './media.ts';

/**
 * The file names an ontology version directory holds — what a release ships
 * in `install/import/ontology/<major.minor>/`, what an export writes and what
 * an ontology server serves (src/server.ts serveOntologyIoFile). ONE grammar.
 */
export function isOntologyIoFileName(name: string): boolean {
	return (
		/^[a-z_]{2,}\.copy\.gz$/.test(name) ||
		name === 'ontology.json' ||
		name === 'ontology_llm_map.json'
	);
}

/** A version directory of the release (`7.0`). */
const ONTOLOGY_VERSION_DIR = /^\d+\.\d+$/;

/** macOS Finder litter: not operator data, never a reason to keep the legacy dir. */
const PROBE_IGNORED: ReadonlySet<string> = new Set(['.DS_Store']);

/**
 * The ONTOLOGY_DATA_IO_DIR legacy probe (2026-10-21). The in-tree
 * `install/import/ontology/` SHIPS the vendored release, so the generic probe
 * ("holds any entry") kept every install in the code tree: an image install
 * died EACCES on `.staging`, and every tree-swap code update was refused by
 * the runtime-path census. Release content is not operator data, so it reads
 * 'empty'; 'content' means something the release does not ship — a
 * `recovery/` snapshot, a stale `.staging`, an unknown file — or an ontology
 * server, whose exports overwrite the shipped dumps and which serves from there
 * (a live master is never repointed on a guess).
 */
export function probeOntologyLegacyDir(path: string): LegacyDirProbe {
	if (readEnv('IS_AN_ONTOLOGY_SERVER')?.trim() === 'true') return 'content';
	if (!existsSync(path)) return 'empty';
	try {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			if (PROBE_IGNORED.has(entry.name)) continue;
			if (!entry.isDirectory() || !ONTOLOGY_VERSION_DIR.test(entry.name)) return 'content';
			for (const file of readdirSync(join(path, entry.name), { withFileTypes: true })) {
				if (PROBE_IGNORED.has(file.name)) continue;
				if (!file.isFile() || !isOntologyIoFileName(file.name)) return 'content';
			}
		}
		return 'empty';
	} catch {
		return 'unreadable';
	}
}

/**
 * The ONTOLOGY_DATA_IO_DIR default: `<private>/import/ontology`, unless the
 * legacy in-tree dir holds operator content (probe above). `record` + `warn`
 * belong to the ONE consumer call (config.ts), as for MEDIA_PATH.
 */
export function ontologyDataIoDefaultDir(
	options: { record?: boolean; warn?: boolean } = {},
): string {
	return legacyAwareDefaultDir(
		'ONTOLOGY_DATA_IO_DIR',
		['install', 'import', 'ontology'],
		['import', 'ontology'],
		{ preferPrivateWhenExists: true, probe: probeOntologyLegacyDir, ...options },
	);
}

/**
 * SERVER BOOT: freeze the derived decision in ts_state.json (the sticky home).
 * At BOOT and not at config import, because `pg_bin.ts` loads config during the
 * installer's machine preflight — and a refused install writes NOTHING into its
 * private dir (install_validation_upfront_tripwire). A configured key needs no
 * record: the explicit value wins on every read.
 */
export function recordOntologyDataIoDefault(): void {
	if ((readEnv('ONTOLOGY_DATA_IO_DIR') ?? '').trim() !== '') return;
	ontologyDataIoDefaultDir({ record: true, warn: true });
}

export const MAINTENANCE_KEYS = {
	CODE_SERVERS: {
		type: 'server_list',
		scope: 'operator',
		default: undefined,
		heading: 'Defining server code provider',
		typeLabel: 'array',
		doc: `This parameter defines the code servers this install offers releases from. Each entry is a JSON object with \`name\`, \`url\` and \`code\`; add entries to the array to offer mirror servers too.

The installer (\`sh install.sh\`, or \`bun run dedalo:install\`) WRITES the official Dédalo code server entry below, unless the install is declared air-gapped (\`--no-update-servers\`, or answering no to its update-server question), which writes \`[]\`. Unset or \`[]\` means no masters: the panel offers no code updates. When the installer writes \`.env\` over an existing one in the same private directory (an unfinished install, or a fresh install into a reused private directory) and is not air-gapped, it leaves a NON-EMPTY list already in the file untouched (mirrors you added survive); a \`[]\`, or a value that is not a valid JSON list, is replaced by the official entry. The list is read at boot, and so is the browser's \`connect-src\` that lets the update panel reach a master: restart the server after changing it.

\`url\` must be \`https://\`: an \`http://\` entry is ignored at startup (one log line), because the access \`code\` and the release archives would cross the network in clear. Plain http is accepted only for a master on this same machine (\`localhost\`, \`127.0.0.1\`, \`::1\`).

\`url\` is the master's JSON API endpoint — it MUST end in \`/dedalo/core/api/v1/json/\` (or \`/api/v1/json\`); any other path answers 404 and the panel reports the server as unreachable. \`code\` is the shared secret: the master only answers a release manifest to a caller presenting a code listed in its OWN \`CODE_SERVERS\`.

**Beta channel (opt-in).** A second official server, \`beta7.dedalo.dev\`, publishes prereleases and developer builds. The installer never writes it: you enable it by hand, with its own access code, by adding the commented entry below to the array. It only offers anything to a code-update panel set to **Prereleases** or **Developer builds**; a panel left on published releases keeps seeing only what \`master7\` publishes. Which servers an installation trusts is the operator's decision — nothing is asked of us.

To act as such a server, an installation sets \`IS_A_CODE_SERVER=true\` and \`DEDALO_CODE_FILES_DIR\`; the beta server also sets \`DEDALO_CODE_SERVER_PRERELEASE_CHANNEL=true\` and \`DEDALO_CODE_SERVER_DEV_CHANNEL=true\`, while \`master7\` leaves both channel switches off (the default).

**Moving from \`v7.master.dedalo.dev\`.** That address is retired, with no alias. Edit \`CODE_SERVERS\` (and \`ONTOLOGY_SERVERS\`) in \`../private/.env\` to the \`master7\` (or \`beta7\`) URL and **restart**: the browser's \`connect-src\` is built at boot. A list still naming the old host logs one line at every boot.

\`\`\`bash
CODE_SERVERS=[{"name":"Official Dédalo code server","url":"https://master7.dedalo.dev/dedalo/core/api/v1/json/","code":"x3a0B4Y020Eg9w"}]
# Opt-in beta channel, INACTIVE (to enable: replace the line above with this one, without the leading "# "):
# CODE_SERVERS=[{"name":"Official Dédalo code server","url":"https://master7.dedalo.dev/dedalo/core/api/v1/json/","code":"x3a0B4Y020Eg9w"},{"name":"Dédalo beta code server","url":"https://beta7.dedalo.dev/dedalo/core/api/v1/json/","code":"4Ofvb8noHMNvS5"}]
\`\`\``,
	},
	DEDALO_CODE_RESTORE_POINTS_KEEP: {
		type: 'number',
		scope: 'operator',
		default: 3,
		heading: 'Code restore points to keep',
		typeLabel: 'number',
		doc: `How many code restore points this installation keeps on disk.

Every code update renames the outgoing tree aside as a restore point and keeps it WITH its \`node_modules\`, so a rollback is a bare \`mv\` that boots with no network. That is what makes a bad update survivable — and it means each point is a full copy of the code tree, on the same disk the update itself measures and refuses on when it runs short.

Pruning runs after an update the booted tree has CONFIRMED, never before: until that flip the new tree is unproven and the points behind it are the way back. The newest bootable point is never pruned whatever this is set to — it is the rollback for the code running right now.

Set it higher on an installation that updates rarely and has disk to spare; \`1\` keeps only the rollback.

\`\`\`bash
DEDALO_CODE_RESTORE_POINTS_KEEP=3
\`\`\``,
	},
	DEDALO_CODE_FILES_DIR: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Defining is a code server directory',
		typeLabel: 'string',
		doc: `This parameter defines the path to the release archives on a code server. Releases are organised in version directories, \`<major>/<major.minor>/<version>.zip\`, each next to its \`.sha256\` sidecar:

\`\`\`
/srv/dedalo/code/7/7.0/7.0.1.zip
/srv/dedalo/code/7/7.0/7.0.1.zip.sha256
\`\`\`

The directory is CREATED AT BOOT when this key is set on a code server (\`IS_A_CODE_SERVER\`) and the path does not exist — recursively, at mode \`0750\`, since only this process reads the archives. An existing directory is left exactly as it is, mode included.

The build action writes both. Remote installs never read this path: they fetch \`/dedalo/install/code/<version>/<version>.zip\`, which the server maps back to it — so the directory does not need to be inside the web root, and should not be.

\`\`\`bash
DEDALO_CODE_FILES_DIR="/srv/dedalo/code"
\`\`\``,
	},
	DEDALO_CODE_SERVER_GIT_DIR: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Defining is a code server build version from development git',
		typeLabel: 'string',
		doc: `This parameter defines the path to git directory in the server. It use to build the version with for specific version.
GIT directory is a valid git server than can provide the build version.
This parameter is not necessary if the server will be only a mirror from official files.


\`\`\`bash
DEDALO_CODE_SERVER_GIT_DIR="/my_dedalo_git_directory"
\`\`\``,
	},
	DEDALO_CODE_SERVER_DEV_CHANNEL: {
		type: 'boolean',
		scope: 'operator',
		default: false,
		heading: 'Publishing developer builds from a code server',
		typeLabel: 'bool',
		doc: `This parameter lets a code server OFFER developer builds (\`<version>-dev.zip\`, built from the tip of the \`master\` branch) to installations that explicitly ask for them. Published releases (\`<version>.zip\`) are built from release tags (\`vX.Y.Z\`) and are offered regardless of this setting.

It exists so a developer can test integrated but unreleased work on a real installation without cutting a release: a developer build carries no version bump of its own, so it can be installed OVER the same version. Both switches must be on — this one here, and the "Developer builds" switch in the target installation's code-update panel. A code server that leaves this unset answers a developer-channel request exactly as it answers a normal one, so developer builds are never enumerable from outside.

Everything else is unchanged: the archive is still fetched from a configured code server, still verified against its \`.sha256\` sidecar, and the update still requires a superuser, maintenance mode and a recent backup.

\`\`\`bash
DEDALO_CODE_SERVER_DEV_CHANNEL=true
\`\`\``,
	},
	DEDALO_CODE_SERVER_PRERELEASE_CHANNEL: {
		type: 'boolean',
		scope: 'operator',
		default: false,
		heading: 'Publishing prereleases from a code server',
		typeLabel: 'bool',
		doc: `This parameter lets a code server OFFER prereleases (\`<version>-beta.N.zip\`, built from a prerelease tag such as \`v7.0.1-beta.2\`, or \`-alpha.N\` / \`-rc.N\`) to installations that explicitly ask for them. Published releases (\`<version>.zip\`) are offered regardless of this setting.

A prerelease is a real release — fixed bytes, verified against its \`.sha256\` sidecar — of a version that is not yet stable, so it is offered only to an installation whose code-update panel is set to **Prereleases** (or to **Developer builds**, which includes prereleases). An installation that asks for published releases never sees one, even when a prerelease is the newest version on this server. A code server that leaves this unset answers a prerelease request exactly as it answers a normal one.

This switch is separate from \`DEDALO_CODE_SERVER_DEV_CHANNEL\`: a server can publish prereleases without publishing developer builds, and the other way round.

\`\`\`bash
DEDALO_CODE_SERVER_PRERELEASE_CHANNEL=true
\`\`\``,
	},
	DEDALO_SOURCE_VERSION_LOCAL_DIR: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Defining source versions local directory to save the new code',
		typeLabel: 'string',
		doc: `**Not honoured by the engine.** A code update downloads and stages the new release in \`.code_staging\` under the code-backup root (\`<DEDALO_BACKUP_PATH>/.code_staging\`), whatever this key says. Setting it has no effect on staging; it is a retirement candidate.

\`\`\`bash
DEDALO_SOURCE_VERSION_LOCAL_DIR="/tmp/my_museum"
\`\`\``,
	},
	IS_A_CODE_SERVER: {
		type: 'boolean',
		scope: 'operator',
		default: false,
		heading: 'Defining is a code server',
		typeLabel: 'bool',
		doc: `This parameter defines if the server can provide code to other Dédalo servers. By default no Dédalo server provides code, but it is possible to set one up as a mirror server that provides code versions. To enable it, also set \`DEDALO_CODE_FILES_DIR\` — the URL other servers fetch from is derived automatically.

When it is on, the maintenance area shows the **Serve Code** panel: whether this server can publish, the build source, the archives on disk, and the buttons that build a release. See [Updating code](../management/updates/updating_code.md).

\`\`\`bash
IS_A_CODE_SERVER=false
\`\`\``,
	},
	IS_AN_ONTOLOGY_SERVER: {
		type: 'boolean',
		scope: 'operator',
		default: false,
		heading: 'Is an ontology master server',
		typeLabel: 'bool',
		doc: `It defines if the installation server can provide his ontology files to other Dédalo servers.

The maintenance area's **Serve Ontology** panel shows whether this key, \`ONTOLOGY_SERVER_CODE\` and \`DEDALO_CORS_ALLOWED_ORIGINS\` are set, and the endpoint other installations register. See [Updating ontology](../management/updates/updating_ontology.md#serving-other-installations-ontology-master).

\`\`\`bash
IS_AN_ONTOLOGY_SERVER=false
\`\`\``,
	},
	DEDALO_ONTOLOGY_RECOVERY_PATH: {
		type: 'string',
		scope: 'operator',
		default: () => join(privateDir, 'db', 'dd_ontology_recovery.sql.gz'),
		defaultDoc: '`<private dir>/db/dd_ontology_recovery.sql.gz`',
		heading: 'Ontology recovery file path',
		typeLabel: 'string',
		doc: `This parameter defines where the ontology recovery file is written and read. Before an ontology update, Dédalo dumps the whitelisted slice of the ontology into this gzipped SQL file, so a failed update can be examined and the previous definitions restored.

Unset, the file lives at \`db/dd_ontology_recovery.sql.gz\` inside the private directory — OUTSIDE the code tree, because a code update replaces the whole install directory and the recovery dump is exactly the file you need AFTER an update went wrong. A recovery file still sitting at the legacy in-tree location (\`install/db/dd_ontology_recovery.sql.gz\`) keeps being read while no file exists at the new location, with a warning; the next build always writes to this path.

\`\`\`bash
DEDALO_ONTOLOGY_RECOVERY_PATH="/srv/dedalo_private/db/dd_ontology_recovery.sql.gz"
\`\`\``,
	},
	ONTOLOGY_DATA_IO_DIR: {
		// Empty = unset, as config.ts reads it: the census (runtime_paths.ts)
		// must not resolve `ONTOLOGY_DATA_IO_DIR=` to the cwd — the code tree.
		emptyIsUnset: true,
		type: 'string',
		scope: 'operator',
		default: () => ontologyDataIoDefaultDir(),
		defaultDoc:
			'`<private dir>/import/ontology`; an install whose legacy `<install dir>/install/import/ontology` holds anything that is not an ontology release file (or that is an ontology server) keeps the legacy dir until that private directory exists',
		heading: 'Ontology input/output, export/import or download directory',
		typeLabel: 'string',
		doc: `This parameter defines the directory to input/output the ontology files in the server. Ontology files can be created by master ontology servers or downloaded from an external provider such as the official master Dédalo server.

Unset, Dédalo uses \`import/ontology\` inside the private directory — OUTSIDE the code tree, because a code update replaces the whole install directory: an update refuses to start while runtime data lives inside it, and an image install cannot write there at all. The \`install/import/ontology\` directory inside the code tree holds the ontology release that ships with the code; Dédalo only reads it.

An install from before this default keeps using \`install/import/ontology\`, with a warning at start-up, when that directory holds anything that is not an ontology release file (a \`recovery/\` snapshot or \`.staging\` from an earlier update, any other file), or when the install is an ontology server (\`IS_AN_ONTOLOGY_SERVER\`, whose exports were written and are served there). Nothing is moved for you. Move those files to \`<private dir>/import/ontology\` (creating it ends the fallback), or set this key explicitly. An ontology server copies every \`<major.minor>/\` directory, its exports included, before creating the private directory: once it exists, the server serves from it. The decision is taken once and recorded.

The check goes by file NAME: an export of your own written into \`install/import/ontology/<major.minor>/\` on an install that is not an ontology server has the name of a release file and is treated as one. Such an export is rebuilt from the database at any time, and a code update keeps it in the backup of the old code.

Files are organised in version directories, \`<major.minor>/\`: one \`<tld>.copy.gz\` per ontology, \`matrix_dd.copy.gz\` for the private lists, and the \`ontology.json\` (plus \`ontology_llm_map.json\`) that describe them. The canonical production layout is:

\`\`\`
/srv/dedalo/ontology/7.0/dd.copy.gz
/srv/dedalo/ontology/7.0/matrix_dd.copy.gz
/srv/dedalo/ontology/7.0/ontology.json
\`\`\`

\`\`\`bash
ONTOLOGY_DATA_IO_DIR="/srv/dedalo/ontology"
\`\`\``,
	},
	ONTOLOGY_SERVER_CODE: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'defining the  ontology master server code',
		typeLabel: 'string',
		doc: `It  defines the valid code for clients to validate to get ontology files.

\`\`\`bash
ONTOLOGY_SERVER_CODE="x3a0B4Y020Eg9w"
\`\`\`

This parameter needs to be included as \`code\` in [ONTOLOGY_SERVERS](#ontology-servers) defintion in every authorized client.`,
	},
	DEDALO_UPDATE_HTTP_SOURCES_DEV: {
		type: 'boolean',
		scope: 'test_seam',
		default: false,
		heading: 'Allowing a plain-http update master on a development network',
		typeLabel: 'boolean',
		doc: `Development seam, not a setting. Code and ontology masters (\`CODE_SERVERS\`, \`ONTOLOGY_SERVERS\`) must be \`https://\` — a plain \`http://\` entry is dropped at startup with a log line, and every download re-checks it — because the shared \`code\` and the release archive would otherwise cross the network in clear. The only http address allowed is this machine itself (\`localhost\`, \`127.0.0.1\`, \`::1\`). When this key is \`true\`, http masters on other addresses are allowed too: \`bun run probe:update\` sets it in the docker museum it drives, whose master is the developer's machine on the LAN. Never set it on an installation.

\`\`\`bash
DEDALO_UPDATE_HTTP_SOURCES_DEV=true
\`\`\``,
	},
	ONTOLOGY_SERVERS: {
		type: 'server_list',
		scope: 'operator',
		default: undefined,
		heading: 'Ontology servers',
		typeLabel: 'array of objects',
		doc: `This parameter defines the ontology master servers to get the ontology updates. The servers could be:

- the official dedalo.dev server
- an external server for local Ontologies (private Ontologies of entities.)
- local server, the current installation

Each entry is a JSON object with \`name\`, \`url\` and \`code\`.

The installer (\`sh install.sh\`, or \`bun run dedalo:install\`) WRITES the official dedalo.dev entry below, unless the install is declared air-gapped (\`--no-update-servers\`, or answering no to its update-server question), which writes \`[]\`. Unset or \`[]\` means no masters: the panel offers no ontology updates. When the installer writes \`.env\` over an existing one in the same private directory (an unfinished install, or a fresh install into a reused private directory) and is not air-gapped, it leaves a NON-EMPTY list already in the file untouched (mirrors you added survive); a \`[]\`, or a value that is not a valid JSON list, is replaced by the official entry.

The list also has an install-time role: its FIRST entry (a preserved custom list, otherwise the official server) is where the installer fetches every domain ontology other than the built-in \`oh\`, and whose catalog decides which ontologies can be chosen, unless \`--ontology-source\` names a local export. With \`[]\` and no \`--ontology-source\`, only \`oh\` can be installed.

Configuration for the official dedalo.dev server:

\`\`\`bash
ONTOLOGY_SERVERS=[{"name":"Official Dédalo Ontology server","url":"https://master7.dedalo.dev/dedalo/core/api/v1/json/","code":"x3a0B4Y020Eg9w"}]
# Opt-in beta ontology provider, INACTIVE (to enable: replace the line above with this one, without the leading "# "). It takes oh from beta7:
# ONTOLOGY_SERVERS=[{"name":"Dédalo","url":"https://master7.dedalo.dev/dedalo/core/api/v1/json/","code":"x3a0B4Y020Eg9w","tlds":["dd","rsc","ontology","ontologytype","hierarchy","lg","matrix_dd"]},{"name":"Dédalo beta","url":"https://beta7.dedalo.dev/dedalo/core/api/v1/json/","code":"4Ofvb8noHMNvS5","tlds":["oh"]}]
\`\`\`

**Beta ontology (opt-in).** \`beta7.dedalo.dev\` is a second official ontology server where ontology changes are tested before they reach \`master7\`. It has no channel setting: it is just another provider in this list, and an installation that does not list it never sees it. The installer never writes it; it has its own access code, and the decision to list it is the operator's. To take some TLDs from it, list it with those TLDs and remove them from the \`master7\` entry (every TLD in exactly one entry, \`matrix_dd\` included), as in the commented example above. An installation serves the ontology to others with \`IS_AN_ONTOLOGY_SERVER=true\`; both official servers do.

**Moving from \`v7.master.dedalo.dev\`.** That address is retired, with no alias: edit this list (and \`CODE_SERVERS\`) in \`../private/.env\` to the new URL and **restart**. A list still naming the old host logs one line at every boot.

It gets the tld from the [ACTIVE_ONTOLOGY_TLDS](#defining-active-ontology-tlds) definition.

Every \`url\` must be \`https://\` (plain http only for a master on this same machine); an \`http://\` entry is ignored at startup with one log line.

A master is identified by its \`url\`, not by its \`code\`: several masters may share one access
code, and the update downloads only from the address of the master picked in the panel. List
each master once.

**Several masters: one source per TLD.** With two or more masters, each entry also lists the
shared TLDs this installation takes from it, in \`tlds\` (include \`matrix_dd\`, the shared value
lists, in exactly one of them). The update refuses a TLD that no master lists, that two masters
list, or that the picked master does not list. One master needs no \`tlds\`: everything comes
from it.

\`\`\`bash
ONTOLOGY_SERVERS=[{"name":"Dédalo","url":"https://master7.dedalo.dev/dedalo/core/api/v1/json/","code":"x3a0B4Y020Eg9w","tlds":["dd","rsc","ontology","ontologytype","hierarchy","lg","oh","matrix_dd"]},{"name":"Museum master","url":"https://ontology.museum.example/dedalo/core/api/v1/json/","code":"…","tlds":["mus"]}]
\`\`\`

The update panel interrogates each master **from the browser**, so the engine adds every origin
named here to its own \`connect-src\` Content-Security-Policy automatically — there is no second
setting to keep in step. The policy is built at boot, so **restart** after adding a master, or
the browser refuses the call before it leaves and the panel reports
\`Max retries reached, request failed\`.

Local ontologies can be provided by other installations in parallel by adding new
entries to this list. Every Dédalo server can provide its own ontologies.`,
	},
	STRUCTURE_FROM_SERVER: {
		// Tri-state: UNSET is not the same as 'false' (the reader branches on all
		// three), so type:'string' is right and the 'bool' LABEL was the lie.
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Sync ontology from master server',
		typeLabel: 'true || false',
		typeSuffix: '(optional; unset = not configured)',
		doc: `**Not honoured by the engine.** The key is still parsed, but nothing reads the value: it has no effect on ontology updates, which are run from the *Update ontology* panel against the masters in [ONTOLOGY_SERVERS](#ontology-servers). A v6 \`.env\` that carries it keeps booting; the line can be removed. It is a retirement candidate.

\`\`\`bash
STRUCTURE_FROM_SERVER=true
\`\`\``,
	},
	DEDALO_GEOIP_ENABLED: {
		type: 'boolean',
		scope: 'operator',
		default: true,
		heading: 'Enable local IP to Country resolution',
		typeLabel: 'bool',
		doc: `Enables the built-in, self-hosted IP to Country resolution used in section Activity to show the source country flag from an IP address.

Resolution runs on the server against a local, openly-licensed country database (DB-IP IP to Country Lite, CC-BY-4.0) — no third-party request is made from the browser. When disabled, IP addresses are shown without a country flag.

\`\`\`bash
DEDALO_GEOIP_ENABLED=true
\`\`\``,
	},
	DEDALO_GEOIP_DIR: {
		type: 'string',
		scope: 'operator',
		default: () => join(privateDir, 'geoip'),
		defaultDoc: '`<private dir>/geoip`',
		heading: 'IP to Country database directory',
		typeLabel: 'string',
		doc: `Directory where the local IP to Country database file is downloaded and cached. Defaults to \`geoip\` inside the private directory (outside the web root).

\`\`\`bash
DEDALO_GEOIP_DIR="/srv/dedalo/geoip"
\`\`\``,
	},
	DEDALO_GEOIP_AUTO_UPDATE: {
		type: 'boolean',
		scope: 'operator',
		default: true,
		heading: 'Auto-download and refresh the IP to Country database',
		typeLabel: 'bool',
		doc: `When enabled, the server downloads the IP to Country database on first use and refreshes it monthly. Disable it to use only a database file placed manually in \`DEDALO_GEOIP_DIR\` (e.g. air-gapped installs).

\`\`\`bash
DEDALO_GEOIP_AUTO_UPDATE=true
\`\`\``,
	},
	DEDALO_GEOIP_DB_URL: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'IP to Country database download URL override',
		typeLabel: 'string',
		doc: `Overrides the default monthly DB-IP download URL. Use it to point at a mirror or a pinned month. The default is \`https://download.db-ip.com/free/dbip-country-lite-YYYY-MM.mmdb.gz\` (the current month, with a fallback to the previous month), computed automatically.

\`\`\`bash
DEDALO_GEOIP_DB_URL="https://mirror.example.org/dbip-country-lite-2026-07.mmdb.gz"
\`\`\``,
	},
} as const satisfies Record<string, CatalogEntry>;
