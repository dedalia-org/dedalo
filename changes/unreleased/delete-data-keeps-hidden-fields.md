---
title: Deleting a record's data no longer empties fields its section hides.
type: fixed
audience: user
date: 2026-11-12
breaking: false
wc: WC-2026-11-12-wipe-respects-virtual-exclusion
---
On sections built on another one (image, audiovisual or document resources, thesaurus instances…), "delete data" also emptied the fields the section does not show, and moved their files aside. Those fields now stay as they are; only the fields the section shows are emptied. Fields already emptied this way by an earlier delete can be restored one by one from the Time Machine, which kept their previous value.
