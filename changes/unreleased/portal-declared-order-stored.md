---
title: A portal whose ontology declares an order now stores its records in that order.
type: changed
audience: user
date: 2026-10-31
wc: WC-2026-10-31-portal-order-model
---
A portal column can declare a fixed order in the ontology (for example, linked records sorted by name). That order used to be applied only on screen, so exports, publication and the edit view could disagree, and dragging records inside such a portal was refused. Now every save keeps the stored list in the declared order, and editing the value a linked record is ordered by re-sorts every portal that holds it. Because the declared order is fixed, those portals cannot be reordered: for now, dragging records in such a portal, using its change-order dialog or clicking its sortable column headers shows an error and changes nothing, until the edit view is updated to offer an on-screen-only header sort (by a column you are allowed to read) instead. Lists saved before their order was declared keep their old order until they are saved again, or until an administrator runs the `portal_declared_order` reconcile (Maintenance › Reconcile). The reconcile also runs by itself once an ontology update has added or changed an order (once, after the whole update), and in the background after an order is edited in the ontology editor; stopping the update, the background process or the server stops it at the next record, and a later reconcile run finishes the job. A record it cannot save is listed in its report and does not stop the others from being sorted.
