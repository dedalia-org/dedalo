# Password recovery (forgot password)

> See also: [Management and maintenance](index.md) · [Users, profiles and permissions](users_and_permissions.md) · [Outbound email configuration](configuration/config.md#mailer)

## Introduction

A user who has forgotten their password can recover access on their own from the
login screen, without an administrator's help. The flow is deliberately simple:
the user asks for a recovery code, receives an 8-digit code by email, and types
it back together with a new password. No password is ever sent by email — only
the short-lived code.

Recovery is **self-service for ordinary accounts only**. The root user
(`section_id = -1`) is never recoverable through this flow; see
[Changing root password](users_and_permissions.md#changing-the-root-password). A logged-in user who simply
wants a different password does not need recovery either — an administrator can
set a new password by editing the user record in the Users section.

## Requirements

Recovery works only when all of the following hold:

1. **Outbound email is configured.** The engine relays mail through an existing
   SMTP mailbox — it never runs its own mail server. If `DEDALO_SMTP_HOST` is
   not set, no recovery email is ever sent (the login screen will still behave
   normally, by design — see the anti-disclosure note below). Configure the
   `DEDALO_SMTP_*` keys in `../private/.env`; see
   [Outbound email and password recovery](configuration/config.md#mailer).
2. **The account is active.** The user record's *active account* radio button
   (component `dd131`) must be set to *Yes*. Inactive accounts are silently
   ignored.
3. **The account has a valid email address** stored on the user record
   (component `dd134` in the Users section). No email on file means nothing can
   be sent.
4. **The identifier matches exactly one account.** The user may type either
   their username or their email address. If two accounts share the same email
   address, the match is ambiguous and the request is silently ignored —
   fix the duplicate from the Users section.

## The user's steps

1. On the login screen, follow the **Forgot your password?** link.
2. Type the username **or** the email address of the account and send the
   request. The screen always confirms with *"If an account matches, a recovery
   code has been sent"* and moves on to the code form.
3. Check the mailbox. The message *"Your Dédalo password recovery code"*
   contains an 8-digit code. By default the code is valid for **10 minutes**
   and can be used **once**.
4. Type the code and the new password, entered twice. It must meet the
   password requirements that apply everywhere in Dédalo: 8 to 64 characters,
   at least one lowercase letter, one uppercase letter and one number, no `&`,
   no common words such as "password", and no runs like `abcd` or `1234` (the
   screen names the first requirement a password misses). On success the screen
   returns to the login form and the new password is active immediately.
5. Log in with the new password.

After a successful reset the account owner also receives a *"Your Dédalo
password was changed"* notice, so an unauthorized recovery does not go
unnoticed. If you receive that notice without having reset your password,
contact your administrator immediately — someone may have access to your email
account.

!!! note "All sessions are signed out"
    A successful reset closes **every** open session of that account, on every
    device. This is deliberate: if the reset was prompted by a stolen or leaked
    password, whoever was using it is cut off at the same moment the password
    changes. The user simply logs in again with the new password.

## How it works

Understanding the mechanics helps when something appears "not to work" —
most of the surprising behavior below is an intentional security property.

### The server never reveals whether an account exists

The request step **always** answers with the same generic confirmation — for a
matching account, an unknown identifier, an inactive account, an account
without an email, an ambiguous match, and even when the mail relay fails. The
response time is normalized too. This prevents an attacker from using the login
screen to discover which usernames or email addresses exist. The flip side:
when recovery silently "does nothing", the reason is only visible in the
**server log**, never in the browser.

### The code, not the reset, is the secret

- The emailed code is generated from a cryptographically secure source and is
  **never stored or logged in clear text** — the server keeps only a salted
  Argon2id digest of it, alongside the code's expiry and attempt counter, in
  the engine's local session store (a SQLite file in the private directory —
  nothing is written to the user record until the reset succeeds).
- The opaque `reset_id` token the browser holds between the two steps is not a
  secret; without the emailed code it is useless.
- The recovery email deliberately contains no username or other account
  identifier, so a misdirected message leaks nothing.

### Brute force is not practical

An 8-digit code has 100 million combinations, and three independent limits keep
guessing hopeless:

| Limit | Default | Behavior when reached |
| --- | --- | --- |
| Code lifetime (`DEDALO_PWRESET_CODE_TTL`) | 600 s (10 min) | The code expires; request a new one |
| Wrong guesses per code (`DEDALO_PWRESET_MAX_ATTEMPTS`) | 5 | The code is invalidated; request a new one |
| Requests / verifications per client address | login-throttle window | Further attempts are silently ignored until the window passes |

A too-short new password is refused with its own message and does **not** count
as a wrong-code guess.

### The password write is the ordinary one

On a correct code the new password goes through the same write path as any
password edit: it is hashed with **Argon2id** before storage (never stored in
clear text) and the change is recorded in the record's Time Machine history,
attributed to the user themself. No session is created by the reset — the user
logs in normally afterwards.

## Configuration

The [installer](../install/installer_reference.md#interactive-mode) asks for
these settings during installation (the optional *Mail* screen, which
also verifies the connection against the relay), and accepts them as
`--mailer --smtp-*` flags (see
[the installer reference](../install/installer_reference.md#command-line-flags)).
On an existing installation, set the keys by hand: they live in
`../private/.env` and are documented in
[the settings reference](configuration/config.md#mailer):

```bash
# SMTP relay (required for recovery emails)
DEDALO_SMTP_HOST="smtp.example.org"
DEDALO_SMTP_PORT=587
DEDALO_SMTP_SECURE=tls
DEDALO_SMTP_USER="dedalo@example.org"
DEDALO_SMTP_PASS="my_smtp_password"
DEDALO_SMTP_FROM="dedalo@example.org"
DEDALO_SMTP_FROM_NAME="Dédalo"

# Recovery tuning (defaults shown)
DEDALO_PWRESET_CODE_TTL=600
DEDALO_PWRESET_MAX_ATTEMPTS=5
```

The SMTP server's TLS certificate is always verified — there is no setting to
turn verification off. If your relay uses a private certificate authority,
provide it to the runtime via the standard `NODE_EXTRA_CA_CERTS` environment
variable instead.

## Troubleshooting

The login screen is intentionally uninformative (see above), so diagnose from
the **server process output** (e.g. `journalctl -u <service> -f`). Typical
causes when no email arrives:

| Server log line | Meaning / fix |
| --- | --- |
| `[mailer] not configured (DEDALO_SMTP_HOST missing)` | Set the `DEDALO_SMTP_*` keys and restart |
| `[mailer] send failed: …` | The relay refused the message — check host/port/credentials/encryption mode |
| `[password_reset] request throttled` | Too many requests from that address — wait for the throttle window |
| *(no line at all)* | The identifier matched no single active account with a valid email — check the user record (active flag `dd131`, email `dd134`, duplicate emails) |

A `[password_reset] recovery code issued for user_id=…` line confirms the
lookup succeeded and a code was generated; from there any failure is on the
mail path.
