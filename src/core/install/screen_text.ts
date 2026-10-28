/**
 * THE TERMINAL INSTALLER'S PROSE (phase 2, 2026-10-12) — every sentence the
 * screen model (screen_model.ts) puts on a screen, in ONE place, English,
 * owned by the installer.
 *
 * NOT the retired wizard's `installation_*` labels: those were deleted with it
 * (phase 5, 2026-10-12). Translation, if it is
 * ever wanted, is an installer-owned catalog (owner flag 1). The ONE shared
 * text is the password policy's rule list, which belongs to component_password
 * and lives in src/core/labels/master.json (`password_rule_*`) — read there,
 * never copied (screen_model.ts passwordFeedback).
 *
 * Plain data: no imports, no logic beyond string templates. Every value is
 * passed through the plain UI's sanitizer before it reaches a terminal; what
 * comes from a catalog (an ontology server's names) is untrusted and is never
 * part of this file.
 */

/** The docs the Install-type and Review screens link (the docs site's own URLs). */
export const HELP_LINKS = Object.freeze({
	guide: { label: 'Install guide', url: 'https://dedalo.dev/docs/v7/install/' },
	reference: {
		label: 'Installer reference',
		url: 'https://dedalo.dev/docs/v7/install/installer_reference/',
	},
	production: {
		label: 'Production install',
		url: 'https://dedalo.dev/docs/v7/install/production/',
	},
	multiInstance: {
		label: 'Several instances on one host',
		url: 'https://dedalo.dev/docs/v7/install/multi_instance/',
	},
	docker: { label: 'Docker install', url: 'https://dedalo.dev/docs/v7/install/docker/' },
	devQuickstart: {
		label: 'Developer quick start',
		url: 'https://dedalo.dev/docs/v7/install/dev_quickstart/',
	},
});

/** Screen titles and descriptions, by screen id. */
export const SCREEN_TEXT: Readonly<Record<string, { title: string; description: string }>> =
	Object.freeze({
		route: {
			title: 'Install type',
			description: 'How will this Dédalo run? The steps that follow adapt to the route.',
		},
		system: {
			title: 'System check',
			description: 'What this machine has. A failed row must be fixed before the install.',
		},
		database: {
			title: 'Database',
			description: 'PostgreSQL for the records, the ontology and the search stores.',
		},
		image: { title: 'Image', description: 'Which Dédalo image the stack runs.' },
		tls_address: { title: 'TLS & address', description: 'How browsers reach the stack.' },
		containers: {
			title: 'Containers',
			description: 'Where the stack keeps its data and how it is published.',
		},
		identity: {
			title: 'Identity',
			description:
				'Where this instance lives and who it belongs to (production: the install folder and the service account first). The install fingerprint can never change later.',
		},
		web_tls: { title: 'Web server & TLS', description: 'How browsers reach this instance.' },
		dev_server: {
			title: 'Development server',
			description:
				'Where `bun run dev` serves the browser: the port, who can reach it, and its certificate. A value your .env already has is kept unless you change it here.',
		},
		services: {
			title: 'Services',
			description: 'Where this instance keeps its media and listens for the web server.',
		},
		ontologies: {
			title: 'Ontologies',
			description:
				'What kind of collection is this? The core is always installed; declared dependencies tick themselves.',
		},
		thesauri: {
			title: 'Thesauri',
			description:
				'The thesauri your ontologies declare are pre-ticked. Untick what you do not need.',
		},
		languages: {
			title: 'Languages',
			description: 'The languages the records and the interface use.',
		},
		publication: {
			title: 'Publication',
			description:
				'Optional. Publish records to a public website database (diffusion, MariaDB). Can be added later from Maintenance.',
		},
		mail: {
			title: 'Mail',
			description:
				'Optional. Outgoing mail through an existing SMTP relay: password recovery sends an 8-digit code by mail. Dédalo runs no mail server of its own.',
		},
		administrator: {
			title: 'Administrator',
			description:
				'The root account manages users, ontologies and maintenance. Its password is set here, in the terminal.',
		},
		review: {
			title: 'Review plan',
			description: 'Everything that will happen, before anything runs. Nothing has changed yet.',
		},
	});

/** One question's label and description, by answer key (or question id for keyless ones). */
export const QUESTION_TEXT: Readonly<Record<string, { label: string; description: string }>> =
	Object.freeze({
		route: { label: 'Install type', description: 'Pick the route.' },
		instance: {
			label: 'Instance name',
			description:
				'A short name for this instance (e.g. prado): lowercase letters, digits and _. Its database, role, media and socket derive from it, so several Dédalo instances can share this host.',
		},
		install_dir: {
			label: 'Install folder',
			description:
				'Where this instance lives: its code (dedalo/), private settings (private/) and backups (backups/). Any absolute path, e.g. /home/my_domain.org/dedalo. Created owned by the service user if missing; an existing folder is used only if empty or already the service user’s. Its parent is never changed.',
		},
		service_user: {
			label: 'Service user',
			description:
				'The account the instance runs as. Enter = a new account of its own (recommended). A new name is created; an existing account (e.g. a hosting account) is used as it is — the installer never creates or deletes an existing account.',
		},
		service_group: {
			label: 'Service group',
			description:
				'The group the web server joins to reach this instance’s socket, media and client. Empty = the service user’s own group (the new same-named one, or an existing account’s primary group). A group of its own is recommended.',
		},
		db_hostname: {
			label: 'Database host',
			description: 'Host name or address of the PostgreSQL server.',
		},
		db_port: { label: 'Database port', description: 'TCP port of the PostgreSQL server.' },
		db_socket: {
			label: 'Database socket',
			description:
				'Absolute path of the PostgreSQL socket directory, to connect through it instead of TCP. Empty = TCP.',
		},
		db_database: { label: 'Database name', description: 'The database to install into.' },
		db_username: {
			label: 'Database user',
			description: 'The PostgreSQL user (a login role) Dédalo connects as; it owns the database.',
		},
		db_password: {
			label: 'Database password',
			description: 'Empty for a peer or trust connection.',
		},
		entity: {
			label: 'Entity code',
			description:
				'A short code for the institution: a letter, then letters, digits and _. It becomes a directory and a key prefix.',
		},
		entity_label: { label: 'Entity name', description: 'The full name shown to users.' },
		information: {
			label: 'Information',
			description:
				'The install fingerprint, written once to ts_state.json and never changed later. The engine only uses it to read passwords migrated from a v6 install; keep the default unless you are moving a v6 installation.',
		},
		info_key: {
			label: 'Info key',
			description:
				'The short key of the install fingerprint (see Information). Never changed later.',
		},
		timezone: { label: 'Time zone', description: 'An IANA time zone (e.g. Europe/Madrid).' },
		locale: { label: 'Locale', description: 'A BCP 47 locale tag (e.g. es-ES).' },
		media_path: {
			label: 'Media directory',
			description:
				'Absolute path where images, documents and recordings are stored (often its own volume).',
		},
		unix_socket: {
			label: 'Server socket',
			description: 'Absolute path of the unix socket the web server proxies to.',
		},
		media_access_mode: {
			label: 'Media access mode',
			description:
				'private = only logged-in users read media; publication = published media is public too; false = no control.',
		},
		update_servers: {
			label: 'Update servers',
			description: 'Where ontology and code updates come from. Nothing installs by itself.',
		},
		ontology_source: {
			label: 'Offline ontology package',
			description:
				'A directory or .tar.gz in the ontology server export layout; empty = built-in oh only.',
		},
		ontologies: {
			label: 'Ontologies',
			description: 'Tick the domain ontologies this collection needs.',
		},
		hierarchies: {
			label: 'Thesauri',
			description: 'Tick the thesauri to install. Only country toponymies ship terms.',
		},
		langs: {
			label: 'Languages',
			description: 'The working languages: records can be written in each of them.',
		},
		app_lang_default: {
			label: 'Interface language',
			description: 'The default interface language (one of the ticked languages).',
		},
		data_lang_default: {
			label: 'Data language',
			description: 'The default language records are written in (one of the ticked languages).',
		},
		diffusion: {
			label: 'Publish to a website',
			description: 'Set up diffusion to a MariaDB website database now.',
		},
		mysql_hostname: { label: 'MariaDB host', description: 'Host of the website database.' },
		mysql_port: { label: 'MariaDB port', description: 'TCP port of the website database.' },
		mysql_socket: {
			label: 'MariaDB socket',
			description: 'Absolute socket path, instead of TCP. Empty = TCP.',
		},
		mysql_database: {
			label: 'Website database',
			description: 'The MariaDB database publication writes to.',
		},
		mysql_username: {
			label: 'MariaDB user',
			description: 'The MariaDB user publication writes as.',
		},
		mysql_password: { label: 'MariaDB password', description: 'The password of that user.' },
		mailer: {
			label: 'Send mail through an SMTP relay',
			description: 'Needed for password recovery by mail.',
		},
		smtp_host: { label: 'SMTP server', description: 'Host name of the relay.' },
		smtp_port: { label: 'SMTP port', description: '587 for STARTTLS, 465 for implicit TLS.' },
		smtp_secure: { label: 'SMTP security', description: 'How the connection is encrypted.' },
		smtp_user: { label: 'SMTP user', description: 'The mailbox the relay authenticates.' },
		smtp_pass: { label: 'SMTP password', description: 'The password of that mailbox.' },
		smtp_from: {
			label: 'From address',
			description: 'The sender address; empty uses the SMTP user.',
		},
		smtp_from_name: { label: 'From name', description: 'The sender name shown to recipients.' },
		root_password: {
			label: 'Root password',
			description: 'Never written to the plan file, the log or the shell history.',
		},
		// The host steps (phase 4).
		db_mode: {
			label: 'Database',
			description:
				'create = the installer creates the role and the database on this host (peer login, no password stored); existing = a database you created, probed as it is.',
		},
		web_server: {
			label: 'Web server',
			description:
				"The one that serves this instance. Empty = the one this host has, else nginx. Only this instance's own site file is written.",
		},
		server_name: {
			label: 'Public address',
			description: 'The domain name browsers use (e.g. dedalo.museum.org) — not an IP address.',
		},
		http_port: { label: 'HTTP port', description: 'Plain HTTP (redirects to HTTPS).' },
		https_port: { label: 'HTTPS port', description: 'The port browsers use.' },
		tls_mode: { label: 'Certificate', description: 'Where the TLS certificate comes from.' },
		tls_extra_names: {
			label: 'Other addresses',
			description:
				"Optional: other names or IPv4 addresses staff type (e.g. dedalo.lan,192.168.1.20), comma-separated. On the production route an IP address must be one of this server's and claimed by no other instance. The certificate names them, and the local authority can certify nothing else.",
		},
		letsencrypt_email: {
			label: "Let's Encrypt e-mail",
			description: "Expiry notices from Let's Encrypt go here.",
		},
		tls_cert_path: {
			label: 'Certificate file',
			description:
				'The fullchain PEM (certificate + intermediates), absolute path; used where it is.',
		},
		// The stack COPIES the files in (host/stack/tls.ts): its own words (C3-48).
		'tls_address.tls_cert_path': {
			label: 'Certificate file',
			description:
				"The fullchain PEM (certificate + intermediates), absolute path; copied into the stack's deploy/certs/.",
		},
		'tls_address.tls_key_path': {
			label: 'Key file',
			description:
				"The private key PEM, absolute path; checked against the certificate and copied into the stack's deploy/certs/.",
		},
		tls_key_path: {
			label: 'Key file',
			description: 'The private key PEM, absolute path; checked against the certificate.',
		},
		// The developer listener's own words (DEV_ROUTE_SERVE §1.1–1.2).
		dev_port: {
			label: 'Port',
			description:
				'The port `bun run dev` serves the browser on (SERVER_TCP_PORT). If another program already uses it, the Review refuses and suggests the next free one.',
		},
		dev_host: {
			label: 'Reachable from',
			description:
				'This machine only, or the local network (SERVER_TCP_HOST). A development install shows full error details to the browser: open it to the network only on one you trust.',
		},
		'dev_server.tls_mode': {
			label: 'Certificate',
			description:
				'HTTPS with a local certificate authority (a secure context like production: Secure cookies, clipboard, service workers), plain HTTP, or your own certificate files.',
		},
		'dev_server.tls_cert_path': {
			label: 'Certificate file',
			description:
				'Your fullchain PEM (e.g. made with mkcert), absolute path; the server reads it where it is.',
		},
		'dev_server.tls_key_path': {
			label: 'Key file',
			description:
				'Its private key PEM, absolute path, readable by your account only; the server refuses to start with a key of another certificate.',
		},
		'dev_server.unix_socket': {
			label: 'Server socket',
			description:
				'The unix socket `bun run dev` also binds (SERVER_UNIX_SOCKET), absolute path. One per checkout: the default carries the entity (/tmp/dedalo_ts_<entity>.sock), so two installs on this machine never share one. If a running server already answers on it, the Review refuses.',
		},
		backup_dir: {
			label: 'Backup directory',
			description:
				'Where the nightly backup of the database, the media and the configuration goes.',
		},
		image_source: {
			label: 'Image source',
			description:
				"Official: pulled from the Dédalo registry under this installer's own version (a stable release or a prerelease such as 7.0.0-beta.7), its signature verified — the Review checks the registry before you install. A development build (a commit with no release tag) is no image: Official and Build are refused for it, and Custom is preselected — pulled from your own registry. Build: built here from a release or beta checkout's last commit (slow the first time: the Review says how long).",
		},
		image_repository: {
			label: 'Image repository',
			description: 'Your own registry repository (custom image only).',
		},
		image_version: {
			label: 'Image version',
			description:
				"The image tag; empty = this installer's own release. No other tag is accepted: Docker has no nightly images (a development build has no image).",
		},
		'route.trial_no_media_protection': {
			label: 'Trial without media protection',
			description:
				'The trial stack serves plain HTTP and has NO media access control: anyone who can reach this server can read every image, document and recording in it, without logging in. For an evaluation only: never put real records in it — no records you need to keep, no restricted material, no personal data.',
		},
		'thesauri.none_selected': {
			label: 'No thesaurus selected',
			description:
				'The install will carry no thesaurus beyond Languages. Thesauri can be installed later from Maintenance › Install hierarchies.',
		},
		'publication.probe_override': {
			label: 'Keep the publication settings untested',
			description:
				'The MariaDB connection did not pass. Accept to keep these settings anyway (shown on the review).',
		},
		'mail.probe_override': {
			label: 'Keep the mail settings untested',
			description:
				'The SMTP test did not pass. Accept to keep these settings anyway (shown on the review).',
		},
	});

/**
 * HOW an acknowledgement is given, per front end — ONE source, so the words
 * always match the control (campaign 3 C3-26: a full-screen checkbox under
 * "Type yes" ignored a typed yes). Both front ends take a TYPED `yes`; the
 * full screen also ticks with Space.
 */
export const ACKNOWLEDGE_TEXT = Object.freeze({
	plain: 'Type yes to accept (anything else declines): ',
	full: 'Space ticks it, or type yes — then Enter. Unticked, Enter declines.',
	tick: 'I understand',
});

/**
 * The command each route's install is run with — what a "same as" line and an
 * answers file's next step print (campaign 3 C3-53: never `bun run …` on a
 * route whose host has no Bun on its PATH). The host routes' words are the
 * bootstrap's, as host_executor.ts hostCommandPrefix types a resume (gated
 * equal: install_screen_model_tripwire).
 */
export const ENTRY_COMMAND: Readonly<Record<string, string>> = Object.freeze({
	production: 'sudo sh install.sh',
	docker: 'sh install.sh',
	trial: 'sh install.sh',
	developer: 'bun run scripts/install.ts',
});

/** The route options. */
export const ROUTE_TEXT = Object.freeze({
	production: {
		label: 'Production',
		badge: 'recommended for a museum',
		description:
			'Native services on this host (systemd, nginx or Apache, TLS, backups, watchdog); a named instance that can share the server with others.',
	},
	docker: {
		label: 'Docker',
		badge: 'compose stack',
		description: 'Containers for Dédalo, PostgreSQL and the web server; volumes on this host.',
	},
	trial: {
		label: 'Trial',
		badge: 'Docker without media protection',
		description:
			'The Docker stack WITHOUT media access control: any file is served to anyone with its URL. Evaluation only.',
	},
	developer: {
		label: 'Developer',
		badge: 'from a git checkout',
		description: 'bun run dev against a local PostgreSQL.',
	},
});

/** The choice options' own words. */
export const OPTION_TEXT = Object.freeze({
	update_servers: {
		official: (url: string) => ({
			label: 'Official Dédalo servers',
			description: `Ontology and code updates are offered from ${url} (Maintenance; never automatic).`,
		}),
		none: {
			label: 'None (air-gapped)',
			description:
				'No update server is configured (ONTOLOGY_SERVERS and CODE_SERVERS are written empty): no update is ever offered, and only the built-in oh ontology can be installed unless an offline package is given.',
		},
	},
	media_access_mode: {
		'': { label: 'Engine default', description: 'Not written; the engine default applies.' },
		private: { label: 'private', description: 'Only logged-in users read media.' },
		publication: {
			label: 'publication',
			description: 'Logged-in users read everything; anyone reads published media.',
		},
		false: { label: 'false', description: 'No media access control.' },
	} as Record<string, { label: string; description: string }>,
	db_mode: {
		create: {
			label: 'Create it',
			description:
				'The role of the service user (peer login) and its database, on this host’s PostgreSQL 18.',
		},
		existing: { label: 'Use an existing one', description: 'Probed as it is; nothing is created.' },
	} as Record<string, { label: string; description: string }>,
	web_server: {
		'': { label: 'Detect', description: 'The web server this host has, else nginx.' },
		nginx: {
			label: 'nginx',
			description: 'conf.d/dedalo-<instance>.conf (nginx 1.25.1 or newer).',
		},
		apache: {
			label: 'Apache',
			description: 'One virtual host file; its modules are checked, never enabled.',
		},
	} as Record<string, { label: string; description: string }>,
	tls_mode: {
		letsencrypt: {
			label: "Let's Encrypt",
			description:
				'Issued and renewed automatically (the address must reach this host on port 80).',
		},
		files: {
			label: 'Our own certificate',
			description:
				'Your institution’s fullchain and key, checked against the address and the expiry.',
		},
		local_ca: {
			label: 'Local CA',
			description:
				'A certificate authority made by the installer, for a network with no public name (an intranet): each staff computer trusts it once.',
		},
	} as Record<string, { label: string; description: string }>,
	/** The developer listener's address. */
	dev_host: {
		'127.0.0.1': {
			label: 'This machine',
			description: 'Only a browser on this computer (127.0.0.1).',
		},
		'0.0.0.0': {
			label: 'The local network',
			description: 'Every address of this computer (0.0.0.0) — with full error details shown.',
		},
	} as Record<string, { label: string; description: string }>,
	devHostOther: 'This address of the computer (given by flag or kept from your .env).',
	/** The developer listener's certificate (no Let's Encrypt: a checkout has no public name). */
	dev_tls_mode: {
		local_ca: {
			label: 'Local CA (HTTPS)',
			description:
				'A certificate authority made for this checkout in <private>/tls; this computer trusts it once.',
		},
		none: {
			label: 'None (plain HTTP)',
			description: 'http:// only — the session cookie is then sent without the Secure flag.',
		},
		files: {
			label: 'My own certificate',
			description: 'A fullchain and key you already have (e.g. from mkcert).',
		},
	} as Record<string, { label: string; description: string }>,
	devTlsKept: {
		label: 'Keep the current certificate',
		description: (cert: string) => `The pair your .env already names (${cert}).`,
	},
	image_source: {
		official: {
			label: 'Official',
			description:
				'The signed Dédalo image of this release, verified before use (not for a development build).',
		},
		custom: { label: 'Custom', description: 'An image from your own registry.' },
		build: {
			label: 'Build',
			description: 'Built here from this checkout (not for a development build).',
		},
	} as Record<string, { label: string; description: string }>,
	smtp_secure: {
		tls: { label: 'STARTTLS', description: 'Plain connection upgraded to TLS (port 587).' },
		ssl: { label: 'Implicit TLS', description: 'TLS from the first byte (port 465).' },
		none: { label: 'None', description: 'Unencrypted: only on a trusted local relay.' },
	} as Record<string, { label: string; description: string }>,
});

/** The marks an option can carry, as words (a screen reader reads them). */
export const MARK_TEXT = Object.freeze({
	core: 'always installed',
	default: 'default',
	ships_terms: 'ships terms',
	empty: 'definition, you fill it',
	needed_by: (by: readonly string[]) => `needed by ${by.join(', ')}`,
	recommended_by: (by: readonly string[]) => `strongly recommended by ${by.join(', ')}`,
	also_installs: (tlds: readonly string[]) => `also installs ${tlds.join(', ')}`,
	undeclared_vendored: 'dependencies not declared (built-in file predates them)',
	undeclared_server: 'dependencies not declared by its source',
});

/** The explanatory notes under a TLD — one per ontology_choice.ts ONTOLOGY_NOTE_LABELS key (gated equal). */
export const ONTOLOGY_NOTE_TEXT: Readonly<Record<string, string>> = Object.freeze({
	oh: 'Oral history: interviews, their audiovisual recordings, transcriptions and indexing. Built in — installable without a network.',
	tch: 'Tangible cultural heritage: the general inventory model for objects and collections. Downloaded from the update server.',
});

/** Every other sentence a screen shows. */
export const NOTICE_TEXT = Object.freeze({
	coreOntologies: (tlds: readonly string[]) => `Always installed: ${tlds.join(', ')} (core).`,
	coreThesauri: (labels: readonly string[]) => `Always installed: ${labels.join(', ')}.`,
	airGapped:
		'Air-gapped: ONTOLOGY_SERVERS and CODE_SERVERS are written empty — no update is ever offered. Only oh is offered unless an offline package is given.',
	onlyOh: 'Air-gapped without an offline package: only oh is offered.',
	catalogUnreachable: (msg: string) =>
		`The ontology catalog could not be read (${msg}) — only the built-in ontologies are offered.`,
	catalogSource: (label: string) => `Ontologies offered by ${label}.`,
	thesauriIntro:
		'Thesauri ship EMPTY by design — definitions you fill — except the country toponymies, which ship their terms. A large country toponymy uses database space and import time.',
	// The example code is a REAL tld of the vendored offer (gated: install_screen_model_tripwire).
	toponymyExample: 'np',
	toponymy: (example: string) =>
		`No country toponymy selected. Type a country code (e.g. ${example}) to add one, or press enter to skip.`,
	databasePrerequisite:
		'The database must exist and be EMPTY, owned by the role below (it creates tables, indexes and functions): CREATE DATABASE <name> OWNER <role>.',
	databaseCreated:
		'The installer creates the role and the database on this host (PostgreSQL 18, peer login over the local socket: no database password is stored).',
	stackDbPassword:
		'The database of the stack gets a generated password, written to .dedalo.env (0600) — never shown.',
	hostCommands:
		'Every host command is listed on the Review, exactly as it will run. Packages, repositories and the firewall are never removed or changed behind your back: packages stay installed on --abort, the firewall is only checked.',
	/** The docker and trial routes' own words (C3-48 — never the production boilerplate). */
	stackCommands:
		"Every host command is listed on the Review, exactly as it will run. Docker itself and your user's groups are never installed or changed — they are only checked; the images stay on --abort. The firewall is neither changed nor checked: Docker-published ports bypass it (see Docker install).",
	/** The trial's own pointer (campaign 3c D23: its firewall warning is the Trial page's, not Docker's). */
	trialCommands:
		"Every host command is listed on the Review, exactly as it will run. Docker itself and your user's groups are never installed or changed — they are only checked; the images stay on --abort. The firewall is neither changed nor checked: Docker-published ports bypass it (see the Trial page's firewall warning).",
	databaseProbe: (msg: string) => `Database check: ${msg}`,
	noMail: 'Without mail, a forgotten password needs the server console.',
	probeOk: (msg: string) => `Check passed: ${msg}`,
	probeFailed: (msg: string) => `Check failed: ${msg}`,
	systemVersion: (version: string, seed: string) => `Dédalo ${version} · seed ${seed}`,
	systemSummary: (failed: number, warned: number) =>
		failed === 0
			? `System ready${warned === 0 ? '' : ` (${warned} warning${warned === 1 ? '' : 's'})`}.`
			: `${failed} check${failed === 1 ? '' : 's'} failed — fix ${failed === 1 ? 'it' : 'them'} and re-check.`,
	systemIncomplete: (msg: string) => `The system check did not complete: ${msg}`,
	/** A failure no fix on this machine can change (an unsupported system — C3-61). */
	systemUnfixable: 'This system cannot run this route — quit, or go back to choose another route.',
	envSecret: 'supplied by the environment — kept',
	trialHttpPort:
		'The port browsers use: the trial serves plain HTTP only (no HTTPS port, no certificate).',
	trialProbesSkipped:
		'The stack is not running yet, so the connection is tested by the install inside the container.',
	mediaProbe: (msg: string) => `Media directory: ${msg}`,
	/** The developer listener (DEV_ROUTE_SERVE §1.1). */
	devServerUrl: (url: string) => `bun run dev will serve ${url}`,
	devServerKept: (keys: readonly string[]) =>
		`Kept from your .env (not rewritten): ${keys.join(', ')}.`,
	// The network warning is the plan's own sentence: dev_listener.ts devListenerNetworkWarning.
	devServerPlain:
		'Plain HTTP: SESSION_COOKIE_SECURE is written false so the browser keeps the login cookie on http://.',
	identityProbe: (msg: string) => `Install folder and service account: ${msg}`,
	reviewEnvHelp:
		'The .env keys below are written to <private>/.env (0600); the values are never shown here.',
	reviewRoot:
		'The production route runs as root (sudo sh install.sh); the engine steps then run as the service user.',
	reviewInstallOffered: 'Type install to start, or edit a step.',
	/** A word a failed check's prompt does not offer (campaign 3c D19: one plain sentence). */
	notOffered: (word: string, prompt: string) => `'${word}' is not offered here — type ${prompt}`,
	/**
	 * The run's own system check refuses at the typed yes (campaign 3c D2): the
	 * session stays on the Review with every answer.
	 */
	refusedAtYes:
		'not started — the system check of the run refuses this plan (nothing was changed; your answers are kept): fix the cause, then install again (it checks first), or edit a step',
	/** `install` on a refused Review: the plan is measured anew (campaign 3d C3d-F2). */
	recheckReview: 'checking again what the run would refuse…',
	stillRefused: 'checked again — install is still not offered: see the errors above',
	/** The re-check found nothing to refuse: the yes prompt follows (campaign 3e E2). */
	recheckOffered: 'checked again — nothing is refused now: install is offered',
});

/** The review's line labels. */
export const REVIEW_TEXT = Object.freeze({
	route: 'route',
	instance: 'instance',
	database: 'database',
	ontologies: 'ontologies',
	thesauri: 'thesauri',
	languages: 'languages',
	publication: 'publication',
	mail: 'mail',
	media: 'media',
	socket: 'socket',
	admin: 'administrator',
	steps: 'steps',
	envKeys: '.env keys',
	planFile: 'plan file',
	sameAs: 'same as',
	prerequisites: 'before the install',
	off: 'off',
	tested: 'tested',
	untested: 'not tested',
	acknowledged: 'kept untested (acknowledged)',
	passwordSet: 'root · password set',
	passwordMissing: 'root · password NOT set',
	notWritten: 'not written (engine default)',
	address: 'address',
	certificate: 'certificate',
	backups: 'backups',
	hostCommands: 'host commands',
	devServer: 'development server',
	devNames: 'certificate names',
	devTrust: 'trust store',
	kept: 'kept from .env',
	devCertificate: (source: string, cert: string): string => {
		if (source === 'none') return 'none (plain HTTP)';
		if (source === 'kept') return `kept · ${cert}`;
		if (source === 'files') return `your own · ${cert}`;
		return `local CA · ${cert}`;
	},
	/** The identity lines (identity_verdict.ts labels → words). */
	identity: Object.freeze({
		'install folder': 'install folder',
		'service user': 'service user',
		'service group': 'service group',
		'database user': 'database user',
		note: 'note',
	}),
});

/**
 * The end of a run, in ONE place: the plain CLI prints these sentences and the
 * full-screen Done screen shows them (scripts/install.ts plainReporter,
 * ui/screens/done.ts).
 */
const DONE_TEXT_ENGINE_SUPERVISOR =
	'Start the server with `bun run dev` (development) or `bun run start:supervised` — docs/install/dev_quickstart.md; plain `bun run start` is unsupervised and cannot take code updates. A host set up by hand starts it under systemd: docs/install/manual_install.md#manual-host_units.';
const DONE_TEXT_ENGINE_ABORTED =
	'install aborted — what the install created is removed; the database itself is kept.';
/** An --engine-only run is the by-hand host procedure's: its server is systemd's (C3-54). */
const DONE_TEXT_ENGINE_ONLY =
	"Next: the instance's systemd units start it — docs/install/manual_install.md#manual-host_units.";

/** `1 step undone` / `3 steps undone`. */
function stepsUndone(count: number): string {
	return `${count} step${count === 1 ? '' : 's'} undone (each line above says what it removed)`;
}

/** What a LIVE instance keeps, and where removing it by hand is described — per route. */
function liveKept(ending: DoneEnding): string {
	return ending.route === 'production'
		? 'its user, database and code are kept — removing a served instance is a manual job: docs/install/multi_instance.md#removing-an-instance'
		: `its containers and volumes (the database) are kept — to remove it, see ${ending.route === 'docker' ? 'docs/install/docker.md#removing-the-stack' : 'docs/install/quickstart.md#removing-the-trial'}`;
}

/** The aborted sentence of a LIVE instance (it has served: an abort keeps it). */
function abortedLive(ending: DoneEnding): string {
	const count = ending.undone?.length ?? 0;
	if (count === 0) {
		return `nothing was undone — the instance has served, so --abort keeps it whole: ${liveKept(ending)}.`;
	}
	return `install partly undone — ${stepsUndone(count)}; the instance has served, so ${liveKept(ending)}. --resume puts the undone steps back.`;
}

/** What a host route's full abort leaves on the machine on purpose. */
const HOST_ABORT_KEPT: Readonly<Record<string, string>> = Object.freeze({
	production: 'the installed packages and any backups are kept',
	docker: 'the images are kept (docker image ls)',
	trial: 'the images are kept (docker image ls)',
});

export const DONE_TEXT = Object.freeze({
	complete: (verified: boolean) => `install complete${verified ? ' — root login verified' : ''}`,
	/**
	 * A run that did not complete, in one line: a REFUSAL (nothing was done — an
	 * --abort of a sealed install, a resume whose answers differ) says so, never
	 * "install failed" (campaign 3b N24).
	 */
	failure: (outcome: {
		readonly result: string;
		readonly failedStep: string | null;
		readonly message: string | null;
	}): string =>
		outcome.result === 'refused'
			? `refused: ${outcome.message ?? ''}`
			: `install failed${outcome.failedStep === null ? '' : ` at step [${outcome.failedStep}]`}: ${outcome.message ?? ''}`,
	/** What the closing block repeats after a salt shown on this terminal (campaign 3b N28). */
	saltKeep:
		'The generated DEDALO_SALT_STRING shown above is also kept in the private .env (0600) — keep a copy with your backups: the stored passwords cannot be verified without it.',
	/** The engine-only run's next step (a host route says its own: `next`). */
	supervisor: DONE_TEXT_ENGINE_SUPERVISOR,
	aborted: DONE_TEXT_ENGINE_ABORTED,
	browser:
		'Then open the web interface and log in as root: Maintenance installs further thesauri and toponymies, restores a backup and offers updates.',
	written: (path: string) => `answers written to ${path} (no secret is in it)`,
	/** --write-answers on an interactive run that never reached a valid Review (C3-36). */
	notWritten: (path: string) =>
		`answers not written to ${path}: the session ended before the Review showed a valid plan (--write-answers writes at a valid Review)`,
	writtenNext: (route: string) =>
		`Run the install from them with: ${ENTRY_COMMAND[route] ?? ENTRY_COMMAND.developer} --answers <file> (the passwords via DEDALO_INSTALL_* or --secrets-stdin).`,
	saltStored: "A generated secret is also stored in the install's private .env (0600).",
	/**
	 * A run refused after the typed yes (campaign 3c D2): the reviewed answers
	 * are kept in a file, and the command that runs them again is printed.
	 */
	keptAnswers: (path: string, route: string): string[] => [
		`  Your answers are kept in ${path} (no secret is in it). Fix the cause, then run the install from them:`,
		`    ${ENTRY_COMMAND[route] ?? ENTRY_COMMAND.developer} --answers ${path}`,
		'  (the root password is asked again on a terminal; other passwords via DEDALO_INSTALL_* or --secrets-stdin)',
	],
	/** The answers could not be written: the equivalent command line keeps them. */
	keptAsCommand: (refusal: string, command: string): string[] => [
		`  Your answers could not be written (${refusal}). They are this command line:`,
		`    ${command}`,
	],
	/** The closing list of what the operator does (a host route — campaign 3c D5: every front end). */
	todoHeading: 'To do on this host:',
	/** What comes next after a complete install — per route: a host route already started it. */
	next: (ending: DoneEnding): string => {
		if (ending.route === 'production') {
			const unit = `dedalo-ts@${ending.instance}`;
			return `${unit} is running under systemd and starts at boot; its health watchdog and nightly backup timer are armed (systemctl status ${unit} · journalctl -u ${unit}). Do not start dedalo-ts.service — that is the single-instance unit of the manual procedure, not this instance.`;
		}
		if (ending.route === 'docker' || ending.route === 'trial') {
			const compose = `docker compose -f ${ending.route === 'trial' ? 'docker-compose.simple.yml' : 'docker-compose.yml'} -f compose.override.yaml --env-file .dedalo.env`;
			return `The stack is up under Docker and restarts with it — from this checkout: \`${compose} ps\` / \`${compose} logs dedalo\` (all three files, or compose resolves its built-in defaults).`;
		}
		return engineNext(ending);
	},
	/**
	 * The developer route's closing block (TODO-053, DEV_ROUTE_SERVE §1.3): the
	 * command, every URL (built from the WRITTEN keys — dev_serve.ts), the root
	 * login, the certificate — on every front end (plain, full screen, and left
	 * on the main screen after it closes). docs/install/dev_quickstart.md quotes
	 * it; gated against this function.
	 */
	served: (view: ServedEnding): string[] => [
		`Start:   ${view.start}   (Ctrl-C stops it)`,
		...view.urls.map((url, index) => `${index === 0 ? 'Open:   ' : '        '} ${url}`),
		'Log in:  root, with the password set during this install',
		...servedTlsLines(view.tls),
		...(view.network
			? ['Network: other machines reach it, with full error details — only on a network you trust']
			: []),
	],
	/**
	 * The aborted sentence — per route, whether a live instance was kept, and
	 * built from what the abort ACTUALLY undid (campaign 3 C3-50: never "removed:
	 * its site, units, user…" after `undoing: nothing`).
	 */
	abortedFor: (ending: DoneEnding): string => {
		if (ending.keptLive) return abortedLive(ending);
		const kept = HOST_ABORT_KEPT[ending.route];
		if (kept === undefined) return DONE_TEXT_ENGINE_ABORTED;
		const count = ending.undone?.length ?? 0;
		if (count === 0) {
			return 'install aborted — nothing had been created yet, so nothing was undone; the install record is removed.';
		}
		return `install aborted — ${stepsUndone(count)}; ${kept}.`;
	},
});

/** How a run ended (structurally run_events.ts RunEnding — this file imports nothing). */
interface DoneEnding {
	readonly route: string;
	readonly instance: string;
	readonly keptLive: boolean;
	readonly undone?: readonly string[];
	readonly served?: ServedEnding;
}

/** What comes next on an engine run: the served developer listener, systemd, or the supervisor. */
function engineNext(ending: DoneEnding): string {
	if (ending.served !== undefined) {
		return `Start it with \`${ending.served.start}\`, then open ${ending.served.urls[0] ?? ''} and log in as root.`;
	}
	return ending.route === 'engine_only' ? DONE_TEXT_ENGINE_ONLY : DONE_TEXT_ENGINE_SUPERVISOR;
}

/** The developer route's served listener (structurally run_events.ts DevServedView). */
export interface ServedEnding {
	readonly start: string;
	readonly urls: readonly string[];
	readonly network: boolean;
	readonly tls:
		| {
				readonly kind: 'local_ca';
				readonly caFile: string;
				readonly fingerprint: string | null;
				readonly trusted: boolean | null;
				readonly manual: string;
		  }
		| { readonly kind: 'files'; readonly certFile: string }
		| null;
}

/** The certificate lines of the served block. */
function servedTlsLines(tls: ServedEnding['tls']): string[] {
	if (tls === null) {
		return [
			'TLS:     none — plain HTTP (SESSION_COOKIE_SECURE=false; the installer with --tls local_ca serves HTTPS)',
		];
	}
	if (tls.kind === 'files') {
		return [
			`TLS:     your own certificate, ${tls.certFile} — its authority must be trusted by the browser`,
		];
	}
	const trust =
		tls.trusted === true
			? 'trusted on this machine: the browser opens it without a warning'
			: tls.trusted === false
				? `not trusted yet — the browser warns until you trust it once: ${tls.manual}`
				: 'trust not measured (DEDALO_TEST_TRUST_STORE_OFF: a test run)';
	return [
		`TLS:     local certificate authority ${tls.caFile}`,
		`         SHA-256 ${tls.fingerprint ?? '(unreadable)'}`,
		`         ${trust}`,
	];
}
