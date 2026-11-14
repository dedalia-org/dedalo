---
title: Login *forgot password* flow is live
type: added
audience: user
date: 2026-07-18
wc: WC-039
---
The recovery actions
`request_password_reset` / `confirm_password_reset` are implemented natively
(`src/core/security/password_reset.ts` + a nodemailer SMTP mailer), with
pending codes in the session store. `request` always returns
`{result:true, reset_id}` (anti-enumeration); a successful reset evicts the
user's existing sessions. TLS peer verification is never disableable (pin a
private CA via `NODE_EXTRA_CA_CERTS`). Config: catalog domain `mailer`
(`DEDALO_SMTP_*`, `DEDALO_PWRESET_*`). User guide:
[Password recovery](./administration/password_recovery.md).
