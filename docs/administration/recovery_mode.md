# Recovery mode

> See also: [Management and maintenance](index.md) · [Updating ontology](updates/updating_ontology.md) · [Backup](backup.md)

The Dédalo Ontology defines every section, component and label of the application. If
it is damaged — a failed update, a bad import, a manual edit — the interface may not
render at all, including the maintenance area you would use to fix it.

Earlier versions had a **Recovery mode** switch in *Maintenance → Check config* for this.
It is gone in v7: it only showed a banner, and a switch inside the interface cannot be
reached when the ontology that draws the interface is broken. A damaged ontology is
repaired **from the command line, with Dédalo stopped**.

## How the ontology is stored

Dédalo runs on the `dd_ontology` table. That table is **derived**: every node in it is
parsed from an ontology record (the `<tld>0` sections, e.g. `dd0`, `rsc0`). So most damage
to `dd_ontology` is repaired by deriving it again from those records.

There is one catch: the parser itself reads the core ontology (`dd`, `ontology`, …) to
understand the records. If the core nodes are broken, it cannot derive anything. For
that case Dédalo keeps a **recovery file**: a copy of the core ontology
(`dd, rsc, lg, hierarchy, ontology, ontologytype, test`), built from
*Maintenance → Build database version → recovery file* and stored at
`<private dir>/db/dd_ontology_recovery.sql.gz` (`DEDALO_ONTOLOGY_RECOVERY_PATH` moves it).
Build a fresh one whenever the ontology is known to be healthy, and before every update.

## Repair the ontology

1. Stop Dédalo (and its watchdog timer). The repair refuses to write while any
   client is connected to the database: a running server would keep serving the
   damaged ontology from its cache.
2. From the installation directory, see what would happen (nothing is written):

    ```bash
    bun scripts/ontology_recover.ts
    ```

    It reports the recovery file it would use and, for every TLD, how far
    `dd_ontology` is from its records (*drift*). When the core ontology itself is
    broken, the drift cannot be measured yet: the report says so, and the snapshot
    step is what fixes it.

3. Repair:

    ```bash
    bun scripts/ontology_recover.ts --apply
    ```

    This runs two steps, in order:

    - `--snapshot` — puts the recovery file's core ontology back into `dd_ontology`,
      replacing every row of those TLDs, in one transaction (a failure writes nothing).
      A node the recovery file could not hold (an identifier that breaks the naming
      rules, listed when the file was built) is gone until the `--rebuild` step
      derives it again — run both steps unless you know why not.
    - `--rebuild` — derives every TLD's `dd_ontology` again from its records.

    Pass only one of them to run only that step, e.g. `--rebuild --apply` when the core
    is fine and only a TLD has drifted. `--file <path>` uses another recovery file.

4. Start Dédalo and check the result.

Exit status: `0` repaired (or a dry run with nothing to repair), `2` something is left
to do (drift, a missing recovery file, or TLDs the rebuild could not repair — named in
the report as *NOT repaired*), `1` refused or failed.

## When the records themselves are damaged

`--rebuild` derives the ontology from the records *as they are*. If a bad update damaged
the records, the rebuild reproduces the damage: re-apply the ontology from the master
server ([Updating ontology](updates/updating_ontology.md)), or restore a database backup
([Backup](backup.md)).
