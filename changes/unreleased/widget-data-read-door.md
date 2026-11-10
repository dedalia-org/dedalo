---
title: Info widgets are computed only for users who may read the widget's section and component.
type: security
audience: user
date: 2026-11-10
wc: WC-2026-11-10-widget-data-read-door
---
The request that computes an info widget (the values an info component shows, loaded on demand)
used to check only that the record was in the user's projects. It now asks what the record page
asks: read access to the section, read access to the info component itself, and the record in the
user's scope. A user without those grants is refused instead of being served the computed value.
The components a widget reads its inputs from are not checked one by one: the widget is shown as
the info component displays it. Users who already see the widget see no change. A request naming a
record id that is not a number is now refused as an invalid request.
