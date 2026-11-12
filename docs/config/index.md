# Configuration

> See also: [Installation](../install/index.md) · [Management and maintenance](../management/index.md)

Dédalo v7 keeps **all** of its configuration in one file, **`../private/.env`** —
one level above the install, outside the web root:

```bash
# ../private/.env
ENTITY=my_museum
DB_NAME=dedalo
DB_HOST=localhost
DB_USER=dedalo
DB_PASSWORD=…
```

Change a value, restart the server, done. There is nothing to edit inside the
served tree — if you are looking for the four config files of v6, see
[what changed in v7](whats_changed_v7.md).

A fresh install needs none of this by hand: the installer writes the file for
you — the terminal installer (`sh install.sh`, or `bun run dedalo:install` in a checkout), whatever
route or mode you run it in, writes the same keys ([what `.env` gets](../install/installer_reference.md#what-privateenv-does-and-does-not-get)).

---

## Configuration pages

| Page | What it covers |
|---|---|
| [How configuration works](administration.md) | Where values live, how they resolve, secrets, required keys, troubleshooting. **Start here.** |
| [Settings reference](config.md) | Every setting, what it means, and its default. |
| [What changed in v7](whats_changed_v7.md) | The v6 → v7 map: renamed, reshaped and removed settings. |
| [Migrating a v6 install to v7](../install/migrating_from_v6.md) | The whole v6 → v7 migration, config included — `dedalo:migrate-config` is Phase C of it. |
| [Database connection](config_db.md) | PostgreSQL (the work database) and MariaDB (diffusion). |
| [Areas](administration.md#11-denying-and-hiding-areas) | Allowing and denying areas. |
| [Media protection](media_protection.md) | Web-server-enforced access control for media files. |
| [Search](search.md) | The search trust boundary and its limits. |
| [Thesaurus dependencies](thesaurus_dependencies.md) | Which ontology TLDs need which hierarchies. |

---

## The essentials

**The file.** `../private/.env`, mode `0600`, outside the web root. One
`KEY=value` per line. Lists and maps are JSON; booleans are `true`/`false`.

**Precedence.** The process environment beats the file; the file beats the
engine's built-in default.

**It is append-only.** Three edits are legitimate, and nothing else:

- **Add a line** for a key the file does not have yet.
- **Change a value on its existing line**, in place — for example adding a
  domain ontology's code to `ACTIVE_ONTOLOGY_TLDS`, replacing the `[]` of an
  air-gapped install's `ONTOLOGY_SERVERS`/`CODE_SERVERS`, or new database
  credentials. Never add a second line for a key that is already there: the
  file is read top to bottom and the **last** line silently wins.
- **Rename a retired key** when the boot refuses and names it.

Never delete a line: a key you remove silently falls back to a default. The
installer writes `.env` once, at install time, and refuses to install over a
sealed installation, so after the install every change is a hand edit.

**Restart to apply.** Configuration is read once, at boot.

**`install/sample.env`** in the code tree documents every key with its default —
copy the lines you need out of it. The installer leaves a copy at
`../private/sample.env`, but a code update does not refresh that copy, so it lacks
every key added since the install.

---

## Required settings

A configured install must have `ENTITY`, `DB_NAME`, `DB_HOST`, `DB_USER` and the
language block (`DEDALO_APPLICATION_LANGS`, `DEDALO_APPLICATION_LANGS_DEFAULT`,
`DEDALO_DATA_LANG_DEFAULT`, `PROJECTS_DEFAULT_LANGS`), or the server refuses to
boot — loudly, naming the missing key. See
[§5 Required settings](administration.md#5-required-settings).

## Runtime state is not configuration

Maintenance mode, install status and area overrides live in
`../private/ts_state.json`, written by the application itself. Do not hand-edit it.
