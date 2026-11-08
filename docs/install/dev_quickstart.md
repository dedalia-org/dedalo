# Developer quickstart

> See also: [Installation hub](index.md) · [Installer reference](installer_reference.md) · [Troubleshooting](troubleshooting.md) · [Production install](production.md)

A working Dédalo on your laptop in about ten minutes. This is a **development** setup: a TCP listener on this machine (HTTPS from a local certificate authority, or plain HTTP if you choose), no reverse proxy, no systemd — `bun run dev` is its own restart loop (it declares `DEDALO_SUPERVISED=true`). Do not run it this way on a server — for that, see [production](production.md).

## 1. What you need

| | macOS (Homebrew) | Ubuntu 26.04 / Debian 13 | RHEL / Rocky / Alma 10 |
| --- | --- | --- | --- |
| Base tools | `brew install git` (curl and unzip ship with macOS) | `sudo apt install git curl unzip` | `sudo dnf install git curl unzip` |
| PostgreSQL 18 + `psql` | `brew install postgresql@18` | `sudo apt install postgresql-18 postgresql-client-18 postgresql-contrib` | `sudo dnf install postgresql18-server postgresql18 postgresql18-contrib` |
| pgvector (for `test:db:setup`) | `brew install pgvector` | `sudo apt install postgresql-18-pgvector` | `sudo dnf install pgvector_18` |
| Media tools | `brew install ffmpeg imagemagick poppler ocrmypdf librsvg` | `sudo apt install ffmpeg imagemagick poppler-utils ocrmypdf librsvg2-bin` | `sudo dnf install ffmpeg ImageMagick poppler-utils librsvg2-tools` |
| MariaDB (for the test suite) | `brew install mariadb` | `sudo apt install mariadb-server` | `sudo dnf install mariadb-server` |

Bun comes in step 3, inside the checkout, because the version it installs is the one the checkout pins.

!!! note "Debian has no `sudo` by default"
    A Debian 13 installed with a root password has no `sudo`, and every command on this page assumes it (the installer also uses it once, to trust its certificate authority). As root, add it and put your account in the `sudo` group, then log out and in again:

    ```shell
    su -
    apt install sudo
    usermod -aG sudo <your user>
    ```

Debian 13 and RHEL-family 10 do not ship PostgreSQL 18 themselves, and RHEL-family 10 needs extra repositories for FFmpeg and ImageMagick. Add them first, exactly as the [manual install](manual_install.md) does: the PostgreSQL project's repository (PGDG) on Debian, and EPEL, CodeReady Builder, RPM Fusion free and PGDG on RHEL, Rocky and Alma. On Debian, PGDG's own setup script adds it:

```shell
sudo apt install postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt update
```

The same script adds PGDG on an Ubuntu older than 26.04 — Ubuntu 24.04 ships PostgreSQL 16, so `apt install postgresql-18` fails there with *Unable to locate package*. A development checkout runs on it; the production route does not (it installs on the newest releases only).

On RHEL-family, PGDG's server also needs its data directory created and the service started:

```shell
sudo /usr/pgsql-18/bin/postgresql-18-setup initdb
sudo systemctl enable --now postgresql-18
```

MariaDB is not needed by a development install. The test suite starts its own private MariaDB server from these binaries, and without them the publication tests fail rather than skip (see step 8).

!!! note "macOS binary base"
    Media binaries are looked up under `/opt/homebrew/bin` on macOS and `/usr/bin` on Linux, automatically. Override the base with `DEDALO_BINARY_BASE`, or any single binary with its own key (`DEDALO_AV_FFMPEG_PATH`, `DEDALO_MAGICK_PATH`, …). On an Intel Mac, Homebrew installs to `/usr/local/bin` — set `DEDALO_BINARY_BASE=/usr/local/bin`.

!!! note "Several PostgreSQL versions installed?"
    `psql` must not be older than the server. A version-suffixed Homebrew install is detected automatically, newest first. If you have a stranger layout, point at it explicitly with `DEDALO_PG_BIN_PATH=/opt/homebrew/opt/postgresql@18/bin`.

## 2. Clone the Dédalo code

Clone into a directory of its own: the installer puts the private directory **next to** the checkout, so give both a common parent.

```shell
mkdir -p ~/dev/dedalo
git clone https://github.com/dedalia-org/dedalo.git ~/dev/dedalo/master_dedalo
cd ~/dev/dedalo/master_dedalo
```

The clone is on `master`, the development branch. To work on a published release instead, check out its tag:

```shell
git tag --list 'v7.*'        # the releases
git checkout v<version>      # for example: git checkout v7.0.0-beta.6
```

The resulting layout:

```text
~/dev/dedalo/
├── master_dedalo/    # the checkout: code, client, install seed, .bun-version
└── private/          # created by the installer in step 5: .env, media, certificates
```

!!! note "The private directory is a sibling of the repo"
    The installer will create `~/dev/dedalo/private/` — one level **above** the repo. Make sure that directory is writable (it will be, if you cloned into a directory you own).

## 3. Install Bun (the Dédalo engine)

Bun runs the Dédalo server, the installer and the tests. Install the exact version the checkout pins in `.bun-version` — **from inside the checkout**:

```shell
cd ~/dev/dedalo/master_dedalo
cat .bun-version                                                         # the pinned version
curl -fsSL https://bun.sh/install | bash -s "bun-v$(cat .bun-version)"   # installs it into ~/.bun
exec "$SHELL" -l                                                         # puts ~/.bun/bin on your PATH
```

The Bun line reads `.bun-version` from the current directory. Run elsewhere, the version is empty and the download fails.

Check that the Bun on your `PATH` is the pinned one:

```shell
which bun                  # ~/.bun/bin/bun
bun --version              # must print the same version as .bun-version
[ "$(bun --version)" = "$(cat .bun-version)" ] && echo "Bun OK" || echo "Bun version mismatch"
```

`which bun` naming another path (Homebrew's `/opt/homebrew/bin/bun`, for example) means an older Bun shadows this one: remove it, or put `~/.bun/bin` first in your `PATH`. When a later `git pull` changes `.bun-version`, run the same `curl` line again: it replaces the installed Bun with the new pin.

Then the checkout's dependencies:

```shell
bun install                # required: the installer refuses to start without them
```

That is the whole setup. The browser libraries the client loads ship **with the repo** — from `node_modules/` or from the committed `vendor/` tree. Nothing is fetched or copied at install time.

## 4. Create an empty database

On **macOS**, Homebrew's PostgreSQL already has a superuser named after you:

```shell
createdb dedalo_dev
```

On **Linux**, the server has only the `postgres` role at first, so `createdb` answers `role "<you>" does not exist`. Create a role named after your login once, then the database:

```shell
sudo -u postgres createuser --superuser "$USER"
createdb dedalo_dev
```

Your role connects over the local socket with peer authentication: no password exists, and none is asked. The role is a superuser because the install creates PostgreSQL extensions, and `test:db:setup` builds databases. That is fine on a development machine, never on a server.

If you prefer a role of its own, create it as a superuser and give it the database:

```sql
CREATE ROLE dedalo_user LOGIN SUPERUSER PASSWORD 'dev';
CREATE DATABASE dedalo_dev WITH ENCODING='UTF8' OWNER=dedalo_user;
```

A role with a password connects over TCP (`localhost`), and you give the installer that password.

The installer restores **into** this database and refuses a non-empty one. It never creates the database itself.

## 5. Run the installer

The Developer route installs into the database you just created and writes `../private/.env`. It runs no host step: no packages, no units, no web site. It installs the checkout's development dependencies, writes the development listener `bun run dev` serves on, issues that listener's certificate and asks this machine to trust it (step 6). Interactively:

```shell
bun run scripts/install.ts            # the full-screen installer: choose Developer on the first screen
bun run scripts/install.ts --plain    # the same questions, one per line
```

`sh install.sh` from the [installation hub](index.md) starts the same installer: it fetches and verifies the pinned Bun itself, installs the installer's dependencies, then runs `scripts/install.ts` with your arguments. In a checkout where Bun is already installed (step 3), `bun run scripts/install.ts` is the shorter way to the same questions.

The *System check* screen shows Bun, the seed, the private directory and the PostgreSQL client (`psql`, required), then this machine's platform, memory, processor, disk, ImageMagick and FFmpeg; a failed row must be fixed first. A `psql` older than the server is reported by the *Database* screen, once the server's version is known. The *Database* screen checks that the database exists, is reachable and is empty.

Or headless, for a repeatable setup — `--route developer` is the default when no route is given:

```shell
DEDALO_INSTALL_ROOT_PASSWORD='dev-root-password' \
bun run scripts/install.ts \
  --route developer \
  --db-name dedalo_dev \
  --db-user "$(whoami)" \
  --db-socket /var/run/postgresql \
  --entity dev \
  --langs lg-eng,lg-spa --app-lang lg-eng --data-lang lg-eng
```

Add `--write-answers ~/dedalo-dev.answers.json` once and the next fresh install is `bun run scripts/install.ts --answers ~/dedalo-dev.answers.json` (the file holds no secret). `--plan` shows the keys and steps a command would produce without touching anything.

No `--media-path`: the media root defaults to `../private/media` (see step 6). To keep it elsewhere, add `--media-path "$HOME/dev/dedalo/media"`; the installer creates that directory and writes it to `.env` as `MEDIA_PATH`. Setting `MEDIA_PATH=…` in front of the command does not work: the installer would probe that directory, but `.env` would not get it.

`--db-socket` connects over the local unix socket, as the role from step 4 does, so no password is needed. The socket directory depends on how PostgreSQL was installed:

| PostgreSQL from | `--db-socket` |
| --- | --- |
| Ubuntu, Debian, PGDG on RHEL / Rocky / Alma | `/var/run/postgresql` |
| Homebrew (macOS) | `/tmp` |

The installer writes it to `.env` as `DB_SOCKET`; the engine and the test suite both connect through it. Without `--db-socket`, the installer connects to `localhost` over TCP, which needs a role with a password (step 4).

With no `--hierarchies`, only the thesauri the chosen ontologies declare are installed — no country's toponymy is ever pre-selected; `--hierarchies none` skips even those. The Languages thesaurus is activated with the database either way. With no `--ontologies`, the default domain ontology, Oral history (`oh`), is installed from the copy built into the repo — no network needed; `--ontologies oh,tch` downloads `tch` and what it declares from the update server. The `.env` it writes points `ONTOLOGY_SERVERS` and `CODE_SERVERS` at the official Dédalo update server (add `--no-update-servers` to leave both empty) and lists the installed ontologies in `ACTIVE_ONTOLOGY_TLDS`.

Its last step proves the install serves before it says so: it starts `bun run dev` once, the way you will, asks the development listener for `/health` (over HTTPS, with the local certificate authority as the only trust anchor), logs in as `root` over it, and stops it again. If that fails, the install is **not** reported complete and the message names the cause: the port taken by another program, a certificate the server cannot read, the database unreachable, a development dependency missing, or another Dédalo server on the same unix socket. Fix it and run `bun run scripts/install.ts --resume`, which runs the check again.

When it passes, the installer ends with what to do next, built from the keys it wrote:

<!-- dev-final-screen -->
```text
✔ install complete — root login verified.

  Start:   bun run dev   (Ctrl-C stops it)
  Open:    https://127.0.0.1:3500/dedalo/core/page/
           https://localhost:3500/dedalo/core/page/
  Log in:  root, with the password set during this install
  TLS:     local certificate authority /home/me/dev/dedalo/private/tls/dedalo-local-ca.pem
           SHA-256 3F:A2:…:9C
           trusted on this machine: the browser opens it without a warning
```

The URLs, the certificate authority's path and its SHA-256 fingerprint are your install's own. Opened to the local network (`--dev-host 0.0.0.0`), the list adds this machine's network addresses. If this machine does not trust the authority yet (you cancelled the password dialog), the last line says so and gives the command that trusts it.

If the install stops part-way, fix the cause and run `bun run scripts/install.ts --resume`; `--abort --confirm-database dedalo_dev` undoes it before the install is sealed ([Resume and abort](installer_reference.md#resuming-an-install-resume)).

## 6. What the installer writes for `bun run dev`

The installer writes a *Development only* section into `../private/.env`. With the defaults — the local certificate authority (`--tls local_ca`) — and with plain HTTP (`--tls none`), it holds:

<!-- dev-env-table -->
| Key | `--tls local_ca` (default) | `--tls none` |
| --- | --- | --- |
| `SERVER_TCP_PORT` | `3500` | `3500` |
| `SERVER_TCP_HOST` | `127.0.0.1` | `127.0.0.1` |
| `SERVER_TCP_TLS_CERT_FILE` | `<private>/tls/fullchain.pem` | not written |
| `SERVER_TCP_TLS_KEY_FILE` | `<private>/tls/privkey.pem` | not written |
| `SESSION_COOKIE_SECURE` | `true` | `false` |
| `DEDALO_DEV_MODE` | `true` | `true` |
| `DEDALO_DEBUG_API_ERRORS` | `true` | `true` |

`<private>` is `../private`, next to the checkout. `--tls files --tls-cert <fullchain> --tls-key <key>` writes your own pair instead (made with mkcert, for example).

- **`SERVER_TCP_PORT`** — the engine always listens on a unix socket; a browser cannot. This opens an extra TCP listener for development. Leave it **unset in production**. `--dev-port` chooses another port. When another program already uses the port, the installer refuses before it writes anything and names the next free one; it never picks a port for you.
- **`SERVER_TCP_HOST`** — `127.0.0.1`: only a browser on this machine reaches a server that shows full error details. `--dev-host 0.0.0.0` opens it to your network on purpose (the Review warns).
- **`SERVER_TCP_TLS_CERT_FILE`**, **`SERVER_TCP_TLS_KEY_FILE`** — the listener's certificate. The installer issues it from a certificate authority it makes in `<private>/tls`, restricted to `localhost`, `127.0.0.1` and the addresses the listener is opened on. It then makes this machine trust that authority: on macOS in your login keychain (macOS asks for your password), on Linux in the system store through `sudo` for that one command. A cancelled prompt does not stop the install; the final screen says *not trusted yet* and how to trust it. `bun run tls:renew` renews the certificate from the same authority, and `bun run tls:untrust` removes the authority from every store the installer put it in.
- **`SESSION_COOKIE_SECURE`** — follows the listener: `true` over HTTPS, `false` over plain HTTP, where a browser drops a `Secure` cookie and every login silently fails.
- **`DEDALO_DEV_MODE=true`** — serves the browser test harness and the dev-only libraries.
- **`DEDALO_DEBUG_API_ERRORS=true`** — echoes exception text to the client instead of only a request id. Very useful locally; a disclosure hole anywhere else.

A re-run of the installer keeps the port, address, certificate pair and modes your `.env` already has, unless you answer them again.

!!! tip "Media works with no configuration"
    Unset, `MEDIA_PATH` **derives** to `../private/media` (`config.media.rootPath`) — outside the code tree, so a code update never carries it away — and the engine serves media itself on the dev listener — session-gated — because there is no web server in front of it here. Set `MEDIA_PATH` only to put the media tree somewhere else. In production media is served by the web server from generated rule files, and the engine's fallback is structurally unreachable (the socket never serves media): see [media protection](../config/media_protection.md).

!!! danger "Edited the `.env` by hand? Keep `SESSION_COOKIE_SECURE` matched to the listener"
    A `Secure` cookie is dropped by the browser over plain `http://`. The login request succeeds, the server sets the cookie, the browser throws it away, and the next request arrives with no session — so you land back on the login form with no error message worth reading. The installer writes the right value; if you switch the listener between HTTPS and plain HTTP by hand, switch this key with it.

    Never set it to `false` anywhere a real user can reach.

!!! note "One download at first boot"
    On its first start the server downloads the free DB-IP country database (from `https://download.db-ip.com`) into `../private/geoip/`. The Activity section uses it to show a country flag beside an IP address, and the server refreshes it monthly. Offline, the server starts anyway and shows no flags. To make no download at all, set `DEDALO_GEOIP_AUTO_UPDATE=false` (or `DEDALO_GEOIP_ENABLED=false`).

## 7. Run it

```shell
bun run dev          # watch mode; `bun run start:supervised` runs it without the watchers
```

`bun run dev` runs two watchers together: the server (reloading on TypeScript changes, and restarting itself if a code update asks for a fresh process) and the stylesheet compiler (recompiling the affected CSS whenever you save a `.less`). Ctrl-C stops both. If you are editing styles, read [Building the CSS](../core/ui/css_architecture.md#building-the-css) first — the compiled `.css` is committed, and it must not be hand-edited.

!!! note "Which scripts are supervised"
    `bun run dev`, `bun run dev:server` and `bun run start:supervised` restart the server when it asks for a fresh process, so each **declares** `DEDALO_SUPERVISED=true` in its own command line. Plain `bun run start` restarts nothing and deliberately declares nothing: the [code update panel](../management/updates/updating_code.md) refuses to swap code under it rather than leave the server dead. Do not put `DEDALO_SUPERVISED` in `../private/.env` — every launch method reads that file, so the engine ignores the key there.

```text
Dédalo TS server listening on unix socket /tmp/dedalo_ts_dev.sock (entity: dev)
Dédalo TS dev listener on https://localhost:3500/dedalo/core/page/
```

Open the URL the installer printed — **`https://127.0.0.1:3500/dedalo/core/page/`** with the defaults — and log in as `root` with the password you set in step 5.

!!! note "One unix socket per server"
    The engine also listens on a unix socket in development, and two servers cannot share one. The installer asks for it on the Development server screen and writes it as `SERVER_UNIX_SOCKET`. The default carries your entity, `/tmp/dedalo_ts_<entity>.sock`, so two checkouts of different entities each get their own. Change it there, or with `--socket`. When a running server already answers on that socket (another checkout's `bun run dev`), the Review refuses to install until you stop it or choose another one. On a re-run, the socket your `.env` already names is kept.

## 8. Run the tests

The suite has its **own database** — it never reads or writes the one your app uses:

```shell
bun run test:db:setup   # once (and after a schema/seed change)
bun test                # picks it up automatically
```

`test:db:setup` connects the way your `.env` says (over `DB_SOCKET` when it names one), never prompts for a password, and needs pgvector on the server (step 1). It builds `<your_db>_test` from files vendored in this repo, **through the installer's own steps**: the core-only install seed and the default domain ontology (`oh`, from the vendored file) exactly as a fresh installation gets them, then the suite's own fixtures — the generic `test` ontology, the canonical `test3` playground records, the hierarchies the tests reference and the registered tools. Nothing is copied from your install.

!!! info "Why a separate database"
    Running the suite against the application's database made the tests depend on that install's data — on a fresh install 183 of 2039 unit tests failed — and let them WRITE to it: one gate provisioned a scratch ontology node and **deleted a real one** on its way out. Tests get their own database; the app's is not theirs to touch.

    If the test DB is missing, `bun test` says so and names the command that builds it; it never falls back to your application's database, so a DB-backed gate fails with `database "…_test" does not exist`. `DEDALO_TEST_DATABASE` overrides the name; `DEDALO_TEST_DB_DISABLE=true` (process environment only) opts out and runs against the configured database.

### What a fresh machine needs, and what stays red

Beyond step 1, two more things decide whether the suite can pass:

- **MariaDB binaries** (`mariadbd`, `mariadb-install-db`, `mariadb`). The publication tests start their own MariaDB server under `../private/test_mariadb/`, never yours. Without the binaries, those tests fail with `SuiteMariadbUnavailable`: a missing prerequisite is reported as a failure, not skipped.
- **An ImageMagick that can write AVIF.** `magick -list format | grep AVIF` must show `rw`. On Debian and Ubuntu, `sudo apt install libheif-plugin-aomenc` adds the encoder. Without it, the AVIF media tests fail with `no encode delegate for this image format`.

Some tests are red on every suite database **by construction**: the read-path parity gates under `test/parity/` replay requests recorded against one real installation's records, which the suite database does not hold. Their expected failures are recorded per test in `engineering/parity_baseline.json`, and they are being replaced by tests on the generic `test` ontology. A red parity gate that is in that file is not your machine's fault.

[Testing](../development/testing.md) explains the suite: its tiers, its own database and media root, and how to read a red run.

## Where the test3 playground lives

The canonical **`test3` playground section** — sample records covering every component model, the section the component reference pages document against — is **not** part of an installation: your dev install has the core ontologies and `oh`, nothing else. The playground lives in the suite database. To click around in it, serve that database with its own login:

```shell
bun run test:db:setup        # once
bun run test:client:server   # the suite server, kept alive for browsing (Ctrl-C stops it)
```

## Everyday commands

| Command | What |
| --- | --- |
| `bun run dev` | the server in watch mode **and** the LESS watcher, together (supervised) |
| `bun run dev:server` | the server in watch mode only (supervised) |
| `bun run start:supervised` | the server with no watcher (supervised: restarts on exit `75`) |
| `scripts/dev_instance.sh` | a second instance beside the first, on its own port and socket (`scripts/dev_instance.sh --help`) |
| `bun run css:build` | compile the LESS once (needed if you edited a `.less` without `dev` running) |
| `bun test test/unit/…` | targeted unit gates (the whole suite takes minutes) |
| `bun run test:client` | the browser client suite; it starts its own server on the suite database (step 8) and stops it |
| `bunx tsc --noEmit` | type check |
| `bun run lint` | the linter |
| `bun run scripts/verify.ts` | the pre-merge gate: typecheck, lint, all tripwires, neighbours |

## When something does not work

- **Cannot log in, no error** → `SESSION_COOKIE_SECURE` does not match the listener (`false` over plain HTTP). See step 6.
- **The browser warns that the certificate is not trusted** → the installer could not make this machine trust the local authority (a cancelled password dialog). The final screen printed the command that trusts it on your system: run it once.
- **The installer's last step (`verify_dev_server`) fails with the port in use** → something took the port after the installer checked it. The install is already sealed, so `--dev-port` is not accepted any more: stop the other program, or set `SERVER_TCP_PORT` in the `.env` to the free port the message names, then run the installer again with `--resume`.
- **`install refused: this checkout has no dependencies (no node_modules)`** → `bun install` was skipped. Run it in the checkout (step 3), then start the installer again.
- **`bun run dev` stops with `the CSS watcher stopped`** → a development dependency is missing (the error above it names it, for example `Cannot find package 'less'`). Run `bun install` in the checkout.
- **`address already in use` / the server exits 1 at boot** → another instance is already listening on your `SERVER_UNIX_SOCKET` (by default `/tmp/dedalo_ts_<entity>.sock`). The double-start guard probes the socket and refuses to steal it. Stop the other one, or point `SERVER_UNIX_SOCKET` somewhere else.
- **The server exits at once with `[boot] REFUSED — not installed`** (exit code 78) → it found none of the four required keys. It is not reading your `.env` — check that it is at `../private/.env`, one level above the repo (or run the installer).
- Everything else → [troubleshooting](troubleshooting.md).
