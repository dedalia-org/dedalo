---
title: The record's Id badge can be selected to show its information in the inspector.
type: fixed
audience: user
date: 2026-11-04
---
Clicking the Id badge of a record in the edit view did nothing, so the inspector
never described it. The badge now selects like any other field: the inspector shows
the component's tipo, model, view/mode and its data, and the record's history for it.
Because the id is the record's identity and cannot be edited, selection marks it with
an orange ring around the badge instead of the field highlight — the badge keeps its
own surface and colour and the number stays readable, in every active-field style and
in both themes. Selecting it never takes a component lock, so it can never make the
record look "in use" to another user.
