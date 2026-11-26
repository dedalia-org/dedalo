---
title: Accounts still on a v6 password are counted at start, and the log names the command that fixes them
type: changed
audience: admin
date: 2026-11-19
wc: WC-2026-11-19-legacy-aes-lazy-rehash-retired
---

After a migration from v6, an account whose password was never converted cannot log in: v7 accepts Argon2id hashes only, and there is no conversion at the next login. The server log gave advice that no longer applies (to log in once on the previous engine), and nothing warned you before a user was refused.

Now every start counts those accounts and logs `[boot] LEGACY PASSWORDS: <n> account(s) …` with the command to run, `bun run dedalo:migrate-passwords`; `/health` carries `"notices": ["legacy_password_accounts"]` while any remain (the check stays green; the server re-checks about once a minute, so the notice goes shortly after the migration, without a restart); and each refused login of such an account is logged with the same command. Nobody has to choose a new password. See [Migrate the passwords](./install/migrating_from_v6.md#62-migrate-the-passwords).

