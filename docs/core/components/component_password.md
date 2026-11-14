# component_password

## Overview

```json
{
    "could_be_translatable" : false,
    "is_literal": true,
    "is_related": false,
    "is_media": false,
    "modes": ["edit","list","tm","search"],
    "default_tools" : [
        "tool_propagate_component_data",
        "tool_time_machine"
    ],
    "render_views" :[
        {
            "view"    : "default | line",
            "mode"    : "edit"
        },
        {
            "view"    : "mini | print",
            "mode"    : "edit"
        },
        {
            "view"    : "default | text | mini",
            "mode"    : "list"
        }
    ],
    "data": "object",
    "sample_data": {
        "lg-nolan": ["$argon2id$v=19$m=65536,t=4,p=1$..."]
    },
    "value": "array of strings",
    "sample_value": ["****************"]
}
```

!!! note "Stored values are served masked"
    `component_password` is a write-only credential field. Its descriptor
    declares `secretValue: true`, and `resolveComponentValue`
    (`src/core/resolve/component_data.ts`) — the resolver every display door
    reads through (section read and `get_data`, the save response, the Time
    Machine history, portal list values, datalists) — serves each non-empty
    stored value as the constant mask `****************`, keeping the item's
    `id`. An empty value stays empty, so "no password" remains visible.

## Definition

`component_password` is a literal-direct component that stores a single user
credential securely. Descriptor-wise it is unremarkable —
`src/core/components/component_password/descriptor.ts` stores its data in the
same `string` matrix column as [component_input_text](component_input_text.md),
read/written by the same generic engines. What makes it security-critical is
three behaviours layered on top of that plain string storage:

1. **One-way hashing on write.** Plaintext entered by the user is hashed with
   Argon2id before it ever reaches the matrix write. The stored value is
   non-reversible.
2. **Masked on every read.** The component is meant to never emit its real
   stored value — the API datum, grid/list views, export and diffusion should
   all substitute a constant mask (`****************`) instead of the hash.
3. **Verification, not equality.** Because Argon2id incorporates a random salt, two
   hashes of the same password differ. Comparison must go through a
   constant-time verify call, never a string equality check.

!!! note "Where each behaviour lives"
    Hashing on write (1) is a single chokepoint: `src/core/section/record/save_component.ts`
    detects `model === 'component_password'` and routes the change through
    `hashPasswordChanges` (`src/core/security/password_hash.ts`), which first
    refuses a plaintext that breaks the password policy and then hashes it —
    every write door (client API, MCP tools, the agent change-plan, CSV import)
    funnels through `save_component.ts`. Masking on read (2) is the descriptor
    facet `secretValue` applied by `resolveComponentValue`
    (`src/core/resolve/component_data.ts`). Verification (3) is implemented in
    the **auth flow** (`src/core/security/auth.ts`), which reads the stored
    hash directly and verifies with `Bun.password.verify()` (native Argon2id).

**Why it exists.** Dédalo needs to authenticate users without ever holding a
recoverable copy of their password. This component is the credential field:
hashing on write, masking on read and verification on login are implemented;
the legacy-hash upgrade path is a one-time migration (see [Notes](#notes)).

**When to use it.** Only for actual secret credentials that must be verified but
never displayed — most prominently the user account password field
[dd133](https://dedalo.dev/ontology/dd133) inside the
users section. In a cultural-heritage install this is the back-office account
password for catalogers, archivists or external contributors logging into the
repository.

**When not to use it.** Never for data you need to read back. It is not a generic
"hidden" or "obfuscated" text field — once saved, the plaintext is gone forever.
For ordinary text use [component_input_text](component_input_text.md); for an API
token or external identifier you need to retrieve, use a normal literal component,
not this one.

## Data model

**Data:** `object` with language as property (`lg-nolan` for the canonical
non-translatable instance — see below).

**Value:** `array` of `strings`, or `null`. Each string is a stored *credential*
(an Argon2id hash for current data, or a legacy AES blob for not-yet-upgraded data).

**Storage:** Like every string component, the persisted unit inside the matrix
`data` column is an array of items `{id, value}`. Its descriptor declares
`classSupportsTranslation: true` — the same class-level capability as
[component_input_text](component_input_text.md) — so translatability is driven by
the ontology node, not hard-coded by the model. The canonical instance
([dd133](https://dedalo.dev/ontology/dd133), the user account password) is
deployed with `translatable: false`, so its language is always `lg-nolan` and
there are no per-lang rows.

Stored shape (current Argon2id hash):

```json
{
    "lg-nolan" : ["$argon2id$v=19$m=65536,t=4,p=1$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG"]
}
```

Legacy reversible AES blob (base64), still readable during the migration window but
**not** transparently upgraded on login (see [Notes](#notes)):

```json
{
    "lg-nolan" : ["SzlpYmp6TXg5VEN4RDVRZnVPMU9yVStjZWJmYVV1M003aDM3bVAremVxcz0="]
}
```

!!! note "What the client/API actually receives"
    On read, the datum `data` item keeps the real entry `id` but its value is
    the mask: `{ "id": 7, "value": "****************" }`. The mask can never be
    saved back as a credential — it breaks the password policy and is refused.

## Ontology instantiation

Define a `component_password` as an ontology node like any other literal component.
The minimal node JSON:

```json
{
    "tipo"         : "dd133",
    "model"        : "component_password",
    "parent"       : "dd119",
    "lg-eng"       : ["Password"],
    "lg-spa"       : ["Contraseña"]
}
```

- `model` must be `component_password`; the model is resolved from the tipo by
  `getModelByTipo()` (`src/core/ontology/resolver.ts`).
- `translatable` is honoured like any class-translatable component. The
  canonical `dd133` node ships `translatable: false`, so it is `lg-nolan` and
  has no `tool_lang`; a node could in principle be declared translatable, but
  that is not the deployed shape and is not a sensible one for a credential.
- Wire it into a section by giving it a `parent`/`section_tipo` that resolves to the
  owning section (for the canonical case, the users section
  `DEDALO_SECTION_USERS_TIPO`). `section_tipo` is mandatory on `get_instance`
  (auto-resolution was removed; empty returns `null`).

A realistic `properties` block for this component is typically empty — the sample
context ships `"properties": {}`:

```json
{
    "properties" : {},
    "css"        : null
}
```

There is no per-component object to construct. The auth flow reads the
stored hash directly with a parameterized SQL query against `matrix_users` and
verifies it with `Bun.password`:

```ts
// src/core/security/auth.ts (findUserByUsername, abridged)
const rows = await sql.unsafe(
    `SELECT section_id, string FROM matrix_users
     WHERE section_tipo = $1 AND string->$2 @> $3::text::jsonb LIMIT 1`,
    [USERS_SECTION_TIPO, USERNAME_COMPONENT, JSON.stringify([{ value: username }])],
);
const passwordHash = rows[0]?.string?.[PASSWORD_COMPONENT]?.[0]?.value ?? null;
// ...
const verified = await Bun.password.verify(password, passwordHash);
```

`USERS_SECTION_TIPO` resolves to `dd128` and `PASSWORD_COMPONENT` to `dd133` —
the users section and its password field.

## Properties & options

`component_password` reads **no component-specific ontology properties**. The sample
context ships an empty `properties` object, and nothing in its behaviour reads it.
Standard generic framing properties (e.g. `css`, `request_config`) still apply
through the common datum `context`, but there are no password-only options to
configure.

!!! note "The password policy is engine-wide, enforced on the server, and not ontology-driven"
    One policy applies to every door that sets a password: at least 8 and at most
    64 characters (counted in code points), at least one lowercase letter, one
    uppercase letter and one digit (Unicode-aware), no `&`, no common words such as
    `password`/`contraseña`, and no run of 4 consecutive letters or digits
    (`abcd`, `1234`). The rules and their evaluator are ONE pure module,
    `client/dedalo/core/component_password/js/password_policy.js`, run by the
    browser (the live checklist) and by the server
    (`src/core/security/password_policy.ts` re-exports it). The write engine
    refuses a new plaintext that breaks a rule with `validation.password_policy`
    (`details.rule` = the first broken rule) before hashing; the password
    recovery flow and the installer's root step apply the same rules. A replayed
    Argon2id hash (import round-trip) is not judged. It is not an ontology
    property: there is no per-node policy.

There are no deprecated component properties.

## Render views & modes

Modes (the same four standard component modes): `edit`, `list`, `tm`, `search`.
In the JS model both `list`, `tm` and `search` resolve to the list renderer, so all
non-edit modes render the masked read-only output.

| view | mode | renderer | output |
| --- | --- | --- | --- |
| `default` | edit | `view_default_edit_password` | the password editor (see below) |
| `line` | edit | `view_default_edit_password` (no label node) | same editor, compact wrapper |
| `print` | edit | `view_default_edit_password` (forces `permissions=1`) | read-only masked `content_value` |
| `mini` | edit / list | `view_mini_password` | masked mini wrapper |
| `default` | list | `view_default_list_password` | masked list wrapper |
| `text` | list | `view_text_list_password` | masked `<span>` text node |

!!! note "Edit: the password editor"
    The field is always **empty** (a stored hash is never a value to edit); an
    idle status line says whether a password is set. Typing shows the policy
    checklist, each rule painted pending / met / broken as you type, plus a
    confirm field and a "both passwords match" row. **Save** is enabled only
    when every rule passes and both fields match; Save or Enter commits through
    `save_password()` (`component_password.js`), never on blur. The status line
    then reads *Password saved*, or the reason it was not saved (a server
    `validation.password_policy` refusal renders there, not as a toast).
    Escape or Cancel discards the draft. A draft arms the page's unsaved-work
    guard (a tab close asks) without becoming `changed_data`, so the
    navigation auto-save sweep never commits an unconfirmed password. The
    editor does not offer removing a password.

The CSS (`component_password.less`) styles the editor (`.password_editor`:
field + toggle, confirm, `.password_rules` checklist keyed on `data-state`,
actions, `.password_status`); `view_line` is `display: block`.

## Import / export model

**Export.** A `component_password` column is not offered for export
(`section_elements_context.ts` skips the model), and a value that reaches the
export grid through the shared emission is the mask, never the hash:

```json
{ "label": "Password", "value": "****************" }
```

**Import.** Import runs through the generic write path: `conformImportData()`
(`src/core/tools/import_data.ts`, `component_password` is a
`VALUE_PROPERTY_MODELS` member) wraps a bare cell into a `{value}` item, and
the save itself goes through `saveComponentData()`
(`src/core/tools/import_execute.ts` -> `src/core/section/record/save_component.ts`)
— the same hashing gate described above. A plaintext string cell is hashed with
Argon2id before it lands in the matrix; a cell that is already an Argon2id hash
(`$argon2…`) passes through verbatim, so an export→import round-trip of a
current-format credential never double-hashes:

```json
{
    "lg-nolan" : ["$argon2id$v=19$m=65536,t=4,p=1$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG"]
}
```

!!! warning "Legacy AES cells are re-hashed, not preserved"
    The hashing gate (`hashPasswordForStorage`, `src/core/security/password_hash.ts`)
    only recognises an Argon2id hash as "already stored"; it has no separate
    legacy-ciphertext check wired into that decision. Importing a cell that
    holds a legacy AES-encrypted value (not an `$argon2…` string) is treated
    as plaintext and gets Argon2id-hashed — turning the ciphertext itself into
    a new hash, which silently invalidates that credential rather than
    preserving it. Do not round-trip legacy password columns through import.

See [importing data](../../using/importing_data.md) and [exporting data](../../using/exporting_data.md)
for the general model.

## Notes

**Hashing & verification API.**

- `hashPasswordForStorage(value)` (`src/core/security/password_hash.ts`) — the
  per-value rule: empty/null passes through untouched (the caller means "no
  change"); an already-Argon2id value (`$argon2…`) passes through verbatim;
  anything else is treated as plaintext and hashed with `Bun.password.hash(value,
  { algorithm: 'argon2id' })`. The per-password random salt is embedded in the
  hash string, so there is no separate global salt.
- `hashPasswordChanges(changes)` — applies `hashPasswordForStorage` across a
  save's changed-data entries (array or bare-string item shapes); this is what
  `save_component.ts` calls for `model === 'component_password'`.
- `isArgon2Hash(value)` — recognises any `$argon2…` PHC string.
- `isLegacyEncryptedPassword(value)` — recognises a legacy reversible-AES
  ciphertext (non-empty, not an Argon2 hash, not `$`-prefixed) but is **not**
  wired into `hashPasswordForStorage`'s decision — see the warning above about
  legacy cells being re-hashed on import rather than preserved.
- `Bun.password.verify()` (`src/core/security/auth.ts`) — constant-time
  Argon2id verification against the stored hash at login.

**Lazy migration on login is not implemented; login is refused instead.** A
legacy (pre-Argon2) password hash cannot be transparently upgraded on login
today. The auth flow checks whether the stored hash starts with `$argon2`; if
it does not, it logs a server-side error and refuses the login (the same
ambiguous client-facing message as any other failure) rather than attempting a
rehash. There is no `root`-user special case, because there is no upgrade path
for it to be excluded from.

The actual remediation is a one-time bulk migration, not a per-login rehash:
`scripts/migrate_v6_passwords.ts` (backed by `src/core/security/legacy_password.ts`)
decrypts the reversible legacy ciphertext, immediately re-hashes it with
Argon2id, and writes the hash back — the recovered plaintext is never logged,
returned, or persisted. It is meant to be run once against the database before
opening it to logins, not invoked automatically by the auth flow.

**Save through the section.** Like all components, `component_password` never
touches the DB directly; it goes through the same generic
`src/core/section/record/save_component.ts` as any other string component,
with the hashing gate described above applied first. Saves are refused in
`search`/`tm` modes.

**Default tools.** The shipped context exposes `tool_propagate_component_data` and
`tool_time_machine`. The canonical `dd133` instance has no `tool_lang` (it is
non-translatable) and no `tool_add_component_data`/`tool_replace_component_data`
(single masked value).

**Gotchas.**

- Never compare stored values with `===`; always go through `Bun.password.verify()`
  (`src/core/security/auth.ts`).
- The value a reader receives is always the mask (or empty). Do not build
  client behaviour on it beyond "a password is set".
- `hashPasswordForStorage`'s "already hashed" check is a simple prefix test
  (`startsWith('$argon2')`). A plaintext password that happens to start with
  that literal string would be stored verbatim, unhashed, instead of being
  hashed — an edge case worth being aware of, however unlikely in practice.

**Related components.** [component_input_text](component_input_text.md) (same
`string` column, but readable and translatable), [component_iri](component_iri.md)
and `component_security_access`. See the typology overview in
[index](index.md).
