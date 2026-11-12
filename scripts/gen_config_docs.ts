/**
 * gen_config_docs.ts — render the operator-facing config artifacts from the catalog.
 *
 *   bun run config:gen      write install/sample.env + the generated regions of
 *                           docs/administration/configuration/{config,config_db}.md
 *   bun run config:check    render, diff against disk, exit 1 on drift (what CI runs)
 *
 * The catalog (src/config/catalog/) is the single source of truth; these three files are
 * OUTPUT. `test/unit/config_docs_tripwire.test.ts` re-renders and demands byte identity,
 * so hand-editing any of them is a red gate — the only way to change them is to change the
 * catalog and re-run this.
 *
 * Runs on an UNCONFIGURED box by design: it imports the catalog and the renderers, never
 * `config.ts` (which throws when the box has no .env — e.g. a fresh clone, or CI).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderReferencePage, renderSampleEnv, spliceGenerated } from '../src/config/render.ts';

const ROOT = join(import.meta.dir, '..');
const check = process.argv.includes('--check');

interface Artifact {
	path: string;
	next: string;
}

const artifacts: Artifact[] = [{ path: 'install/sample.env', next: renderSampleEnv() }];

for (const page of ['config', 'config_db'] as const) {
	const path = `docs/administration/configuration/${page}.md`;
	const existing = readFileSync(join(ROOT, path), 'utf8');
	artifacts.push({ path, next: spliceGenerated(existing, renderReferencePage(page)) });
}

let drifted = 0;
for (const { path, next } of artifacts) {
	const full = join(ROOT, path);
	let current: string;
	try {
		current = readFileSync(full, 'utf8');
	} catch {
		current = '';
	}
	if (current === next) {
		if (!check) console.log(`  unchanged  ${path}`);
		continue;
	}
	if (check) {
		drifted++;
		const currentLines = current.split('\n').length;
		const nextLines = next.split('\n').length;
		console.error(`  DRIFT  ${path}  (on disk: ${currentLines} lines, rendered: ${nextLines})`);
		continue;
	}
	writeFileSync(full, next);
	console.log(`  written    ${path}`);
}

if (check && drifted > 0) {
	console.error(
		`\n${drifted} artifact(s) are out of date with src/config/catalog/.\nRun: bun run config:gen`,
	);
	process.exit(1);
}
if (check) console.log('config artifacts are in sync with the catalog.');
