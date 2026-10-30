/**
 * CONFIG CATALOG — domain: diffusion
 *
 * GENERATED SCAFFOLD (probe_emit_catalog.ts). Hand-edit from here on.
 */

import type { CatalogEntry } from '../catalog_types.ts';

export const DIFFUSION_KEYS = {
	API_WEB_USER_CODE_MULTIPLE: {
		type: 'publication_api_users',
		scope: 'operator',
		default: undefined,
		heading: 'Publication server API v1 access codes',
		typeLabel: 'array of objects',
		typeSuffix: '*optional*',
		doc: `The publication databases served by the legacy publication server API v1
(\`publication/server_api/v1\`), each with the access \`code\` that API expects. The
maintenance dashboard (Publication → Publication server API) shows one "Open Swagger UI"
button per entry, opening the API's interactive documentation for that database with the
code, the database name and the current interface language already filled in.

Every entry is an object with \`db_name\` (the publication database) and \`code\` (the same
value as \`API_WEB_USER_CODE\` in that API's own configuration). The optional \`api_ui\`
is the address of the documentation page when the API runs on another server; unset, it
is \`/dedalo/publication/server_api/v1/docu/ui/\` on this site. The v1 API and its
documentation page are a separate application that Dédalo itself never serves: the default
address only works when the web server in front of Dédalo routes \`/dedalo/publication/\`
to that application —
otherwise the button answers "not found", and \`api_ui\` must point at the server that does
run v1. Only an \`http(s)://\` or a root-relative address is accepted. An entry without \`db_name\` or \`code\` is dropped and
reported at boot. The v6 configuration migrator carries the v6 value across, leaving
out the empty entry a stock v6 configuration ships.

Empty by default: no buttons are shown. The codes are only sent to global administrators,
the only users who can open the maintenance area. The publication server API v2 is configured in its own \`.env\`;
its documentation button comes from \`DEDALO_PUBLICATION_API_V2_URL\`.

\`\`\`bash
API_WEB_USER_CODE_MULTIPLE=[{"db_name":"web_my_entity","code":"my_api_code"}]
\`\`\``,
	},
	DEDALO_DIFFUSION_BATCH_RECORDS: {
		type: 'number',
		scope: 'operator',
		default: undefined,
		heading: 'Publication record batch size',
		typeLabel: 'int',
		doc: `The number of records the publication resolver walks per batch. Diffusion is a
streaming process: records are selected in ordered batches, resolved, and handed to
the format writer, so that a section of hundreds of thousands of records never has to
fit in memory at once. A smaller batch lowers the memory ceiling of a publication run;
a larger one reduces the number of round trips to the database.

Unset, a run resolves **500** records per batch. Each publication run reads the key when
it starts (a resumed run reads it again), so a change applies from the next start. Each
batch is also one durable step: its records, its checkpoint and its run-ledger rows are
written together, so a smaller batch means less work to redo when a run is resumed. The
diffusion panel of the maintenance dashboard reports the configured value.

\`\`\`bash
DEDALO_DIFFUSION_BATCH_RECORDS=500
\`\`\``,
	},
	DEDALO_DIFFUSION_BATCH_ROWS: {
		type: 'number',
		scope: 'operator',
		default: 200,
		heading: 'Publication rows per write statement',
		typeLabel: 'int',
		doc: `The maximum number of rows the engine packs into a single insert/update statement
when it writes a published table into the target database. Default \`200\`.

Raise it to reduce the number of statements sent to a remote target database (fewer,
bigger writes); lower it if the target rejects or chokes on large statements — a very
wide table (many columns, long texts) can hit the target's maximum packet size before
it hits the row cap. Any value that is not a positive number falls back to the default.

\`\`\`bash
DEDALO_DIFFUSION_BATCH_ROWS=200
\`\`\``,
	},
	DEDALO_DIFFUSION_DB_HOST: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Diffusion target database host',
		typeLabel: 'string',
		doc: `The hostname or IP of the MariaDB/MySQL server that receives the published tables.
Set it when the publication target runs on a different machine than Dédalo, or when it
listens on TCP rather than on a local socket.

Transport precedence is: \`DEDALO_DIFFUSION_DB_SOCKET\` first, then this host (with
\`DEDALO_DIFFUSION_DB_PORT\`), and — when neither is set — the default local socket
\`/tmp/mysql.sock\`. Only the transport is configured here: the target *databases* and
*tables* themselves come from the diffusion ontology.

\`\`\`bash
DEDALO_DIFFUSION_DB_HOST="localhost"
\`\`\``,
	},
	DEDALO_DIFFUSION_DB_PASSWORD: {
		type: 'string',
		scope: 'secret',
		default: '',
		heading: 'Diffusion target database password',
		typeLabel: 'string',
		doc: `The password of \`DEDALO_DIFFUSION_DB_USER\`, the account Dédalo uses to write the
published tables into the target database. This is a **secret**: the shipped template
carries a placeholder only, and a real installation must replace it with the actual
password (or leave it empty when the target authenticates the user by socket instead).

\`\`\`bash
DEDALO_DIFFUSION_DB_PASSWORD="my_password"
\`\`\``,
	},
	DEDALO_DIFFUSION_DB_PORT: {
		type: 'number',
		scope: 'operator',
		default: 3306,
		heading: 'Diffusion target database port',
		typeLabel: 'int',
		doc: `The TCP port of the publication target database. Only used when
\`DEDALO_DIFFUSION_DB_HOST\` is set (a socket connection ignores it). Defaults to
\`3306\`, the standard MariaDB/MySQL port.

\`\`\`bash
DEDALO_DIFFUSION_DB_PORT=3306
\`\`\``,
	},
	DEDALO_DIFFUSION_DB_SOCKET: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Diffusion target database socket',
		typeLabel: 'string',
		doc: `Path to the local unix socket of the publication target database. Set it when the
target server runs on the same machine as Dédalo and you want to bypass TCP — the
usual production posture, and the fastest one.

It takes precedence over \`DEDALO_DIFFUSION_DB_HOST\`. When neither key is set, Dédalo
falls back to the conventional socket path \`/tmp/mysql.sock\`; if your distribution
puts it elsewhere, name it here.

\`\`\`bash
DEDALO_DIFFUSION_DB_SOCKET="/var/run/mysqld/mysqld.sock"
\`\`\``,
	},
	DEDALO_DIFFUSION_DB_USER: {
		type: 'string',
		scope: 'operator',
		default: '',
		heading: 'Diffusion target database username',
		typeLabel: 'string',
		doc: `The user account Dédalo connects with to publish into the target database. It must
be able to create and alter the published tables and to insert, update and delete their
rows: the engine provisions the table structure from the diffusion ontology on every
run, so read/write on existing tables is not enough.

\`\`\`bash
DEDALO_DIFFUSION_DB_USER="my_username"
\`\`\``,
	},
	DEDALO_DIFFUSION_DOMAIN: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Diffusion domain',
		typeLabel: 'string',
		doc: `This parameter would be set with the diffusion domain of our project publication, diffusion domain is the target domain or the part of diffusion ontology that will be used to get the tables and fields and the relation components in the back-end.

The definition for diffusion domain in the configuration file can set only one ontology diffusion_domain for our installation, it can have different diffusion groups or diffusion elements with different databases and tables.

\`\`\`bash
DEDALO_DIFFUSION_DOMAIN="default"
\`\`\`

> Any other 'section_tipo' are accepted and it can be other standard tlds used in the ontology like oh1 or ich1. If your institution has a specific tld space in the ontology, you can use your own tld into the DEDALO_DIFFUSION_DOMAIN.`,
	},
	DEDALO_DIFFUSION_FILES_ROOT: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Published files root',
		typeLabel: 'string',
		doc: `The directory under which the file-format publications (RDF, XML, Markdown, CSV,
JSON…) are written, one subdirectory per format and publication target. When unset — the
normal case — Dédalo publishes under its media root (the resolved \`MEDIA_PATH\`, or the
derived default when that key is unset).

Publishing and un-publishing (which removes the files of a deleted record) resolve the
root through ONE function (\`src/core/diffusion_bridge/published_files.ts\`), so they
agree on where the artifacts are whether this key is set or not. Change it only between
publications: files published under the previous root are not moved, and a record deleted
after the change is un-published under the NEW root only — run the \`public_tier\`
reconcile against the old root before retiring it.

Set it when the published files must live outside the media root, for example on a
volume that the public web server exposes and the media root is not.

\`\`\`bash
DEDALO_DIFFUSION_FILES_ROOT="/var/www/published"
\`\`\``,
	},
	DEDALO_DIFFUSION_MAX_RUNNERS: {
		type: 'number',
		scope: 'operator',
		default: 2,
		heading: 'Concurrent publication runners',
		typeLabel: 'int',
		doc: `How many publication jobs may run at the same time. Dédalo queues every diffusion
request durably and dispatches it to a **runner process** of its own — a separate,
killable process with its own memory ceiling — so a long publication survives a browser
disconnect, a logout, or a server restart. This key caps how many of those processes
the scheduler will have in flight; further jobs simply wait in the queue. Default \`2\`,
minimum \`1\`.

Raise it on a machine with spare cores and database connections; each runner opens its
own database pool, so the budget to respect is
\`DB_POOL_MAX × (1 + DEDALO_DIFFUSION_MAX_RUNNERS)\` connections against the PostgreSQL
server's \`max_connections\`.

\`\`\`bash
DEDALO_DIFFUSION_MAX_RUNNERS=2
\`\`\``,
	},
	DEDALO_DIFFUSION_NATIVE: {
		type: 'boolean',
		scope: 'operator',
		default: true,
		heading: 'Native diffusion engine',
		typeLabel: 'bool',
		doc: `Routes the publication tool to the diffusion engine built into this server instead
of the separate, external diffusion service of earlier releases. The tool in the browser
is unchanged, only the server that answers it is.

Defaults to \`true\`: this server IS the diffusion engine. It was \`false\` while
installations still ran the separate service of earlier releases alongside Dédalo, but that
service is decommissioned and this server serves no \`/dedalo/diffusion/api/v1/\` route — so
with the flag off every publication call from the tool fails with a 404.

Set it to \`false\` ONLY on a deployment that still runs the external service and reaches
it through a reverse-proxy route of its own.

\`\`\`bash
DEDALO_DIFFUSION_NATIVE=false
\`\`\``,
	},
	DEDALO_DIFFUSION_NATIVE_ELEMENTS: {
		type: 'string_list',
		scope: 'operator',
		default: undefined,
		heading: 'Elements routed to the native diffusion engine',
		typeLabel: 'array',
		doc: `A staged-migration lever: the diffusion element tipos that the native engine is
allowed to publish, or the single value \`all\` for every one of them. An element outside
the list is refused loudly with an explicit "not routed" message, so that one
element+section is never published by two engines at once.

Accepted encodings: a JSON array or a plain comma-separated list — both parse to the same
set.

Use it to move a large installation over one publication at a time. Unset (the default)
is permissive — every element is accepted — which is the right posture for a development
box and for an installation that has finished its migration.

\`\`\`bash
DEDALO_DIFFUSION_NATIVE_ELEMENTS=["dd1190","rsc167"]
\`\`\``,
	},
	DEDALO_DIFFUSION_RESOLVE_LEVELS: {
		type: 'number',
		scope: 'operator',
		default: 2,
		heading: 'Defining resolution levels; going to the deeper information',
		typeLabel: 'int',
		doc: `This parameter set the number of resolution levels we would like to accomplish. By default, its value is set to '2'.

\`\`\`bash
DEDALO_DIFFUSION_RESOLVE_LEVELS=2
\`\`\`

> Every other positive, numerical value will be accepted.

The number defines the maximum resolution levels of linked information that Dédalo will resolved in the publication process. Dédalo work with related data connected by locators, every link is a level of information, the parameter limit the quantity of linked data will be resolve in the linked data tree.

Ex: If you have an Oral History interview (level 0) with 1 linked image (level 1) and this image has a person linked as author (level 2) and these author 1 linked toponym for the birthplace (level 3). For publishing all linked information will be necessary 3 levels of resolution:

If you increase the value of this parameter, the time needed by Dédalo to resolve the linked data in the publication process will also increase in exponential progression.`,
	},
	DEDALO_DIFFUSION_SCHEDULER_ENABLED: {
		type: 'boolean',
		scope: 'operator',
		default: true,
		heading: 'Publication job scheduler',
		typeLabel: 'bool',
		doc: `Whether **this** server claims publication jobs from the queue and dispatches runner
processes for them. Enabled by default: a standard, single-server installation must have
it on, or publications will queue and never start.

Set it to \`false\` only on an instance that must not touch the live queue — a second
instance of the same installation (a maintenance or smoke-test copy sharing the database)
or a deployment where a dedicated machine runs the runners. Turning it off disables only
the claiming and the recovery sweep of interrupted jobs; the rest of diffusion, including
the removal of a deleted record from the published tables, keeps working.

\`\`\`bash
DEDALO_DIFFUSION_SCHEDULER_ENABLED=false
\`\`\``,
	},
	DEDALO_PUBLICATION_API_V2_URL: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Publication server API v2 address',
		typeLabel: 'string',
		typeSuffix: '*optional*',
		doc: `The address of the publication server API v2 (\`publication/server_api/v2\`), its
\`BASE_PATH\` included — the same address a client of the API uses, e.g.
\`https://pub.example.org/publication/server_api/v2\`. The maintenance dashboard
(Publication → Publication server API) shows one "Open API v2 docs" button opening
\`<address>/docs\`, the API's own interactive documentation (Swagger UI and Scalar).

The v2 API is a separate application with its own \`.env\`; Dédalo does not serve it and
does not probe it, so the button works only when that address answers. Only an
\`http(s)://\` or a root-relative address is accepted; anything else is ignored and reported
at boot. A trailing \`/\` is dropped. Unset by default: no v2 button is shown.

\`\`\`bash
DEDALO_PUBLICATION_API_V2_URL=https://pub.example.org/publication/server_api/v2
\`\`\``,
	},
	DIFFUSION_ACTIVITY_TABLE: {
		type: 'string',
		scope: 'test_seam',
		default: undefined,
		heading: 'Diffusion activity table (test seam)',
		typeLabel: 'string',
		doc: `Not an administrator setting. Redirects the diffusion-activity table (which records
what has been published, and therefore what must be un-published when a record is
deleted) to a scratch table so the test suite never touches the live one. An override is
rejected unless it carries the \`dedalo_ts_test_\` prefix, so a live installation can
never be pointed at an arbitrary table. Leave it unset: Dédalo then uses the real
\`matrix_activity_diffusion\` table.`,
	},
	DIFFUSION_JOBS_TABLE: {
		type: 'string',
		scope: 'test_seam',
		default: undefined,
		heading: 'Diffusion jobs table (test seam)',
		typeLabel: 'string',
		// Deliberately does NOT name the real table. sql_confinement_tripwire (T4) confines the
		// diffusion job table family to its owning module, and it scans raw source — it cannot
		// tell prose from a query, and a doc string is not worth an exemption from a
		// confinement rule.
		doc: `Not an administrator setting. Redirects the durable publication job queue to a
scratch table so a test run's queue and scheduler never share state with the live one.
An override is rejected unless it carries the \`dedalo_ts_test_\` prefix, so a live
installation can never be pointed at an arbitrary table. Leave it unset: Dédalo then uses
the engine's own publication job table.`,
	},
	DIFFUSION_RUNNER_STUB_DELAY_MS: {
		type: 'number',
		scope: 'test_seam',
		default: 200,
		heading: 'Runner stub batch delay (test seam)',
		typeLabel: 'int',
		doc: `Not an administrator setting. The artificial per-batch pause (in milliseconds,
default \`200\`) of the runner's lifecycle *stub* — the fake job the test suite and the
job-lifecycle checks use to exercise progress, cancellation and crash recovery without
publishing anything. A real publication run never reads it.`,
	},
} as const satisfies Record<string, CatalogEntry>;
