# Updating the Bun runtime

> See also: [Upgrading](upgrading.md) · [Production install](production.md) · [Several instances on one host](multi_instance.md) · [Update code](../management/updates/updating_code.md)

Dédalo runs on Bun, and every release pins the exact Bun it was verified on. On an instance installed by the installer, that runtime lives **outside** the instance directory, owned by root, and the service unit names it by absolute path: moving the pin is a host change one administrator makes by hand, install beside the old one and repoint the unit. This page is that procedure, with the checks that prove each step and the gates that refuse when it is skipped.

The worked example is the `1.4.3 → 1.4.4` move; substitute the pin pair of the release you are installing.

## Why the runtime is pinned

The engine is coupled to version-specific runtime behaviour. The `Bun.sql` JSONB parameter inference is the one that matters most — a drift there does not slow anything down, it writes wrong values — and the MariaDB adapter used by diffusion and `Bun.serve`'s defaults are in the same class. Each release is verified on exactly one Bun, records it in `.bun-version`, and the engine compares that file with its own runtime at every start.

!!! danger "Never run `bun upgrade` on a production host"
    `bun upgrade` changes the runtime under the code without changing the pin: nothing was verified, nothing is recorded, and the first symptom is likely to be data rather than a crash. A new pin is always installed **beside** the old one, and the unit is pointed at it.

The pin is enforced at three places, and all three compare for exact equality:

| Where | What it compares | Result |
| --- | --- | --- |
| Boot | the runtime against the running code's `.bun-version` | **warns loudly and starts anyway** |
| Update code panel | the release's `.bun-version` against the running runtime | **refuses the update** |
| Restore code panel | the restore point's `.bun-version` against the running runtime | **refuses the restore** |

The boot echo is the line to look for on every start, on a host whose runtime and pin agree:

```text
Dédalo TS server starting on Bun 1.4.4 (pinned: 1.4.4)
```

A mismatch prints a second line, and it is a warning on purpose — a deliberate, in-progress bump must still boot:

```text
[runtime] Bun 1.4.4 does NOT match the verified pin 1.4.3 (.bun-version). Bun.sql/Bun.serve behavior is version-coupled (audit S2-36) — verify before relying on this runtime.
```

The update and restore refusals are the opposite: they stop before changing anything, because the alternative is code written for one runtime running on another. Their wording is in [the exact strings you will meet](#the-exact-strings-you-will-meet).

## What lives where

| Piece | Path | Owner | Changed by |
| --- | --- | --- | --- |
| the runtime | `/opt/dedalo/bun/<pin>/bun` | `root` | **you**, by hand (this page) |
| the unit | `/etc/systemd/system/dedalo-ts@.service` — **one template per host** — plus the instance's drop-in `dedalo-ts@<i>.service.d/10-dedalo-install.conf` | `root` | the installer wrote both; you repoint `ExecStart` in the drop-in |
| the pin the code declares | `<dir>/dedalo/.bun-version` | the service user | the release — never you |
| the host registry entry | `/var/lib/dedalo-install/instances/<i>.json`, field `bun_pin` | `root` | the installer only (it is its shared-pin refcount, not a status) |
| the installer's copies | `/var/lib/dedalo-install/bun/<pin>/` (the verified zip cache) and `…/bun-shared/<pin>/` (the copy the bootstrap's engine child runs) | `root` | the installer |

`<i>` is the instance name and `<dir>` its install folder — `/home/ded_<i>` unless you chose another. The split follows one rule: **what root-run units execute lives in root-owned directories, outside every instance directory**. The unit runs the binary as the service user, but the service user can never replace what it runs; an in-app code update, which runs as the instance, cannot touch the runtime either. That is why this one step stays yours.

`/opt/dedalo/bun/` is shared by every instance on the host, one directory per pin. Several instances on the same pin run the same bytes; two instances on different pins simply name different paths — which is why the commands below find the instance rather than assume its name.

All the commands below are driven by five shell variables, set once in [step 1](#1-find-the-instance-and-read-the-current-state): `I` (the instance), `U` (its service user), `DIR` (its code tree), `F` (its drop-in) and `PIN_NOW` (the pin the unit names today). Yours to type are the target pin `PIN` and the path of the release archive, in [step 2](#2-get-the-verified-binary).

## The order: runtime first, then the update

The update panel refuses a release whose pin differs from the running runtime, so the runtime has to be in place before the release is applied. After the restart, the code that is *installed* still pins the previous version, so the boot echo carries the mismatch warning until the release that moved the pin is installed. That window is expected and safe:

1. install the new Bun beside the old one;
2. repoint the unit and restart — the boot echo names the new runtime and warns about the old pin;
3. apply the code update — the panel now finds the runtime it needs, and the warning is gone on the next start.

!!! warning "Do not move the runtime while you still need the previous release"
    The gate is exact in **both** directions. A host running Bun 1.4.4 refuses a release whose `.bun-version` is 1.4.3, in the same way a host running 1.4.3 refuses one that pins 1.4.4. Move the runtime when you are ready to take the release that carries the new pin — not before, or you cannot install the releases you were still on.

## Before you start

- **A published release, not an announced one.** The [change log](../change_log.md) has an *Unreleased* section: a pin described there is merged but not installable yet, and every archive the panel can download still pins the old Bun — so moving now leaves you with releases the panel refuses. Move the runtime when the release carrying the pin is published.
- **One root shell.** Every block on this page creates or edits root-owned files (`/var/lib/dedalo-install/`, `/opt/dedalo/`, `/etc/systemd/system/`), and shell variables do not survive `sudo`. Open `sudo -i` once and run the whole page in it, step 1 included.
- **The target pin**, named in the release notes' *Action needed* box.
- **A maintenance window of a minute.** Restarting the server is a few seconds; the host's watchdog probes `/health` every 30 seconds, so a restart is seen as a normal blip, not an outage.
- **A recent, proven database backup if a code update follows.** The runtime step touches no data, but the update run refuses a stale or unproven backup unless you tick the panel's waive-backup box, and it is the moment to have one anyway ([backup](../management/backup.md)).
- **Keep the old runtime.** It is what you roll back to, and it is about 100 MB.

## 1. Find the instance and read the current state

Read-only. The first block fills the variables every later block uses.

```bash
# the Dédalo instances on this host, and their names
systemctl list-units 'dedalo-ts@*' --all --no-legend --no-pager
INSTANCES=$(systemctl list-units --all --plain --no-legend --no-pager 'dedalo-ts@*' \
  | awk '{print $1}' | sed -n 's/^dedalo-ts@\(.*\)\.service$/\1/p')
printf 'instances: %s\n' "$INSTANCES"
COUNT=$(printf '%s\n' "$INSTANCES" | grep -c .)
if [ -z "$I" ] && [ "$COUNT" -gt 1 ]; then
  echo "STOP: more than one instance — set I=<name> from the list above and re-run this block"
else
  I=${I:-$(printf '%s\n' "$INSTANCES" | head -1)}
fi

# everything else is read from the unit the installer wrote
U=$(sudo systemctl show -p User --value "dedalo-ts@$I")
DIR=$(sudo systemctl show -p WorkingDirectory --value "dedalo-ts@$I")
F="/etc/systemd/system/dedalo-ts@$I.service.d/10-dedalo-install.conf"
PIN_NOW=$(sudo sed -n 's#^ExecStart=/opt/dedalo/bun/\([^/]*\)/bun.*#\1#p' "$F" | head -1)
printf 'instance=%s user=%s tree=%s\n' "$I" "$U" "$DIR"
printf 'drop-in=%s runtime-pin=%s code-pin=%s\n' "$F" "$PIN_NOW" "$(sudo cat "$DIR/.bun-version")"
[ -n "$PIN_NOW" ] || echo "STOP: no ExecStart in $F — this is not an installer instance"
```

A host whose instance has never been started lists no unit; in that case run `systemctl list-unit-files 'dedalo-ts@*'` and set `I` by hand from its output. The instance name is everything between `@` and `.service`, dots included — a host set up by hand is often named after its domain (`dedalo-ts@example.org`).

`PIN_NOW` is deliberately read from the unit, not from the code: they are the same value on a healthy host, and when they differ the unit is the one that runs. The code's pin is printed beside it (`code-pin`), and [the mismatch warning](#why-the-runtime-is-pinned) is what a divergence looks like in the journal.

Then read the rest of the picture: the command systemd holds, the host's own record, and every runtime installed.

```bash
sudo systemctl cat "dedalo-ts@$I" | grep -E '^# /|^ExecStart'
sudo grep -H '"bun_pin"' /var/lib/dedalo-install/instances/*.json
for bun in /opt/dedalo/bun/*/bun; do printf '%s → %s\n' "$bun" "$("$bun" --version)"; done
```

On a host with one instance called `prado`, running `1.4.3`, the answers look like this — output only, the commands are the ones above:

```console
instances: prado
instance=prado user=ded_prado tree=/home/ded_prado/dedalo
drop-in=/etc/systemd/system/dedalo-ts@prado.service.d/10-dedalo-install.conf runtime-pin=1.4.3 code-pin=1.4.3

# /etc/systemd/system/dedalo-ts@.service
ExecStart=/bin/false
# /etc/systemd/system/dedalo-ts@prado.service.d/10-dedalo-install.conf
ExecStart=
ExecStart=/opt/dedalo/bun/1.4.3/bun run src/server.ts

/var/lib/dedalo-install/instances/prado.json:  "bun_pin": "1.4.3",

/opt/dedalo/bun/1.4.3/bun → 1.4.3
```

The template's `ExecStart=/bin/false` and the drop-in's bare `ExecStart=` are the two halves of the same mechanism: the drop-in clears the template's command, so a template without a drop-in runs nothing. Leave both lines in place.

The `bun_pin` in the registry is the value the installer recorded at install time, and this procedure does not update it — [Removing the old runtime](#removing-the-old-runtime) explains what that value is and is not good for.

## 2. Get the verified binary

The release's table `.bun-sha256` is the authority: it carries the pin on its first line, the signing key it was derived from on its second, and one row per asset. Take the rows from **the release you are installing**, not from the running tree — the tree still holds the previous release's table, which cannot verify the new zip.

If you already have the release archive (the installer's hand-over directory, or the file you downloaded), read the pin and the table out of it. The commands try the flat layout first and the one-directory layout second, so they work on either kind of archive:

```bash
ARCHIVE=/path/to/7.0.0-beta.8.zip          # the release zip you downloaded
unzip -l "$ARCHIVE" | grep -E '\.bun-(version|sha256)$'
unzip -p "$ARCHIVE" .bun-version 2>/dev/null \
  || unzip -p "$ARCHIVE" '*/.bun-version'                          # the pin that release needs
SHA=$(mktemp) || exit 1
unzip -p "$ARCHIVE" .bun-sha256 2>/dev/null > "$SHA" \
  || unzip -p "$ARCHIVE" '*/.bun-sha256' > "$SHA"
head -2 "$SHA"
```

For the release that carries `1.4.4`, the table begins with the version it was generated for and the key it was derived from:

```console
# bun-v1.4.4
# signed-by: F3DCC08A8572C0749B3E18888EAB4D40A7B22B59
```

The table names exactly three Linux assets; anything else is not the release's. Pick the one for this machine:

| Machine | Asset | Test |
| --- | --- | --- |
| ARM64 | `bun-linux-aarch64.zip` | `uname -m` prints `aarch64` |
| x86_64 with AVX2 | `bun-linux-x64.zip` | `grep -qw avx2 /proc/cpuinfo` succeeds |
| x86_64 without AVX2 (some virtual machines) | `bun-linux-x64-baseline.zip` | the grep above fails |

Then download and verify it. `PIN` is the only value you type:

```bash
PIN=1.4.4
case "$(uname -m)" in
  aarch64) ASSET=bun-linux-aarch64.zip ;;
  *) grep -qw avx2 /proc/cpuinfo && ASSET=bun-linux-x64.zip || ASSET=bun-linux-x64-baseline.zip ;;
esac
echo "asset: $ASSET"

install -d -o root -g root -m 0700 "/var/lib/dedalo-install/bun/$PIN"
cd "/var/lib/dedalo-install/bun/$PIN"
# a previous install at this pin leaves the verified zip here; re-checking it is free
test -s "$ASSET" || curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --remove-on-error -o "$ASSET" \
  "https://github.com/oven-sh/bun/releases/download/bun-v$PIN/$ASSET"
grep " $ASSET\$" "$SHA" | sha256sum -c -
```

The check must print `OK` and nothing else:

```console
bun-linux-x64.zip: OK
```

Anything else — a missing row, a `FAILED`, a different asset name — stops here. An unverified zip is not the release's runtime. If an earlier attempt was interrupted mid-download, delete the partial file and fetch it again: `rm -f "$ASSET"` before the `curl` line.

## 3. Install it beside the old one

```bash
cd "/var/lib/dedalo-install/bun/$PIN"
rm -rf extract
unzip -q -o "$ASSET" -d extract
install -d -o root -g root -m 0755 "/opt/dedalo/bun/$PIN"
NEW="extract/${ASSET%.zip}/bun"
# the installer never replaces a pin another instance is running; neither should you
cmp -s "$NEW" "/opt/dedalo/bun/$PIN/bun" \
  || install -D -m 0755 -o root -g root "$NEW" "/opt/dedalo/bun/$PIN/bun"
rm -rf extract
```

Prove both: the version the new binary reports, and that it is root's.

```bash
/opt/dedalo/bun/$PIN/bun --version
stat -c '%U:%G %a %n' /opt/dedalo/bun/$PIN/bun
ls -l /opt/dedalo/bun/
```

```console
1.4.4
root:root 755 /opt/dedalo/bun/1.4.4/bun
drwxr-xr-x 2 root root 4096 Nov  2 09:14 1.4.3
drwxr-xr-x 2 root root 4096 Nov  4 10:02 1.4.4
```

The old directory is untouched, which is the point: it is the rollback, and any instance still on that pin keeps running. The installer's own `host_runtime` step does the same download, check and destination; a host set up by hand uses its own paths instead ([Install by hand › host_runtime](manual_install.md#manual-host_runtime)).

!!! note "The RHEL family: relabel the binary"
    On a host with SELinux enforcing, a file installed by hand under `/opt/dedalo/` inherits the label of its parent directory, which is not necessarily the one the unit needs. If the service fails to execute the new binary, relabel it and restart: `sudo restorecon -F /opt/dedalo/bun/<pin>/bun`. Distribution packages and the installer's own steps do this for you; a hand-installed pin does not.

!!! note "Another instance may already run this pin"
    If `/opt/dedalo/bun/<pin>/bun` already exists because a second instance on this host uses that pin, the `cmp` above keeps it when the bytes match. Never overwrite it with a different build: the running process would keep a deleted inode and the next restart could fail.

## 4. Point the unit at it

The unit is a copy taken at install time: no update rewrites it, which is why this step is manual. The interpreter line lives in the instance's drop-in — `$F`, set in step 1 — one line containing the version you are replacing.

```bash
sudo grep -n '^ExecStart' "$F"
```

On the example host those lines read:

```ini
ExecStart=
ExecStart=/opt/dedalo/bun/1.4.3/bun run src/server.ts
```

Rewrite the version in the path, keeping the empty `ExecStart=` line above it, and reload the unit. The pattern stops at the binary, so any arguments after it are left alone; the guard stops an empty variable from writing a path that cannot exist:

```bash
if [ -z "$PIN" ] || [ -z "$PIN_NOW" ] || [ ! -f "$F" ]; then
  echo "STOP: PIN, PIN_NOW or F is missing — re-run steps 1 and 2 in THIS shell"
else
  sudo sed -i "s#^ExecStart=/opt/dedalo/bun/$PIN_NOW/bun#ExecStart=/opt/dedalo/bun/$PIN/bun#" "$F"
  sudo grep -n '^ExecStart' "$F"
fi
```

`grep` must now show the new pin in `ExecStart=`. If it still shows the old one, the line does not match the pattern (open the file and look at it) and nothing was changed; fix the line by hand and run `grep` again. Then reload:

```bash
sudo systemctl daemon-reload
```

`daemon-reload` is mandatory: a restart alone re-executes the **cached** command, i.e. the old binary, silently. Prove what systemd now holds before restarting:

```bash
systemctl show -p ExecStart --value "dedalo-ts@$I"
```

```console
{ path=/opt/dedalo/bun/1.4.4/bun ; argv[]=/opt/dedalo/bun/1.4.4/bun run src/server.ts ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }
```

The `path=` member must name the new pin. If it still names the old one, the edit did not land where systemd reads — see [the server still runs the old version](#the-server-still-runs-the-old-version).

## 5. Restart and prove the change

```bash
sudo systemctl restart "dedalo-ts@$I"
P=$(systemctl show -p MainPID --value "dedalo-ts@$I")
echo "pid=$P"
sudo readlink -f "/proc/$P/exe"
sudo journalctl -u "dedalo-ts@$I" -n 30 --no-pager -o cat | grep -iE 'Bun|listening'
sudo curl --fail --unix-socket "/run/dedalo-$I/dedalo_ts.sock" http://localhost/health
```

The socket probe goes through the unit's own listener, so it needs no DNS and no certificate. A correct restart looks like this:

```console
pid=4821
/opt/dedalo/bun/1.4.4/bun

Dédalo TS server starting on Bun 1.4.4 (pinned: 1.4.3)
[runtime] Bun 1.4.4 does NOT match the verified pin 1.4.3 (.bun-version). Bun.sql/Bun.serve behavior is version-coupled (audit S2-36) — verify before relying on this runtime.
[boot] core module graph warmed: 1183 modules in 742ms
Dédalo TS server listening on unix socket /run/dedalo-prado/dedalo_ts.sock (entity: prado)

{"entity":"prado","version":"7.0.0-beta.7","db":"ok"}
```

The warning is the expected state between the two halves of the move (see [the order](#the-order-runtime-first-then-the-update)); the `/health` body above is trimmed to the keys that matter here. A browser probe of `https://<the address staff type>/health` must answer too — it is the same payload through the web server. A `pid=0` means the unit did not come back; the journal line above says why. Two more places confirm the runtime without a terminal:

- **Maintenance → System info** shows `engine: bun 1.4.4`, and a `Bun supported version` row that compares the runtime with the **minimum** the code requires (`>= 1.4.4`), not with the pin — a green row there does not prove the pin.
- **Maintenance → Update code**, in its readiness list, shows the **Bun version pin** row. Until the release lands it reads a warning, `1.4.4 != 1.4.3` — informative, not blocking: the panel cannot know the target release's pin before it downloads it, so the hard gate sits in the update itself.

## Then apply the code update

From here the ordinary procedure carries on: **Maintenance → Update code**, as the superuser, in maintenance mode, with a fresh proven database backup. The run downloads the release, verifies its checksum, extracts it to quarantine, checks its `.bun-version` against the running runtime — **before** installing any dependency, and the check that now passes — installs them, boot-tests the new tree there, swaps it in and restarts onto it; the release's remaining phases run in the new code. [Update code](../management/updates/updating_code.md) describes the panels, and [the update run](../management/updates/index.md#the-update-run) the phases and the states.

From a terminal, as the service user, in the code tree (the run's journal lives in the private directory, outside both the tree and the database, so this works while the server is down):

```bash
sudo -u "$U" -- env HOME="${DIR%/dedalo}" \
  sh -c "cd '$DIR' && exec '/opt/dedalo/bun/$PIN/bun' run update status"
```

After the update, the boot echo loses the warning and both lines name the same version:

```text
Dédalo TS server starting on Bun 1.4.4 (pinned: 1.4.4)
```

## Removing the old runtime

Keep the previous pin until the new release is confirmed healthy: it is the way back if the new runtime misbehaves on this host, and a rollback is then a one-line repoint instead of a fresh download. Remove it when you are satisfied, and only when no unit still names it:

```bash
if [ -z "$PIN_NOW" ]; then
  echo "STOP: PIN_NOW is empty — re-run step 1 in THIS shell"
elif sudo grep -rlq -- "bun/$PIN_NOW/" /etc/systemd/system/ /run/systemd/system/ /usr/lib/systemd/system/ 2>/dev/null; then
  echo "STOP: a unit still names $PIN_NOW:"
  sudo grep -rl -- "bun/$PIN_NOW/" /etc/systemd/system/ /run/systemd/system/ /usr/lib/systemd/system/ 2>/dev/null
else
  sudo rm -rf -- "/opt/dedalo/bun/$PIN_NOW"
  ls -l /opt/dedalo/bun/
fi
```

!!! note "The registry's `bun_pin` is a refcount, not a status"
    `/var/lib/dedalo-install/instances/<i>.json` records the pin each instance was installed with, and the installer's `--abort` counts those entries before it deletes `/opt/dedalo/bun/<pin>/`. This procedure does not rewrite the field, so after a hand-moved pin the registry still names the old one. That makes the field useless as a "who uses this pin" test — the units are the test, as above — and it means an instance removed later with `--abort` may not protect the pin you just installed. If you are about to remove an instance, read [Removing an instance](multi_instance.md#removing-an-instance) with that in mind rather than editing installer state by hand.

A restore point is a separate question from an installed binary: restoring code whose `.bun-version` differs from the running runtime is refused, so rolling the *code* back to an older release means pointing the unit at that release's pin first — the repoint above, which needs the old directory to still be there.

The installer's zip cache under `/var/lib/dedalo-install/bun/<pin>/` can go on the same rule; keeping it makes a later install at that pin skip the download. [Several instances on one host](multi_instance.md) follows the same rule when an instance is removed.

## Rolling the runtime step back

The runtime step has an undo as small as itself: point the unit back and restart. The old pin must still be in `/opt/dedalo/bun/` — this is why it is not removed until the new release is confirmed.

```bash
if [ -z "$PIN" ] || [ -z "$PIN_NOW" ] || [ ! -f "$F" ]; then
  echo "STOP: PIN, PIN_NOW or F is missing — re-run steps 1 and 2 in THIS shell"
else
  sudo sed -i "s#^ExecStart=/opt/dedalo/bun/$PIN/bun#ExecStart=/opt/dedalo/bun/$PIN_NOW/bun#" "$F"
  sudo systemctl daemon-reload
  sudo systemctl restart "dedalo-ts@$I"
fi
```

Nothing else changed, so nothing else is undone. Note what this does and does not buy: it puts the old runtime back, but it does not undo a code update. If the 1.4.4-pinned release is already installed, the old runtime starts with the mismatch warning, and restore points that pin 1.4.4 are refused until you move forward again.

## The exact strings you will meet

| String | When | What to do |
| --- | --- | --- |
| `[runtime] Bun 1.4.4 does NOT match the verified pin 1.4.3 (.bun-version). …` | boot, after a runtime bump | expected until the release that moved the pin is installed; keep going |
| `Error. The release pins Bun 1.4.4 but this server runs Bun 1.4.3 — install the pinned Bun first, then retry the update.` | update, after the archive is downloaded and checked, before any dependency is installed or anything is swapped | run this page for the named version, then retry the update |
| `Error. That restore point pins Bun 1.4.4 but this server runs Bun 1.4.3 — install the pinned Bun first, then retry the restore.` | restoring a code restore point | same — the panel also shows the short reason *This copy pins a different Bun runtime than the one running. Install the pinned Bun first.* |
| `Error. No supervisor declared; …` | update, on a unit without `DEDALO_SUPERVISED=true` | not a runtime issue — [troubleshooting](troubleshooting.md#error-no-supervisor-declared-the-server-would-not-restart-onto-the-new-tree) |

Both refusals come before the code swap, so the live tree is unchanged. A run whose release declares an ontology precondition has already applied it (and taken its backup first); phases other than the code swap are safe to repeat, which is why retrying after the runtime step is safe.

## The server still runs the old version

Restarting is the step that most often looks done and is not. With `I` from step 1 and `PIN` (the pin you installed) set in the same shell, these lines produce a decisive answer:

```bash
P=$(systemctl show -p MainPID --value "dedalo-ts@$I")
echo "pid=$P"
sudo readlink -f "/proc/$P/exe"                              # the binary the process IS
sudo systemctl show -p ExecStart --value "dedalo-ts@$I"      # the command systemd HOLDS
sudo systemctl show -p FragmentPath -p DropInPaths --value "dedalo-ts@$I"
sudo journalctl -u "dedalo-ts@$I" -n 20 --no-pager -o short-iso | grep -iE 'Bun|runtime|start'
```

| Evidence | Cause | Fix |
| --- | --- | --- |
| the binary `readlink` printed is the old one, and the unit has been up since before your restart | `daemon-reload` was skipped, or the restart never ran | `sudo systemctl daemon-reload && sudo systemctl restart "dedalo-ts@$I"` |
| `ExecStart` still names the old binary, while the file on disk names the new one | the unit was reloaded but the edit is in a file this unit does not read | compare `systemctl cat` with `DropInPaths`; edit the file it names |
| `DropInPaths` does not list your file | wrong instance name, or wrong drop-in directory | `sudo systemctl edit "dedalo-ts@$I"` creates the right one — give it **both** lines: an empty `ExecStart=` and then the command |
| the effective `ExecStart` is the old one although a later drop-in exists | a later drop-in resets `ExecStart` and assigns the old path; a drop-in that adds a line without the empty reset makes the unit invalid instead (next row) | fix the offending drop-in; keep exactly one reset line |
| the unit refuses to load, mentioning more than one `ExecStart=` | the reset line was removed | restore `ExecStart=` (empty) above the new line |
| `pid=0` while the site still answers | a server started by hand is serving, and the unit is not running | `sudo ss -xlp \| grep dedalo` names the socket's owner; stop the stray, start the unit — two writers on one database is worse than the version question |
| the binary `readlink` printed is already the new one, only the log says otherwise | you are reading an older journal entry | re-run `journalctl` with `-n 5 --no-pager -o short-iso` and compare timestamps |
| `status=203/EXEC` and `pid=0` | the binary is missing, not executable, or a parent directory is not traversable | `/opt/dedalo/bun/$PIN/bun --version` as root, then as `$U`; `stat -c '%U:%G %a'` on the binary and on `/opt/dedalo`, `/opt/dedalo/bun` |

Two more, less common:

- **Retrying after a failed start.** Five failed starts inside five minutes and systemd refuses more (`StartLimitBurst`): `sudo systemctl reset-failed "dedalo-ts@$I"` clears the count before the next restart.
- **The process starts and dies at once.** Run the binary as the service user — `sudo -u "$U" -- "/opt/dedalo/bun/$PIN/bun" --version` — and check `journalctl` for a dynamic-linker or `Illegal instruction` message. The last one means the asset did not match the CPU: an `x64` build on a machine without AVX2. Install `bun-linux-x64-baseline.zip` and repeat step 3.
- **The service is fine but the panel still shows the pin mismatch after the update.** The panel reports the *running* process, so restart it: `sudo systemctl restart "dedalo-ts@$I"`. A mismatch with the freshly installed release means the update did not land — `bun run update status` says which state the run reached.

## Routes this page does not cover

| Route | How its Bun moves |
| --- | --- |
| Docker | with the image: a new image carries Bun at the pin ([Docker](docker.md)) |
| Developer checkout | install the pin (`curl -fsSL https://bun.sh/install \| bash -s "bun-v<pin>"`), then `bun install`; the checkout's `.bun-version` is the pin ([Developer quickstart](dev_quickstart.md)) |
| a host set up by hand | the same idea with its own paths; [Upgrading › A host set up by hand](upgrading.md#a-host-set-up-by-hand) has the commands |
| publication hosts | each site has its own Bun, moved per site ([Upgrading a site's Bun](publication_host.md#upgrading-a-sites-bun)) |

## Checklist

- [ ] The release carrying the target pin is **published**, not only merged.
- [ ] `I`, `U`, `DIR` and `F` read from the unit; `PIN_NOW` read from its `ExecStart`, not from `.bun-version`.
- [ ] The target pin read from the release, not guessed.
- [ ] The zip verified against **that release's** `.bun-sha256` (`OK`).
- [ ] The new binary is root-owned, mode `755`, at `/opt/dedalo/bun/$PIN/bun`, and `--version` prints the pin.
- [ ] The old runtime directory is still in place.
- [ ] `systemctl show -p ExecStart` names the new path; `daemon-reload` was run.
- [ ] `readlink -f /proc/<MainPID>/exe` names the new binary.
- [ ] The boot echo names the new runtime; the pin warning is expected until the update lands.
- [ ] `/health` answers `200` with `"db":"ok"` — over the socket, and through the web server.
- [ ] The code update is applied, and a later boot has no pin warning.
- [ ] The old runtime removed only once no unit names it (the registry's `bun_pin` is not that test).
