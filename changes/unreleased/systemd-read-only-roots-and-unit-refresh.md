---
title: The server unit runs on a read-only file system; the installer upgrades its own earlier templates and the update names the re-render command.
type: security
audience: admin
date: 2026-11-13
wc: WC-2026-10-30-update-run
---
On a production host the engine's systemd unit now runs with `ProtectSystem=strict`: the whole
file system is read-only to it except the roots the instance's drop-in opens (`ReadWritePaths=`,
derived from the install answers — the install folder, the backup directory, the web root with the
media and the published client, the socket directories, the temp directories). The installer writes
the same list as a small manifest beside the drop-in, and at every start the engine checks each
path it is configured to write against it: a path moved in `.env` outside the roots refuses the
start (exit `78`), naming the path and the root command that re-renders the units —
`sudo <bun> run <tree>/scripts/ops/host_units_refresh.ts --instance <i>`. Hosts installed before
this release keep their units until that command runs once (as root): the installer and the
command now recognise every template an earlier release shipped (`deploy/systemd/shipped_digests.json`)
and upgrade it in place, while a template no release shipped is still refused. A code update
never rewrites `/etc/systemd`; after a verified update its `host_units` check records that command
in the run's journal, in `bun run update status` and in the server log when the host's templates
are not this release's. See [Re-rendering the units](./install/multi_instance.md#re-rendering-the-units).
