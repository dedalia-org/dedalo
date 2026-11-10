---
title: The "+" of a portal (and Duplicate, add term, the assistant) now needs permission to create in the target section.
type: security
audience: user
date: 2026-11-10
breaking: true
wc: WC-2026-11-10-add-new-element-create-gate
---
Before, anyone who could edit a portal (or a selector, or a children field) could create
records through its "+" in any section at all — including Users and Profiles — even without
permission to create there. The tools that create records through a portal (import files,
numismatic acquisition, poster frame) had the same gap.

Now these ways of creating a record ask for write access to the section **and** to its
**New** button: the "+" of a portal, selector or children field, **Duplicate**,
adding a term in a thesaurus tree, and the AI assistant's create / find-or-create / duplicate
tools (an assistant change plan is checked the same way before you confirm it). A portal's
"+" can only create in the sections that portal links to. When the answer is no, a message
now appears on screen; before, the click silently did nothing or created the record anyway.
Global administrators have no bypass, and even root cannot use **+**, **Duplicate** or **add
term** in a section that has no **New** button.

Creating a record with **New** in a section's list, the records a feature creates for you in
its own section — notes on a text, Time Machine notes, indexation notes, references,
dataframe annotations, presets — and the records an import tool creates (import files,
numismatic acquisition, poster frame) still need only write access to that section, as
before. A portal create made by such a tool is also limited to the sections the portal links
to.

**Action needed:** a profile whose users should use the **+** of a portal, **Duplicate**,
**add term** in a tree, or the assistant's record tools must grant the section's **New**
button at write level (in the profile's permissions, under that section). Notes, references,
presets and imports do not need it.
