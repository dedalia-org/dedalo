---
title: A section whose term names a component the engine cannot render as text now fails loudly instead of showing blank labels.
type: changed
audience: admin
date: 2026-11-13
wc: WC-2026-11-13-section-map-term-uncovered-throws
---
A section's `section_map` names the components that build its label (the "term").
Before, naming a component whose type has no text value (a password field, for
instance) made every label drawn from that section blank or truncated, in the tree,
in autocomplete chips and in exports, with nothing in any log. Now reading such a
label fails with `engine.uncovered_scope` naming the section, the component and its
type, so the configuration can be fixed. No shipped ontology is affected; only a
local configuration can name such a component.
