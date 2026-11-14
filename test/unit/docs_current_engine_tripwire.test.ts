/**
 * DOCS CURRENT-ENGINE tripwire (DEC-12: every documented invariant has one).
 *
 * NOTE THE FILE NAME. This gate forbids a string, so it may not be NAMED with that
 * string — or the style guide could not cite its own enforcer without failing it. (It
 * was born as `docs_php_purge_tripwire.test.ts` and promptly flunked itself.)
 *
 * `docs/` is the PRODUCT MANUAL — the thing a new project reads to install and operate
 * Dédalo. The PHP engine is retired dead code, so the manual's law is:
 *
 *   PHP may appear ONLY as the thing you are migrating FROM (what changed, how to
 *   upgrade) or as HISTORY. It may NEVER appear as documentation of how the current
 *   system works.
 *
 * Before the 2026-07-12 sweep, 194 of 234 pages violated that: `docs/install/index.md`
 * was still a PHP install guide (and was the FIRST link in the "System administrator —
 * install" reading path, so a new project literally installed PHP by following the
 * docs), and `docs/core/**` explained TS by comparing it to PHP classes the reader has
 * never heard of. Prose rots back the moment nobody is watching, hence this gate.
 *
 * FOUR ASSERTIONS:
 *   1. no `php` anywhere in docs/, outside the reason-stamped allowlist
 *   2. no `rewrite/` path token — rewrite/ is GITIGNORED, so every such link is dead on
 *      a clone (and AGENTS.md forbids anything reading a path under it)
 *   3. every internal link resolves to a real file INSIDE docs/ — the in-repo mirror of
 *      `mkdocs build --strict`, which fails on links escaping docs_dir. Failing here
 *      costs 200 ms instead of a Python CI job, and stops the `../../engineering/X.md`
 *      trap at the door (engineering/ deliberately KEEPS its PHP references, so a link
 *      from the manual into it would re-import PHP through the back door).
 *   4. the allowlist is EXACTLY the files below — set equality, so nobody can quietly
 *      add a fifth entry instead of doing the work.
 *
 * WHY A RAW SUBSTRING, NOT `\bphp\b`: no English word contains the letters p-h-p, so the
 * raw substring is false-positive-free — while the word-boundary form would sail past
 * `phpMyAdmin`, `php-fpm` and `index.php5`.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Glob } from 'bun';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const DOCS_DIR = join(REPO_ROOT, 'docs');

/**
 * The ONLY pages that may name PHP, each because PHP is its SUBJECT or its INPUT — never
 * because it explains how Dédalo works today. Set-equality-asserted (assertion 4): adding
 * a file here is a deliberate, reviewable act, not a way to dodge the sweep.
 */
const PHP_ALLOWLIST: Record<string, string> = {
	// The why-we-rewrote narrative. PHP is the thing the story is ABOUT.
	'docs/rewrite.md': 'the rewrite narrative — PHP is its subject',

	// PHP as MIGRATION INPUT, not instruction: the v6→v7 manual points `dedalo:migrate-config`
	// at a directory of v6 config.php / config_db.php files full of define()s, and deploys a
	// widget into the old engine's tree. A migration page that cannot name the file you point
	// the tool at is a broken tool. (2026-08-07: one process ⇒ one page — the former
	// docs/administration/configuration/migrating_from_v6.md is now Phase C of the install manual, and redirected.)
	'docs/install/migrating_from_v6.md': 'PHP is the input artifact of the v6→v7 migration',
	'docs/whats_changed_v7.md': "the v6→v7 table's left column IS the v6 PHP setting",

	// The v1 Publication API is a SUPPORTED retro-compatible surface for public websites
	// built against v6 — not dead code. Quarantined behind an explicit "Legacy" heading
	// so a new integrator is steered to v2, but its operators keep their reference.
	'docs/diffusion/publication_api/publication_api.md':
		'legacy v1 publication API (supported, quarantined)',
	'docs/diffusion/publication_api/server_config_api.md':
		'legacy v1 publication API (supported, quarantined)',
	'docs/diffusion/publication_api/public_api_configuration.md':
		'legacy v1 publication API (supported, quarantined)',
	// The publication host INSTALLS that supported v1 API: its declaration has a `php_bin` field
	// (the v1 syntax check's runtime) the operator must type, and choosing it well (the
	// version-named file, not the alternatives link) is the instruction. Unnamed, the page hid it.
	'docs/install/publication_host.md':
		'installs the supported v1 publication API — its php_bin declaration field must be named',

	// NOT about the engine at all: `matomo.php` is the analytics vendor's own tracker
	// endpoint (a third-party URL, not a Dédalo path). Renaming it breaks analytics, and
	// no reader learns anything about Dédalo's engine from it.
	'docs/additional_javascript.js':
		"matomo.php is the analytics vendor's endpoint, not a Dédalo path",
};

/**
 * Text files the docs BUILD ships. Not just .md — the CSS/JS/YAML go out too, and so do
 * the SVG diagrams: four architecture diagrams labelled the work server "PHP" right next
 * to "PostgreSQL", so a reader who never read a word of prose still learned PHP existed.
 * Prose-only scanning would have missed them entirely.
 */
const DOCS_TEXT_GLOB = '**/*.{md,css,js,yaml,yml,svg}';

/**
 * Strip base64 payloads before scanning. An SVG may embed a raster image as a data: URI,
 * and arbitrary base64 contains the letters p-h-p often enough to false-positive on every
 * diagram in the tree. We want the diagram's TEXT, not its pixels.
 */
const BASE64_BLOB = /base64,[A-Za-z0-9+/=\s]+/g;

/** No English word contains "php". A raw substring beats \bphp\b, which misses php-fpm. */
const PHP_SUBSTRING = /php/i;

/** The PATH token only. The WORD "rewrite" is fine (docs/rewrite.md is a legitimate page). */
const REWRITE_PATH_TOKEN = /rewrite\//;

/** Markdown inline links: [text](target). Enough for the link graph the docs actually use. */
const MD_LINK = /\[[^\]]*\]\(([^)]+)\)/g;

/**
 * Blank out fenced code blocks and inline code spans before scanning for links.
 * Without this the gate "finds" the ILLUSTRATIVE links inside examples — the page that
 * documents Markdown export (`docs/diffusion/diffusion_markdown.md`) shows sample output
 * containing `[label](rsc167_88.md)`, which is a fixture, not a link to a doc that must
 * exist. Replacing with spaces (not '') keeps every line number intact for the report.
 */
function stripCode(text: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return text
		.replace(/^```[\s\S]*?^```/gm, blank) // fenced blocks
		.replace(/`[^`\n]*`/g, blank); // inline spans
}

function docsTextFiles(): string[] {
	const glob = new Glob(DOCS_TEXT_GLOB);
	return [...glob.scanSync({ cwd: DOCS_DIR })].sort();
}

/** `file` is docs-relative; returns the offending lines as "path:line: text". */
function hits(file: string, pattern: RegExp): string[] {
	const raw = readFileSync(join(DOCS_DIR, file), 'utf8');
	// Blank the base64 (keep line count) so an embedded image cannot fake a hit.
	const text = raw.replace(BASE64_BLOB, (m) => m.replace(/[^\n]/g, ' '));
	const out: string[] = [];
	text.split('\n').forEach((line, i) => {
		if (pattern.test(line)) out.push(`docs/${file}:${i + 1}: ${line.trim().slice(0, 120)}`);
	});
	return out;
}

/** What a maintainer needs to be told when one of these fires. */
const WHY_NO_PHP =
	'The product manual documents the CURRENT engine; PHP is retired. Rewrite the statement so it stands on its own — the design is never justified against a system the reader has never heard of. If a page genuinely documents migrating FROM PHP, add it to PHP_ALLOWLIST with a reason.';
const WHY_NO_REWRITE_PATH =
	'rewrite/ is INTERNAL PROCESS and gitignored — it is not on a clone, so these links are dead for every reader. The port is done; a manual reader has no business in an internal ledger. Delete the pointer, or inline the fact it carried.';
const WHY_LINKS_RESOLVE =
	'Broken or escaping links fail `mkdocs build --strict`. Repo paths outside docs/ (engineering/, src/, scripts/) must be named in `code font` as PLAIN TEXT, never linked — engineering/ deliberately keeps its PHP references, so linking the manual into it would re-import PHP through the back door.';

describe('docs current-engine tripwire', () => {
	test('no PHP reference in docs/, outside the reason-stamped allowlist', () => {
		const offenders: string[] = [];
		for (const file of docsTextFiles()) {
			if (PHP_ALLOWLIST[`docs/${file}`] !== undefined) continue;
			offenders.push(...hits(file, PHP_SUBSTRING));
		}
		expect(offenders, `${WHY_NO_PHP}\n${offenders.join('\n')}`).toEqual([]);
	});

	test('no dead `rewrite/` path token in docs/ — rewrite/ is gitignored', () => {
		const offenders: string[] = [];
		for (const file of docsTextFiles()) offenders.push(...hits(file, REWRITE_PATH_TOKEN));
		expect(offenders, `${WHY_NO_REWRITE_PATH}\n${offenders.join('\n')}`).toEqual([]);
	});

	test('every internal link resolves to a real file inside docs/', () => {
		const offenders: string[] = [];
		for (const file of docsTextFiles()) {
			if (!file.endsWith('.md')) continue;
			const text = stripCode(readFileSync(join(DOCS_DIR, file), 'utf8'));
			const fromDir = dirname(join(DOCS_DIR, file));

			for (const match of text.matchAll(MD_LINK)) {
				const raw = (match[1] ?? '').trim().split(/\s+/)[0] ?? ''; // drop an optional "title"
				if (raw === '') continue;
				// Skip: absolute URLs, mailto/other schemes, pure anchors, template vars.
				if (/^([a-z][a-z0-9+.-]*:|#|\/|\{)/i.test(raw)) continue;

				const path = raw.split('#')[0] ?? '';
				if (path === '') continue; // a same-page anchor, e.g. (#section)

				const target = resolve(fromDir, path);
				const inside = !relative(DOCS_DIR, target).startsWith('..');
				if (!inside) {
					offenders.push(
						`docs/${file} → ${raw}  (ESCAPES docs/ — name it in code font, do not link it)`,
					);
					continue;
				}
				if (!existsSync(target)) {
					offenders.push(`docs/${file} → ${raw}  (target does not exist)`);
				}
			}
		}
		expect(offenders, `${WHY_LINKS_RESOLVE}\n${offenders.join('\n')}`).toEqual([]);
	});

	test('the PHP allowlist is exactly the reason-stamped set (no quiet additions)', () => {
		// Guards the guard: an allowlist you can append to is not an allowlist. Every entry
		// must exist, and the set must match the constant above exactly.
		const expected = [
			'docs/additional_javascript.js',
			'docs/diffusion/publication_api/public_api_configuration.md',
			'docs/diffusion/publication_api/publication_api.md',
			'docs/diffusion/publication_api/server_config_api.md',
			'docs/install/migrating_from_v6.md',
			'docs/install/publication_host.md',
			'docs/rewrite.md',
			'docs/whats_changed_v7.md',
		];
		expect(Object.keys(PHP_ALLOWLIST).sort()).toEqual(expected);
		for (const file of expected) {
			expect(existsSync(join(REPO_ROOT, file)), `allowlisted page is missing: ${file}`).toBe(true);
		}
		for (const reason of Object.values(PHP_ALLOWLIST)) {
			expect(reason.length, 'every allowlist entry carries a written reason').toBeGreaterThan(10);
		}
	});
});
