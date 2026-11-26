---
title: "A tool's availability check receives the real section and mode of the element it is offered on; inside Time Machine (dd15) only the export tool is offered."
type: fixed
audience: developer
date: 2026-11-22
wc: WC-2026-11-22-tool-availability-context
---
A tool's server-side `isAvailable` hook was given the element's own tipo as its section and an
empty mode, so a hook keyed on a section answered "no" for every field of that section and a
hook keyed on a mode never fired. It now receives the section the element lives in and the mode
it is drawn in (the indexation grid's columns run in `indexation_list`). Elements shown inside
the Time Machine section offer the export tool only.
