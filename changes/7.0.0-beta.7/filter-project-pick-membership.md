---
title: A user can only assign a record to projects they belong to
type: security
audience: admin
date: 2026-10-22
breaking: false
wc: WC-2026-10-22-filter-project-pick-membership
---
The *Projects* field lists only the projects the logged user belongs to, but the
server used to store any project it was sent. A modified or out-of-date request
could therefore place a record in a project the user is not a member of, or, on
a user's own *Projects* field, grant a project the editor cannot see. Saving now
refuses a project the user is not a member of with a message, and nothing is
stored. Global administrators can still assign any project. Projects already on a
record, including those added by colleagues in other projects, are never removed
by this check. See [component_filter](./core/components/component_filter.md#security-model).
