---
title: The production installer can now make a local certificate authority, for an intranet with no public name.
type: added
audience: admin
date: 2026-10-16
---
A museum that installs Dédalo with internet access and then runs it on an isolated
intranet has no public name, so Let's Encrypt cannot reach it, and until now the only
other choice on the production route was to make certificates by hand. The *Web server
& TLS* screen now offers **Local CA** (`--tls local_ca`), as the Docker route already
did. **Other addresses** (`--tls-extra-names dedalo.lan,archivo.museo.lan`) adds the
other names staff type: the certificate names them and the site answers to them.

On an intranet with no local DNS, **Other addresses** can also list the server's IPv4
addresses (`--tls-extra-names dedalo.lan,192.168.1.20`), on both routes: staff then open
`https://192.168.1.20/`, and `http://` to it redirects to `https://`. A browser sends no
server name for an IP address, so on the production route the instance *claims* the
address in the installer's host-wide catch-all, which hands a handshake to that address
the instance's certificate. Every other site on the server keeps answering by name, on
that address too, and a handshake to an address no instance claims is refused as
before. The System check refuses an address that is not this server's, one another
instance already claims, one a site of yours listens on itself, a site of yours on port
443 that loads before the catch-all (it would answer visits by IP address), and IPv6. On nginx the
claiming instance's site key becomes readable by the web server's group, because nginx
loads that certificate per connection; on Apache, one instance per server can claim
addresses. See [Reaching an instance by IP address](./install/reverse_proxy.md#reaching-an-instance-by-ip-address).

The installer makes the authority and the site certificate in
`/opt/dedalo/instances/<i>/tls/`, with the same script the Docker route and every
rotation use. The authority can only certify the install's own addresses, exactly. When the
install ends, the *To do on this host* list names the authority's file and its SHA-256
fingerprint, how to trust it once on Windows, macOS, Linux and Firefox, and the `curl`
command that checks it from a staff computer. The site certificate then renews itself
from the same authority (`dedalo-tls-renew@<i>.timer`), so staff computers never trust
anything again. `--abort` removes only what this install made: the timer, its drop-in
and the certificate directory.

On both routes, an install over a certificate directory that already holds an authority
stops at the *System check* when that authority cannot serve the answered addresses,
and names the rotation command. That happens when it was made for other addresses, or
when it was made before this release and its certificate does not name them all. The
production route also refuses an authority made before this release, because it is not
restricted. See [Production install](./install/production.md); its last section is a
recipe for trying the production route in a virtual machine with no domain name.
