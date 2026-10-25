---
title: The component lock requests refuse a section that is not an ontology tipo.
type: security
audience: developer
date: 2026-10-23
wc: WC-2026-10-23-lock-section-tipo-grammar
---
`dd_utils_api` `update_lock_components_state` and `get_lock_status` now check that
`options.section_tipo` is a string in the tipo grammar before doing anything, for every
action — including the caller's own lock cleanup, which runs no section read check. A missing
value still answers `400 request.invalid_options`; a present value that is not a tipo (an array,
an object, a number, a free string) now answers `400 request.invalid_tipo` and touches no lock,
where it used to reach the database as-is. The Dédalo client always sends a tipo, so nothing
changes for it.
