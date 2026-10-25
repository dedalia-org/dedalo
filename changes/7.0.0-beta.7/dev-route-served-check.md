---
title: A developer install is reported complete only once `bun run dev` has served, and it ends by saying where to open it.
type: changed
audience: developer
date: 2026-10-17
---
**Served, then complete.** A developer install used to end with "install complete"
without anything having served the browser. Its last step, `verify_dev_server`, now
starts `bun run dev` once with the `.env` the install wrote, asks the development
listener for `/health` over HTTPS (the local certificate authority as the trust
anchor), logs in as `root` over it (every cookie the login sets must be `Secure` exactly
when the listener is HTTPS), and stops it again. It refuses to run as root in a
checkout another user owns. If it fails, the install is not reported complete and
the message names the cause: the port taken by another program, a certificate the
server cannot read or that does not verify, the database unreachable, a
development dependency missing, another Dédalo server on the same unix socket, a
cookie flag that does not match the listener, or the login refused. The install is
sealed by then, so the message names the key to edit in the written `.env`
(`SERVER_TCP_PORT`, `SERVER_UNIX_SOCKET`) rather than an installer flag, and the
failure hint no longer offers `--abort`. Fix it and run the installer with
`--resume`, which runs the check again. An install written to another private
directory is started, and shown, as `DEDALO_PRIVATE_DIR=<dir> bun run dev`.

**Where to open it.** The installer then ends with what to do next, built from the
keys it wrote: `bun run dev`, every address the client answers on
(`https://127.0.0.1:3500/dedalo/core/page/` and `https://localhost:3500/…` with the
defaults, plus this machine's network addresses when it is opened to the network),
the `root` login, and the certificate authority's path, SHA-256 fingerprint and
whether this machine trusts it. The full-screen installer leaves these lines on the
terminal when it closes. See the
[developer quickstart](./install/dev_quickstart.md#5-run-the-installer).

**`bun run dev` stops when its CSS watcher dies.** The stylesheet watcher never
stops on a LESS error, so when it exits something is wrong — usually a missing
development dependency (`Cannot find package 'less'`). `bun run dev` now stops with
it and says so, instead of serving on while every stylesheet edit is lost.
