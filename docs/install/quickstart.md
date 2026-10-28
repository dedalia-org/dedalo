# Trial

> See also: [Installation hub](index.md) · [Docker](docker.md) · [Production install](production.md) · [Installer reference](installer_reference.md) · [Troubleshooting](troubleshooting.md)

The Trial route installs a complete Dédalo in containers on one machine, for an evaluation or a demonstration. It is the same engine with the same data model and features. What it leaves out is everything that protects real records.

!!! danger "Plain HTTP and no media protection: evaluation only"
    The trial stack serves **plain HTTP**, with no certificate, and has **no media access control**: every image, document and recording is readable by anyone who can reach the machine, without logging in. The installer makes you type `yes` to that before it goes on.

    Do not put records you need to keep, restricted material or personal data in a trial. A collection that is going to be used belongs on the [Production](production.md) or [Docker](docker.md) route.

## What you need

- **Docker Engine and the Compose v2 plugin, 2.24.4 or newer** (`docker compose`, not the old `docker-compose`). The installer checks them and tells you how to fix what is missing; it never installs Docker or changes group membership. To install them:
    - **Ubuntu:**

        ```shell
        sudo apt install docker.io docker-compose-v2 docker-buildx
        ```

    - **Debian and the RHEL family** (RHEL, AlmaLinux, Rocky): Docker's own repository, as [docs.docker.com/engine/install](https://docs.docker.com/engine/install/) describes for each distribution. On the RHEL family that procedure first removes the `podman`, `buildah` and `runc` packages the system ships.

    - **macOS:** Docker Desktop.

    **Podman, and `podman-docker`, are not supported.**

- **Your user in the `docker` group**, so the daemon answers without `sudo`:

    ```shell
    sudo usermod -aG docker "$USER"
    ```

    then log out and in again or run

    ```shell
    newgrp docker
    ```

    in the shell you install from. Membership of `docker` is root-equivalent.

- **`curl`, `unzip`, `sha256sum` and `git`**: `install.sh` downloads the Bun runtime with `curl`, checks it with `sha256sum` and unpacks it with `unzip`, and `git` gets the checkout.

    On Ubuntu and Debian,

    ```shell
    sudo apt install curl unzip git
    ```

    on the RHEL family (`sha256sum` comes with the system),

    ```shell
    sudo dnf install curl unzip git
    ```

- **About 8 GiB free** under Docker's root directory: the engine image is about 2.5 GB and PostgreSQL about 0.7 GB, and a local image build parks about 3 GB of build cache. Below that the database restore fails part-way with `No space left on device`, so the installer refuses first. A Docker root it cannot measure (a VM, a remote daemon) skips the check.
- **Port 80 free** on the machine, or another HTTP port chosen on the *Containers* screen. The trial publishes no HTTPS port.
- **`cosign`**, if you install an official image: its signature is verified. Without `cosign`, choose a local build instead.
- **The image of this release.** The installer installs the image of its own release, named in its header: `7.0.1` for a stable release, `7.0.0-beta.7 (prerelease)` for a beta. A development checkout (a commit with no release tag) is no image: the installer refuses Official and Build for it, and preselects **Custom** (`--image-source custom`, a registry of your own). The Review checks the registry before you type `yes`: an official image that is not published — a beta whose image is not out yet, for example — is refused there, with your answers kept; choose **Build** then (a first build takes about 2 to 6 minutes on 2 CPUs, longer on a slow network or disk) ([Docker: which official image the installer asks for](docker.md#which-official-image-the-installer-asks-for)).

Check by hand first if you like:

```shell
docker --version
docker compose version     # 2.24.4 or newer
docker info                # an error here = the daemon is not running, or your user cannot reach it
```

!!! warning "Published ports bypass the host firewall"
    Docker writes its own packet-filter rules for every published port, ahead of the host firewall's: the trial's HTTP port is reachable from the network even when `firewalld` or `ufw` does not allow it. To restrict who reaches it, filter in Docker's `DOCKER-USER` chain, which Docker consults before its own rules ([Docker and the firewall](https://docs.docker.com/engine/network/packet-filtering-firewalls/)). Remember that anyone who reaches the port reads every media file.

## Run the installer

From the checkout of Dédalo ([Get Dédalo](index.md#get-dedalo)), as yourself:

```shell
sh install.sh
```

Choose **Trial** on the first screen and answer the screens in the terminal; `sh install.sh --plain` asks the same questions one per line. Give no other flag: any answer flag, `--route` included, makes the run headless, and a headless run takes every answer from its flags or an answers file (see [Command-line flags](installer_reference.md#command-line-flags)).

## The screens

| Screen | What it asks |
| --- | --- |
| **Install type** | the route, and the acknowledgement that the trial has no media protection (type `yes`; the full screen also ticks it with Space) |
| **System check** | nothing: it shows what this machine has (Docker, Compose, disk). A failed row must be fixed first |
| **Image** | where the Dédalo image comes from: an **official** registry (verified with `cosign`), a registry of your **own**, or a local **build** from this checkout's last commit. **Image version** is the image tag: leave it empty for the installer's own version — the only one accepted besides its `-dev` tag, because the engine steps run inside the image with this installer's request format |
| **Containers** | the published HTTP port (`80` by default) |
| **Identity** | the institution's short code (`entity`) and full name, the install fingerprint (**Information** and **Info key** — keep the defaults), the locale and the time zone. The time zone stamps every database timestamp |
| **Ontologies** | the domain ontologies: Oral history (`oh`) is built in and pre-ticked; others come from the update server, with what they declare. Also whether to use the official update servers |
| **Thesauri** | the thesauri the chosen ontologies declare, pre-ticked. Nothing else is pre-selected, and no country's toponymy. The thesauri are created empty: only `lg` and the country toponymies carry terms |
| **Languages** | the interface and data languages |
| **Publication**, **Mail** | optional: a MariaDB publication target and an SMTP relay. On this route the connections are tested inside the container, during the install |
| **Administrator** | the `root` password, typed twice and checked against the password policy |
| **Review plan** | everything that will happen, and every command — see below |

The database name, its user, the media root and the socket are fixed by the stack, and the database password is generated during the install and never shown. Every screen is described in the [installer reference](installer_reference.md#interactive-mode).

## The Review

Nothing has changed on the machine until you type `yes` here. The Review lists the answers, the ontologies in install order, the thesauri, the languages, the steps, and **every command each host step will run** — exactly the commands the run executes:

| Step | What it does |
| --- | --- |
| `stack_preflight` | checks Docker, Compose v2, the free disk, that no Dédalo instance is already here (`dedalo_private` volume), that no stack files of an earlier install are left (`.dedalo.env`, `compose.override.yaml`), and the image source — an official image must be published for this release (a development build has none) |
| `stack_image` | pulls the image and verifies its signature and version label, or builds it here from a clean snapshot of the checkout's last commit (`deploy/dedalo-image-build.sh`: committed files only, the image labelled with its version), printing each build step as it starts (a first build takes about 2 to 6 minutes on 2 CPUs, longer on a slow network or disk) |
| `stack_files` | writes `.dedalo.env` (`0600`, with the generated database password) and `compose.override.yaml` (plain HTTP only: no HTTPS port, no certificate volumes) into the checkout |
| `stack_database` | starts PostgreSQL and waits for it |
| `stack_engine` | runs the engine steps inside the container: the database seed, the ontologies, the thesauri, the tools, the `root` password |
| `stack_up` | starts the engine, waits for it, then starts the rest of the stack — nginx always in a new container — and waits for nginx to stay up: its configuration accepted and its HTTP port published |
| `stack_health` | `/health` on the engine's socket and through nginx over plain HTTP, and the reminder that there is no media protection. A `--resume` probes it again, even when an earlier run recorded it done |

At the Review, `write <path>` (or **w** on the full screen) saves your answers as an answers file instead, with no secret in it; `sh install.sh --answers <file>` installs from it later. That run asks nothing: give it the `root` password in `DEDALO_INSTALL_ROOT_PASSWORD`, or on standard input with `--secrets-stdin` ([Secrets](installer_reference.md#secrets)).

## Done

When the install completes, the Done screen shows the outcome and the generated `DEDALO_SALT_STRING` **once** — keep it with your backups. Open `http://<this machine's address>/dedalo/` (add `:<port>` if you published another HTTP port) and log in as **`root`** with the password you chose.

The installer's record of this install is in `<checkout>/.dedalo-install/`. If the install stops part-way, fix the cause and run `sh install.sh --route trial --resume`; it continues from the failed step. A resume runs in line mode, not on the full screen, and asks again for the secrets the remaining steps need. See [Resume and abort](installer_reference.md#resuming-an-install-resume).

The salt is shown once, by the run whose engine steps generate it — on the full screen in the install view and on the card that ends that run (installed, or failed); a later `--resume` does not show it again. A run stopped with Ctrl-C leaves the full screen without that card, so its ✖ block names the command that reads the salt back instead — as does the ✖ block of every run that fails after the salt was generated. Every run that completes the install also lists, under *To do on this host*, the same command, which reads the salt from the `private` volume whether the stack is running or not:

```shell
docker compose -f docker-compose.simple.yml -f compose.override.yaml --env-file .dedalo.env run --rm --no-deps dedalo grep ^DEDALO_SALT_STRING= /private/.env
```

Then continue with [After the install](index.md#after-the-install).

## Everyday commands

Every compose command carries the same three files: the stack file, the installer's override and the environment file. Leave out `--env-file .dedalo.env` and compose resolves the built-in defaults instead of your install's values.

```shell
docker compose -f docker-compose.simple.yml -f compose.override.yaml --env-file .dedalo.env ps
docker compose -f docker-compose.simple.yml -f compose.override.yaml --env-file .dedalo.env logs -f dedalo
docker compose -f docker-compose.simple.yml -f compose.override.yaml --env-file .dedalo.env stop    # stop, keep everything
docker compose -f docker-compose.simple.yml -f compose.override.yaml --env-file .dedalo.env up -d   # start again
```

To update the image, run `./deploy/dedalo-image-update.sh --version <version>` from the checkout: it backs up the database, gets the new image from where this install took it, and rolls back on its own if the new version does not come up healthy. It is the same procedure as on the [Docker route](docker.md#upgrading).

## Removing the trial

An install that **failed or was interrupted** is undone with:

```shell
sh install.sh --route trial --abort --confirm-database dedalo
```

It removes, in reverse order, only what this install created: its containers, the volumes it created, the files it wrote and its record. The images stay, and the abort names them with the `docker image rm` command that reclaims the space.

A **completed** trial is a live instance, and `--abort` never takes it apart: it removes the engine, nginx and backup containers and leaves PostgreSQL running with the data, and `--resume` starts them again (a trial stopped before its `dedalo` container ever started has not served: `--abort` removes it whole). Its `docker image rm` line leaves out `postgres:18`, which that container still runs. To remove a finished trial, destroy it yourself — the volumes hold the database, the media and the secrets, so this deletes everything:

```shell
docker compose -f docker-compose.simple.yml -f compose.override.yaml --env-file .dedalo.env down -v
rm .dedalo.env compose.override.yaml
rm -r .dedalo-install
```

Check that nothing is left: `docker volume ls | grep dedalo_` prints nothing.

The images and caches stay on the machine until you remove them — several gigabytes:

```shell
docker image rm localhost/dedalo:<version> postgres:18 nginx:alpine   # or the official image you pulled
docker builder prune -af                                             # a local build's cache (about 3 GB)
rm -rf ~/.cache/dedalo-install ~/.bun/install/cache                  # the installer's Bun and its package cache
rm -rf node_modules                                                  # the installer's packages in this checkout (about 400 MB)
```

`docker image ls` names the Dédalo image the trial ran. Skip the Bun-cache line if you use Bun for anything else. `node_modules` comes back with the next `sh install.sh`; or delete the whole checkout last.

## Moving on from a trial

The installer has no conversion from a trial to another route. When you have decided, install the route you want — [Production](production.md) on a server, or [Docker](docker.md) — as a new install. On this machine, remove the trial first: the Docker route refuses a machine that already holds a Dédalo instance.

## When it fails

| Symptom | Where to look |
| --- | --- |
| `Docker is not installed`, `the Docker daemon does not answer`, `Docker Compose 2.24.4 or newer is required` | [Troubleshooting › Docker and trial refusals](troubleshooting.md#docker-and-trial-refusals) |
| `only N GiB free under …` | the same section |
| `this machine already has a Dédalo instance (volume dedalo_private)` | the same section |
| `cosign is not installed` | install `cosign`, or choose a local build |
| the install stopped at a step | fix the cause, then `--resume` — [Resuming an install](troubleshooting.md#resuming-and-undoing-an-install) |
| `port is already allocated` | another program holds the HTTP port: stop it, or choose another port on the Containers screen |
| `stack_up`: `nginx did not stay up (…)` | nginx refused its configuration; the sentence quotes its `[emerg]` line. Fix what it names, then `--resume` |

Everything else: [troubleshooting](troubleshooting.md).
