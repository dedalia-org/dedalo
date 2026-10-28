# Production install

> See also: [Installation hub](index.md) · [Installer reference](installer_reference.md) · [The web server site](reverse_proxy.md) · [Several instances on one host](multi_instance.md) · [Troubleshooting](troubleshooting.md) · [Upgrading](upgrading.md)

The Production route is the recommended way to run Dédalo for a museum, an archive or any institution. The installer turns a clean server into a running, TLS-protected, supervised and backed-up **instance**: one named Dédalo with its own user, database, media, socket, units and web site. This page explains how to run it, what each step does, and how to check or repair each step by hand.

The installer is the recommended procedure. The sections on each step are reference for system administrators: what to look at, and what the installer has already done. Each one links its hand version: [Install by hand](manual_install.md) is the same procedure, one command at a time, for administrators who install by hand.

## Overview

The engine is a single long-lived **Bun** process, run by systemd as the instance's own user. It listens on a **unix socket**. The web server (nginx or Apache) owns TCP and TLS, serves the published client files and the media bytes, and enforces media access control. PostgreSQL 18 on the same host is the system of record.

Everything the installer creates is named after the **instance name** you choose (`<i>` below — for example `prado`), except the install folder and the service account, which you may choose yourself ([The install folder and the service account](#the-install-folder-and-the-service-account)). The table shows the defaults; `<dir>` is the install folder:

| Path or name | What |
| --- | --- |
| `ded_<i>` | the service user and group the instance runs as (default; a new system account with no login shell) |
| `<dir>` = `/home/ded_<i>/` | the install folder (default) |
| `<dir>/dedalo/` | the release tree (an extracted release, not a git clone) |
| `<dir>/private/` | the private directory (`0700`): `.env` (`0600`), the session store, the state file, the engine's install record |
| `<dir>/backups/` | the backups (the default `--backup-dir`) and the code-update backups (`backups/code`) |
| `/srv/dedalo/<i>/` | the web site's root (`0750`) |
| `/srv/dedalo/<i>/dedalo/media/` | `MEDIA_PATH`: originals, derivatives and the media-gate files (`0750`, never world-readable) |
| `/srv/dedalo/<i>/client/` | the client the engine publishes at every start; the web server serves it from here |
| `/run/dedalo-<i>/dedalo_ts.sock` | the engine's socket (systemd `RuntimeDirectory`) |
| `dedalo_<i>` | the database, owned by the role named like the service user (peer authentication, no password) |
| `dedalo-ts@<i>` | the engine's systemd unit, with its watchdog, rollback, restart and backup units |
| `/opt/dedalo/bun/<pin>/bun` | the Bun runtime at the release's pin, **owned by root** and shared by the instances on that pin |
| `/opt/dedalo/instances/<i>/bin/` | the root-owned copies of the scripts root-run units execute |
| `/var/lib/dedalo-install/<i>/` | the installer's record of the host steps (`0700`, root) |

The layout follows one rule, by role. **The install folder is the instance directory**: owned by the service user, it holds the release tree, the private directory and the backups, and an in-app code update renames the release tree only inside it (its parent is never changed). **What root-started units run** — the runtime and the root-run scripts — lives in root-owned directories under `/opt/dedalo/`, outside every instance directory. A host [installed by hand](manual_install.md#the-layout) follows the same rule and the same paths.

Several instances can share one host; each runs the installer with its own name. See [Several instances on one host](multi_instance.md).

### Mandatory: a supervisor that declares itself

Dédalo must run under a process manager that **restarts it** and **declares `DEDALO_SUPERVISED=true` in the process environment**. A code update replaces the tree and then exits the server with code `75`, so that the supervisor boots the new code; without a declared supervisor the [code update panel](../management/updates/updating_code.md) refuses every update (*No supervisor declared*) rather than leave the server dead.

| Launch method | Where the declaration is |
| --- | --- |
| this route's `dedalo-ts@<i>` unit | `Environment="DEDALO_SUPERVISED=true"`, with `Restart=always` and `SuccessExitStatus=75` — written by the installer |
| the compose stacks | the `dedalo` service's `environment:` |
| a host [installed by hand](manual_install.md#manual-host_units) | the same `dedalo-ts@<i>` template and drop-in, written by hand (a host set up before 2026-10-12: [the single-unit set](manual_install.md#the-single-unit-set), `deploy/dedalo-ts.service`) |
| development | `bun run start:supervised` or `bun run dev`; plain `bun run start` is unsupervised |

A `DEDALO_SUPERVISED` line in `.env` is **ignored**: that file is read by every launch method, the unsupervised `bun run start` included.

## Before you start

**A supported system.** Ubuntu 26.04 LTS, Debian 13, or RHEL, Rocky Linux or AlmaLinux 10, with systemd. The installer supports the newest release of each and refuses anything else, before it changes anything. You run it as root.

**The bootstrap's tools.** `curl`, `unzip` and `sha256sum`, which `install.sh` needs before the installer can install anything: `apt-get install curl unzip coreutils` or `dnf install curl unzip coreutils`. See [Get Dédalo](index.md#get-dedalo).

**The release: an archive or a checkout.** Run the installer from a release archive or from a `git` clone checked out at a release tag. A clone usually belongs to the account you cloned it as, not to root. The installer handles that: `install.sh` installs its own dependencies **as the clone's owner**, so root writes nothing in your clone, and `host_runtime` archives the checked-out commit with that one checkout marked safe for `git`, without changing any global `git` setting. A `--route production` run on a system the route does not support is refused before anything is downloaded.

**An instance name.** A lowercase letter, then lowercase letters, digits or `_`, at most 28 characters. It becomes the database `dedalo_<i>`, the units, the web paths and the default service user `ded_<i>`, and cannot be changed later.

### The install folder and the service account

The Identity screen asks, right after the instance name, where the instance lives and which account it runs as. Each question is pre-filled; Enter accepts it.

| Question | Flag | Default | What you may give |
| --- | --- | --- | --- |
| Install folder | `--install-dir` | `/home/ded_<i>` | any absolute path, for example `/home/my_domain.org/dedalo` |
| Service user | `--service-user` | `ded_<i>` | a new name (the installer creates it) or an **existing** account, used as it is |
| Service group | `--service-group` | the service user's own group | another group; a new name is created |

**The install folder.** When it does not exist, the installer creates it, owned by the service user (`0750`). Its parent is never changed: it may be root's, even `0555`. An existing folder is used only when it is the service user's and holds no install (`dedalo/`, `private/`, `backups/`), or when it is root's, empty, under root-owned parents and inside `/home`, `/srv`, `/data`, `/mnt` or `/media` (a mount point, say) — then it is handed to the service user, and `--abort` gives it back with its owner and mode. An empty directory of the system (`/var/mail`, `/var/opt`, …) or of another account is never taken over: `chown` it to the service user yourself first. A folder writable by group or others, one reached through a symbolic link, one below a directory another account controls, a system location (`/etc`, `/usr`, `/var/lib` and the like) and a folder that a web site on this host serves are refused. The backups default to `<dir>/backups`; a `--backup-dir` is a normalized absolute path (no `..`, no `//`, no trailing `/`) that does not exist yet — inside the folder too: the installer never re-modes or fills a directory that was already there.

**The service user.** The default is a new system account of its own, which is the recommended choice. An **existing** account — a hosting account such as `my_domain.org` — is used as it is: the installer never creates, changes or deletes it, and `--abort` keeps it. It must be a regular account (uid in the range of `/etc/login.defs`), never root, and in no privileged group (`wheel`, `sudo`, `docker`, `lxd`, or any system group except the common `users`): systemd gives the service every group of the account. The accounts of the packages the installer installs (`postgres`, `www-data`, `nginx`, `apache`) are refused as service user and as service group. An account with a login shell is accepted; the Review says that whoever logs in as it can change the code the service runs. The installer creates only names that `useradd` accepts by default (no dot); an existing account's name may contain a dot.

**The service group.** The web server's user joins it, to reach the socket, the media and the published client. When the service group is an existing account's primary group (by default, or typed), the web server can then read whatever that group can read: the Review says so. A group of its own (`--service-group ded_<i>`) is recommended.

**One account, one group, one folder per instance.** The System check refuses a service user or group that another Dédalo instance on this host already uses, an account that is a member of another instance's group, and an install folder that is, contains or lies inside another instance's folder. The other instances are read from the host registry (`/var/lib/dedalo-install/instances/`), the units' drop-ins, the installer's records of unfinished installs, and any hand-installed `dedalo*.service` (with no `Group=` line, its group is its `User=`'s primary group; when that cannot be resolved, the unit is refused). The refusal names the file it read. A name an installed instance already holds (its registry entry or its unit's drop-in) is refused on the System check, right after you type it, naming those files: choose another name — an install never takes over an installed instance, its account, folder or database. An account that did not exist at the System check but exists when `host_identity` runs (a package created it) is refused, never taken for the installer's own.

**The database user** is the service user: PostgreSQL's peer authentication maps the operating-system user to the role of the same name. With `--db-mode create` the database user is never asked, and `--db-user` is refused when it differs from the service user. When the account already has a role of its name, use `--db-mode existing`.

**The public address.** A fully qualified name (not `localhost`, not an IP address) whose DNS points at this server. It goes into the site file and the certificate. With a local certificate authority it needs to resolve only where staff work (the intranet's DNS, or each computer's `hosts` file), and **Other addresses** (`--tls-extra-names dedalo.lan,archivo.museo.lan`) adds the other names staff type: the site answers to them and the certificate names them. **Other addresses** may also list IPv4 addresses of this server (`--tls-extra-names dedalo.lan,192.168.1.20`), for an intranet with no local DNS: the instance claims them, and `https://192.168.1.20/` reaches it ([Reaching an instance by IP address](reverse_proxy.md#reaching-an-instance-by-ip-address)). The System check refuses an address that is not this server's, one another instance claims, and IPv6.

**The certificate.**

| Choice | What you need |
| --- | --- |
| **Let's Encrypt** (default) | the name resolves publicly to this server, port 80 is reachable from the internet (the HTTP-01 challenge), and an email address for expiry notices |
| **Local CA** | nothing outside this server: for an intranet with no public name, or a test machine without a domain ([Trying the production route in a virtual machine](#vm-test)). The installer makes a certificate authority on this server and a certificate for the address (and the other addresses). Each staff computer then trusts the authority **once** — the Done screen says where its file is, its fingerprint and how. The authority can certify exactly this install's addresses, `localhost` and `127.0.0.1` — not even a name below one of them, such as `mail.<address>` — so a stolen key cannot impersonate another website or another machine of your network; for the same reason no address may lie inside another (`museo.lan` and `dedalo.museo.lan` together are refused). The certificate renews itself from the same authority, so the staff computers never trust anything again |
| **Your institution's certificate** | the fullchain and the key as files on this server. They must name the address, be valid now (a warning under 30 days, shown on the Review) and pair with each other, and **this server must trust the chain**: the installer's last step checks the site with this machine's `curl`, exactly as a browser would. A certificate from your institution's own certificate authority needs that authority in the system trust store first (Debian and Ubuntu: copy it to `/usr/local/share/ca-certificates/<name>.crt`, then `sudo update-ca-certificates`; RHEL family: copy it to `/etc/pki/ca-trust/source/anchors/`, then `sudo update-ca-trust`). The System check refuses an untrusted chain and names its issuer. The installer uses the files where they are and never copies or changes them |

**The web server.** nginx (at least 1.25.1) or Apache. On a host that has one already, choose that one; when there is none, the installer installs the one you choose on the *Web server & TLS* screen (nginx by default). It refuses, before any change, a run that would install the other web server beside an installed one, and a run whose ports (80 and 443, or yours) another program holds: another web server, such as another instance's, a proxy or a container. The Review's *To do* list names that program before you type `yes`. It writes **one site file** for this instance and, on nginx, once per host the [catch-all site](reverse_proxy.md#the-catch-all-site) that keeps a name no site declares away from every instance (on Apache, each site refuses any name but its own). It never edits another site, another default site or the global configuration.

Apache needs the modules `ssl headers http2 rewrite proxy proxy_http`. Enabling modules is your job: the installer checks them and never enables one. On the RHEL family the `httpd`, `mod_ssl` and `mod_http2` packages load them all. On Debian and Ubuntu the `apache2` package enables none of them, so the Review's *To do* list prints the command, `a2enmod ssl headers http2 rewrite proxy proxy_http && systemctl restart apache2`. When the installer installs Apache itself, the run stops at the web step until you run it, then `--resume` continues. To avoid that stop, install `apache2` and enable the modules before you start.

**The firewall.** The site needs ports 80 and 443 (or your `--http-port` and `--https-port`) open to the browsers that will use it. The installer never changes the firewall. It reads firewalld's default zone or ufw's rules and shows the result on the System check and the Review. When a port is closed, the Review's *To do* list and the closing *To do on this host* list print the command that opens it, for example `firewall-cmd --permanent --add-service=http --add-service=https && firewall-cmd --reload` or `ufw allow 80,443/tcp`. Its last probe connects from the server itself, so it passes even when the firewall blocks everyone else: check from another machine too.

**The database.** By default (`--db-mode create`) the installer creates the role and the database on this host's PostgreSQL 18. With `--db-mode existing` it uses a database you created, which must be empty.

**The media access mode.** Media is served **by the web server**, but the **access rules are generated by Dédalo**. Decide which readers the web server lets through:

| `DEDALO_MEDIA_ACCESS_MODE` | Who can read a media file |
| --- | --- |
| *(unset)* | the `publication` default — fail-closed |
| `private` | logged-in Dédalo users only |
| `publication` | logged-in users **plus** anonymous readers of *published* records, in *public quality* folders only |
| `false` | everybody: the media tree is served openly, with no gate at all |

Three facts about the gate you cannot guess:

- **No Dédalo process is ever in the media byte path.** Authorisation is a single `stat()` performed by the web server, which is why `sendfile`, HTTP `Range` and the H.264 `?start=` clipping still work on multi-gigabyte files.
- **The gate fails closed as `404`, never `403`.** The existence of unpublished media is not disclosed.
- **Master qualities can never be made public.** The `original` and `modified` folders are filtered out of the public list whatever you configure.

How the two rules work is in [The web server site](reverse_proxy.md#how-the-media-gate-decides).

## Run the installer

From the release of Dédalo ([Get Dédalo](index.md#get-dedalo)), as root:

```shell
sudo sh install.sh
```

Choose **Production** on the first screen and type the instance name there (`--plain` asks the same questions one per line). Give no other flag: any answer flag, `--route` and `--instance` included, makes the run headless — see the headless form below. The screens ask, in order:

| Screen | What it asks |
| --- | --- |
| **Install type** | the route and the instance name |
| **System check** | nothing: it shows what this host has, and whether an installed instance already holds the name. A failed row must be fixed before the install |
| **Identity** | the install folder, the service user and the service group first (the database user is the service user, so they come before the database); then the institution's short code (`entity`) and full name, the install fingerprint (**Information** and **Info key** — keep the defaults unless you are moving a v6 installation; they never change later), the time zone and the locale. The time zone stamps every database timestamp |
| **Database** | the database mode: **create** (the default — only the database name is asked: the role is the service user, reached by peer login, with no password) or **existing** (its host, port, socket, name, role and password). Defaults follow the instance name |
| **Web server & TLS** | nginx or Apache, the public address, the certificate (Let's Encrypt and its email, a local CA and its other addresses, or the paths of your files), then the HTTP and HTTPS ports |
| **Services** | the media root, the socket, the media access mode and the backup directory. The defaults are the layout above |
| **Ontologies** | whether to use the official update servers, then the domain ontologies: Oral history (`oh`) is built in and pre-ticked; others come from the update server, with the ontologies they declare |
| **Thesauri** | the thesauri the chosen ontologies declare, pre-ticked. No country's toponymy is pre-selected. The thesauri are created empty: only `lg` and the country toponymies carry terms |
| **Languages** | the interface and data languages |
| **Publication** | optional: a MariaDB publication target (tested, or kept untested by typing `yes`) |
| **Mail** | optional: an SMTP relay for password recovery (tested the same way) |
| **Administrator** | the `root` password, typed twice and checked against the password policy |
| **Review plan** | everything that will happen — see below |

The same install runs headless, for automation. Give the answers as flags or as an answers file and the root password through the environment, never on the command line:

```shell
read -rsp 'New root password: ' DEDALO_INSTALL_ROOT_PASSWORD; echo; export DEDALO_INSTALL_ROOT_PASSWORD
sudo --preserve-env=DEDALO_INSTALL_ROOT_PASSWORD sh install.sh -- \
  --route production --instance prado --entity prado \
  --server-name dedalo.example.org --letsencrypt-email it@example.org --execute
unset DEDALO_INSTALL_ROOT_PASSWORD
```

Every flag, the answers file and `--plan` (a dry run that changes nothing) are in the [installer reference](installer_reference.md#command-line-flags).

## The Review

Nothing has changed on the host until you type `yes` at the Review. It shows the answers, the ontologies in install order, the thesauri, the `.env` key names, and **every command each host step will run, exactly as it will run** — the run executes this same list, and a resume refuses a step whose commands have changed since. Read it: it is the whole change to the host.

Before the steps comes a **To do** list, when there is anything on it: what you must do yourself, because the installer checks it but never does it. It lists the firewall's closed ports with the command that opens them, the Apache modules to enable, and an institution certificate that expires within 30 days or that this server does not trust. A directory a step would create that already exists, such as `/srv/dedalo` or `/opt/dedalo` on a host with other instances, is marked *exists, not created* next to its step and on its own `mkdir` line: the step does not create it, and sets the mode and owner the line shows.

`write <path>` (or **w** on the full screen) saves your answers as an answers file, with no secret in it, instead of installing.

## The steps

The installer runs the steps below in order. Each one is recorded in `/var/lib/dedalo-install/<i>/` before and after it runs. If a step fails, the installer stops, says why, and prints the two ways on:

```shell
sudo sh install.sh --route production --instance <i> --resume                               # fix the cause, then continue
sudo sh install.sh --route production --instance <i> --abort --confirm-database dedalo_<i>   # undo this install
```

`--resume` checks again every step already recorded as done that has a check (`done in an earlier run — verified again: …`), starts again a step that only starts a service and finds it stopped, refuses a step whose work was undone outside the installer, and runs the rest. A done step with nothing to check, such as the System check, is not run again (`… — nothing to re-check, not run again`). `--abort` undoes, in reverse order, only what this install created. Neither ever touches something that existed before the install. Both are described in full in the [installer reference](installer_reference.md#resuming-an-install-resume).

On every step below, **Verify** is what you can check by hand, and **Repair** is what to do when that check fails.

### `host_preflight` — the System check

By hand: [Install by hand › `host_preflight`](manual_install.md#manual-host_preflight).

Measures the host and **refuses, before any change**, everything a later step would trip on: an unsupported system (`<system> is not supported — the production route supports …`), no systemd, not root, nginx older than 1.25.1, anything already using this instance's names (the database or role, the unit, its drop-ins, the site file, the socket, the nginx `upstream` and rate-limit zone names), every [install folder and service account rule](#the-install-folder-and-the-service-account) (another instance's user, group or folder; a system account; a privileged group; a folder that is not empty and not the service user's), **any instance directory that already exists** — under `/srv/dedalo/<i>`, the backup dir, `private/` (the installer never takes over a directory), a web-server configuration it cannot read, the address already served by another site on these ports, the instance's ports held by any program but the chosen web server (another web server, such as another instance's, a proxy, a container), the other web server installed beside the one this run would install, another PostgreSQL major version on the database port, and an institution certificate that does not check out (another address, expired, another key, or a chain this server does not trust). It reads the firewall (firewalld's default zone, or ufw) and **tells** you whether the instance's ports are open, with the command when they are not; it never changes the firewall. On Apache it also tells you which modules to enable (see *The web server* under [Before you start](#before-you-start)).

It changes nothing, so it has no undo. Then it freezes what it measured and the command list of every later step.

- **Verify:** the refusal sentence lists every problem at once.
- **Repair:** resolve each, then run the same command again — nothing was written, so it starts fresh. Open the ports yourself when the firewall line says they are closed; it prints the command. See [Troubleshooting › The System check refuses](troubleshooting.md#the-production-system-check-refuses).

### `host_packages` — packages and repositories

By hand: [Install by hand › `host_packages`](manual_install.md#manual-host_packages).

Installs only what the host is missing: PostgreSQL 18 (server, client, contrib), the media toolchain, the archive tools (`git`, `unzip`, `gzip`, `file`, `curl`, `rsync`, `diffutils`, `ca-certificates`), the web server you chose when there is none, `certbot` for Let's Encrypt, and the SELinux management tools on the RHEL family. It adds the repositories they need:

| System | Repositories |
| --- | --- |
| Ubuntu 26.04 | none — PostgreSQL 18 ships with the release |
| Debian 13 | the PostgreSQL project's repository (PGDG) |
| RHEL / Rocky / AlmaLinux 10 | EPEL (ImageMagick, certbot), CodeReady Builder, RPM Fusion free (FFmpeg), PGDG. `ocrmypdf` is optional there: a failure to install it only warns, and automatic OCR of PDFs stays off. EPEL 10 has no `ocrmypdf` for `aarch64` |

The media toolchain, and what each tool is for:

| Tool | Used for |
| --- | --- |
| `ffmpeg` / `ffprobe` | audiovisual transcoding, posterframes, probing |
| `qt-faststart` | moves the MP4 index to the front so a video starts before it has downloaded |
| ImageMagick | image derivatives, thumbnails, colour-space conversion |
| `pdftotext`, `pdftohtml`, `pdfinfo` (poppler) | PDF text extraction and page rendering |
| `ocrmypdf` | optional automatic OCR of uploaded PDFs |
| `rsvg-convert` (librsvg) | thumbnails of SVG records — the only vector rasterizer Dédalo uses |

ImageMagick can render SVG only through a coder that Dédalo's hardened ImageMagick policy disables, because that coder is a long-standing remote-code-execution vector. Vector rendering therefore goes through `rsvg-convert`, which parses SVG and nothing else.

Packages and repositories are **shared host state**: `--abort` tells you what this install added and never removes it (removing a repository would leave its packages without security updates).

- **Verify:** `command -v ffmpeg ffprobe qt-faststart pdftotext rsvg-convert`, and `psql --version` (18). If `qt-faststart` lives elsewhere, set `DEDALO_AV_FASTSTART_PATH` in `.env`. For OCR in another language, install its Tesseract pack (`tesseract-ocr-spa`…); without it OCR falls back to English.
- **Repair:** a failed download or a locked package manager: fix it, then `--resume`.

### `host_identity` — the service account, the install folder and the directories

By hand: [Install by hand › `host_identity`](manual_install.md#manual-host_identity).

Creates the service user when it does not exist (a system account, no login shell, no skeleton files) with its own group, or the typed group first (`groupadd --system`); an existing account and an existing group are used as they are and appear on the Review as **USED AS IS**. Then every directory in the [layout](#overview) at its mode: the install folder (`0750`), `private` (`0700`), `backups`, `/srv/dedalo/<i>` and the media root (`0750`), and the root-owned `/opt/dedalo/…` directories (`0755`).

Root creates the install folder only under root-owned parents (its missing parents `root 0755`). Under a parent the service user owns — `/home/my_domain.org` — the service user creates it. Everything **inside** the folder and inside the instance's web root is created by the service user: root never works by path in a tree another account controls. A shared directory that already exists (`/srv/dedalo` or `/opt/dedalo` on a host with other instances) is used as it is and never re-moded.

- **Verify:** `getent passwd <service user>`; `sudo stat -c '%a %U:%G %n' <dir> <dir>/private /srv/dedalo/<i>/dedalo/media` shows `750`, `700` and `750`, owned by the service user (`sudo`: the folder is `0750`, so only root and the service account read inside it).
- **Repair:** `--resume`. `--abort` removes, as the service user, what this install left in the folder, then the folder when it created it (an adopted empty folder gets its owner and mode back; a folder used as it is keeps its own content). It removes the user and the group only when it created them — never an existing account — after removing, as that user, what it left at the top of `/tmp` and `/var/tmp` (Bun's `bun-node-<hash>` directory and `.<hash>-0.hm` marker), and keeps them, telling you why, while the user still runs processes or backups remain (a removed user id could be given to a later account, which would then read them).

### `host_runtime` — Bun, the release and the root-run scripts

By hand: [Install by hand › `host_runtime`](manual_install.md#manual-host_runtime).

- **Bun** at the release's pin, **owned by root**, in `/opt/dedalo/bun/<pin>/`. It is taken only from a zip whose sha256 equals the release's committed `.bun-sha256` row — the bootstrap's verified cache. The unit runs it as the instance, but the instance can never replace what it runs. When another instance already runs the same pin, the binary there is byte-identical (`cmp`) and is not installed again.
- **The release** extracted into `<dir>/dedalo` **by the service user** (from a root-owned hand-over directory under `/var/lib/dedalo-install/`), and its dependencies installed as the service user (`bun install --frozen-lockfile --production --ignore-scripts`). From a checkout, the release is its checked-out commit (`git -c safe.directory=<checkout> -c core.fsmonitor=false archive … HEAD`). The `safe.directory` exception applies to this one command and changes no `git` configuration. When `git` refuses, the step's message quotes its `fatal:` line.
- **The root-run scripts** — backup, watchdog, rollback, alert and media-rule scripts, and the local-CA generator `dedalo-tls-rotate.sh` — copied root-owned (`0755`) to `/opt/dedalo/instances/<i>/bin/`, outside the code tree: a code update moves the whole tree aside, and the rollback has to work exactly when the tree is missing.

!!! danger "Never `bun upgrade` on a production server"
    The engine is coupled to version-specific runtime behaviour — JSONB parameter inference in `Bun.sql` above all — and a silent drift there is a data-corruption class, not a performance regression. The server echoes its runtime at boot and warns loudly when it does not match the pin. The rationale is in `engineering/PRODUCTION.md` §1.

- **Verify:** `/opt/dedalo/bun/<pin>/bun --version` equals `sudo cat <dir>/dedalo/.bun-version` (the install folder is `0750`); `stat -c '%U %n' /opt/dedalo/bun/<pin>/bun` is `root`; `ls /opt/dedalo/instances/<i>/bin/`.
- **Repair:** `--resume`. `--abort` removes the release and the scripts, and Bun only when no other instance uses that pin.

### `host_database` — the role and the database

By hand: [Install by hand › `host_database`](manual_install.md#manual-host_database).

With `--db-mode create`, it creates the role named like the service user (LOGIN, **no password** — peer authentication over the local socket `/var/run/postgresql`, so no database password exists at rest) and the database `dedalo_<i>` it owns (UTF8, from `template0`). PostgreSQL lets every role connect to a new database (the `PUBLIC` grant), so the installer then revokes `CONNECT` and `TEMPORARY` from `PUBLIC` and grants them to the instance's role alone: another instance's role cannot reach this database. Then it checks that the instance user reaches its database by peer, and that the three extensions the seed needs (`btree_gin`, `pg_trgm`, `unaccent`) are available. With `--db-mode existing` it does nothing; the engine step probes your database with the password you gave.

- **Verify:** `sudo -u <service user> psql -h /var/run/postgresql -d dedalo_<i> -c 'SELECT current_user'` prints the service user with no password asked; `sudo -u postgres psql -Atc "SELECT has_database_privilege('public', 'dedalo_<i>', 'CONNECT')"` prints `f`.
- **Repair:** a cluster whose `pg_hba.conf` refuses local peer connections is reported, not edited — `pg_hba.conf` is global configuration. Allow `local all all peer` (the distribution default), reload PostgreSQL, then `--resume`. `--abort` drops only a role and database this install created, only when the database is empty, and only with `--confirm-database`.

### `host_engine` — the engine steps, as the instance user

By hand: [Install by hand › `host_engine`](manual_install.md#manual-host_engine).

The engine steps — the database seed, the ontologies, the thesauri, the root password, the tool registration — run in **one child process, as the instance user**, in the instance's own tree:

```shell
runuser -u <service user> -g <service group> -- /usr/bin/env HOME=<install folder> /opt/dedalo/bun/<pin>/bun run scripts/install.ts --request-stdin --execute --events-jsonl
```

The answers and the secrets travel as one JSON object on its standard input — never on a command line, never in a file. The child keeps its own record in `<dir>/private/install/` and writes `<dir>/private/.env`. What each engine step does is in the [installer reference](installer_reference.md#what-the-installer-does-in-order).

- **Verify:** `sudo runuser -u <service user> -- sh -c 'cd <dir>/dedalo && HOME=<dir> exec /opt/dedalo/bun/<pin>/bun run scripts/install.ts --status --json'` prints `"outcome":"complete"` (the installer's own form: `HOME` set to the install folder, so Bun keeps no cache in another home). The `cd` runs as the service user, inside the command: the install folder is `0750`, so your own shell cannot enter it.
- **Repair:** `--resume` resumes the child too. `--abort` runs the child's own `--abort` first, which resets the database to empty — and refuses a completed (sealed) install.

### `host_units` — the systemd units

By hand: [Install by hand › `host_units`](manual_install.md#manual-host_units).

Writes the shared template units from `deploy/systemd/` into `/etc/systemd/system/` (one copy per host), and this instance's drop-ins (`/etc/systemd/system/<unit>@<i>.service.d/10-dedalo-install.conf`: the service user and group, the working directory and `HOME` in the install folder, the `.env`, the pinned runtime, the client publish directory, the backup store lines, and the rollback and watchdog paths). The templates name no user and no path of an instance: a template without its drop-in runs `/bin/false`, never anything as root. Then `systemctl daemon-reload` and `systemctl enable dedalo-ts@<i>` — **not** started, and with **no** watchdog or backup timer yet. A template that already exists with other contents is refused, never overwritten.

| Unit | What it does |
| --- | --- |
| `dedalo-ts@<i>.service` | the server: `RuntimeDirectory=dedalo-<i>`, `UMask=0007`, `Restart=always`, `SuccessExitStatus=75`, `RestartPreventExitStatus=78`, `Environment="DEDALO_SUPERVISED=true"` |
| `dedalo-ts-watchdog@<i>.timer` + `.service` | every 30 s, `/health` over the socket; on failure it restarts the server, or rolls back a code update that has not been confirmed yet |
| `dedalo-ts-restart@<i>.service` | the restart helper the watchdog fires |
| `dedalo-ts-rollback@<i>.service` | rolls a failed code update back to the previous tree; does nothing when no update is pending |
| `dedalo-backup@<i>.service` + `.timer` | the nightly backup set, run as the instance |
| `dedalo-backup-site-builder@<i>.service` | the site-builder store, run as root in its own unit (only with `--backup-site-builder`) |
| `dedalo-backup-alert@<i>.service` | reports a failed backup |
| `dedalo-tls-renew@<i>.timer` + `.service` | local CA only: renews the site certificate from the same authority (written here, enabled by `host_tls`) |

Why both `Restart=always` and the watchdog: the server reads its configuration **once**, at boot, so a configuration change needs a restart, and any crash must bring the process back — `Restart=always` does that. The watchdog catches a different class: *process alive, service dead* (database down, pool wedged), which `Restart=always` cannot see. systemd's own `WatchdogSec` needs `sd_notify`, which the runtime does not speak, so the timer stands in.

The unit declares `DEDALO_SUPERVISED=true` — [why that is mandatory](#mandatory-a-supervisor-that-declares-itself).

- **Verify:** `systemctl cat dedalo-ts@<i>` shows the template and the drop-in; `systemctl is-enabled dedalo-ts@<i>` is `enabled`.
- **Repair:** `--resume`. `--abort` removes the drop-ins, and the templates when no other instance uses them.

### `host_selinux` — SELinux on the RHEL family

By hand: [Install by hand › `host_selinux`](manual_install.md#manual-host_selinux).

Runs only on the RHEL family with SELinux enforcing or permissive; elsewhere it does nothing. It labels what the web server reads or connects to, and the install folder's own subtrees:

| Path | Type |
| --- | --- |
| the socket's directory (`/run/dedalo-<i>(/.*)?` on RHEL 10, from `--socket`) | `httpd_var_run_t` |
| `/srv/dedalo/<i>(/.*)?` (media and the published client), and `MEDIA_PATH`'s web root when it lies elsewhere | `httpd_sys_content_t` |
| `/var/lib/dedalo-install/acme/<i>(/.*)?` (the Let's Encrypt challenge root) | `httpd_sys_content_t` |
| `<dir>/dedalo(/.*)?`, `<dir>/private(/.*)?`, `<dir>/backups(/.*)?`, and the folder itself when the installer created it | `var_lib_t` |
| the backup directory, when it lies outside the install folder | `var_lib_t` |

The socket's rule is written in the spelling the host's policy accepts. The policy's path equivalences (`/etc/selinux/targeted/contexts/files/file_contexts.subs_dist`) map `/var/run` onto `/run` on RHEL 10, and `semanage fcontext -a` refuses a rule on the other side (`conflicts with equivalency rule '/var/run /run'`).

`var_lib_t` lets systemd enter the working directory and read the `.env` wherever the folder is, while the web server is denied it. The specs escape the path (`/home/my_domain\.org/dedalo/private(/.*)?`), and the subtrees are relabelled **as the service user**. A folder the installer did not create, its parent and the account's other files (`~/.ssh`) are never relabelled.

It then loads one host-wide policy module, `dedalo_engine` (`deploy/selinux/dedalo_engine.cil.tpl`), at priority 400. The module gives the engine **its own domain**: systemd starts the pinned runtime (labelled `dedalo_engine_exec_t`) into `dedalo_engine_t`, and the web server may connect to the unix sockets of that domain **only**. A rule naming the generic service domain would let the web server reach every other unconfined service's socket on the host. After loading the module it relabels the runtime (`restorecon -F`). No SELinux boolean is changed.

- **Verify:** `sudo semodule -l | grep dedalo_engine`; `stat -c %C /opt/dedalo/bun/<pin>/bun` contains `dedalo_engine_exec_t`; `sudo ls -Zd /srv/dedalo/<i> <dir>/dedalo <dir>/private`; `sudo semanage fcontext -l -C`.
- **Repair:** `--resume`. A module named `dedalo_engine` that this installer did not write is refused, not replaced. `--abort` removes the contexts this install added — only those the host defines (`semanage fcontext -l -C`); a rule you defined for the same path before the install is kept — and the module when no other instance uses it.

### `host_first_boot` — the first start

By hand: [Install by hand › `host_first_boot`](manual_install.md#manual-host_first_boot).

Starts `dedalo-ts@<i>` and waits, with progress, for `/health` on the socket to answer `200` **and** for every database migration to be recorded. Under SELinux it also reads the running engine's domain and refuses a first boot whose engine is not in `dedalo_engine_t` (it would answer on its socket, but never through the site).

- **Verify:**

    ```shell
    systemctl status dedalo-ts@<i> --no-pager      # active (running), not activating (auto-restart)
    sudo ls -l /run/dedalo-<i>/dedalo_ts.sock     # srw-rw-rw- <service user> <service group>
    ls -ld /run/dedalo-<i>                        # drwxr-x--- <service user> <service group> — what guards the socket
    sudo curl --fail --unix-socket /run/dedalo-<i>/dedalo_ts.sock http://localhost/health
    # {"result":"ok","entity":"<entity>","db":"ok",…}
    ```

    The socket's directory is `0750`, so only root, the service user and its group reach it: hence `sudo`.

- **Repair:** read `journalctl -u dedalo-ts@<i> -n 50`, fix the cause, then `--resume`. `--abort` stops the unit.

### `host_watchdog` — arm the watchdog

By hand: [Install by hand › `host_watchdog`](manual_install.md#manual-host_watchdog).

Enables `dedalo-ts-watchdog@<i>.timer`, and only now: a watchdog armed before the first boot completed would kill it mid-migration.

- **Verify:** `systemctl is-active dedalo-ts-watchdog@<i>.timer` is `active`.
- **Repair:** `--resume`. `--abort` disarms it.

### `host_web_http` — the plain-HTTP site (Let's Encrypt only)

By hand: [Install by hand › `host_web_http`](manual_install.md#manual-host_web_http).

Writes the first stage of the site file: a plain-HTTP server with the Let's Encrypt challenge root (`/var/lib/dedalo-install/acme/<i>/`) and the redirect to HTTPS, so the certificate authority can prove the address before any certificate exists. The web server's user joins the service group (`ded_<i>` by default; it reaches the socket and reads media and client through that group). On Apache it **checks** the modules the site needs (`ssl headers http2 rewrite proxy proxy_http`) and, when one is missing, stops with the exact command to enable it; it never enables a module itself. The configuration is tested before the reload, and a reload applies every pending change of the web server's configuration, which the Review says next to the command.

- **Verify:** `curl -I http://<address>/` answers with a redirect to `https://`.
- **Repair:** for the Apache modules, run the command the message prints (`a2enmod … && systemctl restart apache2` on Debian and Ubuntu — a restart, as `a2enmod` itself advises: loading a module is a process change, and a reload would also apply every other pending change), then `--resume`. `--abort` removes the site file.

### `host_tls` — the certificate

By hand: [Install by hand › `host_tls`](manual_install.md#manual-host_tls).

- **Let's Encrypt:** `certbot certonly --webroot` against the challenge root, as the certificate `dedalo-<i>`, with a deploy hook that reloads the web server, and the distribution's renewal timer enabled (`certbot.timer`; `certbot-renew.timer` on the RHEL family). `--letsencrypt-staging` (headless only) uses the staging authority: the install completes with a certificate browsers do not trust, and the closing *To do on this host* list prints the `certbot` command that replaces it with a real one.
- **Your institution's files:** checked again (the address, the expiry, the key, and that this server trusts the chain) and used where they are.
- **Local CA:** `/opt/dedalo/instances/<i>/bin/dedalo-tls-rotate.sh --mode local-ca --host <address> [--host <other address> …] --dir /opt/dedalo/instances/<i>/tls --no-reload` — the same script the docker route and every rotation use. In `/opt/dedalo/instances/<i>/tls/` (root's; the keys `0600`, labelled `cert_t` on the RHEL family) it writes the authority staff computers trust (`dedalo-local-ca.pem`), the issuing authority whose key signs renewals, and the site certificate (`fullchain.pem` + `privkey.pem`, valid 397 days). The authority is restricted to the addresses it was made for; the key of the authority itself is deleted once it has signed. Then it writes the drop-in of `dedalo-tls-renew@<i>.service` and enables `dedalo-tls-renew@<i>.timer`: once a day the script checks the certificate and, in its last 30 days, re-issues it from the same authority and reloads the web server (`systemctl reload nginx`, `apache2` or `httpd`). A directory that already holds an authority for these addresses is used as it is (no new authority to trust); one made for other addresses is refused on the System check.

On the RHEL family the web server must be able to read your certificate files: keep them under `/etc/pki/tls` or label them `cert_t`.

- **Verify (Let's Encrypt):** `certbot certificates --cert-name dedalo-<i>`; `systemctl is-enabled certbot.timer`.
- **Verify (local CA):** `openssl verify -CAfile /opt/dedalo/instances/<i>/tls/dedalo-local-ca.pem -untrusted /opt/dedalo/instances/<i>/tls/dedalo-issuing-ca.pem /opt/dedalo/instances/<i>/tls/fullchain.pem` prints `OK`; `systemctl list-timers 'dedalo-tls-renew@*'`; a renewal now, to see it work: `systemctl start dedalo-tls-renew@<i>` (it does nothing until the last 30 days) and `journalctl -u dedalo-tls-renew@<i>`.
- **Verify (your files):** `openssl x509 -noout -subject -enddate -in <fullchain>` names the address and a date ahead; `openssl s_client -connect <address>:443 -servername <address> </dev/null | grep 'Verify return code'` prints `0 (ok)` once the site is up.
- **Repair:** a failed Let's Encrypt request is almost always DNS or port 80 — see [Troubleshooting › Let's Encrypt](troubleshooting.md#lets-encrypt-fails). Then `--resume`. `--abort` deletes only a certificate this install issued; for a local CA, it disables the renewal timer, removes its drop-in and deletes the certificate directory when this install created it (remove the authority from the staff computers too).

### `host_web_site` — the full site

By hand: [Install by hand › `host_web_site`](manual_install.md#manual-host_web_site).

Writes the full site file — HTTPS, the API routes to the socket, the published client, the media gate — tests the configuration and reloads. A failed test puts the files back as they were, so the web server is never left with a configuration it would refuse. What the file contains, and why, is in [The web server site](reverse_proxy.md).

| Web server | Site file |
| --- | --- |
| nginx | `/etc/nginx/conf.d/dedalo-<i>.conf` |
| Apache (Debian, Ubuntu) | `/etc/apache2/sites-available/dedalo-<i>.conf`, enabled with `a2ensite` |
| Apache (RHEL family) | `/etc/httpd/conf.d/dedalo-<i>.conf` |

On nginx the media rules the engine generates are not included from the media tree: they are copied, validated, into the root-owned `/etc/nginx/dedalo/<i>/`, and one host-wide file, `/etc/nginx/conf.d/dedalo-00-media-map.conf`, includes the media map.

On nginx, the first instance on ports 80 and 443 also writes the host-wide [catch-all site](reverse_proxy.md#the-catch-all-site), `/etc/nginx/conf.d/dedalo-00-default.conf`. It answers every name no site declares, so `https://<another name of this server>/` never reaches an instance. It is the default by order, never with `default_server`, so a `default_server` of yours (Debian's own `default` site on port 80) stays the default for its port. Later instances use it as it is, except one that claims an IP address, which rewrites it with its claim ([Reaching an instance by IP address](reverse_proxy.md#reaching-an-instance-by-ip-address)); `--abort` removes it with the last instance. On Apache, each site's virtual hosts refuse any `Host` but their own with `421` instead.

- **Verify:** `sudo nginx -t` (or `sudo apachectl -t`); `curl --fail https://<address>/health`; `curl -sk -o /dev/null -w '%{http_code}' --resolve other.invalid:443:127.0.0.1 https://other.invalid/` does not answer `200` (nginx refuses the handshake, Apache answers `421`).
- **Repair:** `--resume`. `--abort` removes the site file, the rule copies and the web user's group membership.

### `host_public_probe` — the instance through its public address

By hand: [Install by hand › `host_public_probe`](manual_install.md#manual-host_public_probe).

Checks from the host what an outside browser gets: `/health` answers `200` over HTTPS with a verified certificate chain, and, with the media gate on, the marker store `/dedalo/media/.publication/auth/` and an unpublished probe file both answer `404` to an anonymous request. It connects to `127.0.0.1` with the server name, so split-horizon DNS or a router without hairpin NAT cannot fail a correct install. It retries every 2 s for up to 90 s while the reload settles.

- **Verify:** from another machine, `curl --fail https://<address>/health` and `curl -I https://<address>/dedalo/media/.publication/auth/` (`404`).
- **Repair:** see [Troubleshooting › The public probe fails](troubleshooting.md#the-public-probe-fails). It changes nothing, so it has no undo.

### `host_backup_verify` — the first backup, verified

By hand: [Install by hand › `host_backup_verify`](manual_install.md#manual-host_backup_verify).

Runs the backup set once (`systemctl start --wait dedalo-backup@<i>`) and verifies the **outcome**: a `LAST_OK` marker written by this run listing every expected store with exit `0`, no `BACKUP_FAILED` marker, and the unit's effective environment carrying the full expected store list. With `--backup-site-builder`, the root-run site-builder unit is run and verified the same way. Only then does it enable the nightly `dedalo-backup@<i>.timer`.

- **Verify:** `systemctl list-timers 'dedalo-backup@*'`; `cat <backup dir>/state/LAST_OK`.
- **Repair:** read `journalctl -u dedalo-backup@<i>`, fix the store that failed, then `--resume`. `--abort` disables the timer and keeps the backups.

## Done

The Done screen shows the generated `DEDALO_SALT_STRING` **once** — keep it with your backups — and what comes next. A `--resume` that completes the install shows it too, when no earlier run did. Every run that completes the install, whichever run showed the salt, lists under *To do on this host* the command that reads it back: `sudo grep ^DEDALO_SALT_STRING= <install folder>/private/.env`. A run that stops after the engine steps generated the salt — a failure, or a Ctrl-C that leaves the full screen without its card — names the same command in its ✖ block. The instance is running under systemd and starts at boot; the watchdog and the nightly backup are armed.

With a **local CA**, the *To do on this host* list names the authority's file, `/opt/dedalo/instances/<i>/tls/dedalo-local-ca.pem`, and its SHA-256 fingerprint. Copy the file to each computer that uses Dédalo, check the fingerprint there, and trust it once:

| System | How |
| --- | --- |
| Windows | save it as `dedalo-local-ca.crt` (Windows opens `.crt` files as certificates, not `.pem` files), double-click it → *Install Certificate* → *Local Machine* → *Trusted Root Certification Authorities*; or, as Administrator, `certutil -addstore -f Root dedalo-local-ca.pem` |
| macOS | open it in *Keychain Access*, *System* keychain → *Always Trust* |
| Debian, Ubuntu | copy it to `/usr/local/share/ca-certificates/dedalo-local-ca.crt`, then `sudo update-ca-certificates` |
| Fedora, RHEL family | copy it to `/etc/pki/ca-trust/source/anchors/`, then `sudo update-ca-trust` |
| Firefox (its own store, every system) | *Settings* → *Privacy & Security* → *Certificates* → *View Certificates* → *Authorities* → *Import*, then tick *Trust this CA to identify websites* (it is off by default) |

Check from a staff computer: `curl --cacert dedalo-local-ca.pem https://<address>/health` answers `200`. The certificate renews itself; the authority lasts ten years. To replace it (a compromised server, an authority near its end), rotate it with the same script, as root: `/opt/dedalo/instances/<i>/bin/dedalo-tls-rotate.sh --mode local-ca --dir /opt/dedalo/instances/<i>/tls --reload systemd --unit <nginx|apache2|httpd> --host <address> [--host …]` — then each staff computer trusts the new authority and deletes the old one. Give exactly the addresses in `/opt/dedalo/instances/<i>/tls/dedalo-local-ca.names`, in its order (the address first): an address left out is no longer certified, and a `--resume` refuses an authority whose list differs from the install's. On nginx, an instance that claims an IP address keeps its site key readable by the web server's group through the rotation: the script reads the group from `tls/dedalo-key-group` ([Reaching an instance by IP address](reverse_proxy.md#reaching-an-instance-by-ip-address)).

A rotation does not add an address. The web site answers only to the addresses it was installed with (its site file names them; another name meets the host's catch-all, or Apache's `421`), and an installed instance cannot change its addresses yet — the installer does not run over a completed install. Choose every address staff will type before you install.

Open `https://<address>/dedalo/core/page/` and log in as **`root`**. Then follow [After the install](index.md#after-the-install): an admin user, users and projects, the thesauri and toponymies you need (from Maintenance), and a restore test of the backups.

```shell
systemctl status dedalo-ts@<i>
journalctl -u dedalo-ts@<i> -f
```

## After the install

### Tuning `.env`

The installer wrote `<dir>/private/.env` (the keys are [listed in the reference](installer_reference.md#what-privateenv-does-and-does-not-get)). The instance is fully configured to boot; the operational tuning is yours. Edit the file as the instance user, then `systemctl restart dedalo-ts@<i>` — configuration is read once, at boot.

!!! danger "`.env` is append-only, documented keys only"
    Add a line for a new key, or change a value on its existing line — never a second line for a key that is already there, and never delete one. Every key is documented in the [configuration reference](../config/index.md).

```dotenv
# --- Serving ---
SERVER_IDLE_TIMEOUT_S=255        # runtime max; the web server's read timeout must be >= this
TRUSTED_PROXY_HOPS=1             # count of proxies that append X-Forwarded-For

# --- Database pool (per process) ---
DB_POOL_MAX=10                   # budget the SUM across processes against max_connections
DB_STATEMENT_TIMEOUT_MS=60000    # 0 (off) by default — caps one runaway query

# --- Observability ---
DEDALO_ACCESS_LOG=true
DEDALO_SLOW_REQUEST_MS=5000
```

`DB_POOL_MAX` deserves a second look on a busy host: the server, each diffusion runner and the RAG drain all draw from PostgreSQL's `max_connections`, and so does every other instance on the host.

### Changing the media access mode

Set `DEDALO_MEDIA_ACCESS_MODE` in `.env` and restart the engine, which regenerates the rule files in `MEDIA_PATH`. On nginx, refresh the validated copies the site includes (the installer prints this command on Done):

```shell
sudo /opt/dedalo/instances/<i>/bin/dedalo-media-rules.sh --source /srv/dedalo/<i>/dedalo/media \
  --dest /etc/nginx/dedalo/<i> --reload /usr/sbin/nginx nginx
```

A copy that fails the nginx configuration test is put back. Apache reads the generated `.htaccess` on every request and needs nothing.

### Adding a domain ontology later

The installation carries the core ontologies and the domain ontologies you chose. To add one later (for example `tch`):

1. In *Maintenance › Update ontology*, put its code **and the codes of the ontologies it requires** in the list and import them. The panel imports exactly the codes in the list. *Fetch list* shows what the master declares.
2. Add the same codes to `ACTIVE_ONTOLOGY_TLDS` in `.env` — inside the JSON list on its existing line — so every later update refreshes them.
3. Restart the server.

See [Updating ontology](../management/updates/updating_ontology.md#which-tlds-are-updated).

### Optional subsystems

All four are **off by default**.

**Diffusion (publication)** publishes records to a MariaDB target database for a public website. The installer writes its keys when you fill in the *Publication* screen (`--diffusion --mysql-*`), but no code creates the target database:

```sql
CREATE DATABASE web_prado CHARACTER SET utf8mb4;
GRANT ALL ON web_prado.* TO 'dedalo_pub'@'localhost';
```

A missing or ungranted target database is a loud configuration error, not something the engine papers over. Details: [the diffusion engine](../diffusion/native_engine.md).

**RAG (semantic search)** needs a pgvector database whose base schema you apply by hand from the [RAG cookbook](../core/ai/rag_cookbook.md); once it exists, the per-model partitions and the index queue are created automatically. Then set `DEDALO_RAG_ENABLED=true` and `DEDALO_RAG_DB_NAME`.

**The AI assistant** is disabled unless a model is configured — see [assistant install](../core/ai/assistant/install.md).

**H.264 real-time clipping** needs a web-server module — see [H.264 streaming module](install_h264_module.md).

## Verify, then harden

Walk the whole path once, in order. Each line is a real failure mode if it does not pass.

- [ ] `sudo curl --fail --unix-socket /run/dedalo-<i>/dedalo_ts.sock http://localhost/health` → `200` with `"db":"ok"`.
- [ ] `curl --fail https://<address>/health` → the same `200`, **through the web server**.
- [ ] `https://<address>/dedalo/core/page/` serves the login form over TLS.
- [ ] Log in as the admin user. The menu renders.
- [ ] Create a record in a section, save it, reload — the value persists.
- [ ] Upload an image. The **derivative and the thumbnail** appear (ImageMagick resolved, the media root is writable).
- [ ] Search for the record you created.
- [ ] `GET /api/v1/counters` as a global admin returns request, pool, queue and memory counters. Anyone else gets a `404`, which is correct.
- [ ] `systemctl reboot`, then repeat the health checks. The service, the socket and the site must all come back on their own.

These are the installed defaults. Check that nothing has changed them, because each is a real hole:

| Setting | Production value | Why |
| --- | --- | --- |
| `SERVER_TCP_PORT` | **unset** | the TCP listener is a development convenience; production is socket-only |
| `DEDALO_DEV_MODE` | `false` | dev mode exposes the browser test harness and unminified client libraries |
| `DEDALO_DEBUG_API_ERRORS` | `false` | otherwise exception text is echoed to the client |
| `MEDIA_DEV_ROUTE_ENABLED` | **unset** | setting it to `true` forces the engine's development media route on for every listener, the socket included — serving media with **no per-record access control** |
| `SESSION_COOKIE_SECURE` | `true` (the default) | requires TLS — a browser drops a `Secure` cookie over plain HTTP |
| `<dir>/private/.env` | `0600`, owned by the service user | it holds every secret |
| `<dir>/private/` | `0700` | it holds the session store and the media-auth store |
| `<dir>/` | owned by the service user, not writable by group or others | an in-app code update renames the release tree inside it; its parent is never the install's |
| `/opt/dedalo` and everything under it | owned by root | a root-run unit must never execute a file the instance can replace |

!!! note "There is no install surface to close"
    The install **seals** the instance. No install page or install API exists: a server whose instance is not installed (or whose `.env` is gone, or whose install did not finish) refuses to start with exit code `78` and one `[boot] REFUSED — …` line, and the unit does not restart it. See [the installer reference](installer_reference.md#a-server-that-is-not-installed-refuses-to-start).

## What the installer does not do after the install

The installer installs; it does not maintain. It refuses to run over a sealed instance, and `--abort` never takes apart an instance that has served. An instance counts as served once its unit has run: `host_first_boot` started it, or `--abort` measures that systemd ever ran the unit or that the engine answers on its socket. An interruption that stopped the start before the unit ran, even inside that step, is not a served instance. After that, `--abort` undoes only the host steps after `host_engine`, and `--resume` puts them back. Before that, `--abort` removes the instance completely, even when its engine install finished. Three things are therefore manual today, with no installer support:

- **The root-run scripts** in `/opt/dedalo/instances/<i>/bin/` are not refreshed by an in-app code update, which runs as the instance. When a release changes a script under `deploy/`, its release notes say so.
- **A new Bun pin.** The code update panel refuses a release whose `.bun-version` differs from the running runtime, and the runtime is root-owned at `/opt/dedalo/bun/<pin>/`.
- **Removing an instance that has served.** No command removes it. [Removing an instance](multi_instance.md#removing-an-instance) lists what to remove by hand.

See [Upgrading](upgrading.md) for what the in-app code update does cover.

## Trying the production route in a virtual machine {#vm-test}

To rehearse a production install, or to test the route while working on Dédalo, on a virtual machine that has no domain name, choose the **Local CA** certificate. Let's Encrypt needs a public name and port 80 open to the internet; a local certificate authority needs nothing outside the machine and the computer you browse from.

1. **The machine.** A virtual machine running a [supported system](index.md#supported-systems), with internet access (the packages and the release are downloaded) and an address your computer can reach: a *bridged* or *host-only* network adapter, not NAT alone. `ip -4 addr` on the machine prints its address. Take a snapshot before the install: `--abort` never takes apart an instance that has served, so going back to the snapshot is the clean way to start again.
2. **A name.** Choose one under `.test`, which is reserved for testing and never exists in public DNS, for example `dedalo-vm.test`. Avoid `.local`: macOS and most Linux desktops resolve it through multicast DNS, not through the hosts file. The machine itself needs no DNS for the name: the installer's own checks connect to it directly.
3. **The install**, on the machine, from the release ([Get Dédalo](index.md#get-dedalo)). On the screens, choose **Local CA** on *Web server & TLS*; headless:

    ```shell
    read -rsp 'New root password: ' DEDALO_INSTALL_ROOT_PASSWORD; echo; export DEDALO_INSTALL_ROOT_PASSWORD
    sudo --preserve-env=DEDALO_INSTALL_ROOT_PASSWORD sh install.sh -- \
      --route production --instance vmtest --entity vmtest \
      --server-name dedalo-vm.test --tls local_ca --execute
    unset DEDALO_INSTALL_ROOT_PASSWORD
    ```

    The Done screen prints the authority's file, `/opt/dedalo/instances/vmtest/tls/dedalo-local-ca.pem`, and its SHA-256 fingerprint.
4. **Your computer finds the name.** Add one line, `<the machine's address> dedalo-vm.test`, to its hosts file: `/etc/hosts` on macOS and Linux (with `sudo`), `C:\Windows\System32\drivers\etc\hosts` on Windows (as Administrator).
5. **Your computer trusts the authority.** Copy the file from the machine, compare the fingerprint with the one the Done screen printed, and check the site with `curl` before you trust anything:

    ```shell
    scp <user>@<the machine's address>:/opt/dedalo/instances/vmtest/tls/dedalo-local-ca.pem .
    openssl x509 -in dedalo-local-ca.pem -noout -fingerprint -sha256
    curl --cacert dedalo-local-ca.pem https://dedalo-vm.test/health
    ```

    Then trust it as in the table under [Done](#done). For a test, Firefox in a profile of its own keeps the authority out of your everyday browser and system: `firefox -CreateProfile dedalo-vm`, then `firefox -P dedalo-vm` and import it there. The authority can certify exactly `dedalo-vm.test`, `localhost` and `127.0.0.1` (and the machine's address, if you listed it below), but remove it from wherever you added it when the machine is gone. Its subject, `Dedalo local CA <stamp>`, tells it apart from any other.
6. Open `https://dedalo-vm.test/dedalo/core/page/` and log in as **`root`**.

**By its IP address instead.** To skip the hosts file, add the machine's address to **Other addresses** in step 3 (`--tls-extra-names 192.168.64.5`, the address `ip -4 addr` printed — it must be one of the machine's own). The instance claims it in the host's [catch-all](reverse_proxy.md#reaching-an-instance-by-ip-address), so `curl --cacert dedalo-local-ca.pem https://192.168.64.5/health` answers `200` and `https://192.168.64.5/dedalo/core/page/` opens the login page, with no step 4. The name stays the instance's address: the installer's checks and the certificate still use it. A bridged adapter's address can change when the machine restarts (DHCP); give the machine a fixed address first, because an installed instance cannot change its addresses.

The certificate renews itself on the machine, as on a real server. Every install makes a new authority: after going back to the snapshot and installing again, trust the new one and remove the old.
