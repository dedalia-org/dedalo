---
title: Relation fields without their own configuration show their linked records in the view the ontology asks for (e.g. mini, text).
type: fixed
audience: user
date: 2026-11-12
---
A relation field that declares no request configuration of its own can still ask, in its
ontology properties, for its linked records to be shown in a particular view
(`children_view`, for example `mini` for coin types or `text` for legend symbols). That
request was ignored: the linked records rendered in their default view. They now render
in the requested view, in edit and list alike, and a child's own `view` is honoured when
the field asks for none.
