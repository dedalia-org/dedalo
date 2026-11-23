/**
 * CONFIG CATALOG — domain: server
 *
 * GENERATED SCAFFOLD (probe_emit_catalog.ts). Hand-edit from here on.
 */

import type { CatalogEntry } from '../catalog_types.ts';

export const SERVER_KEYS = {
	DEDALO_SUPERVISED: {
		// Read as the literal string `'true'` from the PROCESS environment only
		// (src/core/update/supervision.ts); anything else, including unset, is
		// "not supervised". type:'string' because a 'bool' would imply a default
		// and a .env reading, and this key has neither.
		type: 'string',
		scope: 'operator',
		// Operator-facing (the manual documents it), but install/sample.env must not
		// offer a `#DEDALO_SUPERVISED=` line: ../private/.env is the one place it is
		// ignored, and the installer copies the template there as the key census.
		processEnvironmentOnly: true,
		default: undefined,
		heading: 'Declaring that a process supervisor is present',
		typeLabel: 'true',
		typeSuffix: '(process environment only; unset = not supervised)',
		doc: `A code update replaces the installation tree and then exits the server process, so that
it comes back up running the new code. That only works if **something restarts it**. To
avoid taking the server down for good, the update refuses to run unless the process was
started with \`DEDALO_SUPERVISED=true\`.

The key is **declared by the process manager that restarts the server**, never written into
the configuration file. Every shipped runtime definition already carries it: the reference
systemd unit (\`Environment=DEDALO_SUPERVISED=true\`), the Docker Compose stacks
(\`environment:\`), and the \`start:supervised\`, \`dev\` and \`dev:server\` scripts, which
relaunch the server when it asks for a restart. A unit or stack you wrote yourself needs the
same line.

A value in \`../private/.env\` is **ignored**: that file is read by every launch method,
including \`bun run start\`, which is deliberately unsupervised — nothing relaunches it. The
refusal names the ignored line when it finds one. Nor is supervision guessed from the service
manager's own variables: those are inherited by every process started under it, terminal
shells included.

Declaring \`true\` on a process that nothing restarts is the one dangerous mistake here:
the update will swap the code, exit, and the server will stay down until you start it
by hand.

\`\`\`bash
# systemd unit, [Service] section:   Environment=DEDALO_SUPERVISED=true
# compose service, environment: map: DEDALO_SUPERVISED: "true"
# inside a shell loop that relaunches the server when it exits:
DEDALO_SUPERVISED=true bun run src/server.ts
\`\`\``,
	},
	DEDALO_SMOKE_BOOT: {
		// Read as the literal string `'true'` (anything else, including unset, is
		// "not a smoke boot"), so type:'string' is right and a 'bool' LABEL would
		// be the same lie DEDALO_SUPERVISED's was.
		type: 'string',
		scope: 'environment',
		default: undefined,
		heading: 'Pre-swap boot check of a candidate code tree',
		typeLabel: 'true',
		typeSuffix: '(set by the updater; never by hand)',
		doc: `Set by the code updater on a CHILD process, never by an administrator.

Before a code update replaces the installation tree, it boots the downloaded tree once —
in place, in its quarantine directory — to prove the new release can actually start. That
child is spawned with this flag and a throwaway socket of its own.

Under the flag the server is **read-only by construction**: boot migrations, schedulers,
diffusion, watchers and media-tree provisioning are all skipped, and the process only binds
its socket and answers \`/health\` until it is asked to stop. If it never answers, the update
is refused and nothing is swapped.

Setting it by hand on the real server yields a process that serves \`/health\` and nothing
else — never do it. See \`engineering/PRODUCTION.md\` for the update pipeline.`,
	},
	DEDALO_SMOKE_PROCESSES_DIR: {
		// Read only under DEDALO_SMOKE_BOOT (src/core/media/processes_mount.ts
		// verifySmokeProcessesDirMount): the smoke child's own private dir is a
		// throwaway, so the updater names the LIVE processes dir explicitly.
		type: 'string',
		scope: 'environment',
		default: undefined,
		heading: 'Live media processes dir, for the pre-swap boot check',
		typeLabel: 'absolute path',
		typeSuffix: '(set by the updater; never by hand)',
		doc: `Set by the code updater on its pre-swap boot CHILD (see \`DEDALO_SMOKE_BOOT\`), never by an
administrator: the media processes directory the RUNNING installation uses.

The new release's real boot refuses a processes directory on an NFS mount that caches
lookups or attributes (\`engineering/PRODUCTION.md\` §8.1). The pre-swap boot reads the same
verdict on this directory — read only, nothing is created — so an update that would not start
is refused before the installation tree is replaced. Ignored outside that boot.`,
	},
	DEDALO_CLIENT_PUBLISH_DIR: {
		// Read from the PROCESS environment only (src/core/install/client_publish.ts):
		// it names a mount of the container the launcher built, which a value in
		// ../private/.env — a file that outlives every container — cannot know.
		type: 'string',
		scope: 'environment',
		default: undefined,
		heading: 'Directory the engine publishes its own client into',
		typeLabel: 'absolute path',
		typeSuffix: '(set by the container stack; unset = publish nothing)',
		doc: `Set by the container stacks, never by hand. At every start the engine copies the
client files of the code it is running into this directory and switches \`<dir>/dedalo\` to
the new copy in one step; the reverse proxy serves the client from there. The proxy therefore
always serves the client that belongs to the running engine — never the one from a checkout of
another version, which the engine would not understand.

Unset (every installation that is not a container): nothing is published, and the proxy serves
the client from the installation tree as before. Never set in a pre-swap boot check.`,
	},
	DEDALO_WRITABLE_ROOTS_MANIFEST: {
		// Written into the server's systemd drop-in by the production installer
		// (src/core/install/host/systemd/render.ts serverDropin); read at boot by
		// src/config/writable_roots.ts, never set by hand.
		type: 'string',
		scope: 'environment',
		default: undefined,
		heading: 'The manifest of the paths the service unit lets the engine write',
		typeLabel: 'absolute path',
		typeSuffix: '(set by the installer’s systemd drop-in; unset = no check)',
		doc: `Set by the production installer in the instance's systemd drop-in, never by hand. The
server unit runs with \`ProtectSystem=strict\`: the whole file system is read-only to the engine
except the roots the drop-in lists in \`ReadWritePaths=\` — the install folder, the backup
directory, the media root and the published client, the socket directories and the temp
directories. The installer writes that same list, derived from the install answers, into a small
JSON file beside the drop-in and names it here.

At boot the engine checks every path it is configured to write (the private directory,
\`MEDIA_PATH\`, \`DEDALO_BACKUP_DIR\`, the export artifacts, the ontology IO directory, the
client publish directory, the socket directory…) against that list and **refuses to start**
(exit 78, which the unit never restarts) when one lies outside it, naming the command that
re-renders the units from the install's plan. Without the check a path moved in \`.env\` to a
place the unit does not allow would fail at its first write, in the middle of an upload or a
backup. Unset (every installation that is not a production systemd instance): no check.`,
	},
	DEDALO_CONTAINER_IMAGE: {
		// Read from the PROCESS environment only (src/core/update/image_source.ts):
		// the container stack declares the image it runs. Not DEDALO_IMAGE_*: that
		// prefix is the media-image configuration family.
		type: 'string',
		scope: 'environment',
		default: undefined,
		heading: 'Image repository this container runs',
		typeLabel: 'repository',
		typeSuffix: '(set by the container stack from .dedalo.env)',
		doc: `Set by the container stacks from the \`DEDALO_IMAGE\` line of \`.dedalo.env\`, never by
hand: the image repository (no tag) this engine runs — one of Dédalo's registries, a registry
of the operator's own, or \`localhost/dedalo\` for an image built on the Docker host. The
code-update panel shows it, and whether it is an official registry, next to the command that
updates the installation. A value that is not a repository reference is ignored.`,
	},
	DEDALO_CONTAINER_IMAGE_MODE: {
		// Read from the PROCESS environment only (src/core/update/image_source.ts).
		type: 'string',
		scope: 'environment',
		default: undefined,
		heading: 'How this container gets its image',
		typeLabel: 'pull | build',
		typeSuffix: '(set by the container stack from .dedalo.env)',
		doc: `Set by the container stacks from the \`DEDALO_IMAGE_MODE\` line of \`.dedalo.env\`, never
by hand: \`pull\` when updates pull a published image, \`build\` when the Docker host builds it
from its checkout. The code-update panel uses it to describe how an update will be fetched. Any
other value is ignored.`,
	},
	NODE_TLS_REJECT_UNAUTHORIZED: {
		type: 'string',
		scope: 'internal',
		default: undefined,
		heading: 'TLS verification switch (engine guard — never set it)',
		typeLabel: 'string',
		doc: `**Not a Dédalo setting: a runtime variable Dédalo defends against.** Setting it to \`0\`
turns OFF certificate verification for *every* outgoing connection the process makes —
ontology master servers, code-release downloads, external services — leaving them open to
interception.

The engine treats it as a hazard rather than an option: the ontology import **refuses to
run at all** while \`NODE_TLS_REJECT_UNAUTHORIZED=0\` is in the environment, and stops with
an explicit error.

If a server you must reach presents a private or self-signed certificate, trust its
authority instead of disabling verification — point \`NODE_EXTRA_CA_CERTS\` at the
certificate-authority bundle.`,
	},
	SERVER_IDLE_TIMEOUT_S: {
		type: 'number',
		scope: 'operator',
		default: 255,
		clamp: { min: 1, max: 255 },
		heading: 'Defining the request idle timeout',
		typeLabel: 'int',
		doc: `How many seconds a request may stay idle before the engine drops the connection. It
applies to both listeners, and it is clamped to the range 1–255.

Default \`255\` (the maximum): deliberately generous, because the previous silent 10-second
default killed slow but perfectly legitimate work — large exports, wide searches, long tool
actions — in the middle of the handler.

Whatever you choose, **the web server in front must be at least as patient**: a reverse-proxy
read timeout shorter than your slowest legitimate request re-introduces exactly the same
failure one hop earlier (in nginx, \`proxy_read_timeout\`).

\`\`\`bash
SERVER_IDLE_TIMEOUT_S=255
\`\`\``,
	},
	SERVER_MAX_BODY_BYTES: {
		type: 'number',
		scope: 'operator',
		default: 256 * 1024 * 1024,
		clamp: { min: 1 },
		heading: 'Defining the maximum request body size',
		typeLabel: 'int',
		doc: `The ceiling, in bytes, on the body of any single request the engine accepts. Every body
is buffered whole in a long-lived process, so an unbounded one is a memory-exhaustion
hazard — this is the cap that bounds it.

Default \`268435456\` (256 MiB). It does **not** limit the size of a media file: the client
always uploads large files in chunks, so a single request only ever has to carry one chunk.
The per-file limit is \`DEDALO_UPLOAD_MAX_SIZE_BYTES\`, and the chunk size is
\`DEDALO_UPLOAD_SERVICE_CHUNK_FILES\`.

Raise it only if a legitimate single request genuinely needs more, and remember the web
server has its own limit — in nginx, \`client_max_body_size\` — which will reject the request
first if it is lower.

\`\`\`bash
SERVER_MAX_BODY_BYTES=268435456
\`\`\``,
	},
	SERVER_SHUTDOWN_GRACE_MS: {
		type: 'number',
		scope: 'operator',
		default: 10000,
		clamp: { min: 0 },
		heading: 'Defining the shutdown grace period',
		typeLabel: 'int',
		doc: `When the server is asked to stop — a service restart, a deploy, a Ctrl-C — it stops
accepting new connections and then **drains the requests already in flight** for up to this
many milliseconds before it closes the database pool, removes the socket file and exits.
Users mid-save are not cut off by a routine restart.

Default \`10000\` (10 seconds). Raise it if your slowest legitimate request is longer and you
want it to survive a restart; \`0\` exits immediately and abandons whatever was running.

Keep it **below** the stop timeout of whatever supervises the process, or the supervisor
will kill the server before the drain has finished — which defeats the purpose.

\`\`\`bash
SERVER_SHUTDOWN_GRACE_MS=10000
\`\`\``,
	},
	SERVER_TCP_PORT: {
		type: 'number',
		scope: 'operator',
		default: undefined,
		heading: 'Defining the development TCP port',
		typeLabel: 'int',
		typeSuffix: '(optional; development only)',
		doc: `When set, the engine opens an **additional** listener on this port, on top of the unix
socket, and the client is reachable at \`http://localhost:<port>/dedalo/core/page/\` — or
\`https://…\` when \`SERVER_TCP_TLS_CERT_FILE\` and \`SERVER_TCP_TLS_KEY_FILE\` give it a
certificate. It exists because a browser cannot talk to a unix socket directly, so a
developer would otherwise need a web server in front of every local checkout.

Leave it **unset in production**. This listener is the only one that will serve media
straight from the engine when media protection is unconfigured — with no per-record access
control. A production install serves on the socket only, behind the
reverse proxy that owns TLS, the static files and the media.

\`\`\`bash
SERVER_TCP_PORT=3000
\`\`\`

The listener binds to \`SERVER_TCP_HOST\`, which defaults to this machine only (\`127.0.0.1\`).

The developer route of the installer writes it (\`3500\` unless you choose another port) and,
before it reports the install complete, starts \`bun run dev\` once and checks that this
listener answers \`/health\` and a root login.`,
	},
	SERVER_TCP_HOST: {
		type: 'string',
		scope: 'operator',
		default: '127.0.0.1',
		heading: 'Defining the development TCP address',
		typeLabel: 'string',
		typeSuffix: '(optional; development only)',
		doc: `The address the development TCP listener (\`SERVER_TCP_PORT\`) binds to. Default
\`127.0.0.1\`: only a browser on the same machine reaches it. A development install also
shows full error details to the browser (\`DEDALO_DEBUG_API_ERRORS\`), and this listener
has no web server in front of it (and no TLS unless \`SERVER_TCP_TLS_CERT_FILE\` is set),
so it is not opened to the network unless you say so.

Set \`0.0.0.0\` (every IPv4 address) or one address of this machine only when another
machine must reach the development server, and only on a network you trust. Ignored
without \`SERVER_TCP_PORT\`.

\`\`\`bash
SERVER_TCP_HOST=0.0.0.0
\`\`\``,
	},
	SERVER_TCP_TLS_CERT_FILE: {
		// Read with its pair by src/config/tcp_listener.ts (devTcpListener), which
		// refuses a half pair and an unreadable file at boot — never a silent
		// fall back to plain HTTP.
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Serving the development listener over HTTPS',
		typeLabel: 'path',
		typeSuffix: '(optional; development only; set with SERVER_TCP_TLS_KEY_FILE)',
		doc: `The certificate (PEM, the leaf first and then any intermediate certificate) the
development TCP listener (\`SERVER_TCP_PORT\`) presents. With it and
\`SERVER_TCP_TLS_KEY_FILE\` set, the listener speaks HTTPS and the boot log prints an
\`https://\` address; with neither, it serves plain HTTP as before.

Set **both or neither**: one without the other, a file the server cannot read, a file that
is not a certificate, or a key that does not belong to the certificate refuses the boot
with the key and the path named — the listener never falls back to plain HTTP behind your
back. While the certificate has less than 30 days left, every boot warns and names
\`bun run tls:renew\`. Ignored without \`SERVER_TCP_PORT\`: a server with no development
listener does not read the pair, so a leftover line never stops it.

The developer route of the installer writes both, pointing at the certificate it issues
from the local certificate authority in \`../private/tls/\`. Leave both **unset in
production**: there the reverse proxy owns TLS and the engine listens on its socket only.

\`\`\`bash
SERVER_TCP_TLS_CERT_FILE=/home/me/dedalo/private/tls/fullchain.pem
\`\`\``,
	},
	SERVER_TCP_TLS_KEY_FILE: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'The private key of the development listener',
		typeLabel: 'path',
		typeSuffix: '(optional; development only; set with SERVER_TCP_TLS_CERT_FILE)',
		doc: `The private key (PEM) of the certificate in \`SERVER_TCP_TLS_CERT_FILE\`. Keep the file
readable by the account that runs the server and by nobody else (mode \`0600\`).

Set **both or neither** — see \`SERVER_TCP_TLS_CERT_FILE\` for what a half pair, an
unreadable file or a key of another certificate does at boot.

\`\`\`bash
SERVER_TCP_TLS_KEY_FILE=/home/me/dedalo/private/tls/privkey.pem
\`\`\``,
	},
	SERVER_UNIX_SOCKET: {
		type: 'string',
		scope: 'operator',
		default: '/tmp/dedalo_ts.sock',
		heading: 'Defining the server socket',
		typeLabel: 'string',
		doc: `The unix socket the engine listens on. In production this is the **only** listener: the web
server owns TCP and TLS, serves the client files and the media, and forwards the API and the
dynamic routes to this socket.

Default \`/tmp/dedalo_ts.sock\`. The installer always writes it: the developer route
\`/tmp/dedalo_ts_<entity>.sock\` (one socket per checkout), the production route
\`/run/dedalo-<instance>/dedalo_ts.sock\`. On a system that cleans \`/tmp\`, prefer a directory
of your own (\`/run/dedalo/\`). The path must be writable by the user the engine runs as and reachable
by the user the web server runs as — a socket neither can open is the usual cause of a
"bad gateway" that looks like the engine is down.

If the file already exists at start-up the engine probes it: when a live instance answers,
it **refuses to start** rather than quietly steal the running server's socket; a leftover
file from an unclean stop is removed.

\`\`\`bash
SERVER_UNIX_SOCKET="/run/dedalo/dedalo_ts.sock"
\`\`\``,
	},
	TRUSTED_PROXY_TRANSPORT: {
		type: 'string',
		scope: 'operator',
		default: 'socket',
		heading: 'Defining which transport may be believed about the client address',
		typeLabel: 'socket | tcp | none',
		doc: `Which of this engine's listeners sits behind the reverse proxy, and therefore
whose \`X-Forwarded-For\` header may be believed.

\`X-Forwarded-For\` is a request **header**: anything that can open a connection can write
it. It is trustworthy only because a proxy is known to have rewritten it — so it is read
on one transport and ignored on the other, and on the other the connection's own peer
address is used instead.

* \`socket\` (**default**) — the unix socket (\`SERVER_UNIX_SOCKET\`), which only the local
  reverse proxy can open. This is the documented production topology.
* \`tcp\` — a proxy really does stand in front of \`SERVER_TCP_PORT\`. Set this ONLY when
  that is true: on a port a browser reaches directly, it lets any client choose its own
  address.
* \`none\` — never read the header. Every request is attributed to its peer address.

Until 2026-08-24 the header was read on every listener, so on the direct TCP port a client
could pick the address used for the login throttle (a fresh brute-force bucket per
request), for \`dd544\` activity rows, and for any check that matches a literal loopback
address. The address is used for throttling and audit; the hop arithmetic is
\`TRUSTED_PROXY_HOPS\`.

\`\`\`bash
TRUSTED_PROXY_TRANSPORT=socket
\`\`\``,
	},
	TRUSTED_PROXY_HOPS: {
		type: 'number',
		scope: 'operator',
		default: 1,
		clamp: { min: 1 },
		heading: 'Defining the number of trusted proxy hops',
		typeLabel: 'int',
		doc: `How many reverse proxies stand between the internet and the engine. Each one **appends**
the address it received the request from to the \`X-Forwarded-For\` header, so the genuine
client address is the entry this many positions **from the right**. Everything further to the
left was supplied by the caller and can be forged freely.

The engine uses that address for the login throttle and for audit records — never as an
authorization input. Set it to exactly the number of proxies that append the header; the
default \`1\` matches the standard single web server in front. Both mistakes hurt:

* **Too high** — you start trusting an entry the caller wrote. An attacker sends a new forged
  address on every attempt, gets a fresh login-throttle bucket each time, and the brute-force
  protection is gone.
* **Too low** — every request appears to come from your own proxy. All users share one throttle
  bucket, so one person's wrong passwords lock out everybody.

Your proxy must *append* rather than replace (in nginx,
\`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\`), or the count is meaningless.

\`\`\`bash
TRUSTED_PROXY_HOPS=1
\`\`\``,
	},
} as const satisfies Record<string, CatalogEntry>;
