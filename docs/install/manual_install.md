# Install by hand

> See also: [Production install](production.md) · [Installation hub](index.md) · [Installer reference](installer_reference.md) · [The web server site](reverse_proxy.md) · [Several instances on one host](multi_instance.md) · [Troubleshooting](troubleshooting.md)

This page installs a Production instance by hand, one command at a time. It is the human version of the installer's Review screen: every section is one host step of the [Production route](production.md), in the order the installer runs them, and every command is the one that step runs. Files the Review shows only by path and digest are printed here in full. A host built from this page has the same layout, the same units, the same site file and the same backups as a host the installer built, so the two can live side by side.

Use it when you want to see and type every change yourself, when you adapt a host the installer would refuse, or to finish a [migrated v6 host](#a-migrated-v6-host). For a new server the installer is still the shorter road: it measures the host first, refuses every clash before it changes anything, and can resume or undo itself. A host built by hand has none of that: you are the resume and the undo.

## Before you start

You need the same things as the installer ([Production › Before you start](production.md#before-you-start)):

- a supported system with systemd: Ubuntu 26.04 LTS, Debian 13, or RHEL, Rocky Linux or AlmaLinux 10. Only the newest release of each is supported;
- root;
- an **instance name** (`<i>`): a lowercase letter, then lowercase letters, digits or `_`, at most 28 characters;
- the public address, with DNS pointing at this server, and ports 80 and 443 reachable;
- for your institution's certificate, its fullchain and key files.

### The layout {#the-layout}

The layout is defined by **role**, not by fixed paths. Two places matter:

- **The instance directory** (the install folder, `<dir>`) can be any path, and it is **owned by the service user**. It holds the release tree (`<dir>/dedalo`), the private directory (`<dir>/private`) and the backups (`<dir>/backups`). An in-app [code update](../management/updates/updating_code.md) renames the release tree *inside* this directory and moves the old one to `<dir>/backups/code`, so the service user must be able to write here. Its **parent** can stay root-owned, even `0555`: nothing is ever created or renamed there.
- **What root-started units run** — the pinned Bun runtime and the backup, watchdog, rollback, alert and media-rule scripts — lives in root-owned directories outside every instance directory: `/opt/dedalo/bun/<pin>/` and `/opt/dedalo/instances/<i>/bin/`. Root never runs a file the service user can replace.

The two worked examples on this page:

| | The installer's default | An existing hosting account |
| --- | --- | --- |
| instance name `I` | `prado` | `my_domain` |
| service user `U` | `ded_prado` (created) | `my_domain` (exists; used as it is) |
| service group `G` | `ded_prado` (created with the user) | `ded_my_domain` (created; a group of its own) |
| install folder `DIR` | `/home/ded_prado` | `/home/my_domain.org/dedalo` |
| its parent | `/home` (root's) | `/home/my_domain.org` (the account's) |
| the release tree | `/home/ded_prado/dedalo` | `/home/my_domain.org/dedalo/dedalo` |
| `MEDIA_PATH` | `/srv/dedalo/prado/dedalo/media` | `/srv/dedalo/my_domain/dedalo/media` |
| socket | `/run/dedalo-prado/dedalo_ts.sock` | `/run/dedalo-my_domain/dedalo_ts.sock` |
| database and role | `dedalo_prado`, role `ded_prado` | `dedalo_my_domain`, role `my_domain` |
| units | `dedalo-ts@prado` and its siblings | `dedalo-ts@my_domain` and its siblings |

Only the install folder, the service user and group, and the backup directory are yours to choose. The other paths are **fixed by the shared units and the policy module**, so they follow the instance name:

- `/opt/dedalo/instances/<i>/bin/`: the site-builder backup unit names it;
- `/opt/dedalo/bun/<pin>/bun`: the SELinux module labels exactly this path;
- `/run/dedalo-<i>/`: the server unit's `RuntimeDirectory=dedalo-%i` creates it at every start.

The media root, `MEDIA_PATH`, is `/srv/dedalo/<i>/dedalo/media` on this page. When the media lives on a volume of its own, mount that volume there.

The account rules are the installer's: [The install folder and the service account](production.md#the-install-folder-and-the-service-account). In short, use a regular account that is not root and is in no privileged group. Use one account, one group and one folder per instance. A group of its own is recommended, because the web server joins it.

### The shell and the variables {#the-variables}

Run every step in **one root shell**, with the default umask, so that each file is created `0644` and each directory `0755` unless a command says otherwise:

```shell
sudo -i
umask 022
```

Then set the variables every later command uses. The values are the default example; the hosting-account example is in the comments:

```shell
I=prado                      # the instance name                   (my_domain)
U=ded_prado                  # the service user                    (my_domain)
G=ded_prado                  # the service group                   (ded_my_domain)
DIR=/home/ded_prado          # the install folder                  (/home/my_domain.org/dedalo)
BACKUP_DIR=$DIR/backups      # the backup directory
NAME=dedalo.example.org      # the public address
EMAIL=it@example.org         # Let's Encrypt only: the expiry notices
MEDIA=/srv/dedalo/$I/dedalo/media
SOCK=/run/dedalo-$I/dedalo_ts.sock
BIN=/opt/dedalo/instances/$I/bin
RU="/usr/sbin/runuser -u $U -g $G --"    # a command run as the service user
```

Then the values of your system and web server. Set one block of each pair:

```shell
# Ubuntu 26.04, Debian 13
PGBIN=/usr/lib/postgresql/18/bin PGSVC=postgresql.service CERTBOT_TIMER=certbot.timer
#   nginx
WEB=nginx  WEBSVC=nginx   WEBUSER=www-data WEBLOG=/var/log/nginx   SITE=/etc/nginx/conf.d/dedalo-$I.conf
#   Apache
WEB=apache WEBSVC=apache2 WEBUSER=www-data WEBLOG=/var/log/apache2 SITE=/etc/apache2/sites-available/dedalo-$I.conf

# RHEL, Rocky Linux, AlmaLinux 10
PGBIN=/usr/pgsql-18/bin PGSVC=postgresql-18.service CERTBOT_TIMER=certbot-renew.timer
#   nginx
WEB=nginx  WEBSVC=nginx   WEBUSER=nginx    WEBLOG=/var/log/nginx   SITE=/etc/nginx/conf.d/dedalo-$I.conf
#   Apache
WEB=apache WEBSVC=httpd   WEBUSER=apache   WEBLOG=/var/log/httpd   SITE=/etc/httpd/conf.d/dedalo-$I.conf

# Every system: does SELinux apply here (the RHEL family, Enforcing or Permissive)?
SELINUX_MODULE=false
getenforce 2>/dev/null | grep -qiE '^(enforcing|permissive)$' && SELINUX_MODULE=true

# Every system: does this instance write nginx's host-wide media map? host_web_site sets it.
MAP_OWNER=false
```

`PIN`, the Bun version, is set in [`host_runtime`](#manual-host_runtime) from the release itself.

**Files.** The installer writes its files from templates, and so does this page: each file below is printed with `@@NAME@@` placeholders, and the `render` function fills them in from the variables. Define it now, in this same shell: it reads the variables each time it runs, so `PIN`, set later in [`host_runtime`](#manual-host_runtime), is filled in too. The unit loop in [`host_units`](#manual-host_units) stops when `render` is not defined, rather than write empty files:

```shell
render() {
  name_re=$(printf '%s' "$NAME" | sed 's/[.]/\\\\&/g')
  sed -e "s|@@INSTANCE@@|$I|g" -e "s|@@USER@@|$U|g" -e "s|@@GROUP@@|$G|g" \
      -e "s|@@DIR@@|$DIR|g" -e "s|@@BACKUP_DIR@@|$BACKUP_DIR|g" -e "s|@@PIN@@|$PIN|g" \
      -e "s|@@PG_BIN@@|$PGBIN|g" -e "s|@@PG_SERVICE@@|$PGSVC|g" \
      -e "s|@@SERVER_NAME_RE@@|$name_re|g" \
      -e "s|@@SERVER_NAME@@|$NAME|g" -e "s|@@LOG_DIR@@|$WEBLOG|g" \
      -e "s|@@SELINUX_MODULE@@|$SELINUX_MODULE|g" -e "s|@@NGINX_MAP_OWNER@@|$MAP_OWNER|g" \
      -e "s|@@WEB_SERVICE@@|$WEBSVC|g" "$@"
}
```

`@@SERVER_NAME_RE@@` is the address as a regular expression, its dots escaped (`dedalo\.example\.org`), for the Apache sites' name guard, which matches the `Host` header against it. The installer escapes it the same way.

`render <file>` renders a file, and `render <<'EOF' … EOF` renders the text between the markers. Keep the quotes around the first `EOF`, so the shell leaves the `$` in the files alone. The installer indents its files with tabs; this page shows them as spaces. The difference means nothing to systemd, nginx, Apache or JSON.

Every unit drop-in and site file starts with the stamp `# dedalo-install <i> manual`; the nginx media map include and the host-registry record carry none. The installer recognises the stamp: when it later installs another instance on this host, it counts this one when it checks that no two instances share a user, a group or a folder.

## `host_preflight` — check the host {#manual-host_preflight}

Installer: [Production › `host_preflight`](production.md#host_preflight-the-system-check).

The installer measures the host and refuses, before any change, everything a later step would trip on. By hand, check the same list:

```shell
( . /etc/os-release; echo "$ID $VERSION_ID" ) # ubuntu 26.04 · debian 13 · rhel|rocky|almalinux 10.x
test -d /run/systemd/system && echo systemd    # systemd is running
nginx -v                                       # nginx already installed only: 1.25.1 or newer (`http2 on;`)
getent passwd "$U"; getent group "$G"          # absent, or the account you mean to use
ls -ld /srv/dedalo/$I "$DIR/private" "$BACKUP_DIR" /run/dedalo-$I 2>&1   # none may exist
ls /etc/systemd/system/ | grep "@$I\."         # no unit or drop-in of this instance
ls "$SITE" 2>&1                                # no site file for this instance
ls /var/lib/dedalo-install/instances/ 2>&1     # the other instances on this host
/usr/sbin/runuser -u postgres -- $PGBIN/psql -X -A -t -h /var/run/postgresql -p 5432 -d postgres -c \
  "SELECT 'role ' || rolname FROM pg_roles WHERE rolname = '$U'
   UNION ALL SELECT 'database ' || datname FROM pg_database WHERE datname = 'dedalo_$I'"
                                               # PostgreSQL already installed only: prints nothing
```

The first line reads `/etc/os-release` in a subshell, `( … )`, on purpose: that file sets `NAME` (and `ID`, `VERSION`, …), and sourced in this root shell it would overwrite the page's own `$NAME`, the public address every later step renders.

On a fresh host, `nginx: command not found` and `runuser: user postgres does not exist` only mean that nginx and PostgreSQL are not installed yet. That is fine: [`host_packages`](#manual-host_packages) installs them.

Also check:

- **The role and the database are free.** No PostgreSQL role named like the service user and no database `dedalo_<i>` exist yet. The installer refuses either one before it changes anything: an existing role may carry a password, `SUPERUSER` or `CREATEDB`, and the engine would then run as it. A hosting account often has a role of its own name already. Stop and choose another service user, or remove what is left of an earlier install.
- **One web server.** Nothing but your web server listens on ports 80 and 443 (`ss -ltnp 'sport = :80 or sport = :443'` names the program), and, when your web server is not installed yet, the other one is not installed either: the installer refuses a run that would install one web server beside the other, and any program other than your web server holding the ports. With both already installed, it goes ahead as long as only yours holds them.
- **The address is free.** No other site on this host serves `$NAME` on ports 80 and 443 (`nginx -T`; Apache: `apache2ctl -S` on Debian and Ubuntu, `httpd -S` on the RHEL family, whose `apachectl` does not accept `-S`).
- **One PostgreSQL major.** No cluster other than PostgreSQL 18 listens on port 5432. On Ubuntu and Debian, check with `pg_lsclusters`.
- **The folder.** The install folder is absent, or empty, or an existing folder of the service user's. It is not reached through a symbolic link, not writable by group or others, and no web site on this host serves it.
- **One of everything per instance.** No other instance uses the service user, the group or the folder. Read each `/var/lib/dedalo-install/instances/*.json` file and each `User=` line under `/etc/systemd/system/dedalo-ts@*.service.d/`.
- **The firewall** lets ports 80 and 443 in. The installer never changes the firewall; open them yourself:

    ```shell
    firewall-cmd --get-default-zone; firewall-cmd --list-services        # firewalld (RHEL family): http and https listed?
    firewall-cmd --permanent --add-service=http --add-service=https && firewall-cmd --reload
    ufw status                                                           # ufw (Ubuntu): 80 and 443 allowed?
    ufw allow 80,443/tcp
    ```

- **Your institution's certificate**, if you use one, names the address, is valid now, and pairs with its key (`openssl x509 -in <fullchain> -noout -subject -enddate`), and **this host trusts its chain**. The installer's last check runs this host's `curl`, which verifies the chain as a browser does. Check with `openssl verify -untrusted <fullchain> <fullchain>`. When it fails, with *unable to get local issuer certificate*, or with *self-signed certificate in certificate chain* when the file carries your authority's own certificate too, install your authority's certificate: Debian and Ubuntu, copy it to `/usr/local/share/ca-certificates/<name>.crt`, then `update-ca-certificates`; RHEL family, copy it to `/etc/pki/ca-trust/source/anchors/`, then `update-ca-trust`.

## `host_packages` — packages and repositories {#manual-host_packages}

Installer: [Production › `host_packages`](production.md#host_packages-packages-and-repositories).

The installer installs only the packages that are missing, and adds a repository only when a package needs it. Packages and repositories are shared host state: nothing on this page ever removes them.

**Ubuntu 26.04.** PostgreSQL 18 ships with the release, so no repository is added:

```shell
DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get update
DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y --no-install-recommends \
  git unzip gzip file ca-certificates curl rsync diffutils postgresql-18 postgresql-client-18 ffmpeg imagemagick poppler-utils ocrmypdf librsvg2-bin \
  nginx certbot                       # or: apache2 certbot   (certbot: Let's Encrypt only)
/usr/bin/systemctl enable --now postgresql.service nginx      # or: apache2
```

**Debian 13.** PostgreSQL 18 comes from the PostgreSQL project's repository (PGDG), which its own setup script adds:

```shell
DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get update
DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y --no-install-recommends postgresql-common
/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get update
DEBIAN_FRONTEND=noninteractive /usr/bin/apt-get install -y --no-install-recommends \
  git unzip gzip file ca-certificates curl rsync diffutils postgresql-18 postgresql-client-18 ffmpeg imagemagick poppler-utils ocrmypdf librsvg2-bin \
  nginx certbot                       # or: apache2 certbot   (certbot: Let's Encrypt only)
/usr/bin/systemctl enable --now postgresql.service nginx      # or: apache2
```

**RHEL, Rocky Linux, AlmaLinux 10.** EPEL brings ImageMagick and certbot, CodeReady Builder brings EPEL's dependencies, RPM Fusion free brings FFmpeg, and PGDG brings PostgreSQL 18:

```shell
/usr/bin/dnf install -y https://dl.fedoraproject.org/pub/epel/epel-release-latest-10.noarch.rpm
/usr/bin/crb enable
/usr/bin/dnf install -y https://mirrors.rpmfusion.org/free/el/rpmfusion-free-release-10.noarch.rpm
/usr/bin/dnf install -y "https://download.postgresql.org/pub/repos/yum/reporpms/EL-10-$(uname -m)/pgdg-redhat-repo-latest.noarch.rpm"
/usr/bin/dnf install -y \
  git unzip gzip file ca-certificates curl tar rsync diffutils postgresql18-server postgresql18 postgresql18-contrib ffmpeg ImageMagick poppler-utils librsvg2-tools \
  policycoreutils-python-utils \
  nginx certbot                       # or: httpd mod_ssl mod_http2 certbot   (certbot: Let's Encrypt only)
test -e /var/lib/pgsql/18/data/PG_VERSION || \
  PGSETUP_INITDB_OPTIONS='--auth-local=peer --auth-host=scram-sha-256' /usr/pgsql-18/bin/postgresql-18-setup initdb
/usr/bin/systemctl enable --now postgresql-18.service nginx   # or: httpd
/usr/bin/dnf install -y ocrmypdf                   # optional: a failure only leaves PDF OCR off
```

`ocrmypdf` is optional on the RHEL family. EPEL 10 has no build for `aarch64` (`No match for argument: ocrmypdf`), and without it automatic OCR of PDFs stays off.

With Apache on Debian and Ubuntu, enable its modules now (the package enables none of them): `a2enmod ssl headers http2 rewrite proxy proxy_http && systemctl restart apache2`. On the RHEL family, the `httpd`, `mod_ssl` and `mod_http2` packages load them all.

What the media tools are for, and why SVG goes through `rsvg-convert` and never ImageMagick, is in [Production › `host_packages`](production.md#host_packages-packages-and-repositories).

Two things the installer leaves to you:

- **Operating system updates.** The installer never runs `apt-get upgrade` or `dnf upgrade`. Keep the host updated the way you keep your other servers updated.
- **OCR languages.** For OCR in a language other than English, install its Tesseract pack (`tesseract-ocr-spa`, `tesseract-langpack-spa`…).

**Verify:** `command -v ffmpeg ffprobe qt-faststart pdftotext rsvg-convert` finds every tool. With nginx, `nginx -v` prints 1.25.1 or newer; an older nginx rejects the site's `http2 on;`. If `qt-faststart` is somewhere else, set `DEDALO_AV_FASTSTART_PATH` in `.env` after [`host_engine`](#manual-host_engine). `$PGBIN/psql --version` prints 18, and `systemctl is-active $PGSVC` prints `active`.

## `host_identity` — the service account and the directories {#manual-host_identity}

Installer: [Production › `host_identity`](production.md#host_identity-the-service-account-the-install-folder-and-the-directories).

**The account.** Create only what does not exist. An existing account or group is used as it is: never change it.

```shell
if [ "$G" = "$U" ]; then
  # the default: a new user with its own same-named group
  getent passwd "$U" || /usr/sbin/useradd --system --user-group --home-dir "$DIR" --no-create-home \
    --shell /usr/sbin/nologin "$U"
else
  # a group of its own (the hosting-account example): the group first, then the user if it is new
  getent group "$G" || /usr/sbin/groupadd --system "$G"
  getent passwd "$U" || /usr/sbin/useradd --system --gid "$G" --no-user-group --home-dir "$DIR" \
    --no-create-home --shell /usr/sbin/nologin "$U"
fi
```

The account gets no login shell and no skeleton files. Its home is the install folder, which is created below, never by `--create-home`.

**The install folder.** Who creates it depends on whose directory it goes into:

```shell
# under root-owned parents (the default: /home is root's) — root creates it, for the user
install -d -o "$U" -g "$G" -m 0750 "$DIR"

# under a parent the account owns (the hosting-account example: /home/my_domain.org) — the user creates it
$RU /usr/bin/install -d -m 0750 "$DIR"
```

Root never creates anything by path inside a tree another account controls: an account that runs processes could swap a path under it. An existing **empty** folder under root-owned parents can be handed over (`chown "$U:$G" "$DIR"; chmod 0750 "$DIR"`). An existing folder of the user's own is used as it is.

**The instance's directories.** Inside the folder and inside its web root, the user creates them. The shared and root-run ones belong to root:

```shell
$RU /usr/bin/install -d -m 0700 "$DIR/private"
$RU /usr/bin/install -d -m 0750 "$DIR/backups"
$RU /usr/bin/install -d -m 0750 "$BACKUP_DIR" "$BACKUP_DIR/state"   # BACKUP_DIR inside $DIR (the default)
install -d -o root -g root -m 0755 /srv/dedalo
install -d -o "$U" -g "$G" -m 0750 "/srv/dedalo/$I"
$RU /usr/bin/install -d -m 0750 "/srv/dedalo/$I/dedalo" "$MEDIA" "/srv/dedalo/$I/client"
install -d -o root -g root -m 0755 /opt/dedalo /opt/dedalo/bun /opt/dedalo/instances \
  "/opt/dedalo/instances/$I" "$BIN"
install -d -o root -g root -m 0755 /var/lib/dedalo-install /var/lib/dedalo-install/acme \
  /var/lib/dedalo-install/instances
install -d -o root -g root -m 0755 "/var/lib/dedalo-install/acme/$I"   # Let's Encrypt only
```

A shared directory that already exists (`/srv/dedalo`, `/opt/dedalo`, … on a host with other instances) is used as it is and never re-moded. When the backup directory lies outside the install folder, create it and its `state` with `install -d -o "$U" -g "$G" -m 0750` if every existing parent is root's, otherwise as the user.

**Verify:** `getent passwd "$U"`; `stat -c '%a %U:%G %n' "$DIR" "$DIR/private" "$MEDIA"` prints `750`, `700` and `750`, owned by the service user.

## `host_runtime` — Bun, the release and the root-run scripts {#manual-host_runtime}

Installer: [Production › `host_runtime`](production.md#host_runtime-bun-the-release-and-the-root-run-scripts).

**The release.** Download the release archive ([Get Dédalo](index.md#get-dedalo)) as root, into a root-owned hand-over directory that the service group may read, and check it against its published sha256 before anything reads it:

```shell
V=<version>                                        # the release, for example 7.1.0
REL=/var/lib/dedalo-install/release-$I
install -d -o root -g "$G" -m 0750 "$REL"
cd "$REL"
/usr/bin/curl -fsSL --proto =https --tlsv1.2 -o release.zip \
  "https://v7.master.dedalo.dev/dedalo/install/code/$V/$V.zip"
/usr/bin/curl -fsSL --proto =https --tlsv1.2 -o release.zip.sha256 \
  "https://v7.master.dedalo.dev/dedalo/install/code/$V/$V.zip.sha256"
printf '%s  release.zip\n' "$(cut -c1-64 release.zip.sha256)" | sha256sum -c -    # release.zip: OK
/usr/bin/unzip -q release.zip -d tree
SRC=$(dirname "$(dirname "$(ls "$REL"/tree/scripts/install.ts "$REL"/tree/*/scripts/install.ts 2>/dev/null)")")
PIN=$(cat "$SRC/.bun-version")
```

**From a checkout** instead of the archive (a version not published as an archive, for example), clone it into the same place and check out the release's tag. Run this in place of the `curl` and `unzip` lines, before setting `SRC`:

```shell
/usr/bin/git clone https://github.com/dedalia-org/dedalo.git "$REL/tree"
/usr/bin/git -C "$REL/tree" checkout "v$V"
```

The archive step below leaves `.git` out of the release, so an instance built from a checkout reports its version as `<version>-dev`, with no build date, on `/health`, the login page and the Maintenance panel: only a published archive carries the build stamp. It runs the same code. `install_digest` on `/health` is `null` on every new install, the installer's included: it names the archive an in-app code update installed, and none has run yet. The archive holds the tree either at its top level or in one top-level directory; `SRC` is wherever `scripts/install.ts` is. Keep `$REL` until [`host_selinux`](#manual-host_selinux): the units and the policy module are copied from it, never from the instance's own tree.

**Bun**, at the release's pin, root-owned. It comes only from a zip whose sha256 is the release's committed row in `.bun-sha256`, checked before it is unpacked:

```shell
case "$(uname -m)" in
  aarch64) ASSET=bun-linux-aarch64.zip ;;
  *) grep -qw avx2 /proc/cpuinfo && ASSET=bun-linux-x64.zip || ASSET=bun-linux-x64-baseline.zip ;;
esac
install -d -o root -g root -m 0700 "/var/lib/dedalo-install/bun/$PIN"
cd "/var/lib/dedalo-install/bun/$PIN"
test -s "$ASSET" || /usr/bin/curl -fsSL --proto =https --tlsv1.2 -o "$ASSET" \
  "https://github.com/oven-sh/bun/releases/download/bun-v$PIN/$ASSET"
grep " $ASSET\$" "$SRC/.bun-sha256" | sha256sum -c -          # bun-linux-….zip: OK — stop otherwise
/usr/bin/unzip -o -q "$ASSET" -d extract
/usr/bin/install -D -m 0755 -o root -g root "extract/${ASSET%.zip}/bun" "/opt/dedalo/bun/$PIN/bun"
/usr/bin/rm -rf extract
```

On a host where another instance already runs this pin, `/opt/dedalo/bun/$PIN/bun` is already there: leave it. The installer compares it byte for byte with the verified one (`cmp -s`) and does not install it again, so a running instance's binary is never replaced.

!!! danger "Never `bun upgrade` on a production server"
    The engine is coupled to version-specific runtime behaviour, and a silent drift there is a data-corruption class. A new pin is installed next to the old one, as above, and the units are pointed at it.

**The release in place.** Root archives the tree; the service user extracts it and installs its locked dependencies:

```shell
/usr/bin/tar -C "$SRC" --exclude=./node_modules --exclude=./.git -cf "$REL/release.tar" .
$RU /usr/bin/install -d -m 0750 "$DIR/dedalo"
$RU /usr/bin/tar -xf "$REL/release.tar" -C "$DIR/dedalo" --no-same-owner --no-overwrite-dir
cd "$DIR/dedalo"
BUN_INSTALL_CACHE_DIR="$DIR/dedalo/.bun-install-cache" TMPDIR="$DIR/dedalo" \
  $RU /usr/bin/env HOME="$DIR" "/opt/dedalo/bun/$PIN/bun" install --frozen-lockfile --production
$RU /usr/bin/rm -rf "$DIR/dedalo/.bun-install-cache"
```

The `cd` matters: `runuser` keeps the directory you are standing in. `--no-overwrite-dir` keeps `$DIR/dedalo` at `0750`: the archive's own `./` entry would otherwise give it the source's `0755`. `--frozen-lockfile` refuses any dependency tree other than the tested one, and `--production` leaves out the test harness and the linters. The package cache lives inside the tree and is removed straight after. `TMPDIR` keeps Bun's temporary files inside the tree too: with `/tmp` on another filesystem, Bun leaves an empty `/tmp/.<hash>-0.hm` owned by the service user, which would outlive the account if the instance is ever removed. `runuser` resets `HOME` to the account's own home, so every Bun command on this page sets `HOME` to the install folder, as the installer does: nothing is left in the account's home.

**The root-run scripts**, copied root-owned, byte for byte, outside the code tree. A code update moves the whole tree aside, and the rollback has to work exactly when the tree is missing:

```shell
for script in dedalo-backup-step.sh dedalo-db-backup.sh dedalo-tree-backup.sh dedalo-site-builder-backup.sh dedalo-backup-alert.sh dedalo-ts-watchdog.sh dedalo-code-rollback.sh dedalo-media-rules.sh dedalo-tls-rotate.sh; do
  /usr/bin/install -m 0755 -o root -g root "$SRC/deploy/$script" "$BIN/$script"
done
```

**Verify:** `/opt/dedalo/bun/$PIN/bun --version` prints `$PIN`; `stat -c '%U' /opt/dedalo/bun/$PIN/bun` prints `root`; `stat -c %a "$DIR/dedalo"` prints `750`; `ls "$DIR/dedalo/node_modules" "$BIN"`.

## `host_database` — the role and the database {#manual-host_database}

Installer: [Production › `host_database`](production.md#host_database-the-role-and-the-database).

The role is named like the service user and has **no password**: PostgreSQL's peer authentication maps the system user to the role of the same name over the local socket, so no database password exists at rest. The database `dedalo_<i>` belongs to it:

```shell
PSQL="/usr/sbin/runuser -u postgres -- $PGBIN/psql -X -q -A -t -v ON_ERROR_STOP=1 -h /var/run/postgresql -p 5432"
$PSQL -d postgres -c "SELECT 1 / count(*) FROM pg_roles WHERE rolname = '$U'" >/dev/null 2>&1 || \
  printf 'CREATE ROLE "%s" LOGIN;\n' "$U" | $PSQL -d postgres
$PSQL -d postgres -c "SELECT 1 / count(*) FROM pg_database WHERE datname = 'dedalo_$I'" >/dev/null 2>&1 || \
  printf "CREATE DATABASE \"dedalo_%s\" OWNER \"%s\" ENCODING 'UTF8' TEMPLATE template0;\n" "$I" "$U" | $PSQL -d postgres
printf 'REVOKE CONNECT, TEMPORARY ON DATABASE "dedalo_%s" FROM PUBLIC;\nGRANT CONNECT, TEMPORARY ON DATABASE "dedalo_%s" TO "%s";\n' "$I" "$I" "$U" | $PSQL -d postgres
```

PostgreSQL lets every role connect to a new database and create temporary tables in it (the `PUBLIC` grant). The last line takes that away and gives it to the instance's role alone, so another instance's role cannot reach this database.

**Verify**, as the installer does — the service user reaches its database by peer, and the three extensions the seed needs are available:

```shell
$RU $PGBIN/psql -X -q -A -t -h /var/run/postgresql -p 5432 -d "dedalo_$I" -c 'SELECT 1'     # 1
$PSQL -d postgres -c "SELECT count(*) FROM pg_available_extensions WHERE name IN ('btree_gin', 'pg_trgm', 'unaccent')"   # 3
$PSQL -d postgres -c "SELECT has_database_privilege('public', 'dedalo_$I', 'CONNECT')"                               # f
```

The `||` guards only make a re-run of this page harmless after it stopped halfway. They never adopt a role or a database that existed before: [`host_preflight`](#manual-host_preflight) checked that neither did.

A cluster whose `pg_hba.conf` refuses local peer connections fails the first check. Allow `local all all peer` (the distributions' default), then reload PostgreSQL. `pg_hba.conf` is global configuration: change it deliberately, for every database on the host.

## `host_engine` — the engine steps, as the service user {#manual-host_engine}

Installer: [Production › `host_engine`](production.md#host_engine-the-engine-steps-as-the-instance-user).

The engine steps fill the database and write the configuration: the seed, the ontologies, the thesauri, the languages, the tools, the `root` password, and `<dir>/private/.env`. They are not reproduced by hand. You run them with the installer itself, as the service user, with `--engine-only`: only the engine steps run, with no host step and no root.

```shell
cd "$DIR/dedalo"
$RU /usr/bin/env HOME="$DIR" "/opt/dedalo/bun/$PIN/bun" run "$DIR/dedalo/scripts/install.ts" \
  --route production --instance "$I" --engine-only \
  --db-user "$U" --pg-bin-path "$PGBIN" --media-access-mode publication \
  --backup-dir "$BACKUP_DIR" \
  --entity prado --entity-label 'Museo del Prado' --locale es-ES --timezone Europe/Madrid
```

- `--route production --instance "$I"` gives the Production defaults that follow the instance name: the database `dedalo_<i>` over the socket `/var/run/postgresql`, `MEDIA_PATH=/srv/dedalo/<i>/dedalo/media`, and the socket `/run/dedalo-<i>/dedalo_ts.sock`.
- `--db-user "$U"` is required whenever the service user is not `ded_<i>`: the database user is the service user, and the default would be `ded_<i>`.
- `--pg-bin-path "$PGBIN"` is written as `DEDALO_PG_BIN_PATH`, so the backups dump with the PostgreSQL 18 client.
- `--backup-dir "$BACKUP_DIR"` is written as `DEDALO_BACKUP_DIR=$BACKUP_DIR/db`, the directory the backup units write. The server's own backups and its directory check then use that directory too, and the instance has one backup location.
- `--media-access-mode publication` is the Production default, spelled out so the choice is visible. The installer writes it as `DEDALO_MEDIA_ACCESS_MODE`, with or without the flag, as the installer's own route does, so the first boot does not report an unconfigured mode. Choose `private` or `false` here if that is your choice: [Production › The media access mode](production.md#before-you-start).
- Add any other answer as a flag or with `--answers <file>`, as on the installer's headless form: `--langs`, `--app-lang`, `--data-lang`, `--ontologies`, `--hierarchies`, `--media-access-mode`, `--diffusion --mysql-*`, `--mailer --smtp-*`. Every flag is in the [installer reference](installer_reference.md#command-line-flags). `--plan` prints the plan and changes nothing.

Run this way, at a terminal and without `--execute`, the installer **asks** for the `root` password (hidden, typed twice, checked against the policy). The password never appears on a command line or in the environment. For an unattended run, add `--execute --secrets-stdin` and pipe the secrets in as one JSON object, `{"root_password":"…"}`, plus `mysql_password` or `smtp_pass` when diffusion or the mailer is on. See [Installer reference › Secrets](installer_reference.md#secrets). Avoid `DEDALO_INSTALL_ROOT_PASSWORD` here: exported in the root shell, the password stays in that shell's environment for every later command on this page, and typed inline it lands in the shell history.

The run prints the generated `DEDALO_SALT_STRING` **once**. Keep it with your backups.

**Verify:**

```shell
cd "$DIR/dedalo" && $RU /usr/bin/env HOME="$DIR" "/opt/dedalo/bun/$PIN/bun" run "$DIR/dedalo/scripts/install.ts" --status --json
# {"exists":true,"outcome":"complete","failed_step":null,"needs":[],"salt_generated":true,"running":null}
```

If it fails, fix the cause and run the same command with `--resume`. A database it filled is undone with `--abort --confirm-database dedalo_<i>`, which resets it to empty and refuses a completed install.

## `host_units` — the systemd units {#manual-host_units}

Installer: [Production › `host_units`](production.md#host_units-the-systemd-units).

**The templates.** The units are shared by every instance on the host, and `%i` is the instance. Their only placeholder is the PostgreSQL unit. A template that already exists (another instance's) must be byte-equal to yours. If it differs, stop: the installer refuses to overwrite it, and so should you.

```shell
for unit in dedalo-ts@.service dedalo-ts-restart@.service dedalo-ts-rollback@.service dedalo-ts-watchdog@.service dedalo-ts-watchdog@.timer dedalo-backup@.service dedalo-backup@.timer dedalo-backup-alert@.service dedalo-backup-site-builder@.service dedalo-tls-renew@.service dedalo-tls-renew@.timer; do
  text=$(render "$SRC/deploy/systemd/$unit") && [ -n "$text" ] ||
    { echo "STOP: nothing rendered for $unit — define render first (see Before you start)"; break; }
  if [ -e "/etc/systemd/system/$unit" ]; then
    printf '%s\n' "$text" | cmp - "/etc/systemd/system/$unit" || echo "STOP: $unit differs"
  else
    printf '%s\n' "$text" > "/etc/systemd/system/$unit"
  fi
done
```

Nothing is written when `render` is missing or renders nothing: an empty template would otherwise stay behind, and a second run of the loop would report it as *differs*. The templates name no user and no path of an instance. Each instance-run template runs `/bin/false` until its drop-in gives it a command, so a template without its drop-in never runs anything as root.

**The drop-ins** are this instance's own. Each one goes to `/etc/systemd/system/<unit>@<i>.<type>.d/10-dedalo-install.conf`. The server: the account, the folder, the pinned runtime, the client publish directory.

```shell
install -d -m 0755 "/etc/systemd/system/dedalo-ts@$I.service.d"
render > "/etc/systemd/system/dedalo-ts@$I.service.d/10-dedalo-install.conf" <<'EOF'
# dedalo-install @@INSTANCE@@ manual
[Service]
User=@@USER@@
Group=@@GROUP@@
WorkingDirectory=@@DIR@@/dedalo
Environment="HOME=@@DIR@@"
ExecStart=
ExecStart=/opt/dedalo/bun/@@PIN@@/bun run src/server.ts
Environment="DEDALO_CLIENT_PUBLISH_DIR=/srv/dedalo/@@INSTANCE@@/client"
EOF
```

The backup set: three stores — the database, the media and the private directory — each from the root-owned bin directory, all run as the service user, with the `.env` as their environment:

```shell
install -d -m 0755 "/etc/systemd/system/dedalo-backup@$I.service.d"
render > "/etc/systemd/system/dedalo-backup@$I.service.d/10-dedalo-install.conf" <<'EOF'
# dedalo-install @@INSTANCE@@ manual
[Service]
User=@@USER@@
Group=@@GROUP@@
EnvironmentFile=
EnvironmentFile=@@DIR@@/private/.env
Environment="DEDALO_BACKUP_STATE_DIR=@@BACKUP_DIR@@/state"
Environment="DEDALO_BACKUP_EXPECTED_STORES=matrix_db media private"
ExecStart=
ExecStart=-/opt/dedalo/instances/@@INSTANCE@@/bin/dedalo-backup-step.sh run matrix_db /opt/dedalo/instances/@@INSTANCE@@/bin/dedalo-db-backup.sh --label timer --dir-key DEDALO_BACKUP_DIR --dir @@BACKUP_DIR@@/db --db-key DB_NAME --host-key DB_HOST --port-key DB_PORT --user-key DB_USER --password-key DB_PASSWORD --socket-key DB_SOCKET --pg-dump @@PG_BIN@@/pg_dump --pg-restore @@PG_BIN@@/pg_restore
ExecStart=-/opt/dedalo/instances/@@INSTANCE@@/bin/dedalo-backup-step.sh run media /opt/dedalo/instances/@@INSTANCE@@/bin/dedalo-tree-backup.sh --label media --source-key MEDIA_PATH --dest @@BACKUP_DIR@@/media --keep 14
ExecStart=/opt/dedalo/instances/@@INSTANCE@@/bin/dedalo-backup-step.sh run --last private /opt/dedalo/instances/@@INSTANCE@@/bin/dedalo-tree-backup.sh --label private --source @@DIR@@/private/ --dest @@BACKUP_DIR@@/private --keep 14 --exclude backups --exclude /export_artifacts
EOF
```

To back up the site builder too (the installer's `--backup-site-builder`), add two lines right after the stamp: `[Unit]` and `Wants=dedalo-backup-site-builder@<i>.service`. That store runs as root in a unit of its own, with no `EnvironmentFile`. Never add a root (`+`) line to the backup set: systemd applies the set's `EnvironmentFile=` (a file the service user writes) to every line, root lines included.

The backup alert, the code rollback and the watchdog:

```shell
install -d -m 0755 "/etc/systemd/system/dedalo-backup-alert@$I.service.d"
render > "/etc/systemd/system/dedalo-backup-alert@$I.service.d/10-dedalo-install.conf" <<'EOF'
# dedalo-install @@INSTANCE@@ manual
[Service]
User=@@USER@@
Group=@@GROUP@@
Environment="DEDALO_BACKUP_STATE_DIR=@@BACKUP_DIR@@/state"
ExecStart=
ExecStart=/opt/dedalo/instances/@@INSTANCE@@/bin/dedalo-backup-alert.sh dedalo-backup@@@INSTANCE@@.service
EOF
install -d -m 0755 "/etc/systemd/system/dedalo-ts-rollback@$I.service.d"
render > "/etc/systemd/system/dedalo-ts-rollback@$I.service.d/10-dedalo-install.conf" <<'EOF'
# dedalo-install @@INSTANCE@@ manual
[Service]
User=@@USER@@
Group=@@GROUP@@
ExecCondition=
ExecCondition=/opt/dedalo/instances/@@INSTANCE@@/bin/dedalo-code-rollback.sh --check --app-dir @@DIR@@/dedalo --backup-root @@DIR@@/backups/code
ExecStart=
ExecStart=/opt/dedalo/instances/@@INSTANCE@@/bin/dedalo-code-rollback.sh --no-restart --app-dir @@DIR@@/dedalo --backup-root @@DIR@@/backups/code --service dedalo-ts@@@INSTANCE@@ --socket /run/dedalo-@@INSTANCE@@/dedalo_ts.sock
EOF
install -d -m 0755 "/etc/systemd/system/dedalo-ts-watchdog@$I.service.d"
render > "/etc/systemd/system/dedalo-ts-watchdog@$I.service.d/10-dedalo-install.conf" <<'EOF'
# dedalo-install @@INSTANCE@@ manual
[Service]
ExecStart=
ExecStart=/opt/dedalo/instances/@@INSTANCE@@/bin/dedalo-ts-watchdog.sh --socket /run/dedalo-@@INSTANCE@@/dedalo_ts.sock --app-dir @@DIR@@/dedalo --backup-root @@DIR@@/backups/code --service dedalo-ts@@@INSTANCE@@.service --grace 900 --restart-unit dedalo-ts-restart@@@INSTANCE@@.service --rollback-unit dedalo-ts-rollback@@@INSTANCE@@.service
EOF
```

The watchdog runs as root, so its drop-in names no user. The rollback and the watchdog name the release tree and the code-update backup root explicitly, and never read them from the `.env`.

Then reload systemd and enable the server, **without** starting it. Do not enable the watchdog or the backup timer yet:

```shell
/usr/bin/systemctl daemon-reload
/usr/bin/systemctl enable "dedalo-ts@$I.service"
```

**Verify:** `systemctl cat "dedalo-ts@$I"` shows the template and the drop-in; `systemctl is-enabled "dedalo-ts@$I"` prints `enabled`. What each unit does is in [Production › `host_units`](production.md#host_units-the-systemd-units).

## `host_selinux` — SELinux on the RHEL family {#manual-host_selinux}

Installer: [Production › `host_selinux`](production.md#host_selinux-selinux-on-the-rhel-family).

Only on the RHEL family, and only when `getenforce` prints `Enforcing` or `Permissive`. Elsewhere, skip to the last command of this section.

**The file contexts.** The web server reads the socket's directory and the web root; systemd reads the install folder's own subtrees, and the web server is denied them. Paths are written as regular expressions, so the install folder is escaped first. Add only the rules `semanage fcontext -l -C` does not list yet:

```shell
E=$(printf '%s\n' "$DIR" | sed 's/[][\.^$*+?(){}|]/\\&/g')     # /home/my_domain\.org/dedalo
/usr/sbin/semanage fcontext -a -t httpd_var_run_t "/run/dedalo-$I(/.*)?"
/usr/sbin/semanage fcontext -a -t httpd_sys_content_t "/srv/dedalo/$I(/.*)?"
/usr/sbin/semanage fcontext -a -t httpd_sys_content_t "/var/lib/dedalo-install/acme/$I(/.*)?"   # Let's Encrypt only
/usr/sbin/semanage fcontext -a -t var_lib_t "$E"                  # only if you CREATED the folder in host_identity
/usr/sbin/semanage fcontext -a -t var_lib_t "$E/dedalo(/.*)?"
/usr/sbin/semanage fcontext -a -t var_lib_t "$E/private(/.*)?"
/usr/sbin/semanage fcontext -a -t var_lib_t "$E/backups(/.*)?"
```

A backup directory outside the install folder gets its own `var_lib_t` rule, escaped the same way. The socket's rule uses the `/run` spelling. RHEL 10's policy maps `/var/run` onto `/run` (`/etc/selinux/targeted/contexts/files/file_contexts.subs_dist`), and `semanage` refuses a rule written on the `/var/run` side (`conflicts with equivalency rule '/var/run /run'`). systemd creates the socket's directory at every start, and the rule labels it then.

**Relabel.** Root relabels the web root; the service user relabels inside its own folder:

```shell
/usr/sbin/restorecon -RF "/srv/dedalo/$I"
/usr/sbin/restorecon -RF "/var/lib/dedalo-install/acme/$I"         # Let's Encrypt only
/usr/sbin/restorecon -F "$DIR"                                      # only if you created the folder; as $RU if the user did
$RU /usr/sbin/restorecon -RF "$DIR/dedalo"
$RU /usr/sbin/restorecon -RF "$DIR/private"
$RU /usr/sbin/restorecon -RF "$DIR/backups"
```

A folder you did not create, its parent and the account's other files (`~/.ssh`) are never relabelled.

**The policy module** gives the engine its own domain, `dedalo_engine_t`. The web server may connect to that domain's sockets and to no other service's. The module is shared by every instance on the host: when `semodule -l` already lists `dedalo_engine`, it must have been loaded from the same file. Otherwise, load it:

```shell
install -d -o root -g root -m 0700 /var/lib/dedalo-install/selinux
sed 's/@@STAMP@@/dedalo-install/' "$SRC/deploy/selinux/dedalo_engine.cil.tpl" > /var/lib/dedalo-install/selinux/dedalo_engine.cil
chmod 0600 /var/lib/dedalo-install/selinux/dedalo_engine.cil
/usr/sbin/semodule -X 400 -i /var/lib/dedalo-install/selinux/dedalo_engine.cil
/usr/sbin/restorecon -F "/opt/dedalo/bun/$PIN/bun"
```

No SELinux boolean is changed.

**Verify:** `semodule -l | grep dedalo_engine`; `stat -c %C "/opt/dedalo/bun/$PIN/bun"` contains `dedalo_engine_exec_t`; `ls -Zd "/srv/dedalo/$I" "$DIR/dedalo" "$DIR/private"`.

**On every system**, the release's hand-over directory has served its purpose. Remove it:

```shell
cd / && /usr/bin/rm -rf "$REL"
```

## `host_first_boot` — the first start {#manual-host_first_boot}

Installer: [Production › `host_first_boot`](production.md#host_first_boot-the-first-start).

Start the server, then wait until `/health` answers `200` on the socket **and** every database migration is recorded. The first boot runs the boot migrations, and on a large ontology that can take minutes. The installer waits up to 45 minutes.

```shell
/usr/bin/systemctl start "dedalo-ts@$I.service"
until [ "$(/usr/bin/curl -s -o /dev/null -w '%{http_code}' --max-time 10 --unix-socket "$SOCK" http://localhost/health)" = 200 ]; do
  sleep 3
done
cd "$DIR/dedalo" && $RU /usr/bin/env HOME="$DIR" "/opt/dedalo/bun/$PIN/bun" run scripts/ops/boot_status.ts --json
# {"applied":<n>,"pending":[]} — run it again until pending is empty
```

If the loop never ends, check whether the server refused to boot. `systemctl show -p Result --value "dedalo-ts@$I"` printing `exit-code`, with `ExecMainStatus` `78`, means it is not installed for the unit's environment. Read the `[boot] REFUSED` line in `journalctl -u "dedalo-ts@$I"`.

On the RHEL family with SELinux, the engine must run in its own domain:

```shell
/usr/bin/ps -o label= -p "$(systemctl show -p MainPID --value "dedalo-ts@$I")"   # …:dedalo_engine_t:…
```

**Verify:** `systemctl status "dedalo-ts@$I" --no-pager` shows `active (running)`; `ls -l "$SOCK"` is `srw-rw-rw-`, owned by the service user and group. The server opens the socket itself; what guards it is its directory: `ls -ld /run/dedalo-$I` is `drwxr-x---`, service user and service group, so only the service group (the web server's user among it) reaches the socket.

## `host_watchdog` — arm the watchdog {#manual-host_watchdog}

Installer: [Production › `host_watchdog`](production.md#host_watchdog-arm-the-watchdog).

Only now, after the first boot has finished: a watchdog armed earlier would kill the first boot in the middle of its migrations.

```shell
/usr/bin/systemctl enable --now "dedalo-ts-watchdog@$I.timer"
```

**Verify:** `systemctl is-active "dedalo-ts-watchdog@$I.timer"` prints `active`.

## `host_web_http` — the plain-HTTP site (Let's Encrypt only) {#manual-host_web_http}

Installer: [Production › `host_web_http`](production.md#host_web_http-the-plain-http-site-lets-encrypt-only).

With your institution's certificate, skip to [`host_tls`](#manual-host_tls).

The web server's user joins the service group, through which it reaches the socket, the media and the published client. A reload is enough, because the workers start again with the new membership:

```shell
id -nG "$WEBUSER" | grep -qw "$G" || /usr/sbin/usermod -aG "$G" "$WEBUSER"
install -d -o root -g root -m 0755 /var/www/empty        # Apache only: the empty DocumentRoot
```

Apache needs the modules `ssl headers http2 rewrite proxy proxy_http`. Check with `apache2ctl -M` on Debian and Ubuntu, or `httpd -M` on the RHEL family. Enable a missing one with `a2enmod <module> && systemctl restart apache2` on Debian and Ubuntu (a restart, as `a2enmod` advises), or with its package and `LoadModule` line under `/etc/httpd/conf.modules.d/` on the RHEL family. The installer checks them, lists the command on the Review's *To do* list, and stops at this step while one is missing; enabling modules is the system administrator's job. The installer never sets `ServerTokens`, a server-wide directive: set `ServerTokens Prod` in the global configuration yourself if you want the `Server:` header not to name the system and version.

Write the first stage of the site: the plain-HTTP server with the challenge root, and the redirect to HTTPS.

```shell
# nginx
render > "$SITE" <<'EOF'
# dedalo-install @@INSTANCE@@ manual
# Dédalo instance @@INSTANCE@@ — WRITTEN BY THE INSTALLER (scripts/install.ts, production
# route) or by docs/install/manual_install.md, which renders the same bytes. Every other
# site, the default site and the global configuration are untouched. An installer resume
# compares this file with its own render: change the answers and re-run the installer;
# a by-hand host edits it only where manual_install.md says.

limit_req_zone $binary_remote_addr zone=dedalo_@@INSTANCE@@_api:10m rate=20r/s;
upstream dedalo_@@INSTANCE@@ { server unix:/run/dedalo-@@INSTANCE@@/dedalo_ts.sock; }

server {
	listen 80;
	listen [::]:80;
	server_name @@SERVER_NAME@@;
	server_tokens off;
	location ^~ /.well-known/acme-challenge/ {
		root /var/lib/dedalo-install/acme/@@INSTANCE@@;
		default_type text/plain;
	}
	location / { return 301 https://$host$request_uri; }
}
EOF
```

```shell
# Apache
render > "$SITE" <<'EOF'
# dedalo-install @@INSTANCE@@ manual
# Dédalo instance @@INSTANCE@@ — WRITTEN BY THE INSTALLER (scripts/install.ts, production
# route) or by docs/install/manual_install.md, which renders the same bytes. Every other
# site, the default site and the global configuration are untouched. An installer resume
# compares this file with its own render: change the answers and re-run the installer;
# a by-hand host edits it only where manual_install.md says.

<VirtualHost *:80>
	ServerName @@SERVER_NAME@@
	DocumentRoot /var/www/empty
	Alias /.well-known/acme-challenge/ /var/lib/dedalo-install/acme/@@INSTANCE@@/.well-known/acme-challenge/
	<Directory /var/lib/dedalo-install/acme/@@INSTANCE@@>
		Require all granted
	</Directory>
	RewriteEngine On
	# Only this site's own name: any other Host is refused (421), never served.
	RewriteCond %{HTTP_HOST} !^@@SERVER_NAME_RE@@(:80)?$ [NC]
	RewriteRule ^ - [R=421,L]
	RewriteCond %{REQUEST_URI} !^/\.well-known/acme-challenge/
	RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
</VirtualHost>
EOF
/usr/sbin/a2ensite "dedalo-$I"                             # Debian and Ubuntu only
```

Then test, and reload. A reload applies **every** pending change of the web server's configuration, not only this site's:

```shell
/usr/sbin/nginx -t && /usr/bin/systemctl reload "$WEBSVC"            # nginx
/usr/sbin/apachectl configtest && /usr/bin/systemctl reload "$WEBSVC" # Apache
```

**Verify:** `curl -I "http://$NAME/"` answers with a redirect to `https://`.

## `host_tls` — the certificate {#manual-host_tls}

Installer: [Production › `host_tls`](production.md#host_tls-the-certificate).

**Let's Encrypt.** One certificate per instance, named `dedalo-<i>`, renewed by the distribution's timer. Its deploy hook reloads the web server:

```shell
test -s "/etc/letsencrypt/live/dedalo-$I/fullchain.pem" || \
  /usr/bin/certbot certonly --webroot -w "/var/lib/dedalo-install/acme/$I" -d "$NAME" -m "$EMAIL" \
    --agree-tos --non-interactive --cert-name "dedalo-$I" --deploy-hook "systemctl reload $WEBSVC"
/usr/bin/systemctl enable --now "$CERTBOT_TIMER"
```

Add `--staging` to try the challenge against the staging authority first. Its certificate is not trusted by browsers, so issue the real one afterwards (`certbot certonly … --cert-name "dedalo-$I" --force-renewal` without `--staging`). A failed request is almost always DNS or port 80: see [Troubleshooting › Let's Encrypt](troubleshooting.md#lets-encrypt-fails).

**A local certificate authority** (an intranet with no public name, a test machine without a domain). The root-owned copy of `deploy/dedalo-tls-rotate.sh` from [`host_runtime`](#manual-host_runtime) makes it — the same script the docker route and every rotation use, so do not write certificates with `openssl` by hand. Give every address staff type as a `--host`, the public address first: the authority certifies exactly those names, never one below them, so no name may lie inside another (adding one later means a new authority, and the name in the site file you write in `host_web_site`). The certificate directory is root's; the script makes the keys `0600`:

```shell
TLS=/opt/dedalo/instances/$I/tls
install -d -o root -g root -m 0755 "$TLS"
test -s "$TLS/fullchain.pem" -a -s "$TLS/dedalo-local-ca.pem" || \
  "$BIN/dedalo-tls-rotate.sh" --mode local-ca --host "$NAME" --dir "$TLS" --no-reload --quiet
# more addresses: --host "$NAME" --host dedalo.lan (names only by hand: an IP address needs the
# installer, which claims it in the host's catch-all — reverse_proxy.md, Reaching an instance by IP address)
[ "$SELINUX_MODULE" = true ] && semanage fcontext -a -t cert_t "$TLS(/.*)?" && restorecon -RF "$TLS"
```

In the full site of [`host_web_site`](#manual-host_web_site), the certificate lines name `$TLS/fullchain.pem` and `$TLS/privkey.pem` instead of the Let's Encrypt paths, and every extra address joins the server name: nginx's `server_name` lists them all; Apache adds `ServerAlias <the others>` under `ServerName` and its name guard reads `!^(<name>|<other>…)(:<port>)?$`, each name with its dots escaped.

The certificate renews itself from the same authority, so the staff computers never trust anything again: the drop-in of the renewal unit, then its timer (a daily check; the script acts only in the certificate's last 30 days, then reloads the web server):

```shell
mkdir -p "/etc/systemd/system/dedalo-tls-renew@$I.service.d"
render > "/etc/systemd/system/dedalo-tls-renew@$I.service.d/10-dedalo-install.conf" <<'EOF'
# dedalo-install @@INSTANCE@@ manual
[Service]
ExecStart=
ExecStart=/opt/dedalo/instances/@@INSTANCE@@/bin/dedalo-tls-rotate.sh --mode renew --dir /opt/dedalo/instances/@@INSTANCE@@/tls --reload systemd --unit @@WEB_SERVICE@@
EOF
/usr/bin/systemctl daemon-reload
/usr/bin/systemctl enable --now "dedalo-tls-renew@$I.timer"
```

Then trust `$TLS/dedalo-local-ca.pem` on every staff computer, once — [Production › Done](production.md#done) says how on each system. `openssl x509 -in "$TLS/dedalo-local-ca.pem" -noout -fingerprint -sha256` prints the fingerprint to compare there.

**Your institution's files** are used where they are, never copied. Check that they name the address, are valid now (renew under 30 days) and pair with each other:

```shell
openssl x509 -in <fullchain> -noout -subject -ext subjectAltName -enddate
[ "$(openssl x509 -in <fullchain> -noout -pubkey | sha256sum)" = "$(openssl pkey -in <key> -pubout | sha256sum)" ] && echo pair
```

This host must trust the chain (the public probe verifies it with this host's `curl`): `openssl verify -untrusted <fullchain> <fullchain>` prints `OK` once your authority is in the system trust store. Until then it fails with *unable to get local issuer certificate*, or *self-signed certificate in certificate chain* when the file carries the authority's own certificate: install it as in [`host_preflight`](#manual-host_preflight).

On the RHEL family, the web server must be able to read them: keep them under `/etc/pki/tls`, or label their directory `cert_t` (`semanage fcontext -a -t cert_t '<dir>(/.*)?' && restorecon -RF <dir>`).

**Verify:** with Let's Encrypt, `certbot certificates --cert-name "dedalo-$I"` and `systemctl is-enabled "$CERTBOT_TIMER"`. With a local CA, `openssl verify -CAfile "$TLS/dedalo-local-ca.pem" -untrusted "$TLS/dedalo-issuing-ca.pem" "$TLS/fullchain.pem"` prints `OK` and `systemctl is-enabled "dedalo-tls-renew@$I.timer"` prints `enabled`. With your own files, `openssl x509 -noout -subject -enddate -in <fullchain>` names the address and a date ahead; once the site is up, `openssl s_client -connect "$NAME:443" -servername "$NAME" </dev/null | grep 'Verify return code'` prints `0 (ok)`.

## `host_web_site` — the full site {#manual-host_web_site}

Installer: [Production › `host_web_site`](production.md#host_web_site-the-full-site).

The full site serves HTTPS, the API routes to the socket, the published client and the media gate. It is written after the first boot, because the engine generates the media rules at boot. What each part of the file does, and why, is in [The web server site](reverse_proxy.md).

If you skipped [`host_web_http`](#manual-host_web_http) (your institution's certificate), add the web server's user to the service group and create `/var/www/empty` (Apache) first, as shown there.

**nginx: the media rules.** nginx never includes the rule files from the media tree, which the service user writes. It includes root-owned copies that a script validates first. One host-wide file includes the media map, whose variables are global to nginx. Write it only if no other instance on this host has written it already:

```shell
install -d -o root -g root -m 0755 /etc/nginx/dedalo
"$BIN/dedalo-media-rules.sh" --source "$MEDIA" --dest "/etc/nginx/dedalo/$I"
if ! test -e /etc/nginx/conf.d/dedalo-00-media-map.conf; then
  MAP_OWNER=true   # this instance writes the map: its host record says so
  render > /etc/nginx/conf.d/dedalo-00-media-map.conf <<'EOF'
# dedalo-install media map — WRITTEN BY THE INSTALLER. The media gate's map variables
# are global to nginx: ONE instance's map (its root-owned, validated copy) is included
# here for every Dédalo instance on this host (the installer refuses an instance whose
# map differs — keep same-host instances at the same release).
include /etc/nginx/dedalo/@@INSTANCE@@/media_protection_map.conf;
EOF
fi
```

When the file exists, it names another instance's copy. Both instances must run the same release, because the map is shared.

**The site file, nginx** (Let's Encrypt, media gate on):

```shell
render > "$SITE" <<'EOF'
# dedalo-install @@INSTANCE@@ manual
# Dédalo instance @@INSTANCE@@ — WRITTEN BY THE INSTALLER (scripts/install.ts, production
# route) or by docs/install/manual_install.md, which renders the same bytes. Every other
# site, the default site and the global configuration are untouched. An installer resume
# compares this file with its own render: change the answers and re-run the installer;
# a by-hand host edits it only where manual_install.md says.

limit_req_zone $binary_remote_addr zone=dedalo_@@INSTANCE@@_api:10m rate=20r/s;
upstream dedalo_@@INSTANCE@@ { server unix:/run/dedalo-@@INSTANCE@@/dedalo_ts.sock; }

server {
	listen 80;
	listen [::]:80;
	server_name @@SERVER_NAME@@;
	server_tokens off;
	location ^~ /.well-known/acme-challenge/ {
		root /var/lib/dedalo-install/acme/@@INSTANCE@@;
		default_type text/plain;
	}
	location / { return 301 https://$host$request_uri; }
}

server {
	listen 443 ssl;
	listen [::]:443 ssl;
	http2 on;
	server_name @@SERVER_NAME@@;
	server_tokens off;
	ssl_certificate     /etc/letsencrypt/live/dedalo-@@INSTANCE@@/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/dedalo-@@INSTANCE@@/privkey.pem;
	ssl_protocols       TLSv1.2 TLSv1.3;
	access_log @@LOG_DIR@@/dedalo-@@INSTANCE@@.access.log;
	error_log  @@LOG_DIR@@/dedalo-@@INSTANCE@@.error.log;
	# THE ROOT RULE: root + /dedalo/<media dir>/… == MEDIA_PATH/…
	root /srv/dedalo/@@INSTANCE@@;
	client_max_body_size 300m;
	add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
	add_header X-Content-Type-Options "nosniff" always;
	add_header X-Frame-Options "SAMEORIGIN" always;
	add_header Referrer-Policy "strict-origin-when-cross-origin" always;
	# The media gate: a root-owned, validated copy of the rules the engine generates
	# (deploy/dedalo-media-rules.sh — never the instance-writable file itself).
	include /etc/nginx/dedalo/@@INSTANCE@@/media_protection.conf;
	open_file_cache off;
	location = /health {
		proxy_pass http://dedalo_@@INSTANCE@@;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}
	location ~ ^/(api/v1/|dedalo/core/api/) {
		proxy_pass http://dedalo_@@INSTANCE@@;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
		limit_req zone=dedalo_@@INSTANCE@@_api burst=40 nodelay;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto $scheme;
		proxy_read_timeout 300s;
		proxy_send_timeout 300s;
		proxy_buffering off;
	}
	location /dedalo/lib/ {
		proxy_pass http://dedalo_@@INSTANCE@@;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}
	location /dedalo/tools/ {
		proxy_pass http://dedalo_@@INSTANCE@@;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}
	location /dedalo/core/tools_common/ {
		proxy_pass http://dedalo_@@INSTANCE@@;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}
	location /dedalo/install/import/ontology/ {
		proxy_pass http://dedalo_@@INSTANCE@@;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}
	location /dedalo/install/code/ {
		proxy_pass http://dedalo_@@INSTANCE@@;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}
	location /dedalo/install/import/hierarchy/ {
		proxy_pass http://dedalo_@@INSTANCE@@;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}
	location /dedalo/ai_models/ {
		proxy_pass http://dedalo_@@INSTANCE@@;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}
	location /dedalo/upload_tmp/ {
		proxy_pass http://dedalo_@@INSTANCE@@;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}
	location = /dedalo/core/component_text_area/tag/ {
		proxy_pass http://dedalo_@@INSTANCE@@;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
	}
	location /dedalo/export/artifact/ {
		proxy_pass http://dedalo_@@INSTANCE@@;
		proxy_http_version 1.1;
		proxy_set_header Host $host;
		proxy_buffering off;
	}
	location = /dedalo { return 302 /dedalo/core/page/; }
	location = /dedalo/ { return 302 /dedalo/core/page/; }
	location = /dedalo/core { return 302 /dedalo/core/page/; }
	location = /dedalo/core/ { return 302 /dedalo/core/page/; }
	location /dedalo/ {
		alias /srv/dedalo/@@INSTANCE@@/client/dedalo/;
		etag on;
		add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
		add_header X-Content-Type-Options "nosniff" always;
		add_header X-Frame-Options "SAMEORIGIN" always;
		add_header Referrer-Policy "strict-origin-when-cross-origin" always;
		add_header Cache-Control "no-cache";
		gzip on;
		gzip_types text/css application/javascript application/json image/svg+xml;
		gzip_min_length 1024;
		location ~* \.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$ {
			add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
			add_header X-Content-Type-Options "nosniff" always;
			add_header X-Frame-Options "SAMEORIGIN" always;
			add_header Referrer-Policy "strict-origin-when-cross-origin" always;
			add_header Cache-Control "public, max-age=3600";
		}
	}
	location = / { return 302 /dedalo/core/page/; }
	location   / { return 404; }
}
EOF
```

**The site file, Apache** (Let's Encrypt, media gate on):

```shell
render > "$SITE" <<'EOF'
# dedalo-install @@INSTANCE@@ manual
# Dédalo instance @@INSTANCE@@ — WRITTEN BY THE INSTALLER (scripts/install.ts, production
# route) or by docs/install/manual_install.md, which renders the same bytes. Every other
# site, the default site and the global configuration are untouched. An installer resume
# compares this file with its own render: change the answers and re-run the installer;
# a by-hand host edits it only where manual_install.md says.

<VirtualHost *:80>
	ServerName @@SERVER_NAME@@
	DocumentRoot /var/www/empty
	Alias /.well-known/acme-challenge/ /var/lib/dedalo-install/acme/@@INSTANCE@@/.well-known/acme-challenge/
	<Directory /var/lib/dedalo-install/acme/@@INSTANCE@@>
		Require all granted
	</Directory>
	RewriteEngine On
	# Only this site's own name: any other Host is refused (421), never served.
	RewriteCond %{HTTP_HOST} !^@@SERVER_NAME_RE@@(:80)?$ [NC]
	RewriteRule ^ - [R=421,L]
	RewriteCond %{REQUEST_URI} !^/\.well-known/acme-challenge/
	RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
</VirtualHost>

<VirtualHost *:443>
	ServerName @@SERVER_NAME@@
	Protocols h2 http/1.1
	SSLEngine on
	SSLCertificateFile    /etc/letsencrypt/live/dedalo-@@INSTANCE@@/fullchain.pem
	SSLCertificateKeyFile /etc/letsencrypt/live/dedalo-@@INSTANCE@@/privkey.pem
	SSLProtocol -all +TLSv1.2 +TLSv1.3
	DocumentRoot /var/www/empty
	ErrorLog @@LOG_DIR@@/dedalo-@@INSTANCE@@.error.log
	CustomLog @@LOG_DIR@@/dedalo-@@INSTANCE@@.access.log combined
	LimitRequestBody 314572800
	RewriteEngine On
	# Only this site's own name: any other Host is refused (421), never served.
	RewriteCond %{HTTP_HOST} !^@@SERVER_NAME_RE@@(:443)?$ [NC]
	RewriteRule ^ - [R=421,L]
	ProxyPreserveHost On
	ProxyTimeout 300
	ProxyPass /health unix:/run/dedalo-@@INSTANCE@@/dedalo_ts.sock|http://localhost/health
	ProxyPass /api/v1/ unix:/run/dedalo-@@INSTANCE@@/dedalo_ts.sock|http://localhost/api/v1/
	ProxyPass /dedalo/core/api/ unix:/run/dedalo-@@INSTANCE@@/dedalo_ts.sock|http://localhost/dedalo/core/api/
	ProxyPass /dedalo/lib/ unix:/run/dedalo-@@INSTANCE@@/dedalo_ts.sock|http://localhost/dedalo/lib/
	ProxyPass /dedalo/tools/ unix:/run/dedalo-@@INSTANCE@@/dedalo_ts.sock|http://localhost/dedalo/tools/
	ProxyPass /dedalo/core/tools_common/ unix:/run/dedalo-@@INSTANCE@@/dedalo_ts.sock|http://localhost/dedalo/core/tools_common/
	ProxyPass /dedalo/install/import/ontology/ unix:/run/dedalo-@@INSTANCE@@/dedalo_ts.sock|http://localhost/dedalo/install/import/ontology/
	ProxyPass /dedalo/install/code/ unix:/run/dedalo-@@INSTANCE@@/dedalo_ts.sock|http://localhost/dedalo/install/code/
	ProxyPass /dedalo/install/import/hierarchy/ unix:/run/dedalo-@@INSTANCE@@/dedalo_ts.sock|http://localhost/dedalo/install/import/hierarchy/
	ProxyPass /dedalo/ai_models/ unix:/run/dedalo-@@INSTANCE@@/dedalo_ts.sock|http://localhost/dedalo/ai_models/
	ProxyPass /dedalo/upload_tmp/ unix:/run/dedalo-@@INSTANCE@@/dedalo_ts.sock|http://localhost/dedalo/upload_tmp/
	ProxyPass /dedalo/core/component_text_area/tag/ unix:/run/dedalo-@@INSTANCE@@/dedalo_ts.sock|http://localhost/dedalo/core/component_text_area/tag/
	ProxyPass /dedalo/export/artifact/ unix:/run/dedalo-@@INSTANCE@@/dedalo_ts.sock|http://localhost/dedalo/export/artifact/
	ProxyPassReverse /health unix:/run/dedalo-@@INSTANCE@@/dedalo_ts.sock|http://localhost/health
	ProxyPass /dedalo/media !
	ProxyPass /dedalo !
	RedirectMatch 302 "^/dedalo/?$" /dedalo/core/page/
	RedirectMatch 302 "^/dedalo/core/?$" /dedalo/core/page/
	RedirectMatch 302 "^/$" /dedalo/core/page/
	Alias /dedalo/media /srv/dedalo/@@INSTANCE@@/dedalo/media
	<Directory /srv/dedalo/@@INSTANCE@@/dedalo/media>
		# The generated .htaccess IS the gate: without these overrides it is ignored, OPEN.
		# Only what it uses — never All (the instance user writes it).
		AllowOverride AuthConfig FileInfo Options=Indexes,ExecCGI
		Options -Indexes -ExecCGI
		Require all granted
	</Directory>
	# Merged after every .htaccess: whatever the media tree says, no listing, no CGI.
	<Location "/dedalo/media/">
		Options -Indexes -ExecCGI
	</Location>
	Alias /dedalo /srv/dedalo/@@INSTANCE@@/client/dedalo
	<Directory /srv/dedalo/@@INSTANCE@@/client/dedalo>
		Options -Indexes
		AllowOverride None
		Require all granted
		Header set Cache-Control "no-cache"
	</Directory>
	Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
	Header always set X-Content-Type-Options "nosniff"
	Header always set X-Frame-Options "SAMEORIGIN"
	Header always set Referrer-Policy "strict-origin-when-cross-origin"
</VirtualHost>
EOF
/usr/sbin/a2ensite "dedalo-$I"                             # Debian and Ubuntu only, if not done in host_web_http
```

Three variations of these files:

- **Your institution's certificate.** Put its two paths on the `ssl_certificate`/`ssl_certificate_key` lines (or `SSLCertificateFile`/`SSLCertificateKeyFile` on Apache), and delete the challenge lines from the plain-HTTP server: the `location ^~ /.well-known/acme-challenge/ { … }` block on nginx; the `Alias /.well-known/…` line, its `<Directory …>` block and the `RewriteCond` line on Apache.
- **`DEDALO_MEDIA_ACCESS_MODE=false`** (no media gate): see below, and skip the media rules above.
- **Ports other than 80 and 443.** Change the `listen` and `<VirtualHost>` ports, and add the HTTPS port to the redirect (`https://$host:8443$request_uri`). Apache also needs a `Listen` line in its global configuration.

**Without the media gate**, the installer writes two other lines in place of the gate's three. On nginx, replace the two `# The media gate: …` comment lines and the `include …/media_protection.conf;` line with:

```nginx
	# MEDIA ACCESS CONTROL IS OFF (media_access_mode false): every media file is public.
	location /dedalo/media/ { open_file_cache off; }
```

On Apache, replace the two `# The generated .htaccess IS the gate: …` comment lines and the `AllowOverride AuthConfig …` line with:

```apache
		# MEDIA ACCESS CONTROL IS OFF (media_access_mode false): every media file is public.
		AllowOverride None
```

**The catch-all site (nginx).** A web server answers a name no site declares with its default site, which on a host with only Dédalo sites would be an instance. On nginx, one host-wide site, written once, takes that place for ports 80 and 443 and serves nothing ([The catch-all site](reverse_proxy.md#the-catch-all-site)). Skip it when this instance uses other ports, or when the file already exists (another instance wrote it). Apache needs no such file: each of its virtual hosts above refuses any `Host` but its own with `421`.

```shell
CATCHALL=$(dirname "$SITE")/dedalo-00-default.conf
test -e "$CATCHALL" || render > "$CATCHALL" <<'EOF'
# dedalo-install catch-all
# Answers every name no site of this host declares, so an unknown name never reaches an
# instance. The default BY ORDER (this file sorts first), never `default_server`: a
# default_server another site declares stays the default. Shared by every Dédalo
# instance; removed with the last one. Written by the installer: never edit it.
server {
	listen 80;
	listen [::]:80;
	server_name dedalo-catch-all.invalid;
	return 444;
}
server {
	listen 443 ssl;
	listen [::]:443 ssl;
	server_name dedalo-catch-all.invalid;
	ssl_reject_handshake on;
}
EOF
```

The file is the default site **by order**, never with `default_server`: `conf.d` is read before `sites-enabled`, and the file sorts before every `dedalo-<i>.conf`. A site of yours that declares `listen … default_server` (Debian's own `default` site does, on port 80) therefore stays the default for its port, and nginx never sees two defaults.

Test and reload, as in [`host_web_http`](#manual-host_web_http). If the test fails, put the previous file back before you reload: never leave the web server with a configuration it would refuse.

**Verify:** `nginx -t` (or `apachectl configtest`); `curl --fail "https://$NAME/health"`; `curl -sk -o /dev/null -w '%{http_code}\n' --resolve other.invalid:443:127.0.0.1 https://other.invalid/` does not print `200` (nginx refuses the handshake and prints `000`; Apache answers `421`).

## `host_public_probe` — the instance through its public address {#manual-host_public_probe}

Installer: [Production › `host_public_probe`](production.md#host_public_probe-the-instance-through-its-public-address).

Check what an outside browser gets: `/health` answers `200` over HTTPS with a verified certificate chain. With the media gate on, the marker store and an unpublished file both answer `404` to an anonymous request. `--resolve` connects to this host, so split-horizon DNS or a router without hairpin NAT cannot fail a correct install:

```shell
$RU /usr/bin/install -D -m 0640 /dev/null "$MEDIA/image/thumb/dd_install_probe_dd0_0.jpg"
for path in /health /dedalo/media/.publication/auth/ /dedalo/media/image/thumb/dd_install_probe_dd0_0.jpg; do
  /usr/bin/curl -sS -o /dev/null -w "%{http_code} $path\n" --max-time 20 \
    --resolve "$NAME:443:127.0.0.1" "https://$NAME$path"
done
# 200 /health · 404 /dedalo/media/.publication/auth/ · 404 /dedalo/media/image/thumb/dd_install_probe_dd0_0.jpg
$RU /usr/bin/rm -f "$MEDIA/image/thumb/dd_install_probe_dd0_0.jpg"
```

Give the reload a few seconds; the installer retries for up to 90 seconds. Add `--insecure` only for a staging certificate. When a check fails, see [Troubleshooting › The public probe fails](troubleshooting.md#the-public-probe-fails). Then check the same from another machine: `curl --fail "https://$NAME/health"`.

## `host_backup_verify` — the first backup, verified {#manual-host_backup_verify}

Installer: [Production › `host_backup_verify`](production.md#host_backup_verify-the-first-backup-verified).

Run the backup set once and check its **outcome**, not its exit code. Only then arm the nightly timer:

```shell
/usr/bin/systemctl start --wait "dedalo-backup@$I.service"            # exit 0, 1 or 3: read the outcome below
cat "$BACKUP_DIR/state/LAST_OK"                                       # written by this run: "  matrix_db: exit 0", "  media: exit 0", "  private: exit 0"
test ! -e "$BACKUP_DIR/state/BACKUP_FAILED" && echo no-failure
systemctl show -p Environment "dedalo-backup@$I" | grep -o 'DEDALO_BACKUP_EXPECTED_STORES=matrix_db media private'
/usr/bin/systemctl enable --now "dedalo-backup@$I.timer"
```

With the site-builder store, run `systemctl start --wait "dedalo-backup-site-builder@$I.service"` too, and check `/var/lib/dedalo-install/backup/$I/LAST_OK` for `  site_builder: exit 0`.

The set covers the database, the media and the private directory. The **semantic-search (RAG) database** is not in it: if you enable RAG, back that database up yourself. What each store holds, retention and the restore drill are in [backup](../management/backup.md). A backup that has never been restored is a hypothesis: restore-test it into a scratch database at least once a quarter.

**Verify:** `systemctl list-timers "dedalo-backup@$I.timer"`.

## Register the instance on the host {#register-the-instance}

The installer keeps one record per instance in `/var/lib/dedalo-install/instances/<i>.json`. It reads these records for two things. It refuses a new instance that would share a user, a group or a folder with another. And when it undoes another instance (`--abort`), it keeps the shared pieces that a recorded instance still uses: the unit templates, `/opt/dedalo/bun/<pin>`, the `dedalo_engine` module, the nginx media map include and the catch-all site. Without a record, an installer `--abort` of a neighbouring instance could remove the templates and the runtime this instance runs on. Write it:

```shell
render > "/var/lib/dedalo-install/instances/$I.json" <<'EOF'
{
	"instance": "@@INSTANCE@@",
	"bun_pin": "@@PIN@@",
	"templates": true,
	"selinux_module": @@SELINUX_MODULE@@,
	"nginx_map_owner": @@NGINX_MAP_OWNER@@,
	"catch_all": true,
	"media": "/srv/dedalo/@@INSTANCE@@/dedalo/media",
	"user": "@@USER@@",
	"group": "@@GROUP@@",
	"install_dir": "@@DIR@@",
	"backup_dir": "@@BACKUP_DIR@@"
}
EOF
```

`"selinux_module"` is rendered from `$SELINUX_MODULE` (set with the variables): `true` whenever [`host_selinux`](#manual-host_selinux) applied on this host (the RHEL family, SELinux `Enforcing` or `Permissive`), whether you loaded the policy module or found it already loaded. The flag means *this instance uses the module*, and an installer `--abort` of another instance keeps the module only while a record says so. `"nginx_map_owner"` is rendered from `$MAP_OWNER`: `true` when [`host_web_site`](#manual-host_web_site) wrote `/etc/nginx/conf.d/dedalo-00-media-map.conf` for this instance, `false` when another instance had written it, and always `false` on Apache. In a shell other than the one that wrote the map, set `MAP_OWNER=true` by hand before rendering the record. Set `"catch_all": false` on Apache, if this instance uses other ports than 80 and 443, or if you skipped the catch-all because the file is not the installer's: the flag counts the instances that use the catch-all, and an `--abort` of another instance removes it only when no record says `true`. `"media"` stays as printed: on this page `MEDIA_PATH` is always `/srv/dedalo/<i>/dedalo/media`.

## After the install

The instance is now the same as one the installer built, so everything after the install is on the Production page:

- open `https://<address>/dedalo/core/page/`, log in as `root`, create an admin user, then users and projects ([After the install](index.md#after-the-install));
- [tuning `.env`](production.md#tuning-env), [changing the media access mode](production.md#changing-the-media-access-mode), [adding a domain ontology](production.md#adding-a-domain-ontology-later) and the [optional subsystems](production.md#optional-subsystems);
- [verify, then harden](production.md#verify-then-harden): the whole path once, a reboot test, and the settings that must keep their production values;
- [what the installer does not do after the install](production.md#what-the-installer-does-not-do-after-the-install): refreshing the root-run scripts after a release that changes them, a new Bun pin, and removing an instance. These stay manual on every host.

## A migrated v6 host {#a-migrated-v6-host}

A v6 installation [migrated to v7](migrating_from_v6.md) is never an installer instance: the installer only installs into an empty database, and the migration restores a full one. Build its host with this page, with three differences:

- **[`host_identity`](#manual-host_identity).** On an in-place upgrade, the v6 service user and its home already exist. Use that account as it is, and give it a group of its own ([Phase E › Give the adopted user its own group](migrating_from_v6.md#82-give-the-adopted-user-its-own-group)). Choose an install folder that it owns.
- **[`host_engine`](#manual-host_engine)** is not run. The migration restores the database into the empty one from [`host_database`](#manual-host_database), and its Phase C writes `.env`. Phase D verifies the result.
- **The units onwards** ([`host_units`](#manual-host_units) to [`host_backup_verify`](#manual-host_backup_verify)) come after Phase D, as [Phase E](migrating_from_v6.md#8-phase-e-run-it-as-a-service). `SERVER_UNIX_SOCKET` in `.env` must be `/run/dedalo-<i>/dedalo_ts.sock`, and `MEDIA_PATH` must be `/srv/dedalo/<i>/dedalo/media`: copy the carried-over media tree there (or mount its volume there) and set that path in Phase C. Every file and rule on this page names that path — the site's web root, the SELinux label, the media rules and the public probe — so a media tree anywhere else would be served by none of them.

## Several instances by hand {#several-instances-by-hand}

Repeat the page with another instance name. Everything instance-specific follows the name: the units (`dedalo-ts@<i>`), the socket, the database, `/srv/dedalo/<i>`, the root bin directory and the site file. Each instance needs its own user, group and folder. The account name, its home and the instance name need not agree, because the drop-ins say each of them explicitly. The shared pieces — the templates, the runtime of a pin, the policy module and the nginx media map — are installed once and stay byte-equal. Same-host instances therefore run the same release. `DB_POOL_MAX` is per process: budget the sum against PostgreSQL's `max_connections`. [Several instances on one host](multi_instance.md) explains what each instance must not share.

The installer's unit names are reserved for this procedure. Never write a different file under the name of a template (`dedalo-ts@.service` and its siblings): the installer refuses to install another instance on a host where one differs.

## The single-unit set (hosts set up before 2026-10-12) {#the-single-unit-set}

Hosts set up by hand before this page used a different unit set: `deploy/dedalo-ts.service` and its siblings, one unit per installation, rendered from three placeholders. These units are still shipped and still checked, so a host that runs them keeps working, and the commands below stay valid for it. A **new** hand install uses the templates above instead: only the templates are identical to what the installer writes.

??? note "The layout, the render and the web server of the single-unit set"

    | | A single instance | Several instances, one per domain |
    | --- | --- | --- |
    | instance directory (service user's) | `/opt/dedalo/app/` | `/home/my_domain.org/dedalo/` |
    | the code | `/opt/dedalo/app/master_dedalo/` | `/home/my_domain.org/dedalo/master_dedalo/` |
    | root bin directory: runtime `bun` and root-run scripts | `/opt/dedalo/bin/` | `/usr/local/lib/dedalo/my_domain.org/bin/` |
    | service user and group | `dedalo` | one per instance, for example `my_domain` |
    | `MEDIA_PATH` | `/srv/dedalo/media/` | `/srv/dedalo/my_domain.org/media/` |
    | socket (`RuntimeDirectory=dedalo`) | `/run/dedalo/dedalo_ts.sock` | one directory per instance |

    | Placeholder | What |
    | --- | --- |
    | `DEDALO_USER` | the service user. In `dedalo-backup-alert@.service` it is also the `Group=`: change that line when the group has another name. The other units set only `User=`, so they run with the user's primary group |
    | `INSTANCE_DIR` | the instance directory (the service user's) |
    | `ROOT_BIN_DIR` | the root bin directory (root's, outside the instance directory) |

    Install the root-run scripts into the root bin directory, then render the units, substituting all three placeholders as whole words:

    ```shell
    DEDALO_USER=dedalo INSTANCE_DIR=/opt/dedalo/app ROOT_BIN_DIR=/opt/dedalo/bin
    cd "$INSTANCE_DIR/master_dedalo"
    sudo install -m 0755 deploy/dedalo-code-rollback.sh deploy/dedalo-ts-watchdog.sh \
      deploy/dedalo-backup-step.sh deploy/dedalo-db-backup.sh deploy/dedalo-tree-backup.sh \
      deploy/dedalo-site-builder-backup.sh deploy/dedalo-backup-alert.sh "$ROOT_BIN_DIR/"
    for unit in deploy/dedalo-ts*.service deploy/dedalo-ts*.timer deploy/dedalo-backup*.service deploy/dedalo-backup.timer; do
      sed -e "s|\<DEDALO_USER\>|$DEDALO_USER|g" -e "s|\<INSTANCE_DIR\>|$INSTANCE_DIR|g" \
          -e "s|\<ROOT_BIN_DIR\>|$ROOT_BIN_DIR|g" "$unit" | sudo tee "/etc/systemd/system/${unit#deploy/}" >/dev/null
    done
    grep -nE '\<(DEDALO_USER|INSTANCE_DIR|ROOT_BIN_DIR)\>' /etc/systemd/system/dedalo-ts*.service /etc/systemd/system/dedalo-backup*.service
    ```

    The last command must print nothing. The loop installs `deploy/dedalo-backup-alert@.service` as `/etc/systemd/system/dedalo-backup-alert@.service`: the **same name** as the installer's alert template, with a different body. A host running the single-unit set can therefore never also host instances of the installer or of this page: the installer refuses a host whose template differs, and this page's `host_units` stops on it. On the RHEL family, change `postgresql.service` to `postgresql-18.service` in the server unit's `After=` and `Wants=`. `SERVER_UNIX_SOCKET=/run/dedalo/dedalo_ts.sock` in `.env` must sit under the unit's `RuntimeDirectory`. Then `systemctl daemon-reload` and `systemctl enable --now dedalo-ts.service dedalo-ts-watchdog.timer dedalo-backup.timer`. The site is the [hand-written one](reverse_proxy.md#a-site-written-by-hand); the web server's user joins the service group, and the web server is then **restarted**.

    Several installations on one host give each its own unit names (for example `dedalo-ts-my_domain.service`), and rename every reference between them: the `OnFailure=`, `Wants=`, `Requisite=`, `After=` and `Also=` lines, the `--service`, `--socket` and unit arguments of the watchdog and rollback lines, and `RuntimeDirectory=` with the socket under it.
