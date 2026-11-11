# WC-2026-11-10-own-user-activity-read — a user reads their OWN activity statistics

- **Date:** 2026-11-10. Gate sites: `resolveOwnUserRecordPermission`
  (`src/core/security/permissions.ts`, `SELF_READABLE_COMPONENTS`) and `get_widget_data`
  (`src/core/api/handlers/dd_component_info.ts`, own-record branch).
- **Decision:** DEC-12. TS-only; PHP had no such rule (and no gate on `get_widget_data` at all).

## Shape before

`dd1537` "User activity" (`component_info`, async `user_activity` widget, under dd128's
"Statistics" group) was readable only with a matrix grant on dd128 and dd1537. Most profiles grant
0 on dd128, so an ordinary user could not see their own statistics; `get_widget_data` refused them
through the read door of WC-2026-11-10-widget-data-read-door (section floor → `perm.denied`).

## Shape after

1. On the actor's OWN dd128 record, `dd1537` resolves to level **1** (read, never write) for every
   user, global admins included. Another user's record: unchanged (matrix).
2. `get_widget_data` on the actor's own dd128 record is judged like read Gate A: no section floor,
   no record-scope step — `getRecordComponentPermission(...) >= 1` alone, else `perm.denied`.
   Every other record goes through the read door unchanged.

Request and success body unchanged. `tool_user_admin` renders dd1537 read-only below the profile
fields.

## Reason

The self-service profile tool shows a user their own data; their own activity history is a
derived, read-only value of their own actions and exposes nothing about any other account.

## Gate reconciliation

- `test/unit/user_self_record_permissions.test.ts` — the table row (own → 1, other → null) and the
  end-to-end `get_widget_data` pair (own record served with a zero dd128 grant; another user's
  record `perm.denied`).
