---
title: "Prereleases have an official image: `:7.0.1-beta.2`, signed, and never under a release's tag."
type: added
audience: admin
date: 2026-10-18
wc: WC-2026-10-15-release-identity-from-tag
---
Pushing a prerelease tag (for example `v7.0.1-beta.2`) now publishes the official Docker
image `:7.0.1-beta.2`, in the same way as a release: built from the tag's code, signed,
with the same digest in every registry, and never rebuilt once published. The image is
published only under its own name. It never replaces `:7.0.1`, which is the image of the
release, and no image is tagged `latest`, `7` or `7.0`.

So the installer of a prerelease can now use the **Official** image: it asks the registry
for `:7.0.1-beta.2`, and finds it once the image is published.

The signature check accepts prerelease tags. If you verify images by hand with
`cosign verify`, use the identity printed in the Docker installation guide, which now
includes them. The old command still verifies release images, but it refuses a prerelease
image.
