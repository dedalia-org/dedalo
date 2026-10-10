# Updating ontology

> See also: [Updating code](updating_code.md) · [Updating data](updating_data.md) · [Active ontology TLDs](../../config/config.md#defining-active-ontology-tlds)

The Dédalo ontology is the core of the application. It controls the data definition and how the data is interpreted. The ontology changes several times a day. Updating the ontology ensures that your Dédalo installation has the latest definition.

The ontology version is identified by the timestamp and the build location of the definition.

> Dédalo 2023-09-10T13:38:47+02:00 Benimamet

The ontology is built from different tlds. These tlds identify which part of the ontology is loaded and which parts will be updated.

## Shared and private ontologies

In your installation you could have public and/or private tlds. Public tlds are common and shared definitions and are updated by the main developer/user community.

Private tlds are not common or shared ontology parts and are not maintained by the main developer/user community, but can be maintained by a specific institution or developer and shared by itself, or be your own definition.

Some examples of common and shared tlds: `dd, rsc, oh, ich, tch, hierarchy, etc.`

Some examples of private tlds: `mupreva, qdp, muvaet, etc.`

The update process replaces the whole ontology definition with the latest version, tld by tld; the automatic process reads your configuration and updates only the shared tlds.

Private tlds must be updated manually.

Common and shared tlds are defined by `ACTIVE_ONTOLOGY_TLDS` (set in `../private/.env`). The installer writes it: the core ontologies, the domain ontologies chosen at install time and the ontologies they declare as dependencies (see [Domain ontologies](../../install/installer_reference.md#domain-ontologies)). See the [Configuration Administrator Guide](../../config/administration.md).

## What the panel tells you

Under the master-server list, a collapsed note, **Connect to a remote ontology server**, shows
the [`ONTOLOGY_SERVERS`](../../config/config.md#ontology-servers) entry that puts a master in the
list, field by field. When the picker is empty this is why, and the pill beside the title reads
*None configured*.

Whether THIS installation can serve its ontology to others is a separate maintenance panel,
**Serve Ontology** (see below). It reads the LIVE configuration, so it doubles as a check: each
`../private/.env` key is shown with its current state (`CONFIGURED` / `NOT SET`), never with its
value — the access code itself is never sent to the browser.

## Serving other installations (ontology master)

If your installation is the one **serving** the ontology (`IS_AN_ONTOLOGY_SERVER=true`), each client's update panel asks it for the update manifest **from the browser**, not from the client's server. The master must therefore accept the client's origin in [`DEDALO_CORS_ALLOWED_ORIGINS`](../../config/config.md#cross-origin-api-callers-cors) or the client's browser blocks the call and the panel fails with a network error.

The minimum configuration for an installation that serves its ontology is three keys:

```bash
IS_AN_ONTOLOGY_SERVER=true
ONTOLOGY_SERVER_CODE=xx-myspecialcode-xxx
DEDALO_CORS_ALLOWED_ORIGINS=["*"]
```

[`IS_AN_ONTOLOGY_SERVER`](../../config/config.md#is-an-ontology-master-server) opens the ontology JSON
endpoint (and adds a *Local files* source to this installation's own panel);
[`ONTOLOGY_SERVER_CODE`](../../config/config.md#defining-the-ontology-master-server-code) is the access code every
client must present — pick your own, and give it to the installations you authorize. The
endpoint clients register is `<your origin>/dedalo/core/api/v1/json/`, printed in the
**Serve Ontology** panel, which also shows the three keys as a live checklist.

Which value of `DEDALO_CORS_ALLOWED_ORIGINS` depends on who you serve:

* **A known set of installations** — list every client origin, as exact `scheme://host[:port]` strings (no partial wildcards, no trailing slash): `DEDALO_CORS_ALLOWED_ORIGINS=["https://archive.example.org","https://museum.example.org"]`.
* **A public master**, serving installations you do not know in advance — their origins cannot be enumerated, so set the single entry `*`: `DEDALO_CORS_ALLOWED_ORIGINS=["*"]`. This opens only the **anonymous** API, the same surface any `curl` on the internet already reaches; clients still present the `ONTOLOGY_SERVER_CODE` access code, and no cross-origin caller ever carries a session.

### Declaring what an ontology requires

A master also tells other installations **what each ontology needs**: the
ontologies whose nodes it uses as models or links to, and the thesauri its
data is meant to point at. An installer reads this declaration and nothing else.
It never works out dependencies on its own.

The declaration is ordinary Dédalo data on the master:

1. Open **Ontology › Ontologies main** (`ontology35`) and edit the record of the
   ontology, for example the `tch` record.
2. In the *Relations* group, fill **Dependencies** (`hierarchy60`, a JSON
   field) with one object per requirement:

    ```json
    [
      { "tld": "dd", "main": "ontology35", "mandatory": true },
      { "tld": "dc", "main": "hierarchy1", "mandatory": false }
    ]
    ```

    * `tld` is the TLD of the requirement.
    * `main` says what must be present. `ontology35` means that TLD's
      **ontology**. `hierarchy1` means that TLD's **thesaurus** (its hierarchy,
      with its terms, installed and active). A TLD may appear twice, once with
      each value.
    * `mandatory: true` on an **ontology** (`ontology35`) means it is always
      installed and cannot be unticked. On a **thesaurus** (`hierarchy1`) it is
      a strong recommendation: the installer offers it ticked and marked
      *strongly recommended*, and the operator may still untick it (a warning
      says it can be installed later) — a thesaurus never blocks an install.
      With `mandatory: false`, the installer offers it already ticked and the
      operator may untick it.

    Include the core ontologies the ontology uses (every domain ontology takes
    its models from `dd`). An installer skips core ontologies, because every
    installation already has them. An ontology may name its own thesaurus
    (`main: hierarchy1`), but naming its own ontology is dropped.
3. Export the ontology files again (the **Export** action of the
   [ontology parser](../../tools/using_ontology_parser.md)). The export writes the
   list as `dependencies` on that ontology's entry in `ontology.json`, and the
   update manifest serves it unchanged. Malformed items are left out and listed
   as export warnings.

An **empty** field means *not declared*, not *needs nothing*. The ontology is
exported with no `dependencies`, and an installer that is asked for it warns
that the server declares no dependencies, then installs it alone. An empty list
(`[]`), or a list that names only core ontologies, is a complete declaration:
*needs nothing beyond the core*.

**Importing keeps the declaration.** When an installation imports an ontology
whose master declares its requirements (with this panel or at install time), the
import writes **Dependencies** on that ontology's record here, replacing what
the field held. A master that gets its ontologies from another master (a local
master for an institution's network, for example) therefore publishes the same
declarations with its next export. An ontology the source does not declare
leaves the field as it is.

**An update reports what is missing; it never installs it.** After an update,
each updated ontology's declared requirements are checked against this
installation. A missing **mandatory** requirement is listed under *Import
warnings*, naming both ontologies and how to provide it: add the TLD to
`ACTIVE_ONTOLOGY_TLDS` and run the update again, or install the thesaurus with
**Maintenance › Install hierarchies**. A missing optional requirement is only a note
in the import log.

### On the client side

A client needs one key — the master it may pull from. **The installer already
writes the official master here**, unless the install was air-gapped
(`--no-update-servers`, the unticked update-server box in the wizard, or *no* in
`install.sh`), which writes `[]`. To use another master or a mirror, or to
switch an air-gapped install on, change the value on that existing line — replace
the `[]`, or add the entry inside the list — then restart. An entry looks like this:

```bash
ONTOLOGY_SERVERS=[{"name":"Dédalo Ontology server","url":"https://myserverdomain.org/dedalo/core/api/v1/json/","code":"xx-myspecialcode-xxx"}]
```

`code` is the `ONTOLOGY_SERVER_CODE` configured on **that** server; a wrong or missing one makes
the master answer as *Unreachable* in the picker. Add one object per master.

A master is identified by its `url`, never by its `code`: several masters may share the same
access code (the official one and a local copy of it, for example), and the update downloads
only from the address of the master you picked. A file whose address is on any other host is
refused before it is written.

The client's own engine must also allow the connection: the browser's Content-Security-Policy has to name the master in `connect-src`, or the fetch is refused before it leaves. The engine derives this automatically from the master URLs in [`ONTOLOGY_SERVERS`](../../config/config.md#ontology-servers) — there is no second setting — but the policy is built at **boot**, so a client that has just added or changed a master must be **restarted** before the panel can reach it.

!!! warning "The panel can report a master as *ready* and still fail on submit"
    The reachability check beside the button is made server to server, so neither CORS nor the CSP applies to it. Two separate browser-side gates can still refuse the update, and they fail with different messages in the browser console:

    * `violates the following Content Security Policy directive: "connect-src …"` — the **client** does not list the master. Check `ONTOLOGY_SERVERS` on the client, and restart it.
    * a CORS or network error naming the master — the **master** does not accept the client's origin. Check `DEDALO_CORS_ALLOWED_ORIGINS` on the master.

    Both surface in the panel as the same unhelpful `Max retries reached, request failed`, so read the console for these two.

A refusal that comes **from the server** — a download refused, a file that fails validation, an
import rolled back — is shown in the panel under the button: the error, the server's explanation
(for example `origin mismatch: <file host> != <picked master>`) and a `request_id` that finds the
same request in the server log.

## Update process

To update the shared ontology enter into the Maintenance panel in the System administration -> Maintenance and locate the update ontology control:

![Updating ontology control panel](assets/20230910_141614_updating_ontology_panel.png)

The control panel will show the ontology configuration and the tlds to be updated; it's possible to change the tlds to be updated by editing the input field to add or remove one.

### Which tlds are updated

The prefilled list is `ACTIVE_ONTOLOGY_TLDS` unioned with the core pair `ontology` / `ontologytype` (always imported, whatever the configuration says). When the key is not set in `../private/.env`, it falls back to the core ontologies every installation carries — exactly what the install database ships:

```
dd, rsc, ontology, ontologytype, hierarchy, lg
```

Domain tlds (`oh`, `ich`, `tch`, `numisdata`, `utoponymy`, `nexus`, …) are per-installation: the installer writes the ones it installed into `ACTIVE_ONTOLOGY_TLDS`; add any you import later so they are offered here on every update — that is the only place to change the default for everybody. They are never part of the fallback above.

!!! note "Adding a domain ontology later does not add its dependencies"
    The installer installs the dependencies an ontology server declares; this panel imports exactly the tlds in the line. When you add a domain ontology here, check the master's catalog (*Fetch list*) for what it requires and add those tlds too.

The panel tells you which of the two you are looking at: when the key is set the reference list is headed **Configured in this installation**, and when it is not it reads **Engine fallback (not configured)** and the note says so. An empty value counts as unset.

The master server you pick is also remembered in your browser (by URL) and restored the next
time the panel renders — after a reload or after navigating away and back — so the update is one
click when you come back to it. If that server later disappears from `ONTOLOGY_SERVERS` or is
unreachable, nothing is restored and you simply pick again.

**The input line is yours.** What you type there is remembered in your browser and is *never* rewritten when you select a master server, so you can prepare the list first and pick the server after. Two reference lists sit above it, and neither touches the input unless you click:

* **Configured in this installation** — the prefilled list above. *Use this list* puts it back, which is how you undo an edit.
* **Offered by the selected master** — the master's own manifest, fetched on demand with *Fetch list* (it costs one request, so it is not fetched just by selecting). It has no *Use this list* button on purpose: a master publishes the **whole** ontology, 200+ tlds including every language pack, and importing all of it is never what you mean.

Clicking any tld chip adds it to the line, or removes it if it is already there. A chip is **highlighted while its tld is in the line**, in both lists — including when you type in the field by hand — so the reference lists double as a readout of what the update will import.

When ready, press the "Update Dédalo Ontology to the latest version" button, and the process will execute.

Dédalo will erase all definitions of the specified tlds and import the new definition.

![Updating ontology result](assets/20230910_141614_updating_ontology_result.png)

The import pipeline (`update_ontology` widget, `src/core/ontology/ontology_update.ts`) stages and validates every downloaded file before making any destructive change, takes a per-table recovery snapshot before importing each tld, and auto-restores that snapshot if the import fails partway through — an import either fully succeeds or fully rolls back, tld by tld. A schema-changes snapshot of the update is written under `../private/backups/ontology/changes/`.

### Updating without a network (air-gapped installs)

Copying ontology files onto the server imports nothing by itself: every import
goes through this panel. An installation that can reach no master (an
air-gapped install has `ONTOLOGY_SERVERS=[]`) imports from its own disk through
the panel's **Local files** source:

1. Get the files from a master's export: for each tld a `<tld>.copy.gz`, plus
   the `ontology.json` that describes them (and `matrix_dd.copy.gz` for the
   private lists). They come in a version directory, `<major.minor>/`, for
   example `7.0/`.
2. Put that directory under the server's ontology I/O directory,
   [`ONTOLOGY_DATA_IO_DIR`](../../config/config.md#ontology-inputoutput-exportimport-or-download-directory)
   — by default `../private/import/ontology/` once that directory exists, and
   until then the in-tree `install/import/ontology/`. Prefer the private one: a
   code update moves the whole code tree aside, files you added included.
3. Set [`IS_AN_ONTOLOGY_SERVER=true`](../../config/config.md#is-an-ontology-master-server)
   in `../private/.env` and restart. That is what adds *Local files* to the
   panel. It also makes this installation serve the files in that directory
   to anyone who can reach it; set it back to `false` and restart after the
   import if you do not mean to serve.
4. In the panel, pick **Local files**, put the tlds in the line, and update.

The files themselves are copied from that directory on disk; nothing is
downloaded. Only the file list (the manifest) is fetched over the network: your
browser asks this installation's own public address for it, so the server must
know that address ([`DEDALO_HOST`](../../config/config.md#defining-host)); with
it unset, only a browser on the server itself gets the list.
