/**
 * THE FROZEN MIGRATION LEDGER (update audit 2026-10-29, U-23; design §1, D-2/D-4).
 *
 * `install/db/migrations.lock.json` pins, per migration file:
 *
 *   sha256   the file's content hash. An APPLIED migration is never edited —
 *            the version table records the hash it ran, and the boot runner
 *            refuses a file whose bytes no longer match (an edit after release
 *            silently diverges installs: the old ones ran other SQL).
 *   class    `compatible` — the previous code of the same data model tolerates
 *            the schema after it (an index, a new table, a nullable column),
 *            so the release may be a patch and an automatic code rollback is
 *            still sound; `incompatible` — anything else: the release must be
 *            `incompatible` in the catalog (a minor at least, D-4) and a code
 *            rollback across it needs a human (D-2). `compatible` is a CLAIM
 *            the lexer below must PROVE; `incompatible` is always admissible.
 *   release  the catalog release that ships the file (the line start for the
 *            files the install seed already carries).
 *
 * Gate: test/unit/migration_content_hash_tripwire.test.ts (every file ledgered
 * with its hash, every `compatible` lexer-proven, every release a catalog entry
 * of the right compat). Runtime: install/db/migrate.ts records + verifies.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** The ledger file, beside the migrations it pins. */
export const MIGRATION_LEDGER_PATH = resolve(import.meta.dir, 'migrations.lock.json');

export const MIGRATION_LEDGER_FORMAT = 1;

export type MigrationClass = 'compatible' | 'incompatible';

export interface MigrationLedgerEntry {
	sha256: string;
	class: MigrationClass;
	release: string;
}

export interface MigrationLedger {
	format: number;
	migrations: Readonly<Record<string, MigrationLedgerEntry>>;
}

/** sha256 (hex) of a migration file's exact text. */
export function migrationSha256(content: string): string {
	return new Bun.CryptoHasher('sha256').update(content).digest('hex');
}

/** Read and shape-check the ledger; throws naming the file on anything malformed. */
export async function readMigrationLedger(
	path: string = MIGRATION_LEDGER_PATH,
): Promise<MigrationLedger> {
	const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<MigrationLedger>;
	if (parsed.format !== MIGRATION_LEDGER_FORMAT || typeof parsed.migrations !== 'object') {
		throw new Error(`${path}: not a format-${MIGRATION_LEDGER_FORMAT} migration ledger`);
	}
	const malformed = Object.entries(parsed.migrations ?? {}).filter(
		([, entry]) => !isLedgerEntry(entry),
	);
	if (malformed.length > 0) {
		throw new Error(`${path}: malformed entries: ${malformed.map(([file]) => file).join(', ')}`);
	}
	return parsed as MigrationLedger;
}

function isLedgerEntry(entry: unknown): entry is MigrationLedgerEntry {
	const candidate = entry as Partial<MigrationLedgerEntry> | null;
	return (
		typeof candidate?.sha256 === 'string' &&
		/^[0-9a-f]{64}$/.test(candidate.sha256) &&
		(candidate.class === 'compatible' || candidate.class === 'incompatible') &&
		typeof candidate.release === 'string'
	);
}

/** Why `file` (with `content`) disagrees with the ledger; null when it agrees. */
export function ledgerMismatch(
	file: string,
	content: string,
	ledger: MigrationLedger,
): string | null {
	const entry = ledger.migrations[file];
	if (entry === undefined) {
		return `${file} is not in install/db/migrations.lock.json — ledger it (sha256, class, release)`;
	}
	const actual = migrationSha256(content);
	return actual === entry.sha256
		? null
		: `${file} does not match its frozen hash (ledger ${entry.sha256.slice(0, 12)}…, file ${actual.slice(0, 12)}…) — an applied migration is never edited; add a new file`;
}

/**
 * The statements a `compatible` migration may hold — each matched against ONE
 * whole statement (comments stripped, whitespace collapsed), anchored at both
 * ends. Every shape leaves the previous code's reads and writes valid: an index
 * (never UNIQUE — that rejects writes), dropping one, statistics, a comment, a
 * new table, a nullable column with no default, a session setting.
 */
const COMPATIBLE_SHAPES: readonly RegExp[] = [
	/^SET LOCAL [a-z_]+ ?(?:=|TO) ?[^;]+$/i,
	/^CREATE INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?[a-z0-9_"]+ ON (?:ONLY )?[a-z0-9_."]+ [^;]+$/i,
	/^DROP INDEX (?:CONCURRENTLY )?IF EXISTS [a-z0-9_."]+(?: ?, ?[a-z0-9_."]+)*$/i,
	/^ANALYZE(?: [a-z0-9_."]+(?: ?\( ?[a-z0-9_" ,]+\))?)?$/i,
	/^COMMENT ON [^;]+$/i,
	/^CREATE TABLE IF NOT EXISTS [^;]+$/i,
	/^ALTER TABLE (?:IF EXISTS )?[a-z0-9_."]+ ADD COLUMN IF NOT EXISTS "?[a-z_][a-z0-9_]*"? [a-z][a-z0-9_]*(?: ?\( ?\d+ ?\))?(?: NULL)?$/i,
];

/**
 * `sql` with every comment blanked and every string literal / quoted
 * identifier emptied — ONE left-to-right scan, so a `--` inside a literal is
 * text and a quote inside a comment is comment (two independent regex passes
 * got both wrong: `COMMENT ON t IS '--'; DROP TABLE x` lost its DROP). Null
 * when a literal or block comment never closes — such a file is not provable.
 */
function blankCommentsAndLiterals(sql: string): string | null {
	let out = '';
	let at = 0;
	while (at < sql.length) {
		const next = skipToken(sql, at);
		if (next === null) return null;
		out += next.text;
		at = next.end;
	}
	return out;
}

type Token = { text: string; end: number };

/** A comment at `at` (→ one space), undefined when none starts there, null when it never closes. */
function commentToken(sql: string, at: number): Token | null | undefined {
	const two = sql.slice(at, at + 2);
	if (two === '--') {
		const end = sql.indexOf('\n', at);
		return { text: ' ', end: end === -1 ? sql.length : end };
	}
	if (two !== '/*') return undefined;
	const end = sql.indexOf('*/', at + 2);
	return end === -1 ? null : { text: ' ', end: end + 2 };
}

/** One token at `at`: a comment (→ space), a quoted run (→ its empty quotes), or one char. */
function skipToken(sql: string, at: number): Token | null {
	const comment = commentToken(sql, at);
	if (comment !== undefined) return comment;
	const quote = sql[at] as string;
	if (quote !== "'" && quote !== '"') return { text: quote, end: at + 1 };
	const end = closingQuote(sql, at + 1, quote);
	return end === -1 ? null : { text: quote + quote, end: end + 1 };
}

/** The index of the quote closing a run opened before `from` (a doubled quote is an escape). */
function closingQuote(sql: string, from: number, quote: string): number {
	let at = sql.indexOf(quote, from);
	while (at !== -1 && sql[at + 1] === quote) at = sql.indexOf(quote, at + 2);
	return at;
}

/** A migration's statements, comments blanked, literals emptied, whitespace collapsed. */
export function migrationStatements(sql: string): string[] {
	return (blankCommentsAndLiterals(sql) ?? '')
		.split(';')
		.map((statement) => statement.replace(/\s+/g, ' ').trim())
		.filter((statement) => statement !== '');
}

/**
 * Is every statement of `sql` a compatible shape? A dollar-quoted body (a
 * function, a DO block) is never provable — its inside is not lexed.
 */
export function isProvablyCompatible(sql: string): boolean {
	if (/\$[a-z_]*\$/i.test(sql) || blankCommentsAndLiterals(sql) === null) return false;
	const statements = migrationStatements(sql);
	return (
		statements.length > 0 &&
		statements.every((statement) => COMPATIBLE_SHAPES.some((shape) => shape.test(statement)))
	);
}
