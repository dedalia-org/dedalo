---
title: Catalog terms show the coins of their type again, and legend symbols follow their legend.
type: fixed
audience: user
date: 2026-10-30
breaking: false
wc: WC-2026-10-30-observer-external-value-laws, WC-2026-10-30-observer-target-resolvers, WC-2026-10-30-observer-target-not-host, WC-2026-10-30-observer-law-derived-edges, WC-2026-10-30-portal-get-data-external-refresh
---
Before, cataloguing a term (dropping a type onto it in the cataloging tool) left the term's *Coins* and *Ordered coins* portals empty, and the symbol lists derived from a coin legend never updated when the legend's tags changed. Both kinds of field are calculated, and the server did not know how to calculate them. Now it does: a term's coins are a copy of its type's coins, in the type's order, and they update when a coin is linked to the type as well as when the term is catalogued; a legend's symbol list is the symbols tagged in the legend text, in the order they appear. See [Server-side observers — the value laws](./core/system/observers.md#the-value-laws-of-set_dato_external).

The **update** button of a calculated portal works again. It recomputes that portal on that record from the current data and shows the result; anyone who can read the record may use it, because the value is the same whoever asks. If nothing changed, nothing is saved. See [Refreshing a mirror by hand](./core/system/observers.md#refreshing-a-mirror-by-hand).

Existing stored values are not rewritten by the update: they are corrected the next time their source is saved, when the button is pressed, or by an administrator running the observer reconcile (dry run first — on large catalogues review the proposed removals before applying them).

For developers: the button now sends `source.build_options.get_data_external: true`; the old `get_dato_external` flag is ignored. A calculated value is only created and maintained on records whose section declares the field; a value stored on any other record is left exactly as it is, and the observer reconcile reports such values as left untouched instead of correcting them.
