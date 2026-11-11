/**
 * MIGRATE_V6_CONFIG (CLI) — turn a v6 PHP config into the v7 `../private/.env`.
 *
 * USAGE
 *   bun run dedalo:migrate-config --config-dir=<dedalo_v6>/config            # DRY-RUN (default)
 *   bun run dedalo:migrate-config --config-dir=… --out=/tmp/candidate.env    # write a candidate
 *   bun run dedalo:migrate-config --config-dir=… --execute                   # merge into the live .env
 *
 * SOURCE OF TRUTH
 *   - the classification: `src/config/migration_map.ts` (tripwired against the
 *     keys the engine actually reads — `test/unit/config_census_tripwire.test.ts`)
 *   - the parser:         `src/config/php_defines.ts`
 *
 * SCOPE — reads `<config-dir>` ONLY: config.php, config_db.php, config_areas.php,
 * config_core.php. It NEVER follows an `include` out of that directory (some
 * installs park the payload in `../private/config.inc`); an include that is seen
 * and not followed is REPORTED, so an operator on that layout cannot end up with
 * a silently empty migration.
 *
 * SAFETY
 *   - dry-run unless `--execute`; values are NEVER printed (secrets)
 *   - `--execute` MERGES: existing lines are never rewritten or reordered
 *     (`../private/.env` is append-only), the previous file is backed up to
 *     `.env.bak.<ts>`, and the write is an atomic tmp+rename at 0600
 *   - it refuses to `--execute` when a boot-critical key is unresolved
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseEnvFile, privateDir } from '../src/config/env.ts';
import { encodeEnvValue, type MigrationRule, V6_MIGRATION } from '../src/config/migration_map.ts';
import { type DefineRecord, extractDefines } from '../src/config/php_defines.ts';

const SOURCE_FILES = ['config.php', 'config_db.php', 'config_areas.php', 'config_core.php'];

/**
 * Without these a CONFIGURED install crash-loops on boot (config.ts's required
 * set + the language block that `requireJsonMapOrInstallSentinel` enforces).
 * Named by their v7 spelling.
 */
const BOOT_CRITICAL = [
	'ENTITY',
	'DB_NAME',
	'DB_HOST',
	'DB_USER',
	'DEDALO_APPLICATION_LANGS',
	'DEDALO_APPLICATION_LANGS_DEFAULT',
	'DEDALO_DATA_LANG_DEFAULT',
	'PROJECTS_DEFAULT_LANGS',
];

function fail(message: string): never {
	console.error(`\n✖ migrate_v6_config: ${message}`);
	process.exit(1);
}

function arg(name: string): string | undefined {
	const hit = Bun.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
	return hit?.slice(name.length + 3);
}

interface Planned {
	readonly key: string;
	readonly value: string;
	readonly from: string;
	readonly rule: MigrationRule;
}

function main(): void {
	const configDir = arg('config-dir');
	const outPath = arg('out');
	const execute = Bun.argv.includes('--execute');

	if (configDir === undefined) {
		fail('--config-dir=<dedalo_v6>/config is required (the v6 config directory)');
	}
	if (!existsSync(configDir)) fail(`config dir not found: ${configDir}`);

	// --- read the four sources (this directory only; never /private) -------------
	const files = SOURCE_FILES.filter((f) => existsSync(join(configDir, f))).map((f) => ({
		path: f,
		content: readFileSync(join(configDir, f), 'utf8'),
	}));
	if (files.length === 0)
		fail(`no v6 config files found in ${configDir} (${SOURCE_FILES.join(', ')})`);

	const extracted = extractDefines(files);

	// --- classify ----------------------------------------------------------------
	const planned: Planned[] = [];
	const skippedNull: string[] = [];
	const notMigratable: string[] = []; // a real target, but the value is runtime-computed
	const droppedByReason = new Map<string, string[]>();
	const unknown: string[] = [];

	for (const [name, record] of extracted.records) {
		const rule = V6_MIGRATION[name];
		if (rule === undefined) {
			unknown.push(name);
			continue;
		}
		if (rule.cls === 'DROPPED') {
			const reason = rule.reason ?? 'no reason recorded';
			const bucket = droppedByReason.get(reason) ?? [];
			bucket.push(name);
			droppedByReason.set(reason, bucket);
			continue;
		}
		// A key we DO want, whose v6 value is computed at runtime ($_SERVER, dirname(),
		// a function call): it cannot be baked. Never guess — name it and move on.
		if (record.kind === 'runtime') {
			notMigratable.push(`${name} → ${rule.target}`);
			continue;
		}
		const value = encodeEnvValue(rule.transform ? rule.transform(record.value) : record.value);
		if (value === null) {
			skippedNull.push(name);
			continue;
		}
		planned.push({ key: rule.target as string, value, from: name, rule });
	}

	// --- DEDALO_DIFFUSION_LANGS: DERIVED, never pinned ----------------------------
	// A stock v6 config says `define('DEDALO_DIFFUSION_LANGS', DEDALO_PROJECTS_DEFAULT_LANGS)`
	// — the constant is a pure ALIAS of the project languages, and the extractor
	// faithfully resolves it to the SAME array. Copying it across would freeze a
	// derivation into a snapshot: v7 resolves an unset DEDALO_DIFFUSION_LANGS to the
	// project languages (`config.diffusion`), so a pinned copy means that adding a
	// project language later leaves publication silently behind, still emitting the
	// four languages of migration day. So we write the key ONLY when the v6 install
	// really overrode it.
	//
	// THE COMPARISON IS ON THE ENCODED VALUES — the exact bytes each key would get in
	// the .env — not on the parsed arrays: that is what v7 will read back, and it
	// makes a REORDERING count as an override (the order is load-bearing; the first
	// language is the main one). A different array, a subset, or a different order is
	// therefore a genuine override and IS written.
	const diffusionLangs = planned.find((p) => p.key === 'DEDALO_DIFFUSION_LANGS');
	const projectLangs = planned.find((p) => p.from === 'DEDALO_PROJECTS_DEFAULT_LANGS');
	// No project langs to compare against (absent, null, or runtime-computed) means we
	// cannot prove the value is derived — keep it, and let the boot-critical section
	// below complain about the missing PROJECTS_DEFAULT_LANGS.
	const diffusionLangsDerived =
		diffusionLangs !== undefined &&
		projectLangs !== undefined &&
		diffusionLangs.value === projectLangs.value;
	if (diffusionLangsDerived && diffusionLangs !== undefined) {
		planned.splice(planned.indexOf(diffusionLangs), 1);
	}

	// --- report (values are NEVER printed) ---------------------------------------
	const byClass = (c: string): string[] =>
		planned.filter((p) => p.rule.cls === c).map((p) => `${p.from} → ${p.key}`);

	console.log(`\n\x1b[1m▶ v6 → v7 config migration — ${execute ? 'EXECUTE' : 'DRY-RUN'}\x1b[0m`);
	console.log(`  source: ${configDir}`);
	console.log(`  files:  ${files.map((f) => basename(f.path)).join(', ')}`);
	console.log(
		`  defines: ${extracted.records.size} (${
			[...extracted.records.values()].filter((r) => r.kind === 'literal').length
		} literal)\n`,
	);

	for (const cls of ['SAME', 'ALIAS', 'RENAMED', 'RESHAPED'] as const) {
		const names = byClass(cls);
		if (names.length === 0) continue;
		console.log(`\x1b[1m${cls}\x1b[0m (${names.length}): ${names.join(', ')}\n`);
	}

	for (const [reason, names] of droppedByReason) {
		console.log(`\x1b[2mDROPPED — ${reason}\x1b[0m (${names.length}): ${names.join(', ')}\n`);
	}

	if (extracted.commentedOut.length > 0) {
		console.log(
			`\x1b[2mCOMMENTED OUT in the v6 config — left at the v7 default, on purpose\x1b[0m (${extracted.commentedOut.length}): ${extracted.commentedOut.join(', ')}\n`,
		);
	}

	if (diffusionLangsDerived) {
		console.log(
			"\x1b[2mDERIVED, NOT PINNED\x1b[0m (1): DEDALO_DIFFUSION_LANGS — the v6 value is exactly\n   DEDALO_PROJECTS_DEFAULT_LANGS, which is what v7 derives it from when it is unset.\n   Writing it would freeze today's languages; adding a project language later would\n   not reach publication. Set it by hand ONLY to diffuse a different set.\n",
		);
	} else if (diffusionLangs !== undefined && projectLangs !== undefined) {
		console.log(
			'\x1b[2mDEDALO_DIFFUSION_LANGS is a genuine OVERRIDE in this v6 config (it differs from\n   DEDALO_PROJECTS_DEFAULT_LANGS in content or order) — migrated as-is.\x1b[0m\n',
		);
	} else if (diffusionLangs !== undefined) {
		console.log(
			'\x1b[2mDEDALO_DIFFUSION_LANGS migrated as-is: this config has no usable\n   DEDALO_PROJECTS_DEFAULT_LANGS to compare it against, so it cannot be shown to be\n   the derived default.\x1b[0m\n',
		);
	}

	if (skippedNull.length > 0) {
		console.log(
			`\x1b[2mNULL in v6, or only a stock placeholder (= unset; the v7 default stands)\x1b[0m (${skippedNull.length}): ${skippedNull.join(', ')}\n`,
		);
	}

	// --- the loud sections --------------------------------------------------------
	let refuse = false;

	// Most includes are CODE (class.loader.php, core_functions.php) — expected and
	// irrelevant. The one that matters is an include that could carry CONFIG from
	// outside this directory (the `../private/config.inc` layout): that would mean
	// the defines are somewhere we deliberately do not read.
	const readHere = new Set(SOURCE_FILES);
	const configIncludes = extracted.includes.filter(
		(inc) =>
			/private|config\.inc|config\.local|config_db\.inc/i.test(inc.raw) &&
			!SOURCE_FILES.some((f) => inc.raw.includes(f) && readHere.has(f)),
	);
	const codeIncludes = extracted.includes.length - configIncludes.length;

	// The catch-all that cannot be fooled by HOW the include was written (a real v6
	// box writes `$path = dirname(…).'/private/config.inc'; include $path;`, whose
	// include statement mentions no filename at all): we parsed the config directory,
	// found NOTHING to migrate, and skipped some includes. The settings are in one of
	// them. Refuse — a silently empty migration is worse than no migration.
	const emptyButIncludes = planned.length === 0 && extracted.includes.length > 0;

	if (configIncludes.length > 0 || emptyButIncludes) {
		refuse = true;
		console.log('\x1b[31m!! CONFIG LIVES OUTSIDE THE CONFIG DIRECTORY — and was NOT read.\x1b[0m');
		if (emptyButIncludes) {
			console.log(
				`   Nothing to migrate was found in ${configDir}, yet ${extracted.includes.length} include(s) were`,
			);
			console.log('   skipped. This install keeps its defines in one of them (the');
			console.log('   `../private/config.inc` layout).');
		} else {
			console.log('   This install keeps (some of) its defines in an included file, so the plan');
			console.log('   above is INCOMPLETE.');
		}
		console.log('   Point --config-dir at the directory that really holds the define()s:');
		for (const inc of extracted.includes) console.log(`   ${inc.file}:${inc.line}  ${inc.raw}`);
		console.log('');
	} else if (codeIncludes > 0) {
		console.log(
			`\x1b[2m${codeIncludes} code include(s) not followed (expected — they carry no config).\x1b[0m\n`,
		);
	}

	// A v6 install that defines DEDALO_INFORMATION stores its passwords as AES
	// ciphertext keyed by it (component_password::encrypt_password). v7 accepts ONLY
	// Argon2id and refuses anything else — and the PHP lazy-upgrade-on-login that used
	// to convert them is gone with the PHP engine. Say so BEFORE they migrate and find
	// nobody can log in; the config half of the migration cannot fix it.
	if (extracted.records.has('DEDALO_INFORMATION')) {
		console.log('\x1b[33m!! LEGACY PASSWORD HASHES — users may be locked out of v7\x1b[0m');
		console.log('   v6 stored passwords as AES ciphertext keyed by DEDALO_INFORMATION; v7 accepts');
		console.log('   ONLY Argon2id. A user whose stored value does not start with `$argon2` cannot');
		console.log('   log in, and the PHP upgrade-on-login path no longer exists.');
		console.log('   Check before cutting over:');
		console.log(
			"     SELECT COUNT(*) FROM matrix_users WHERE \"string\"->'dd133'->0->>'value' NOT LIKE '$argon2%';",
		);
		console.log(
			'   If that is > 0, reset those passwords (root: `bun run dedalo:install --root-pw`).\n',
		);
	}

	if (extracted.duplicates.length > 0) {
		console.log(
			`\x1b[33m!! DEFINED MORE THAN ONCE\x1b[0m (${extracted.duplicates.length}) — PHP keeps the first; a static\n   parse cannot know which branch ran. Check these by hand: ${extracted.duplicates.join(', ')}\n`,
		);
	}

	const conditional = [...extracted.records.values()].filter((r: DefineRecord) => r.conditional);
	if (conditional.length > 0) {
		console.log(
			`\x1b[33m!! DEFINED INSIDE A BRANCH\x1b[0m (${conditional.length}) — value taken from the branch as written: ${conditional
				.map((r) => r.name)
				.join(', ')}\n`,
		);
	}

	if (notMigratable.length > 0) {
		console.log('\x1b[33m!! NOT MIGRATABLE — the v6 value is computed at runtime\x1b[0m');
		console.log('   ($_SERVER, dirname(), a function call). The v7 engine needs these set');
		console.log('   EXPLICITLY. Set them by hand in the .env:');
		for (const item of notMigratable) console.log(`   ${item}`);
		console.log('');
	}

	if (unknown.length > 0) {
		refuse = true;
		console.log(
			`\x1b[31m!! UNKNOWN constants\x1b[0m (${unknown.length}) — not in the migration map, so this tool\n   cannot say whether they matter. Classify them in src/config/migration_map.ts:\n   ${unknown.join(', ')}\n`,
		);
	}

	// --- boot-critical check -------------------------------------------------------
	const willWrite = new Set(planned.map((p) => p.key));
	const missing = BOOT_CRITICAL.filter((k) => !willWrite.has(k));
	if (missing.length > 0) {
		console.log(
			`\x1b[31m!! BOOT-CRITICAL keys unresolved\x1b[0m (${missing.length}): ${missing.join(', ')}`,
		);
		console.log('   A configured install without these crash-loops. Set them by hand.\n');
		refuse = true;
	}

	console.log(`\x1b[1mPlan: ${planned.length} keys to write.\x1b[0m`);

	// --- write ---------------------------------------------------------------------
	const target = outPath ?? join(privateDir, '.env');

	if (!execute && outPath === undefined) {
		console.log('\nDry-run complete. Re-run with --out=FILE to write a candidate .env,');
		console.log(`or --execute to MERGE into ${target} (existing lines are never touched).`);
		process.exit(0);
	}

	if (refuse && execute) {
		fail('refusing to --execute with unresolved UNKNOWN or boot-critical keys (see above)');
	}

	// MERGE, never rewrite: ../private/.env is append-only.
	const existing = existsSync(target) ? parseEnvFile(readFileSync(target, 'utf8')) : {};
	const fresh = planned.filter((p) => !(p.key in existing));
	const already = planned.filter((p) => p.key in existing);

	if (already.length > 0) {
		console.log(
			`\n  ${already.length} key(s) already present in the target — left untouched: ${already
				.map((p) => p.key)
				.join(', ')}`,
		);
	}
	if (fresh.length === 0) {
		console.log('\n✔ nothing to add — the target already carries every migrated key.');
		process.exit(0);
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const block = [
		'',
		`# --- migrated from the v6 config (${SOURCE_FILES.filter((f) => existsSync(join(configDir, f))).join(', ')}) ---`,
		`# by scripts/migrate_v6_config.ts on ${stamp}. Classification: src/config/migration_map.ts`,
		...fresh.map((p) => `${p.key}=${p.value}`),
		'',
	].join('\n');

	const body =
		(existsSync(target) ? readFileSync(target, 'utf8').replace(/\n*$/, '\n') : '') + block;

	mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
	const tmp = `${target}.tmp.${process.pid}`;
	writeFileSync(tmp, body, { mode: 0o600 });
	if (existsSync(target)) renameSync(target, `${target}.bak.${Date.now()}`);
	renameSync(tmp, target);

	console.log(`\n✔ wrote ${fresh.length} key(s) to ${target}`);
	if (notMigratable.length > 0 || missing.length > 0) {
		console.log('  Remember the hand-set keys listed above before booting.');
	}
	process.exit(0);
}

main();
