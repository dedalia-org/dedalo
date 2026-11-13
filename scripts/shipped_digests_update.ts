/**
 * APPEND THIS TREE'S TEMPLATE RENDERS TO THE SHIPPED-DIGEST LEDGER (owner
 * ruling C33, 2026-11-13) — deploy/systemd/shipped_digests.json, the memory
 * that lets the installer upgrade its own earlier templates and still refuse a
 * stranger's (src/core/install/host/systemd/shipped_digests.ts).
 *
 *   bun run scripts/shipped_digests_update.ts
 *
 * Run it after EVERY edit of a deploy/systemd/ template, before the commit: for
 * each template × OS row it computes the render's sha256 and APPENDS the ones
 * the ledger lacks; it never removes a digest (append-only — the old render's
 * digest is what an installed host still holds). install_host_render_tripwire (j)
 * is RED until it has run. Prints what it added.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Text } from '../src/core/install/host/fs.ts';
import { OS_ROWS } from '../src/core/install/host/os_support.ts';
import { sourceTreeRoot } from '../src/core/install/host/source.ts';
import { renderTemplate, UNIT_TEMPLATES } from '../src/core/install/host/systemd/render.ts';
import {
	readShippedDigests,
	SHIPPED_DIGESTS_FILE,
} from '../src/core/install/host/systemd/shipped_digests.ts';

const root = sourceTreeRoot();
const ledger = readShippedDigests(root);
let added = 0;
for (const name of UNIT_TEMPLATES) {
	const digests = (ledger.templates[name] ??= []);
	for (const row of OS_ROWS) {
		const digest = sha256Text(renderTemplate(name, row, root));
		if (digests.includes(digest)) continue;
		digests.push(digest);
		added += 1;
		console.log(`+ ${name} (${row.id}) ${digest}`);
	}
}
writeFileSync(join(root, SHIPPED_DIGESTS_FILE), `${JSON.stringify(ledger, null, '\t')}\n`);
console.log(`${SHIPPED_DIGESTS_FILE}: ${added} digest(s) added`);
