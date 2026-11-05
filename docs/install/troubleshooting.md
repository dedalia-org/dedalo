# Troubleshooting

> See also: [Installer reference](installer_reference.md) · [Production install](production.md) · [Docker](docker.md) · [The web server site](reverse_proxy.md) · [Developer quickstart](dev_quickstart.md)

Symptom first. Each entry names the cause and the fix. On a production instance `<i>` is the instance name; on a host you set up by hand, substitute your own unit and paths. If your symptom is not here, start with the two things that answer most questions:

```shell
sudo journalctl -u dedalo-ts@<i> -n 100 -o cat                 # the engine's own words
sudo curl --fail --unix-socket /run/dedalo-<i>/dedalo_ts.sock http://localhost/health
```

The socket's directory is the instance's own (`0750`): `curl` reaches it as root, or as a member of the service group — hence `sudo`.

| Symptom | Jump to |
| --- | --- |
| `install.sh:` refuses, exit code `3` | [The bootstrap refuses](#the-bootstrap-refuses-exit-code-3) |
| `… is not supported — the production route supports …` | [Unsupported system](#an-unsupported-system) |
| The System check refuses, naming things that already exist | [The System check refuses](#the-production-system-check-refuses) |
| A row of the System check screen failed, or the check did not complete | [The System check screen](#the-system-check-screen) |
| Docker, Compose, disk or image refusals | [Docker and trial refusals](#docker-and-trial-refusals) |
| Let's Encrypt fails | [Let's Encrypt fails](#lets-encrypt-fails) |
| `… which this machine does not trust`, or the last check fails with `the certificate chain is not trusted by this host` | [A certificate from your own CA](#a-certificate-from-your-own-certificate-authority) |
| The install completed, but the site cannot be reached from other machines | [The firewall](#the-firewall-closes-the-sites-ports) |
| `database '…' is not empty` | [Installing](#installing) |
| The install stopped part-way | [Resuming and undoing an install](#resuming-and-undoing-an-install) |
| The server exits at once with code `78` (`[boot] REFUSED — …`) | [Booting](#booting) |
| The server refuses to boot for another reason | [Booting](#booting) |
| `502` from the web server | [Serving](#serving) |
| nginx will not start | [Serving](#serving) |
| A code update is refused: `No supervisor declared` | [Updating](#updating) |
| Nobody can log in, and there is no error | [Using it](#using-it) |
| Media `404`s, or media is served to everyone | [Media](#media) |

## Running the installer

### The bootstrap refuses (exit code `3`)

`install.sh` prints `install.sh: <reason>` and exits `3` before the installer starts. Nothing was changed.

| The line says | Cause | Fix |
| --- | --- | --- |
| `this installer runs on Linux, or on macOS for the trial and Docker routes` | another operating system | use a supported one ([Supported systems](index.md#supported-systems)) |
| `no sha256sum (coreutils) on this host`, `unzip is not installed …`, `curl is not installed …` | a minimal system without the bootstrap's tools | install them (`apt-get install curl unzip coreutils`, or `dnf install curl unzip coreutils`) and run again — see [Get Dédalo](index.md#get-dedalo) |
| `musl libc (…): no supported Bun build` | a musl-based Linux (Alpine) | use a glibc distribution |
| `no Bun build for CPU '…'` | neither x86_64 nor aarch64 | use a supported CPU |
| a `--release` whose sha256 does not match `--release-sha256` | the archive is not the one you meant, or it was damaged in transit | fetch it again and compare the sha256 against the one the release publishes; there is no "accept anyway" |
| the Bun zip does not match the release's hash table, or Bun's `SHASUMS256.txt` disagrees | a damaged or substituted download | remove the cached zip (under `/var/lib/dedalo-install/bun/` as root, `~/.cache/dedalo-install/bun/` otherwise) and run again; behind a proxy, `--offline-bun <zip> [<SHASUMS256.txt>]` or `--mirror <https base url>` |

### An unsupported system

```text
<system> is not supported — the production route supports Ubuntu 26.04 LTS, Debian 13 (trixie), RHEL / Rocky Linux / AlmaLinux 10 (newest releases only)
```

**Cause.** The Production route supports the newest release of each distribution, matched on the exact distribution and major version. An older release, or a derivative (Fedora, CentOS Stream, Oracle Linux), is refused before anything changes.

**Fix.** Install on a supported release. There is no flag that accepts another one. The interactive System check shows the same sentence and offers only quit — or back, to choose a route this system supports (Docker or Trial).

### The production System check refuses

**Cause.** `host_preflight` measured something a later step would trip on, and changed nothing. The sentence names every problem at once:

| Refusal | Fix |
| --- | --- |
| `the production route must run as root: sudo sh install.sh …` | run it with `sudo` |
| `account <u> is a system account (uid <n>) — …` | a leftover of an earlier install (`ded_<i>` created as a system account) or a system account: remove it with `userdel`, or choose another `--service-user` |
| `service user <u> is already the service user of instance <j> (<file>) — …`, the same for the group | one account and one group per instance: choose another, or remove the stale `<file>` |
| `install folder <d> overlaps instance <j>'s folder <dj> (…) — …` | choose a folder of its own (`--install-dir`) |
| `install folder <d> is not empty and is not owned by <u> — …`, `… already holds dedalo — …` | the installer uses an existing folder only when it is empty, or the service user's and holds no install: empty it, `chown` it, or choose another |
| `install folder <d> is writable by group or others (mode …)`, `<a> (a parent of the install folder) is writable by an account other than root or <u>` | `chmod go-w` it, or fix the parent's owner |
| `account <u> is a member of <group> (gid <n>) — …` | the service would hold that group's rights (`sudo`, `docker`, a system group — `users` is accepted): choose an account without it |
| `account <u> is a member of <g>, the service group of instance <j> (<file>) — …` | one group per instance: the service would read that instance's files — choose an account without that membership |
| `service user <u> is an account of the installer's packages …`, `group <g> is a group of the installer's packages …` | `postgres`, `www-data`, `nginx` and `apache` are never the service account: choose another |
| `install folder <d> is an existing directory of root outside /home, /srv, /data, /mnt, /media — …`, `install folder <d> is empty but owned by <x>, another account — …` | the installer never takes over a system or another account's directory: `chown` it to the service user first, or choose a folder that does not exist yet |
| `<file> names instance <j> but runs as User=<x>, whose primary group cannot be resolved — …` | a hand-installed unit with no `Group=` whose user is gone: give it its `Group=`, or remove the stale unit |
| `group <g> already exists but user <u> does not — …` | a leftover group: remove it with `groupdel`, or use it as is with `--service-group <g>` |
| `dedalo-ts@<i>.service is already enabled`, `… already has drop-ins` | the same |
| `/etc/nginx/conf.d/dedalo-<i>.conf already exists` (or the Apache site) | another install's site file: choose another instance name |
| `the socket /run/dedalo-<i>/dedalo_ts.sock already exists (another server is listening there)` | stop that server, or choose another name |
| `database dedalo_<i> already exists`, `role <service user> already exists` | choose another name, or use that database with `--db-mode existing` (it must be empty) |
| `PostgreSQL <n> already runs on this host` | another major version holds the database port: stop it, or use `--db-mode existing` with your own server |
| `<address> is already served on port 80/443 by <file>` | another site answers for that name: remove it, or install under another address. The installer never edits another site |
| `tls_extra_names: <ip> is not an address of this host (its IPv4 addresses: …)` | list one of the addresses the sentence names, or give staff a name. A certificate for an address the server does not hold reaches nobody |
| `tls_extra_names claims <ip>, but this host's addresses could not be read (/proc/net/fib_trie) …` | the installer serves an address only once it knows it is this server's: check that `/proc/net/fib_trie` is readable (a container or a hardened kernel may hide it), or give staff a name |
| `tls_extra_names: <ip> is already claimed by instance <j>` | an IP address reaches exactly one instance: give this one another address of the server, or a name |
| `tls_extra_names: an IP address needs the standard ports 80/443 …` | install on ports 80 and 443, or give staff a name: the catch-all that picks the certificate by address covers those ports only |
| `an IP address cannot reach this instance: …` | the sentence names what holds the address: a site of yours that listens on it itself (or on a host name), a `default_server` of yours on port 443 (nginx), a site or vhost of yours on port 443 that loads before the catch-all (nginx answers an unnamed handshake with the first server of the port, Apache with the first vhost — rename or move it so it loads after), another instance that already claims an address (Apache), or a file at the catch-all's path the installer did not write. Change that site, or give staff a name — [Reaching an instance by IP address](reverse_proxy.md#reaching-an-instance-by-ip-address) |
| `nginx name dedalo_<i> is already defined in <file>` | an `upstream` or rate-limit zone of that name exists elsewhere (nginx names are global): choose another instance name |
| `<path> already exists — the installer creates the instance's directories itself and never takes over an existing one` | remove it, or choose another path (a media path under `/var/www`, for example) |
| nginx older than 1.25.1 | upgrade nginx: the site uses `http2 on;`, which older versions reject |
| the institution's certificate names another address, has expired, or does not pair with its key | fix the files, or choose Let's Encrypt |
| `<file>: its chain ends at <issuer>, which this machine does not trust — …` | your certificate authority is not in this machine's trust store — see [A certificate from your own CA](#a-certificate-from-your-own-certificate-authority) |

Then run the same command again — nothing was written, so it starts fresh. The firewall is reported, never changed — see [The firewall](#the-firewall-closes-the-sites-ports).

### The firewall closes the site's ports

**Cause.** The installer reads the firewall (firewalld's default zone, or ufw) and never changes it. On the RHEL family firewalld is on by default and allows only `ssh` and `cockpit`, so an install that completed is reachable from the machine itself and from nowhere else.

**Fix.** The System check shows a **Firewall** row, the Review a *To do yourself* line and the closing *To do on this host* list the exact command for the ports this instance uses — for the defaults:

```shell
sudo firewall-cmd --permanent --add-service=http --add-service=https && sudo firewall-cmd --reload   # firewalld
sudo ufw allow 80,443/tcp                                                                           # ufw
```

The Docker and Trial routes are different: Docker publishes their ports with its own packet-filter rules, ahead of the host firewall, so they are reachable whatever firewalld or ufw allows. To restrict them, see *Published ports bypass the host firewall* on [Docker](docker.md).

### A certificate from your own certificate authority

**Cause.** The institution's certificate was issued by a certificate authority of your own (an internal CA), and **this machine** does not trust it. The installer checks the chain the way a browser does — before anything changes (`host_preflight`, `stack_preflight`: `<file>: its chain ends at <issuer>, which this machine does not trust`) and again at the end, through the site's address (`host_public_probe`, `stack_health`: `the certificate chain is not trusted by this host`, curl's error 60).

**Fix.** Install the CA's certificate in this machine's trust store, then run the same command again (or `--resume`):

```shell
sudo cp <your CA>.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates   # Debian, Ubuntu
sudo cp <your CA>.crt /etc/pki/ca-trust/source/anchors/ && sudo update-ca-trust          # RHEL family
```

Every computer that opens the site needs the same CA, or its browser warns.

### `Apache lacks the modules … — enabling modules is the system administrator's`

**Cause.** The installer checks Apache's modules (`ssl headers http2 rewrite proxy proxy_http`) and never enables one.

**Fix.** Run the command the message prints (`a2enmod … && systemctl restart apache2` on Debian and Ubuntu — a restart, as `a2enmod` itself advises: loading a module is a process change), then `sudo sh install.sh --route production --instance <i> --resume`. The Review lists the same command under *To do yourself* before the install starts, so you can enable the modules first.

### Let's Encrypt fails

**Cause.** `host_tls` (production) or `stack_tls` (docker) asked Let's Encrypt to prove the address over HTTP on port 80, and it could not. Almost always one of:

- the name does not resolve publicly to this machine (`dig +short <address>` from outside);
- port 80 is not reachable from the internet — a firewall, a router without forwarding, a cloud security group;
- the account hit Let's Encrypt's rate limit after repeated failures.

**Fix.** Fix DNS or the firewall, then `--resume`. To rehearse without spending the rate limit, add `--letsencrypt-staging` to a headless install. The install completes with a test certificate browsers do not trust (its public probe does not verify the chain), and `--abort` cannot take a completed install apart. On Production, the installer's closing *To do on this host* list prints the `certbot certonly … --force-renewal --server https://acme-v02.api.letsencrypt.org/directory` command that replaces it with a real certificate in place. On Docker, the rehearsal stack is destroyed by hand, as in [Removing the stack](docker.md#removing-the-stack), and installed again without the flag. If the server cannot be reached from the internet at all, use a local certificate authority (`--tls local_ca`) or your institution's certificate (`--tls files`).

### The public probe fails

**Cause.** `host_public_probe` reached the site through its address from the host itself and did not get the expected answers within 90 seconds: `/health` not `200` over HTTPS with a verified chain, or the media marker store or an unpublished file not answering `404`.

**Fix.** Check by hand, in this order:

```shell
sudo curl --fail --unix-socket /run/dedalo-<i>/dedalo_ts.sock http://localhost/health   # the engine
sudo nginx -t                                                                            # or sudo apachectl -t
curl --fail --resolve <address>:443:127.0.0.1 https://<address>/health                 # the site, locally
```

The probe's own sentence says what curl met: `the certificate chain is not trusted by this host` (curl's error 60) is [a certificate from your own CA](#a-certificate-from-your-own-certificate-authority). An answer of `421` (Apache) means the request named a `Host` the site does not declare: each virtual host answers only its own address, and every other name — an IP address, another name of this machine — gets `421`. Use the address you gave the installer.

A green socket and a red site means the web server cannot reach the socket (its user must be in the service group, `ded_<i>` by default; on the RHEL family the engine must run in `dedalo_engine_t`: `ps -o label= -p $(systemctl show -p MainPID --value dedalo-ts@<i>)`). A media answer other than `404` means the gate is not loaded — see [Media](#media). Then `--resume`.

### The backup verification fails

**Cause.** `host_backup_verify` ran the backup set once and a store failed, or the unit's environment did not carry the full list of expected stores.

**Fix.** `journalctl -u dedalo-backup@<i>` names the store; `<backup dir>/state/` holds the `LAST_OK` or `BACKUP_FAILED` marker. Fix it (disk space, a database the backup cannot reach), then `--resume`.

### Docker and trial refusals

`stack_preflight` refuses before anything is pulled or written. The interactive installer measures the same check on the Review, before `yes`, and lists each refusal there as an error (install is not offered until it is fixed); a refusal after `yes` keeps your answers — see [Installer reference › Interactive mode](installer_reference.md#interactive-mode):

| Refusal | Fix |
| --- | --- |
| `Docker is not installed` | install Docker Engine and its Compose plugin; the installer never installs them |
| `the Docker daemon does not answer <user>` | start it (`sudo systemctl enable --now docker`) or join the `docker` group (`sudo usermod -aG docker <user>`, then log in again). `DOCKER_HOST` is not passed through: use a docker context |
| `Docker Compose 2.24.4 or newer is required … — this machine has <v>` | install or update the `docker compose` plugin: the installer's `compose.override.yaml` uses the `!override` tag, which older Compose versions refuse |
| `only <n> GiB free under <docker root>` | free space (`docker system prune -af`) or move Docker's root to a bigger disk |
| `this machine already has a Dédalo instance (volume dedalo_private)` | keep that instance, or destroy it first (`… down -v` — it deletes its data) |
| `.dedalo.env` or `compose.override.yaml` already exists | files of an earlier install: remove them if that install is gone |
| `image version <v> is not this installer's` | leave **Image version** empty (or give the installer's own `-dev` tag), or use the installer of the matching release. The Image screen refuses the value itself |
| `port <n> is already in use by <program>` | stop that program, or choose another HTTP / HTTPS port (Containers screen, `--http-port` / `--https-port`). Measured with `ss`; where `ss` is missing (macOS) `stack_up` names the port instead: `failed to bind host port … address already in use` |
| `cosign is not installed` | install `cosign`, or build the image here (`--image-source build`) |
| `<repository> is not an official Dédalo registry` | the official source accepts only the official registries; for a registry of your own use `--image-source custom` |
| `docker-compose.yml is not in <directory>` (or `docker-compose.simple.yml`) | run `install.sh` from a Dédalo checkout ([Get Dédalo](index.md#get-dedalo)) |
| `the operator cannot be identified` | `id -un` answered nothing: run the install as a user with a login on this machine, not from a stripped-down environment |

`stack_preflight` refuses an existing instance on purpose: the database restore needs an empty database, so a second install is never a repair.

### The System check screen

The **System check** screen measures this machine before any question about the install. Each row is ok, a warning (told, never blocking) or a failure (fix it, then re-check), and says so once: plain mode prints `ok  <row>`, `warn: <row>` and `error: <row>`, the full screen draws the warning with `!` and the failure with `✗`. **System ready.** appears only when the check completed and no row failed. A failure no fix on this machine can change — an [unsupported system](#an-unsupported-system) — ends with `This system cannot run this route — quit, or go back to choose another route.` and offers only that; any other failure ends with the count (`1 check failed — fix it and re-check.`) and offers retry, edit or quit.

Which rows appear depends on the route:

| Route | PostgreSQL client row | Other rows |
| --- | --- | --- |
| **Production** | `ok` when `psql` is absent: the installer installs PostgreSQL 18 itself. A warning when a `psql` of another major is present; the install's own system check (`host_preflight`) refuses another major's cluster on the database port with `--db-mode create` (see [the production System check](#the-production-system-check-refuses)) | **Operating system**, **Privilege** (`root`), **Firewall** (a warning when ports 80 and 443 are closed, with the command that opens them — see [The firewall](#the-firewall-closes-the-sites-ports); not shown on a system the route does not support: the firewall is read the way that system's row reads it, so the **Operating system** refusal comes alone), Bun, the install seed, the private directory (created by the installer), then the diagnostics: platform, memory, processor, disk, ImageMagick and FFmpeg (installed by the installer), cURL, OpenSSL |
| **Docker**, **Trial** | none: the engine runs in a container and never uses a host `psql` | Bun, the private directory, **Docker**, **Compose**, **Disk** — the same checks, and the same sentences, as [Docker and trial refusals](#docker-and-trial-refusals). A Docker root that cannot be measured is a warning |
| **Developer** | a failure when no `psql` runs: this route installs into an existing PostgreSQL | Bun, the install seed, the private directory, then the diagnostics: platform, memory, processor, disk, ImageMagick, FFmpeg, cURL, OpenSSL |

The developer route compares `psql` with the **server** once it is connected, on the Database step: a client older than the server is a warning there (`psql <n> is older than the server (PostgreSQL <m>) …`), because the backups' `pg_dump` refuses a newer server.

| The row or line says | Fix |
| --- | --- |
| `PostgreSQL client  psql not found — the developer route installs into an existing PostgreSQL …` | install the client (Debian/Ubuntu `apt install postgresql-client`, RHEL `dnf install postgresql`, macOS `brew install postgresql@18`) or set `DEDALO_PG_BIN_PATH` to its `bin` directory — see [`PostgreSQL client (psql) not found`](#postgresql-client-psql-not-found) |
| `PostgreSQL client  <path> does not run (EACCES)` (or another reason) | a `psql` is there but cannot start: fix its permissions (`chmod +x`), or remove it |
| `The system check did not complete: the system probe failed unexpectedly (<class>: <first line>) — full text logged to <file>` | an installer defect, not a setting. The file (mode `0600`, under the system temporary directory, e.g. `/tmp/dedalo-install-probe-system-…log`) holds the full text with its stack: report it with that file. No secret is written in it |

### The full screen is unavailable

```text
full-screen UI unavailable (<reason>) — continuing in plain mode
```

**Cause.** The terminal library has no native build for this machine, or the terminal is not capable (smaller than 80×24, `TERM` unset or `dumb`, output not a terminal).

**Fix.** Nothing is needed: plain mode asks the same questions and runs the same install. A piped standard input is refused instead (`stdin is not a terminal — give the answers with --answers <file> …`): an unattended install uses flags or an answers file.

## Installing

### `PostgreSQL client (psql) not found`

**Cause.** The pre-flight check could not resolve a `psql` binary. The installer, the seed restore, the hierarchy import and the backup widget all shell out to it, so this is a hard gate. (The Production route installs it; this is a Developer-route failure.)

**Fix.** Install the client package (`postgresql-client-18`), or point at it:

```dotenv
DEDALO_PG_BIN_PATH=/usr/lib/postgresql/18/bin
```

### The install fails part way through, with a connection error

**Cause.** Very often: **`psql` is older than the server.** An older client refuses to connect to a newer server, and a machine with several major versions installed can easily resolve the wrong one.

**Fix.** Check both, then pin the client with `DEDALO_PG_BIN_PATH`:

```shell
psql --version
sudo -u postgres psql -c 'SHOW server_version;'
```

### `database '<db>' is not empty (<n> objects, e.g. …) — the installer only installs into an empty database`

**Cause.** Exactly what it says. The installer restores **into** a database and never into one that holds anything: a table, view, sequence, function, type or schema of its own.

**Fix.** Point at an empty database. If you are certain the contents are disposable, drop and re-create it (on the Developer route, `dropdb` and `createdb`). Be certain first: a populated database usually means *somebody already installed here*. On the Production route with `--db-mode create`, the installer creates the database itself and the System check refuses a name that exists.

### `the install role does not own database '<db>'`

**Cause.** The seed restore marks the database as this install's (its comment), which only the owner may write.

**Fix.** Create the database with `OWNER` set to the role the install connects as, or change its owner (`ALTER DATABASE <db> OWNER TO <role>`).

### `Private config directory is not creatable/writable`

**Cause.** The installer creates the private directory one level **above** the code tree, and that parent is not writable by the user the install runs as. (On the Production route the installer creates it itself; this is a Developer-route failure.)

**Fix.** Make the parent of the checkout writable by you, or set `DEDALO_PRIVATE_DIR` to an absolute path you own. In a container, `DEDALO_PRIVATE_DIR` is what the image uses — see [Docker](docker.md).

## Resuming and undoing an install

Any failure after the install recorded its plan prints how to continue:

```text
  Progress saved: …/install.state.json (plan: install.plan.json)
  Fix the cause, then resume:  sudo sh install.sh --route production --instance <i> --resume
  Or undo this install:        sudo sh install.sh --route production --instance <i> --abort --confirm-database dedalo_<i>  (deletes the database this install created)
```

(`sh install.sh --route docker …` on the stack routes; `bun run scripts/install.ts --resume` on the Developer route.) Once the instance has **served** — production once its unit has run (`host_first_boot` started it), docker and trial once `stack_up` started the `dedalo` container (or `--abort` measures that it ever started) — the last line reads `Or partly undo it: … --abort  (the instance has served: …)` instead: an abort then keeps the instance. A resume runs in plain line mode and asks again only for the secrets a remaining step still needs. The rules are in the [installer reference](installer_reference.md#resuming-an-install-resume). On the docker, trial and production routes the engine steps run in a child, and its refusal is quoted in the host's line (`✖ install failed at step [stack_engine]: the engine steps failed: <the engine's reason> — …`, or `the engine child refused its --abort: <the engine's reason> — nothing before it was undone`); the refusals you can meet:

| Refusal | Cause | Fix |
| --- | --- | --- |
| `an install record exists at … — resume it (--resume) or undo it (--abort --confirm-database <db>)` | a fresh run found an earlier install's record | resume or abort it. On the Developer route, if the private directory is being reused deliberately, remove its `install/` directory |
| `answers differ from the saved plan: <keys>` | a resume was given answers other than the saved ones | drop the flags (a resume takes the saved answers), or abort and start again |
| `step <id> was recorded done but its outcome is missing (<detail>) — something changed it outside the installer: put that back, then --resume; or undo the install with --abort and start again — that DELETES the database this install created …` | something the install did was undone by hand since | put it back (the detail names it), then `--resume`; or abort and start again. A step that only **starts** something — `stack_database`, `stack_up`, `host_first_boot` — is never refused this way: a resume finds it stopped and starts it again (`done in an earlier run, but … — started again`) |
| `the commands of <step> are not the ones this install showed (the installer's own files changed since) — put the installer's files back (the same release), then --resume; …` | a resume from another release recomputed different host commands | resume with the release the install started with; or abort and start again with one release |
| `the engine steps of an earlier run are still running (pid <n>…, since <time>) — wait for them to end (or stop that process), then --resume` | an interrupted run's engine child still holds the install (production); on docker and trial, its `dedalo-install-engine` container still runs | wait for it, or stop it (`kill <n>`, or `docker stop dedalo-install-engine`), then resume |
| `a seed restore into '<db>' is still running (backend pid <n>)` | a restore that is not this install's — another install's, or one started outside the installer — is working on the database (this install's own leftover restore is ended by the resume or abort itself, which says `⚠ ended the seed restore an interrupted run left on …`) | wait for it to end; if you know its installer is gone, end it as the database owner (`SELECT pg_terminate_backend(<n>)`), then resume |
| `another installer session is still active on '<db>' (backend pid <n>) — wait for it to end` | a session of another installer process is connected to the database | wait for it to end (an installer session whose client vanished is dropped by the server within about a minute), then resume |
| `this private directory belongs to a SEALED installation — a fresh install never overwrites a live one` | the private directory holds a finished install | install into another private directory; the live one is never overwritten |
| `this install is SEALED (live) — --abort never undoes a sealed installation` | an engine `--abort` of a finished install | nothing to undo: a finished install is a live one. On a host route, the host `--abort` of an instance that has served undoes only the host steps after the engine |
| `this install is SEALED (live) — …: its host says it never served, but the database changed since the install sealed it …` | the engine completed, its host says the instance never started, and the database was written since | something used the database: the instance is treated as live. Remove it by hand — [Removing an instance](multi_instance.md#removing-an-instance) |
| `user <u> KEPT: it still owns <path> (a removed uid would be reused by the next account) — remove what remains, then remove the user (userdel <u>)` | an abort removed what the install created, but files of the service user remain (yours, or a backup) | remove them if you no longer need them, then `userdel <u>` |
| `--abort resets and drops the database <db> this install set up: confirm with --confirm-database <db> — nothing was undone` | the abort would touch the database | repeat it with `--confirm-database <db>` once you are sure |
| `database '<db>' is not stamped by this install … — refusing to reset it` | the database was not seeded by this install | nothing to reset; it is not this install's |
| `Database reset failed (rolled back; SQLSTATE <code>, <n> attempts) …` | the abort's reset of the database failed and was rolled back — nothing was dropped. Before each attempt the abort ends every other session on that database (and only that one); `40P01` (deadlock) and `55P03` (lock timeout) are tried again, up to four times. A line `(sessions it may not end: …)` names sessions the installer's database role is not allowed to end (another role's, a superuser's) | end those sessions, or stop what keeps connecting to the database, as its owner or a superuser (`SELECT pg_terminate_backend(<pid>)`), then repeat the `--abort` |
| `the session(s) ended on '<db>' before the reset did not go within 15 s …` | a session the abort ended was still on the server 15 s later — nothing was reset | look the pid up in `pg_stat_activity`, end it as a superuser, then repeat the `--abort` |

What an abort takes depends on whether the instance has **served**:

- **Never served** (on production its unit never ran: it stopped before `host_first_boot`, or inside it before the start took effect; on docker and trial the `dedalo` container never started: it stopped before `stack_up`, or inside it before `up -d dedalo` took effect — even after the engine steps completed): the abort removes everything this install created, its database, its user and its media tree included, and says how many steps it undid. The engine's own steps are undone only when its database still holds exactly the rows the install left.
- **Served**: the abort answers *install partly undone* and undoes only the steps after the engine — on production the site, the certificate, the units' start and the timers; on docker and trial the running stack (`stack_up`). The instance — its user, database and code, or its containers and volumes — is kept, and `--resume` puts the undone steps back. A second abort says *nothing was undone*. Removing a served instance is done by hand: [Removing an instance](multi_instance.md#removing-an-instance), [Removing the trial](quickstart.md#removing-the-trial).

## Booting

### `Missing required config key 'DB_NAME'` (or `ENTITY`, `DB_HOST`, `DB_USER`)

**Cause.** A **partial** configuration. The four keys `ENTITY`, `DB_NAME`,
`DB_HOST`, `DB_USER` are all-or-nothing: with **none** of them set, the server
refuses to start as not installed (next entry); with **some** of them set, it is
misconfigured and names the first key missing. This is deliberate — a
half-configured server must not be mistaken for a fresh box.

**Fix.** Set all four (the installer writes them under exactly these names), or
none.

### The server exits at once with code `78` (`[boot] REFUSED — …`)

**Cause.** The server found this box **not installed**, and refused to start
before opening a socket or touching the database. There is no install page to
serve; the one line in the log (`journalctl -u dedalo-ts@<i>`, or the container log)
says which case it is and what to do:

| The line says | Cause | Fix |
| --- | --- | --- |
| `not installed: … are unset` | none of `ENTITY`, `DB_NAME`, `DB_HOST`, `DB_USER` reached it — almost always it is not reading the `.env` you think it is | the file must be at `../private/.env`, one level above the repo, or wherever `DEDALO_PRIVATE_DIR` points; on a new box, run the installer (`sh install.sh`) |
| `configuration incomplete: … exists but names none of …` | a `.env` is there, but without the four keys | complete it, or restore it from backup — do not reinstall over it |
| `configuration missing: … installed (sealed) but …` | the install finished, then `.env` was lost | restore `.env` from backup — reinstalling would refuse the non-empty database anyway |
| `install not finished (install_status '…')` | an install stopped part-way | finish it with `--resume` (`sudo sh install.sh --route production --instance <i> --resume` on a production instance), or undo it with `--abort` — [Resuming and undoing an install](#resuming-and-undoing-an-install) |

Confirm what the server reads:

```shell
sudo -u ded_<i> head -5 /home/ded_<i>/private/.env
grep install_status /home/ded_<i>/private/ts_state.json
journalctl -u dedalo-ts@<i> -n 5 --no-pager | grep 'REFUSED'
```

The systemd units do **not** restart a server that exits 78
(`RestartPreventExitStatus=78`): the unit stays `failed` until you fix the cause
and `systemctl start` it. A container under `restart: unless-stopped` is
restarted by Docker (about once a minute) and prints the same line each time.

### `Config key 'DEDALO_PREFIX_TIPOS' is RETIRED`

**Cause.** A **retired** key is not an alias: it configures nothing. Left in
place it would silently fall back to the replacement key's default, so the server
refuses to boot instead.

**Fix.** Rename the line in `../private/.env`:

```dotenv
ACTIVE_ONTOLOGY_TLDS=dd,rsc,ontology,ontologytype,hierarchy,lg,oh,ich
```

### `Config key 'DB_SOCKET': the PostgreSQL socket '…' is not an absolute path`

**Cause.** `DB_SOCKET` (or its old spelling `DEDALO_SOCKET_CONN`) names the
PostgreSQL unix-socket **directory**, and only an absolute path is one. A relative
value would be read as a network host name by PostgreSQL's own tools, so the
server refuses to boot rather than connect somewhere you did not mean.

**Fix.** Write the directory in full, or delete the line to connect over TCP to
`DB_HOST`:

```dotenv
DB_SOCKET=/var/run/postgresql
```

### Crash loop: `Config key 'DEDALO_APPLICATION_LANGS' must be a non-empty JSON object map`

**Cause.** The language configuration is mandatory and the `.env` is missing it,
so every boot dies on that line. The installer writes the languages; a
hand-written `.env` has to carry them itself.

**Fix.** Ensure all four keys are present:

```dotenv
DEDALO_APPLICATION_LANGS={"lg-eng":"English","lg-spa":"Castellano"}
PROJECTS_DEFAULT_LANGS=["lg-eng","lg-spa"]
DEDALO_APPLICATION_LANGS_DEFAULT=lg-eng
DEDALO_DATA_LANG_DEFAULT=lg-eng
```

### `FATAL: another server instance is already listening on … — refusing to steal its socket`

**Cause.** The double-start guard. A pre-existing socket file is **probed with a
connection**; if something answers, a second instance would silently orphan the
first, so it exits `1` instead.

**Fix.** Stop the running instance, or point `SERVER_UNIX_SOCKET` elsewhere. A
*stale* socket file (nothing listening) is removed automatically — this error
only fires when something really is alive on it.

### `error: Cannot find package 'zod' from '…/src/core/concepts/rqo.ts'`

**Cause.** That clone has no usable `node_modules`. The package name varies; the
path in the message is the authoritative part — it names **the tree the engine is
running from**, which is not necessarily the tree you installed into.

Almost always one of two things:

- `bun install` was never run in that directory, or was run in a **different**
  one. `sudo -u <user> <cmd>` does not move to that user's home; it inherits the
  directory you are standing in, so an install launched from `/root` reports
  `could not find a package.json file to install from` and touches nothing.
- It was run as `root`, leaving a `node_modules` the service user cannot read.

**Fix.** Install as the service user, in the clone, in one command:

```shell
sudo -u ded_<i> bash -c 'cd /home/ded_<i>/dedalo && /opt/dedalo/bun/<pin>/bun install --frozen-lockfile --production --ignore-scripts'
ls -d /home/ded_<i>/dedalo/node_modules/zod      # proof it landed
```

Then clear the crash-loop trip before starting — `Restart=always` does not:

```shell
sudo systemctl reset-failed dedalo-ts@<i> && sudo systemctl start dedalo-ts@<i>
```

### The engine listens on `/tmp/dedalo_ts.sock` instead of the unit's socket

**Cause.** `SERVER_UNIX_SOCKET` is not set in `../private/.env`, so the engine
falls back to its default path and ignores the unit's `RuntimeDirectory`
entirely. The boot line says exactly where it bound:

```text
Dédalo TS server listening on unix socket /tmp/dedalo_ts.sock (entity: …)
```

Two consequences, both delayed: the proxy points at a socket that never appears
and every request `502`s, and a **second install on the same host refuses to
boot**, because something is already answering on the default path.

**Fix.** Set it per install, matching the unit's `RuntimeDirectory`, and restart:

```dotenv
SERVER_UNIX_SOCKET=/run/dedalo-<i>/dedalo_ts.sock
```

The installer writes this key on the Production route; a missing one means the `.env` was written by hand.

### `Failed to determine group credentials: No such process`

**Cause.** The `Group=` in the systemd unit — or in a drop-in overriding it —
names a group that **does not exist**. The message is misleading: `No such
process` is the errno the name lookup returns for *no such group*. The engine
never starts; systemd fails the unit before executing anything.

This is the normal first failure on a host **upgraded from v6**, where the
service user's primary group is the web server's (`gid=33(www-data)`) and no
group is named after the user.

**Diagnose.**

```shell
id <service user>              # what group does it really have?
getent group <name>            # empty output = that group does not exist
systemctl cat dedalo-ts@<i>    # what the unit and its drop-ins actually say
```

**Fix.** Three options, best first:

1. **Give the install its own group** — the only one that keeps two installs on
   one host apart:

    ```shell
    sudo groupadd <name> && sudo usermod -g <name> <service user>
    sudo chown -R <service user>:<name> <install home> <media path>
    sudo usermod -aG <name> www-data && sudo systemctl restart apache2
    ```

    On an upgraded install this is a documented migration step, with the reasoning:
    [Phase E](migrating_from_v6.md#82-give-the-adopted-user-its-own-group).

2. **Point `Group=` at the group that exists** (`systemctl edit <unit>`).
   Unblocks a test box; on a shared host it hands socket access to every member
   of that group.

3. **Omit `Group=`** and inherit the user's primary group. Only acceptable when
   that group is install-specific — inheriting `users`, `nogroup` or the web
   server's group is option 2 with the trade-off hidden.

Then, in this order — `Restart=always` does **not** clear a start-limit trip:

```shell
sudo systemctl daemon-reload
sudo systemctl reset-failed <unit>
sudo systemctl start <unit>
```

### The unit fails before the engine logs anything

`journalctl -u <unit>` shows a `status=` code and no output of ours: systemd
could not set up the process. The code says which step:

| Code | Meaning | Usual cause |
| --- | --- | --- |
| `217/USER` | the user does not resolve | `User=` misspelled, or the account was never created |
| *group credentials* | the group does not resolve | see the entry above |
| `200/CHDIR` | cannot enter `WorkingDirectory` | wrong path, or the service user cannot traverse into it |
| `203/EXEC` | cannot execute `ExecStart` | the pinned runtime is not at that path (`/opt/dedalo/bun/<pin>/bun` on an installer instance). On the watchdog or rollback unit: the root-run scripts are missing from `/opt/dedalo/instances/<i>/bin/` (the root bin directory on a host set up by hand — `/opt/dedalo/bin/` in its example) |

Reproduce the same conditions by hand before editing the unit again:

```shell
sudo -u <service user> <ExecStart bun path> --version
sudo -u <service user> bash -c 'cd <WorkingDirectory> && ls src/server.ts'
```

### The boot fails with `core module warm-up: N module(s) failed to evaluate`

**Cause.** A module in the engine's core graph failed to evaluate. The server
evaluates the whole graph **before** it listens, and a failure is fatal by design
— a visible crash loop beats a server that serves identical failures for the rest
of its life.

**Fix.** This is a code defect, not a configuration one. The log names the
modules. Roll back to the previous ref ([upgrading](upgrading.md#rollback)) and
report it.

## Serving

### `https://<IP address>/` fails at the handshake, or answers `421`

**Cause.** A browser sends no server name in the TLS handshake for an IP address, so the web server cannot pick a site by name. On nginx the host's catch-all answers it: an address **no instance claims** gets no certificate, and the browser reports a protocol error (Chrome `ERR_SSL_UNRECOGNIZED_NAME_ALERT` or `ERR_SSL_PROTOCOL_ERROR`; curl `tlsv1 unrecognized name` or `tlsv1 alert internal error`). With an instance claiming addresses, each refusal is a line in `/var/log/nginx/dedalo-catch-all.error.log`. On Apache the handshake gets the first virtual host's certificate (a name mismatch warning), then `421 Misdirected Request`. It is the intended answer for an address the install was not given: nothing is served under an address nobody declared.

**Fix.** An instance serves an IP address only when it was installed with it in **Other addresses** (`--tls-extra-names`, with a local certificate authority): see [Reaching an instance by IP address](reverse_proxy.md#reaching-an-instance-by-ip-address). Check which addresses it claims in `/opt/dedalo/instances/<i>/tls/dedalo-local-ca.names`. An installed instance cannot change its addresses: give staff a name (the intranet's DNS, or each computer's `hosts` file), or install again with the address listed.

### Every request is a `502`

**Cause.** The web server cannot connect to the unix socket. Connecting to a
unix socket needs **write** permission on the socket file. The server makes the
socket `srw-rw-rw-` itself; what guards it is its directory, `/run/dedalo-<i>/`,
which the unit creates `drwxr-x---` (service user, service group). The installer
adds the web server's user (`www-data`, `nginx` or `apache`) to the service group
so that it can enter that directory. A web server
started before that membership, a unit edited by hand, or the RHEL family with
the engine outside its SELinux domain all break it.

**Fix.**

```shell
ls -l /run/dedalo-<i>/dedalo_ts.sock     # → srw-rw-rw- ded_<i> ded_<i>
ls -ld /run/dedalo-<i>                   # → drwxr-x--- ded_<i> ded_<i>
id www-data                              # (nginx / apache) — must list ded_<i>
systemctl restart nginx                  # group membership is read when a process starts
```

On the RHEL family, also check the engine's SELinux domain:
`ps -o label= -p $(systemctl show -p MainPID --value dedalo-ts@<i>)` must contain
`dedalo_engine_t`. Then confirm the paths agree: `SERVER_UNIX_SOCKET` in `.env`,
the `upstream` in the site file, and the socket the watchdog unit probes.

### Apache: `AH01144: No protocol handler was valid for the URL … (scheme 'http')`

**Cause.** `mod_proxy_http` is not loaded. `mod_proxy` alone understands the
`ProxyPass` syntax but has no handler for the `http` scheme, so it matches the
rule and then has nothing to hand the request to.

A host that previously served an older Dédalo shows this reliably: it has
`proxy_fcgi` — the submodule its interpreter pool used — and never needed
`proxy_http`. The engine is reached over HTTP on a unix socket, so the `unix:`
prefix is `mod_proxy`'s part and everything after the `|` is `proxy_http`'s.

**Fix.**

```shell
apachectl -M | grep proxy            # want proxy_module AND proxy_http_module
sudo a2enmod proxy proxy_http
sudo systemctl restart apache2       # LoadModule needs a restart, not a reload
```

### Apache: `AH01630: client denied by server configuration: /etc/apache2/…`

**Cause.** A filesystem path in the vhost is missing its **leading slash**.
Apache resolves a relative path against `ServerRoot` (`/etc/apache2` on
Debian/Ubuntu), so `Alias /dedalo home/site/dedalo/client/dedalo` silently becomes
`/etc/apache2/home/site/…`. No `<Directory>` block matches that invented path, and
the filesystem default outside `DocumentRoot` is `Require all denied` — hence a
denial rather than a `404`. The path in the message is the fabricated one, which
is what makes it recognisable.

**Fix.** Find the offending line and add the slash:

```shell
grep -rnE '^\s*(Alias|AliasMatch|DocumentRoot|ScriptAlias|<Directory)\s+"?[^/"]' \
     /etc/apache2/sites-enabled/ /etc/apache2/conf-enabled/
apachectl -S                          # the resolved DocumentRoot per vhost
apachectl configtest && sudo systemctl reload apache2
```

Two variants produce the same `AH01630` with a **correct-looking** path:

- the `<Directory>` block's path does not match the `Alias` target exactly (a
  trailing slash, or a symlinked component — Apache matches the resolved path);
- the web-server user cannot **traverse** into the tree. A `0700` home denies it
  before `Require all granted` is ever read:

    ```shell
    sudo -u www-data ls /home/<site>/<clone>/client/dedalo >/dev/null
    ```

### A client asset `404`s at a path that is not in the repo

**Symptom.** One `/dedalo/lib/…` or `/dedalo/core/…` request fails while the page
otherwise loads, and the body is the engine's own envelope:

```json
{"ok":false,"request_id":"…","error":{"code":"resource.not_found", …}}
```

**Cause.** That envelope means **the engine answered** — the proxy is fine. Third-
party libraries are served through an allowlist that maps `/dedalo/lib/<id>/<path>`
to a registered package root, and refuses anything else rather than guessing. So a
`404` here says the requested path does not exist in this install's tree.

Almost always the browser is running a **cached module from an older client**. On
an upgrade the hostname does not change, so every returning visitor — and the
operator testing the upgrade — carries the previous engine's module graph. Asset
paths that moved between versions are then requested at their old location. A
plain reload does not help: an ES-module `import` resolved inside a cached module
is not revalidated, which is also why a `?v=` on the entry point cannot reach it.

**Fix.** Confirm it is the cache before touching the server — check whether the
requested path exists in the clone:

```shell
ls <clone>/node_modules/codex-tooltip/dist/tooltip.js   # the path the CURRENT client asks for
grep -rn "codex-tooltip" <clone>/client/ --include="*.js"
```

If the deployed client imports a *different* path than the browser requested, the
browser is stale. Empty the cache and hard-reload (Safari: ⌥⌘E then ⌘R; Chrome and
Firefox: ⇧-reload with the developer tools open, or "Empty cache and hard reload").

!!! note "Tell your users once, after an upgrade"
    This is not only the operator's browser. Anyone who used the old install on the
    same address needs one hard reload; until then they may see a half-rendered
    interface with a console full of module errors.

If the path genuinely is missing from the tree, this is not a cache problem —
the dependencies were not installed in that clone (see
[`Cannot find package …`](#error-cannot-find-package-zod-from-srccoreconceptsrqots)),
or the library is not registered in the allowlist, which is a code change, not a
configuration one.

### nginx: `unknown "dedalo_auth_key" variable`

**Cause.** You included the generated media **server** rules but not the
generated **map** file. A `map` cannot live inside `server{}`, so it ships as a
separate file that must be included at `http{}` scope.

**Fix.** Include both, or neither. On a production instance the installer's
site file includes both — the server-scope copy from `/etc/nginx/dedalo/<i>/`,
and the map through the host-wide `/etc/nginx/conf.d/dedalo-00-media-map.conf` —
so this error there means a file was edited or removed by hand: refresh the
copies with `dedalo-media-rules.sh` ([Production › Changing the media access mode](production.md#changing-the-media-access-mode)).
On a publication host provisioned with `provision init`, the `http{}` map is pushed by **Apply media rules** into the host-wide include and must not be placed by hand; the manual path below still applies to work hosts and hand-provisioned publication hosts. There, run
**Apply media rules** in the **Publication hosts** panel, which pushes the map first; on the
publication host, `provision check <instance>` shows whether the host-wide map include
(`/etc/nginx/conf.d/dedalo_media_map.conf`) exists. On a work host, or a hand-provisioned
publication host:

```nginx
include /srv/dedalo/media/dedalo_media_protection_map.nginx.conf;   # http{} scope
include /srv/dedalo/media/dedalo_media_protection.nginx.conf;       # server{} scope
```

### nginx: `pcre2_compile() failed: missing closing parenthesis`

**Cause.** A known defect in the generated `publication`-mode rules: the rule-B
`location` regex is emitted **unquoted** and contains `{2,12}`, which nginx's
configuration lexer reads as a block delimiter.

**Fix.** Quote that one regex. See
[The web server site](reverse_proxy.md).

### nginx: `open() … dedalo_media_protection.nginx.conf failed`

**Cause.** The engine has not written the rule files yet. It writes them at boot
— but only when a media access mode is configured.

**Fix.** Set `DEDALO_MEDIA_ACCESS_MODE`, start the engine once, then reload
nginx. Bring the proxy up with the two `include` lines commented out if you need
the site before then.

### A large export or a long tool action dies after about a minute

**Cause.** The proxy's read timeout is lower than the engine's idle timeout, so
the proxy hangs up first.

**Fix.** `proxy_read_timeout 300s;` (nginx) or `ProxyTimeout 300` (Apache) —
at least `SERVER_IDLE_TIMEOUT_S` (255).

### The assistant chat or a diffusion progress stream stalls

**Cause.** The proxy is buffering a streaming response.

**Fix.** `proxy_buffering off;` on the API location.

### Uploads fail with `413 Request Entity Too Large`

**Cause.** nginx's `client_max_body_size` defaults to **1 MB**, and the client
uploads in ~4 MB chunks.

**Fix.** `client_max_body_size 300m;` (Apache's default is unlimited — nothing to
do there).

### A script 404s with `MIME type ('application/json') is not executable`

**Cause.** Nothing to do with MIME types. `/dedalo/lib/<id>/…` is the
[client-library route](../development/vendored_library_versions.md), and when it cannot resolve
a file it answers with the standard JSON error envelope. The browser refuses to
execute a `404`'s JSON body as a script and reports *that*, naming neither the
missing library nor the reason.

Two reasons it will not resolve, and a container usually has **both** at once:

* the library is marked `devOnly` (the test harness: `mocha`, `chai`) and
  `DEDALO_DEV_MODE` is not `true`, so the route refuses it before touching disk;
* its package is a `devDependency`, and the image was built with
  `bun install --frozen-lockfile --production`, which drops those.

**Fix.** For the test harness, build the Dockerfile's `dev` target *and* set
`DEDALO_DEV_MODE=true` — both are required, and a dev compose overlay does the
two together. Rebuilding is not enough on a stack that keeps `node_modules` in an
anonymous volume: Compose reattaches the old volume when it recreates the
container, so bring it up with `--force-recreate -V`.

For any **other** library this is a real packaging bug, not a configuration one:
a library the client loads in production must be a runtime `dependency`. The
`client_libs` tripwire asserts exactly that, so a red gate is the expected way to
find out.

### `/health` answers `503 {"db":"down"}`

**Cause.** PostgreSQL is unreachable or the connection pool is wedged. The health
check is deliberately *not* liveness-only — monitoring must go red when the
database is down, not only when the process dies.

**Fix.** Check PostgreSQL, and that it answers where the configuration says. When
`DB_SOCKET` is set the engine connects **only** through that socket directory and
ignores `DB_HOST`: a socket that does not exist is a failed connection, never a
quiet fall back to `localhost`. Check the file is there, e.g.
`ls /var/run/postgresql/.s.PGSQL.5432` for `DB_SOCKET=/var/run/postgresql` and
`DB_PORT=5432`. Then the pool: `DB_POOL_MAX` is **per process**, and
the engine plus every diffusion runner plus the RAG drain all draw against
PostgreSQL's `max_connections`. Watch `db_pool_waits` on
`GET /api/v1/counters`.

### `/health` answers `503 {"process":"poisoned"}`

**Cause.** A module in the graph failed at request time and its failure is cached
for the life of the process. The engine latches this and reports it so that the
watchdog recycles the process rather than serving identical failures forever.

**Fix.** A watchdog recycles the process; how fast depends on the deployment.
Under systemd the health timer polls every 30 seconds and restarts the unit.
On a docker stack the healthcheck is `scripts/ops/container_watchdog.sh`, which
recycles the container after **three consecutive red probes at 30-second
intervals — roughly 90 seconds**, and only once the container has answered green
at least once (so it never recycles a box that never came up — one that is not
installed exits 78 instead).
Either way it is a code defect — capture the log and report it.

### The maintenance widget reports the engine down while the socket probe is green

**Symptom.** `curl --fail --unix-socket /run/dedalo-<i>/dedalo_ts.sock http://localhost/health`
answers `200`, but **maintenance → system info** shows the engine unhealthy, and
after a code update the restart poll never confirms the new version.

**Cause.** The vhost does not route `/health`. The engine serves it at the
**origin root**, and the browser client probes it there — so the proxy has to
carry the route. Without it Apache resolves the path against the `DocumentRoot`
and logs an `AH01630` denial for `…/health`, while nginx hands the request to the
vhost's catch-all and returns `404`. Nothing is wrong with the engine; only the
browser-facing checks can see it.

**Fix.** The installer's site file carries the route; a site written by hand
needs it — see [The web server site](reverse_proxy.md). Reload, and re-run the
probe through the domain:

```shell
curl --fail https://dedalo.example.org/health
```

## Updating

### `Error. No supervisor declared; the server would not restart onto the new tree.`

The [code update panel](../management/updates/updating_code.md) refuses, and its
readiness check shows the supervisor check as blocked on `DEDALO_SUPERVISED`.

**Cause.** A code update replaces the code tree and then exits, so it runs only
when the process manager declares that it will start the server again:
`DEDALO_SUPERVISED=true` in the **process** environment. Three ways to miss it:

- The systemd unit was installed before 2026-10-08 and lacks the line. The
  engine used to guess supervision from systemd's own variables; it no longer
  does. The installed unit is a copy, and no update changes it.
- The key was put in `../private/.env`. The message then adds
  *DEDALO_SUPERVISED in ../private/.env is IGNORED*: every launch method reads
  that file, including the unsupervised `bun run start`.
- The server was started with `bun run start`, which is unsupervised by design.

**Fix.** The installer's `dedalo-ts@<i>` unit declares it; this concerns a unit
set up by hand, such as the single-instance `dedalo-ts` of a migrated host. On
systemd, add the declaration with a drop-in, then restart:

```shell
systemctl edit dedalo-ts
```

```ini
[Service]
Environment=DEDALO_SUPERVISED=true
SuccessExitStatus=75
Restart=always
```

```shell
systemctl restart dedalo-ts
systemctl show dedalo-ts -p Environment     # must list DEDALO_SUPERVISED=true
```

`Restart=always` matters as much as the declaration: after the swap the server
exits with code `75`, and only a unit that restarts on that exit comes back.
A `DEDALO_SUPERVISED` line in `.env` does nothing, whatever its value. Without
systemd, start the server with `bun run start:supervised` (or `bun run dev` on a
development machine), which declares the key and restarts on exit `75`.

### `Error. The release pins Bun 1.4.4 but this server runs Bun 1.4.3 — install the pinned Bun first, then retry the update.`

**Cause.** The release was verified on one Bun, and its `.bun-version` names it;
this host runs another. The refusal comes after the archive is downloaded and
checked and **before** anything is installed or swapped, so the live tree, its
dependencies and the database are untouched — it costs a download, not an
install. The runtime is root-owned and outside the instance, so no code update
can move it for you.

**Fix.** Install the named Bun beside the one you run, repoint the unit at it and
restart, then retry the update. [Updating the Bun runtime](bun_runtime.md) is the
procedure, with the verification for each step.

### The server still runs the old Bun after the runtime step

**Cause.** The unit was restarted without `daemon-reload`, so systemd re-executed
its cached `ExecStart`; or the edit landed in a file this unit does not read; or
the process answering is not that unit at all (a server started by hand).

**Fix.** These read-only checks name the case (the first line assumes one
instance; with several, set `I` to the one you restarted):

```shell
I=${I:-$(systemctl list-units --all --plain --no-legend 'dedalo-ts@*' | awk '{print $1}' | sed -n 's/^dedalo-ts@\(.*\)\.service$/\1/p' | head -1)}
P=$(systemctl show -p MainPID --value "dedalo-ts@$I")
echo "pid=$P"
sudo readlink -f "/proc/$P/exe"                          # the binary the process IS
sudo systemctl show -p ExecStart --value "dedalo-ts@$I"  # the command systemd holds
sudo systemctl show -p FragmentPath -p DropInPaths --value "dedalo-ts@$I"
```

The path `readlink` prints is the decisive line — when `pid` is not `0`: the new
path means you are reading an older journal entry, the old path means the unit is
the cause, and [the diagnosis table](bun_runtime.md#the-server-still-runs-the-old-version)
walks from there. A `pid=0` while the site answers means a hand-started process
owns the socket, and `sudo ss -xlp | grep dedalo` names it. After any drop-in
edit, `sudo systemctl daemon-reload` comes before the restart.

## Using it

### Nobody can log in, and there is no error message

**Cause.** `SESSION_COOKIE_SECURE` defaults to **true**, so the browser discards
the session cookie over plain `http://`. The login *succeeds*; the cookie is
thrown away; the next request arrives with no session; you land back on the login
form.

**Fix.** Serve over **TLS**. That is the real fix, and the only fix on a server.

On a local development machine only:

```dotenv
SESSION_COOKIE_SECURE=false
```

!!! danger
    Never set this to `false` anywhere a real user can reach. The media-auth
    cookie inherits the same attribute, so you would also be shipping a working
    media authorisation value in cleartext.

### The interface misbehaves after the upgrade from v6

Buttons do nothing, panels render half-empty or the console shows script
errors — in browsers that used the v6 install, while a fresh browser (or a
private window) works.

**Cause.** v6 installed a service worker at `core/sw.js` that answered every
Dédalo script from its own `dedalo_files` cache. Until it is replaced, a v7
page loads a mix of v7 and cached v6 scripts.

**Fix.** Nothing to do on the server: v7 serves a replacement at that same URL
that deletes the v6 cache, unregisters the old worker and reloads the page. The
browser picks it up on the first visit, so the symptom lasts one page load. If it
persists, reload once more. As a last resort, in the browser's developer tools
(*Application → Service workers*) unregister the worker for the Dédalo site and
reload.

!!! warning
    Never delete `core/sw.js` from the served tree, nor rewrite it as the real
    worker (that lives at `core/service_worker.js`). That file is what evicts the v6
    worker from browsers that have not visited since the upgrade — remove it and
    those browsers keep the v6 scripts indefinitely.

### Users are logged out more often than they expect

**Cause.** Two clocks, and either one ends a session — see
[login](../core/system/login.md):

| clock | key | default |
| --- | --- | --- |
| Idle timeout | `SESSION_TTL_SECONDS` | `3600` (1h without a single request) |
| Absolute cap | `SESSION_ABSOLUTE_TTL_SECONDS` | `43200` (12h since login, unconditional) |

Users report the **cap** as "it logs me out in the middle of my work", because
activity cannot postpone it. That is what it is for: the idle window alone never
expires a browser that polls in the background.

**Fix.** Raise the one that is actually biting — do not raise both reflexively.
An install on trusted, physically secure workstations can extend the cap; a
shared or public workstation wants the *idle* window short above all.

```dotenv
SESSION_TTL_SECONDS=3600
SESSION_ABSOLUTE_TTL_SECONDS=43200
SESSION_WARNING_SECONDS=300
```

Users should be **warned** before this happens: `SESSION_WARNING_SECONDS`
(default `300`) puts a notice on screen that many minutes ahead. If nobody is
seeing it, check it is not set to `0`, and that the browser is not running a
stale cached copy of the client (a hard reload settles it).

!!! note "Running jobs are not interrupted"
    A logout — voluntary or by timeout — never stops a background import or a
    publication run. They keep the requesting user on the job record and never
    re-read the session, and the same user reattaches to a job in progress after
    logging back in.

## Media

### Docker: newly uploaded media is `403`, older media serves

The nginx error log says `open() "/srv/dedalo/media/…" failed (13: Permission
denied)`. The engine runs under `umask 0027`, so new media files are `640` —
readable only by the engine's group (gid `1000`) — and nginx's workers are not in
it. The shipped compose files add the `nginx` user to that group in the nginx
service's `command:`; a stack whose command was replaced, or one relying on
`group_add` (which never reaches the workers), loses it. Restore the two
`addgroup` calls and recreate the service:

```bash
docker compose up -d --no-deps --force-recreate nginx
docker compose exec nginx sh -c 'grep Groups /proc/$(pgrep -f "worker process" | head -1)/status'   # must list 1000
```

Do not `chmod -R o+r` the media tree: it makes media world-readable, and the next
upload is `403` again. See [Running Dédalo in containers](docker.md#3-the-engine-writes-the-media-rules-nginx-reads-them).

### An SVG uploads but gets no thumbnail

The log says `rasterizeSvg: SVG rasterization needs librsvg's 'rsvg-convert'`.
SVG is rendered by librsvg only — ImageMagick's own SVG path is refused by the
hardened policy. Install it (`apt install librsvg2-bin`, `dnf install
librsvg2-tools`, `brew install librsvg`) or point `DEDALO_RSVG_CONVERT_PATH` at
the binary. The Docker image ships it; an older image needs a rebuild.

### A logged-in user gets `404` for every media file

The giveaway is that **the application itself works perfectly** — records load,
searches run — and only images, video, PDFs and 3D files are missing. That is
expected: the web server enforces media access, not the engine, so a media
failure says nothing about the session.

**Cause.** Rule A failed: either the browser is not sending the
`dedalo_media_auth` cookie, or the marker file it names does not exist under
`<media>/.publication/auth/`. Rule B cannot cover for it — with no publication
markers it never matches, so Rule A is the only door for unpublished media.

**Fix.** Work outward from the file to the browser:

1. Confirm the marker store exists and is readable by the web server. It holds
   one marker per LIVE SESSION, named by that session's cookie value (the
   day-global `<private>/media_auth.json` is retired — boot renames it
   `.migrated`):

    ```shell
    ls -l /srv/dedalo/media/.publication/auth/
    ```

2. Prove the **rules** are fine by presenting a known-good cookie by hand. If
   this returns `200`, the gate works and the problem is the browser's cookie:

    ```shell
    curl -s -o /dev/null -w '%{http_code}\n' \
      -H "Cookie: dedalo_media_auth=<today's value>" \
      https://example.org/dedalo/media/image/thumb/0/<a real file>.jpg
    ```

3. Check the cookie in the browser. It is `HttpOnly`, so read it in DevTools →
   *Application* → *Cookies*, never from JavaScript. It is also `SameSite=Lax`:
   media embedded **cross-site** will not carry it, by design.
4. If it is `Secure` but you are on plain HTTP, see the login entry above.
5. **Reload the page.** The cookie is re-issued on the next authenticated
   request, so a stale or missing one heals itself without a re-login. If it
   does not, no store exists yet — log out and back in, which creates one.

!!! note "Fixed in the current engine"
    On engines predating the session-bound cookie, this had a much simpler
    cause: the cookie was minted **only at login** with a fixed 24-hour
    `Max-Age`, while the session renewed on every request. Anyone logged in for
    longer than a day lost media access with no other symptom. Re-login was the
    only cure. If you are seeing this on a schedule of roughly once a day, that
    is what you are looking at.

### An anonymous visitor gets `404` for a published record's media

**Cause.** Rule B did not match. Three candidates, in order of likelihood:

1. **The record is not published.** The marker
   `<media>/.publication/pub/{section_tipo}_{section_id}` is written by the
   diffusion engine when you publish. No marker, no access.
2. **The quality folder is not public.** Only the configured public qualities are
   readable anonymously, and **master qualities can never be made public** — the
   `original` and `modified` folders are filtered out no matter what you
   configure.
3. **The file name does not parse.** Rule B identifies the record from the file
   *name*. A file renamed outside Dédalo's naming grammar simply never matches,
   and stays login-only. That is deliberate; do not loosen it.

### Every media file `404`s, for everybody, and nginx looks fine

**Cause.** The **root rule**. The generated nginx locations carry no `root` and
no `alias`; they inherit the server's `root`, which must resolve
`/dedalo/<media dir>/…` onto `MEDIA_PATH`.

**Fix.** See [The web server site › The root rule](reverse_proxy.md#the-root-rule).
With the canonical layout it is `root /srv;`.

### Media is served to *everyone* (Apache)

**Cause.** The generated `.htaccess` is being ignored — silently, and open.

**Fix.** The media directory needs `AllowOverride All` (or at least
`FileInfo Options`) and `mod_rewrite` enabled. This one line is the entire gate
on Apache.

### My `MEDIA_HTACCESS_ADDONS` rules are not in the generated `.htaccess`

**Cause.** The value is not valid JSON, so it was refused. The boot log says so:

```text
[config] MEDIA_HTACCESS_ADDONS must be a JSON array of strings — ignoring the value.
```

Almost always this is **backslash escaping**. The key holds a JSON array, so every
backslash in an Apache regex has to be doubled:

```ini
# wrong — natural Apache syntax, but invalid JSON
MEDIA_HTACCESS_ADDONS=["RewriteCond %{REMOTE_ADDR} ^10\.0\.","RewriteRule ^ - [L]"]

# right — backslashes doubled for JSON
MEDIA_HTACCESS_ADDONS=["RewriteCond %{REMOTE_ADDR} ^10\\.0\\.","RewriteRule ^ - [L]"]
```

**Fix.** Correct the escaping and restart. Only your addon lines were dropped — the
access gate itself is unaffected and stayed closed, which is the intended failure
direction: a malformed addon must never become half a directive inside a live
`.htaccess` (that would make Apache reject the whole media directory).

### An uploaded image produces no derivative and no thumbnail

**Cause.** ImageMagick is not installed, or its binaries cannot be resolved.

**Fix.**

```shell
command -v magick convert identify
```

Either is fine — the engine probes for `magick` first and falls back to
`convert`/`identify`, which is what Ubuntu 24.04 ships. If they live somewhere
unusual, set `DEDALO_BINARY_BASE`, or the individual keys
(`DEDALO_MAGICK_PATH`, `DEDALO_IDENTIFY_PATH`).

### Video uploads work, but playback does not start until the file has downloaded

**Cause.** `qt-faststart` is missing, so the MP4 index is still at the end of the
file.

**Fix.** Install it (it ships with `ffmpeg` on most distributions) or point at
it: `DEDALO_AV_FASTSTART_PATH=/usr/local/bin/qt-faststart`.

### Unpublishing a record does not take effect

**Cause.** The web server is caching the `stat()` of the publication marker.

**Fix.** `open_file_cache off;` on the media locations (or
`open_file_cache_valid` ≤ 2 s). Behind a CDN, purge the record's media paths on
unpublish — the origin denies immediately, downstream caches do not.
