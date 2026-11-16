---
title: The release-archive install has a worked example, and `install.sh` says what `--release-sha256` takes.
type: fixed
audience: admin
date: 2026-11-13
---
*Get Dédalo* in the installation guide now names the three archive kinds (stable, prerelease,
developer), their address (`/dedalo/install/code/<X.Y.Z>/<archive>`), the format of the
`.sha256` file beside each, and a complete example for the 7.0.0 developer archive.

`install.sh --release … --release-sha256 <url>` used to answer "--release needs
--release-sha256" although the flag was given. It now says that `--release-sha256` takes the
64 hexadecimal digits of the digest, not the address of the `.sha256` file, and how to read
them.
