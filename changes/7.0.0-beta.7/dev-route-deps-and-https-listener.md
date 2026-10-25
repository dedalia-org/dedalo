---
title: A developer install now installs the development dependencies `bun run dev` needs, and the development listener can serve HTTPS (`SERVER_TCP_TLS_CERT_FILE` + `SERVER_TCP_TLS_KEY_FILE`).
type: fixed
audience: developer
date: 2026-10-16
---
**Development dependencies.** The installer's bootstrap installs only its own,
production dependencies, so after a developer install the first `bun run dev`
crashed with `Cannot find package 'less'`. The developer route now has an
`install_dev_dependencies` step (`bun install --frozen-lockfile --ignore-scripts`),
run as the checkout's owner, that installs only what is missing; a checkout that
already has them is left as it is. Production, Docker and Trial installs keep the
production-only tree. If the step cannot reach the npm registry, the install fails
and quotes bun's error. Run as root in a checkout another user owns, the step refuses.

**HTTPS on the development listener.** Two new keys, `SERVER_TCP_TLS_CERT_FILE` and
`SERVER_TCP_TLS_KEY_FILE`, give the `SERVER_TCP_PORT` listener a certificate: it then
speaks HTTPS and the boot log prints an `https://` address. Set both or neither: a
half pair, an unreadable file, a file that is not a certificate or a key of another
certificate stops the server at boot (exit 78) with the key and path named. It never
falls back to plain HTTP. While the certificate has less than 30 days left, every
boot warns and names `bun run tls:renew`. Without the keys, nothing changes; without
`SERVER_TCP_PORT` the keys are ignored. The test and update-drill servers always
serve plain HTTP, whatever the pair in `../private/.env`. The
warning for a listener opened to the network now says "no TLS" only when that is
true.
