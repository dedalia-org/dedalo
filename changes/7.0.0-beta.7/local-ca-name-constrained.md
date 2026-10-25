---
title: A local certificate authority can now only certify the install's own addresses, and its site certificate can be renewed without touching the staff computers.
type: security
audience: admin
date: 2026-10-16
---
Every staff computer trusts the local certificate authority an install creates, and
until now that authority could sign a certificate for any website: whoever obtained
its key on the server could impersonate any site to those computers. A new authority
is now restricted to the addresses it was issued for (the server name, any extra
`--host` addresses, `localhost`) — exactly those names, not the names below them, so
an authority for `museo.lan` cannot certify `mail.museo.lan` (a list where one name lies
inside another is therefore refused) — and the key of the authority itself is deleted as
soon as it has signed; the key that stays on the server can only sign under that
restriction. The authority is also limited to website certificates, so that key cannot
sign e-mail or software either.

`deploy/dedalo-tls-rotate.sh` gains `--mode renew`: it re-issues the site certificate
(now valid 397 days) from the same authority, so staff computers change nothing. It
does nothing until the certificate is inside its last 30 days. On the Docker route,
run it yourself once a year or from a monthly cron job (`docs/install/docker.md`,
"Renewing the local-CA certificate"). `--host` can be given several times, for a LAN
name or an IPv4 address beside the server name. When the new certificate is in place
but the web server could not be reloaded (for example `docker` missing from cron's
`PATH`), the script now exits with status 3 instead of reporting success, and every
later run retries the reload until it works.

An authority created before this change is not restricted. It keeps working and its
certificate can be renewed (`--mode renew --host <name>`). Your next rotation
(`--mode local-ca`) replaces it with a restricted one, which each staff computer then
trusts in place of the old entry.
