#!/usr/bin/env bun
/**
 * Tool scaffolder (PHP tools/tool_common/cli/create_tool.php).
 *
 * Copies the tool_dev_template package into a new tools/<name>/ directory,
 * renames the identifiers, and writes a minimal register.json in the flat
 * AUTHORING format (which importTools converts to the column-keyed record).
 *
 * Usage:
 *   bun run scripts/create_tool.ts --name=tool_my_thing --label="My Thing" [--models=section,component_input_text]
 *
 * The new tool is created but NOT registered — run the area_maintenance
 * "Register tools" widget (dry-run by default) to reconcile it with dd1324.
 */

import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { collectHues, OUT_FILE, render } from './tool_colors.ts';

const TOOLS_ROOT = resolve(import.meta.dir, '../tools');
const TEMPLATE = 'tool_dev_template';

function arg(flag: string): string | undefined {
	const hit = Bun.argv.find((a) => a.startsWith(`--${flag}=`));
	return hit?.slice(flag.length + 3);
}

const name = arg('name');
const label = arg('label') ?? name;
const models = (arg('models') ?? 'all_components')
	.split(',')
	.map((m) => m.trim())
	.filter(Boolean);

if (name === undefined || !/^tool_[a-z0-9_]+$/.test(name)) {
	console.error('Error: --name=tool_<snake_case> is required (pattern ^tool_[a-z0-9_]+$)');
	process.exit(1);
}
const targetDir = resolve(TOOLS_ROOT, name);
if (existsSync(targetDir)) {
	console.error(`Error: ${targetDir} already exists`);
	process.exit(1);
}

// 1. Copy the template package. Dotfiles are skipped: the only ones that turn up
// in the template tree are OS junk (.DS_Store), and step 2 rewrites every copied
// file as UTF-8 text — which would corrupt a binary one.
cpSync(resolve(TOOLS_ROOT, TEMPLATE), targetDir, {
	recursive: true,
	filter: (source) => !basename(source).startsWith('.'),
});

// 2. Rename template identifiers in every file, and rename template-named files.
function renameInTree(dir: string): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = resolve(dir, entry.name);
		if (entry.isDirectory()) {
			renameInTree(full);
			continue;
		}
		const text = readFileSync(full, 'utf8').replaceAll(TEMPLATE, name as string);
		writeFileSync(full, text);
		if (entry.name.includes(TEMPLATE)) {
			renameSync(full, resolve(dir, entry.name.replaceAll(TEMPLATE, name as string)));
		}
	}
}
renameInTree(targetDir);

// 3. Overwrite register.json with a minimal AUTHORING-format file.
const authoring = {
	$schema: '../../src/core/tools/register.schema.json',
	name,
	version: '1.0.0',
	label: { 'lg-eng': label },
	affected_models: models,
	show_in_component: true,
	active: true,
	// open_as ∈ 'modal' (default: a modal over the page) | 'window' (a separate
	// browser window) | 'attach' (built onto the live caller component; the client
	// class implements attach()/detach(); needs show_in_component: true and
	// show_in_inspector: false). Enforced by validateRegister (src/core/tools/register.ts).
	properties: { open_as: 'modal' },
};
writeFileSync(resolve(targetDir, 'register.json'), `${JSON.stringify(authoring, null, '\t')}\n`);

// 4. Give it its identity colours. The header edge, wash and button fill/ink come
//    only from the GENERATED tool_colors.less (tool_header_contract_tripwire and
//    tool_color_contrast_tripwire refuse a tool missing from it).
writeFileSync(OUT_FILE, render(collectHues().hues));

// 5. Enter it in the phone ratchet as PENDING (tool_phone_tripwire requires every
//    tool directory in exactly one list). It owes a probe + a green
//    `bun run test:tools:phone --tool <name>` before it moves to PHONE_CASES
//    (docs/development/tools/phone_layout.md).
const RATCHET = resolve(import.meta.dir, '../test/helpers/tool_phone_ratchet.ts');
const ratchet = readFileSync(RATCHET, 'utf8');
const pendingAnchor =
	'export const NOT_YET_PHONE: Record<string, { phase: 1 | 2 | 3 | 4; reason: string; probe?: ToolPhoneProbe }> = {\n';
if (!ratchet.includes(`\t${name}:`) && ratchet.includes(pendingAnchor)) {
	writeFileSync(
		RATCHET,
		ratchet.replace(
			pendingAnchor,
			`${pendingAnchor}\t${name}: { phase: 1, reason: 'new tool (scripts/create_tool.ts): add a probe, then prove it with bun run test:tools:phone' },\n`,
		),
	);
} else if (!ratchet.includes(`\t${name}:`)) {
	console.error(
		'Could not enter the tool in test/helpers/tool_phone_ratchet.ts NOT_YET_PHONE — add it by hand.',
	);
}

console.log(`Created ${name} at ${targetDir}`);
console.log(
	`Colour: set --${name} (its identity hue — copied from the template) in tools/${name}/css/${name}.less, then run "bun run css:tool-colors" and "bun run css:build".`,
);
console.log('Next: run the area_maintenance "Register tools" widget to reconcile dd1324.');
console.log(
	`Phone: entered as pending in test/helpers/tool_phone_ratchet.ts — add a probe and run "bun run test:tools:phone --tool ${name} --shots <dir>".`,
);
