---
title: A commit with a release tag is never built as a development build, and Docker says plainly that it has no nightly images.
type: fixed
audience: admin
date: 2026-10-27
---
Before: a developer build of a commit that carries a release tag (for example `v7.0.1`) could be built under the nightly name, even when the tag was asked by name, and a Docker install asked for a `-dev` image was told only that its image version was not accepted.

Now: a developer build of a tagged commit is refused and the message names the tag, whichever way the commit was asked for. A tagged commit is a release or beta and is named by its tag. A Docker install asked for a development image is refused with the sentence "Docker has no nightly images": nightlies reach tree installs through the code update path only. On a development checkout the Image screen refuses Official and Build (a local build of a development checkout is not an image install) and preselects Custom, the operator's own registry.
