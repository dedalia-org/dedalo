---
title: The posterframe tool offers identifying images for records of virtual sections, and creates them through portals whose target is set only in their configuration.
type: fixed
audience: user
date: 2026-11-12
breaking: false
wc: WC-2026-11-12-posterframe-identifying-image-scope
---
When a video was referenced by a record of a virtual section (Objects, Inventory, Photography, Documents, People…), the posterframe tool's identifying-image selector silently left that record out. It is offered again, using the portal of the real section the virtual one is built on, minus the elements the virtual section excludes. Creating an identifying image through a portal whose target section is set only in its configuration (Archives) failed with "The tool cannot operate on this target"; it now creates the image in the configured section.
