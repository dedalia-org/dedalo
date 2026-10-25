---
title: A developer install now issues the development listener's HTTPS certificate and makes this machine trust it; `bun run tls:renew` and `bun run tls:untrust` manage it afterwards.
type: added
audience: developer
date: 2026-10-17
---
**The certificate.** With the default `--tls local_ca`, the developer route issues
the development listener's certificate with the same generator the other routes use
(`deploy/dedalo-tls-rotate.sh`), into `<private>/tls`, as the checkout's owner. Its
certificate authority can certify only `localhost`, `127.0.0.1` and, when the
listener is opened to the network, the IPv4 address it binds (or this machine's IPv4
network addresses with `0.0.0.0`). IPv6 addresses are not certified: a listener on
this machine is opened as `https://localhost:…`, which the certificate names, and a
specific IPv6 `--dev-host` with `local_ca` is refused. A re-run keeps the authority
and renews its certificate when it has less than 30 days left. An authority made
for other addresses is refused before anything is written, and the refusal names
the command that replaces it.

**Trust.** The installer prints the authority's path and SHA-256 fingerprint and
installs it into this machine's trust store. The installer itself stays your user;
only this step asks for more. On macOS the authority goes into your login keychain,
and macOS asks for your password. On Linux it is copied into the system anchors
through `sudo` for one command. Firefox profiles get it through `certutil` when it
is installed; otherwise the step tells you to set
`security.enterprise_roots.enabled`. If you cancel the prompt, the install still
completes and reports *not trusted yet* with the manual command; `bun run dev`
serves either way. On macOS a cancelled dialog leaves no certificate behind in the
keychain. If this machine already trusts the authority, nothing is asked.

**Afterwards.** `bun run tls:renew` (`--force` to renew now) issues a new
certificate from the same authority, so nothing needs to be trusted again.
`bun run tls:untrust` removes the authority from every store the installer put it
in. `--abort` removes what the aborted install added; if that removal is refused,
it keeps the record in `../private/tls/` so `bun run tls:untrust` can finish it.
