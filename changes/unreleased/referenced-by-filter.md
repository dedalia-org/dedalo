---
title: Open relationships now follows every found record, with exact counts per related section.
type: fixed
audience: user
date: 2026-10-30
breaking: false
wc: WC-2026-10-30-search-referenced-by-leaf
---
Before, **Open relationships** (the inspector button, and a portal's *List from component data*) used only the first 1000 found records, without saying so, and sent the list of related ids back and forth on every page of the opened window. Now the dialog lists every related section with its exact number of records — the number the opened window shows, with your permissions applied — and says so when nothing is related. The opened window is an ordinary filtered list: it counts and paginates normally however many records are related, and opening relationships again from it follows the chain further. The related records are read from what the found records themselves store, so the answer no longer depends on the relation index being up to date, and the activity log can be a starting point too. Counting has a 30-second limit, and so does each page and count of the opened window; past it a timeout error is shown instead of the server working on indefinitely. One count runs per session: opening the dialog in another tab or window replaces the count still running in the first, which then offers **Reload**. A found set that includes recursive children (the search's *Children* option) is refused with a message instead of being counted without its children. See [inspector — Open relationships](./core/ui/inspector.md#open-relationships).

For developers: the window's search carries a new `referenced_by` filter leaf, and the counts come from a new read-only `relation_targets` action (one deadline for the whole census, `db.statement_timeout` past it). Every search statement carrying the leaf has the 30-second limit wherever it runs (`read_raw`, the MCP search, tools acting on a search selection, diffusion and export selections), not only the opened window's — see [SQO — relationship filter leaves](./core/sqo.md#relationship-filter-leaves-referenced_by) and [rqo — relation_targets](./core/rqo.md#relation-targets-of-a-search-relation_targets).
