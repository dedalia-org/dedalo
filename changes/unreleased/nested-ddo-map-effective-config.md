---
title: Columns declared for a nested portal now show everywhere it appears, in every mode and on every page.
type: fixed
audience: user
date: 2026-11-04
wc: WC-2026-11-04-nested-paging-add-show, WC-2026-11-04-caller-chain-per-occurrence, WC-2026-11-04-config-less-element-adopts-caller-children, WC-2026-11-04-nested-list-payload-growth, WC-2026-11-04-record-cycle-stop, WC-2026-11-04-ddinfo-gates-kept, WC-2026-11-04-context-traversal-order, WC-2026-11-04-governing-limit-sqo-limit-only
---
A portal can declare which columns a portal nested inside it shows — the Tasks portal of a work process, for example, shows the assigned user as *surname, name*. Those declared columns were applied only in some views: in a list a nested portal could appear empty, the second page of a nested portal switched back to the nested portal's own columns, and the same field nested under two different portals showed the columns of whichever was read first. Now every nested element uses one effective configuration — the columns its parent declares, and its own configuration for anything the parent leaves out — in edit and list views, on every page, and per parent; a page size the parent declares for a nested portal is the page size it pages by. Related-record lists expand linked portals with their own columns as well. A chain of linked records that points back to itself stops where it repeats instead of failing the whole page, with a notice naming the record. See [Nesting](./core/request_config.md#nesting-a-ddo_map-is-a-flat-list-made-a-tree-by-parent).
