---
title: The installer verifies every ontology file against its source's digest; long boots are no longer restarted by the watchdog; the server unit runs sandboxed.
type: security
audience: admin
date: 2026-11-12
wc: WC-2026-10-30-ontology-file-digests
---
- **Ontology files at install time.** The installer now checks every ontology file it stages — downloaded from an ontology server, copied from a local package, or taken from the release itself — against the sha256 its source publishes, before anything is unpacked. A file that does not match stops the installation with nothing installed. A source that publishes no digests (an older ontology server, a hand-built package) still installs, with one warning naming every unverified file. The update panel already worked this way.
- **Long first boots.** While the server runs its boot migrations it now writes a `booting` marker beside its socket, and the health watchdog waits for it instead of restarting a server that is still migrating. No configuration is needed.
- **Sandboxed server unit.** The shipped systemd units (`dedalo-ts.service` and the per-instance `dedalo-ts@.service`) now run the server with a sandbox baseline: no privilege escalation, no capabilities, and the kernel, its devices and other users' processes out of reach. **Upgrade note:** an update never rewrites files under `/etc/systemd`. A host installed before this release keeps its old unit until you replace it with the release's copy (`systemctl daemon-reload` and restart the instance after). Until then, installing a second instance on that host is refused because the template on disk differs from the release's.
