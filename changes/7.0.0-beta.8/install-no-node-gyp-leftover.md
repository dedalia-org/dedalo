---
title: Installing or updating no longer leaves a hidden `.<hash>-<pid>.node-gyp` folder in the Dédalo folder.
type: fixed
audience: admin
date: 2026-10-25
---
The production installer and the **Update code** panel installed the dependencies with
package scripts enabled. Each run left a small, empty-of-data helper folder (a one-file
`node-gyp` shim) inside the Dédalo folder. Dependencies are now installed with scripts
disabled, as every other install path already did, and nothing is left behind. A leftover
folder from an earlier install holds no data and can be deleted. The manual's
`bun install` commands now include `--ignore-scripts` too.
