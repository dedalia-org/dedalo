---
title: "The process-state widget now follows a multi-step path to its state field."
type: fixed
audience: admin
date: 2026-11-22
---
The process-state widget (the `state` widget of a `component_info` field) reads each configured
path from the record down to the select that holds the state or situation. A path of more than
one step — for example a portal to a resource, then the resource's state select — was read as
its last step on the record itself, so the widget showed 0 % for every record. Each step is now
read on the records the previous step points at, and the state values come from the last step
only. A path the widget cannot follow (a step without a component, the same component twice, or
an intermediate step that holds no links) now stops the widget with an error naming the path,
instead of silently showing 0 %. Single-step paths behave as before.

**Action needed:** none.
