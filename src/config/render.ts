/**
 * CATALOG → the generated artifacts. Pure: catalog in, string out, no file I/O.
 *
 *   renderSampleEnv()          → install/sample.env      (the copy-paste census)
 *   renderReferencePage(page)  → the GENERATED region of docs/config/<page>.md
 *
 * Kept pure so `config_docs_tripwire` can import these and compare against disk in-process
 * instead of shelling out to the CLI. The CLI (`scripts/gen_config_docs.ts`) is a thin
 * wrapper that writes what these return.
 *
 * IMPORT RULE: like `catalog/`, this must never import `config.ts` — the generator has to
 * run on an unconfigured box (a fresh clone, CI), and building the frozen config throws
 * there.
 *
 * PHP-FREE RULE: `renderReferencePage` output lands under docs/, where
 * `docs_current_engine_tripwire` bans the substring /php/i outside an allowlist that
 * config.md is NOT on. Entry `doc` text is therefore PHP-free by contract (see
 * catalog_types.ts) and only `renderSampleEnv` — which writes OUTSIDE docs/ — may emit the
 * legacy `phpAlias` spellings.
 */

import { CONFIG_CATALOG, DOMAINS, isOperatorFacing, KEY_DOMAIN } from './catalog/index.ts';
import type { CatalogEntry } from './catalog_types.ts';
import { V6_MIGRATION } from './migration_map.ts';

const BAR = '═'.repeat(78);

/** The marker pair the generator owns. Everything between them is rewritten wholesale. */
export const BEGIN_MARK =
	'<!-- BEGIN GENERATED — src/config/catalog/ · regenerate: bun run config:gen -->';
export const END_MARK = '<!-- END GENERATED -->';

// ---------------------------------------------------------------------------
// Default rendering
// ---------------------------------------------------------------------------

/**
 * How a default is PRINTED. A computed default (a thunk) must never be evaluated here:
 * it would bake this machine's absolute paths (`/opt/homebrew/bin`) into a file every
 * other install reads. `defaultDoc` is what the operator sees, and the catalog type makes
 * it mandatory for exactly this reason.
 */
export function renderDefault(entry: CatalogEntry): string {
	if (typeof entry.default === 'function') {
		return entry.defaultDoc ?? '(derived)';
	}
	if (entry.defaultDoc !== undefined) return entry.defaultDoc;
	const value = entry.default;
	if (value === undefined) return entry.required === true ? '(required)' : '(unset)';
	if (Array.isArray(value)) return JSON.stringify(value);
	if (value !== null && typeof value === 'object') return JSON.stringify(value);
	if (value === '') return '(empty)';
	return String(value);
}

/** The value written on the RHS of an uncommented template line. */
function templateValue(entry: CatalogEntry): string {
	if (entry.placeholder !== undefined) return entry.placeholder.value;
	if (typeof entry.default === 'function' || entry.default === undefined) return '';
	const value = entry.default;
	if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
		return JSON.stringify(value);
	}
	return String(value);
}

// ---------------------------------------------------------------------------
// install/sample.env
// ---------------------------------------------------------------------------

/** Markdown → plain text, on ONE line (links to their text, no emphasis marks). */
function plain(text: string): string {
	return (
		text
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → their text
			// Backticks and asterisks are markup here; `_` is NOT — stripping it turned every
			// key named in prose into DEDALOSMTPUSER. No catalog doc uses _emphasis_.
			.replace(/[`*]/g, '')
			.replace(/\s+/g, ' ')
			.trim()
	);
}

/** A doc paragraph is skipped when it is machinery rather than prose. */
function isProse(para: string): boolean {
	const t = para.trim();
	if (t === '') return false;
	if (t.startsWith('```')) return false; // fenced example — rendered separately
	if (t.startsWith('!!!')) return false; // mkdocs admonition
	if (t.startsWith('|')) return false; // table
	return true;
}

/** Strip markdown to a one-paragraph plain-text blurb for an .env comment. */
function summarize(doc: string): string {
	return plain(doc.split('\n\n').find(isProse) ?? '');
}

/**
 * The bullet list that CONTINUES the blurb. A doc that ends its opening paragraph with a
 * colon ("The servers could be:") is answered by the list right below it — dropping that
 * list is how `ONTOLOGY_SERVERS` shipped a comment that promised an enumeration and then
 * stopped. Only that case is pulled in: a list further down is reference material and
 * belongs in the manual.
 */
function blurbBullets(doc: string): string[] {
	const paras = doc.split('\n\n');
	const first = paras.findIndex(isProse);
	if (first === -1 || !(paras[first] as string).trim().endsWith(':')) return [];
	const next = (paras[first + 1] ?? '').trim();
	if (!/^[-*] /.test(next)) return [];
	return next
		.split('\n')
		.filter((line) => /^\s*[-*] /.test(line))
		.map((line) => plain(line.replace(/^\s*[-*] /, '')));
}

/**
 * The copy-pasteable example. Every operator-facing entry documents one in a fenced block
 * (a gate in `config_docs_tripwire` keeps it that way) — the census used to strip fences
 * wholesale, which left an operator reading `[array of objects] default: (unset)` with no
 * way to guess the shape. The block containing `KEY=` is the one that shows THIS key.
 */
function exampleLines(key: string, doc: string): string[] {
	for (const match of doc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
		const body = (match[1] as string).trimEnd();
		if (!body.includes(`${key}=`)) continue;
		return body.split('\n').filter((line) => line.trim() !== '');
	}
	return [];
}

/** Hard-wrap at `width`, prefixing every line with `# `. */
function comment(text: string, width = 76): string[] {
	if (text === '') return [];
	const out: string[] = [];
	let line = '';
	for (const word of text.split(' ')) {
		if (line !== '' && `${line} ${word}`.length > width) {
			out.push(`# ${line}`);
			line = word;
		} else {
			line = line === '' ? word : `${line} ${word}`;
		}
	}
	if (line !== '') out.push(`# ${line}`);
	return out;
}

export function renderSampleEnv(): string {
	const out: string[] = [];
	out.push(`# ${BAR}`);
	out.push('#  DÉDALO v7 — sample.env  ·  every configurable setting, grouped by domain');
	out.push(`# ${BAR}`);
	out.push('#');
	out.push(
		...comment(
			'Reference of every configuration setting this engine recognizes. This file is NOT loaded by Dédalo — copy the lines you need into ../private/.env and uncomment them. The installer drops a copy of this file next to your .env.',
		),
	);
	out.push('#');
	out.push(
		...comment(
			'FORMAT. KEY=value, one per line. No ${VAR} interpolation. Quote any value containing spaces or a #. List and map values are JSON — ["lg-eng","lg-spa"] or {"lg-eng":"English"}; simple lists also accept a comma list. Booleans are true/false.',
		),
	);
	out.push('#');
	out.push(
		...comment(
			'PRECEDENCE (low→high): catalog default → ../private/.env → the real process environment. There is no per-host overlay. After changing a value, restart the server.',
		),
	);
	out.push('#');
	out.push(
		...comment(
			'TAGS. [operator] a setting you may freely change · [secret] sensitive — set a real value, never commit it. Every line below is COMMENTED OUT at its default; uncomment only what you need to change. Lines that ship UNCOMMENTED carry a placeholder a real install must replace.',
		),
	);
	out.push('#');
	out.push(
		...comment(
			'EACH ENTRY. A short description, then [scope · type] default: …, then an "example:" showing a real value for that exact key — copy the example line, uncomment it and edit the value. The full prose, tables and rationale for every setting live in docs/config/config.md and docs/config/config_db.md.',
		),
	);
	out.push('#');
	out.push('#  GENERATED from src/config/catalog/ — do not edit by hand.');
	out.push('#  Regenerate: bun run config:gen   (config_docs_tripwire fails if you forget)');
	out.push(`# ${BAR}`);

	for (const domain of DOMAINS) {
		const keys = Object.keys(CONFIG_CATALOG).filter(
			(key) =>
				KEY_DOMAIN[key] === domain.id && isOperatorFacing(CONFIG_CATALOG[key] as CatalogEntry),
		);
		if (keys.length === 0) continue;

		out.push('');
		out.push(`# ${BAR}`);
		out.push(`#  [${domain.id}]  ${domain.title.replace(/\*\*/g, '')}`);
		if (domain.intro !== '') out.push(...comment(domain.intro));
		out.push(`# ${BAR}`);

		for (const key of keys) {
			const entry = CONFIG_CATALOG[key] as CatalogEntry;
			out.push('');
			out.push(...comment(summarize(entry.doc)));
			for (const bullet of blurbBullets(entry.doc)) {
				const [head, ...rest] = comment(bullet, 72);
				out.push(`#   - ${(head as string).slice(2)}`);
				for (const line of rest) out.push(`#     ${line.slice(2)}`);
			}
			const tags = [entry.scope, entry.typeLabel].join(' · ');
			out.push(`# [${tags}]  default: ${renderDefault(entry)}`);
			if (entry.phpAlias !== undefined) {
				out.push(`# legacy spelling still honoured: ${entry.phpAlias}`);
			}
			const example = exampleLines(key, entry.doc);
			if (example.length > 0) {
				out.push('# example:');
				for (const line of example) out.push(`#   ${line}`);
			}
			// A process-environment-only key gets NO assignable line: this file is the
			// one place it is ignored (catalog_types.ts processEnvironmentOnly).
			if (entry.processEnvironmentOnly === true) {
				out.push(`# (${key} is not read from this file — set it where the process starts.)`);
				continue;
			}
			// A placeholder key ships UNCOMMENTED — the template must literally carry the
			// value check_config rejects, or "still on the sample value" is unfalsifiable.
			const prefix = entry.placeholder !== undefined || entry.required === true ? '' : '#';
			out.push(`${prefix}${key}=${templateValue(entry)}`);
		}
	}

	// The "NOT HONORED" block migration_map.ts:194 has always pointed at. It did not exist.
	const dropped = Object.entries(V6_MIGRATION)
		.filter(([, rule]) => rule.cls === 'DROPPED')
		.sort(([a], [b]) => a.localeCompare(b));
	if (dropped.length > 0) {
		out.push('');
		out.push(`# ${BAR}`);
		out.push('#  NOT HONORED');
		out.push(
			...comment(
				'Settings a v6 install could define that this engine has no consumer for. Listed so an upgrade can tell "dropped on purpose" from "forgotten". Setting one does nothing.',
			),
		);
		out.push(`# ${BAR}`);
		for (const [key, rule] of dropped) out.push(`#   ${key} — ${rule.reason ?? ''}`);
	}

	out.push('');
	return out.join('\n');
}

// ---------------------------------------------------------------------------
// docs/config/<page>.md
// ---------------------------------------------------------------------------

export function renderReferencePage(page: 'config' | 'config_db'): string {
	const out: string[] = [BEGIN_MARK, ''];

	for (const domain of DOMAINS.filter((d) => d.page === page)) {
		const keys = Object.keys(CONFIG_CATALOG).filter(
			(key) =>
				KEY_DOMAIN[key] === domain.id && isOperatorFacing(CONFIG_CATALOG[key] as CatalogEntry),
		);
		if (keys.length === 0) continue;

		// The id is an EXPLICIT anchor, so a citation never depends on the title's wording
		// (and never on a section NUMBER — numbers shift the moment a domain is added,
		// which is exactly how the old '§12' citations became fiction).
		out.push(`## ${domain.title} {#${domain.id}}`);
		out.push('');
		if (domain.intro !== '') {
			out.push(domain.intro);
			out.push('');
		}

		for (const key of keys) {
			const entry = CONFIG_CATALOG[key] as CatalogEntry;
			out.push(`### ${entry.heading}`);
			out.push('');
			const suffix = entry.typeSuffix === undefined ? '' : ` ${entry.typeSuffix}`;
			out.push(`${key} \`${entry.typeLabel}\`${suffix}`);
			out.push('');
			out.push(entry.doc);
			out.push('');
			out.push(`*Default: ${renderDefault(entry)}*`);
			out.push('');
			out.push('---');
			out.push('');
		}

		if (domain.outro !== undefined && domain.outro !== '') {
			out.push(domain.outro);
			out.push('');
		}
	}

	out.push(END_MARK);
	return out.join('\n');
}

/** Splice a rendered region into a page, preserving its hand-written preamble. */
export function spliceGenerated(existing: string, generated: string): string {
	const begin = existing.indexOf(BEGIN_MARK);
	const end = existing.indexOf(END_MARK);
	if (begin === -1 || end === -1) {
		throw new Error(
			'The page has no BEGIN/END GENERATED markers. Add them once, around the settings reference — everything between them is owned by src/config/catalog/.',
		);
	}
	return existing.slice(0, begin) + generated + existing.slice(end + END_MARK.length);
}
