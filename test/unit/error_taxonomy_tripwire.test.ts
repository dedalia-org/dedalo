/**
 * ERROR-TAXONOMY TRIPWIRE — the closed vocabulary and the one-producer law
 * hold across the WHOLE tree (engineering/ERRORS_SPEC.md §1, §4, §7).
 *
 * ── WHAT IT GUARDS ───────────────────────────────────────────────────────────
 * The error-taxonomy plan retired five failure vocabularies and ~150 hand-built
 * failure bodies. `error_registry_native` proves the REGISTRY is coherent
 * (labels, placeholders, external totality, hints, status↔category, grammar);
 * THIS gate proves the TREE only speaks through it:
 *
 *  A. SOURCE LAWS (hard, zero) — over src/** + tools/** *.ts, non-test, comments
 *     stripped and string contents blanked (test/helpers/strip_comments.ts):
 *     A1 no failure-body BUILDER call: `denied(` / `notAuthorized(` /
 *        `notLogged(` / `failed(` (the P1 shells and the tool `failed()` helper
 *        are DELETED — a caller of one is a fossil that would not compile, and
 *        a NEW helper of that name is a body builder in disguise);
 *     A2 no `result: false` literal in code (the PHP wire fossil) ANYWHERE —
 *        src/core/errors/ included since the compat block's removal
 *        (2026-08-16, WC-2026-08-16-error-envelope-compat-removal) — and
 *        convert.ts writes no top-level `result:` key at all (the retired
 *        mirror of `data`; schema.ts ENVELOPE_FORBIDDEN_KEYS refuses it);
 *     A3 the literal `debug:` body key is written by convert.ts alone (schema.ts
 *        DECLARES it in the zod shape — the two are named; a third file is a leak
 *        of the debug block outside the DEDALO_DEBUG_API_ERRORS door);
 *     A4 no `instanceof TypeError|RangeError|ReferenceError` in src/ outside
 *        src/core/errors/convert.ts + src/core/api/process_health.ts (the four
 *        section_id catch sites key on `isErrorInDomain(e, 'section_id')` —
 *        SectionIdRefused, ERRORS_SPEC §2.1 — a builtin-class check is a
 *        vocabulary the registry does not own);
 *     A5 no file in the WHOLE corpus assigns raw exception text (`error.message`
 *        / `String(error)` / `(error as Error).message` / `err.message`) to a
 *        WIRE key (`msg:` / `errors:` / `publicMessage:`) — the raw text is
 *        `cause` (log-only) or the `message` override of a DedaloError
 *        (Error.message, never the wire). TOTAL census (was the 8 files the P1
 *        plan named — SEC-17 fell through that list); the sites that remain
 *        are ENUMERATED in RAW_ON_WIRE_EXEMPTIONS, each with a count and a
 *        reason, shrink-only (regression AND staleness are red). Anti-vacuity:
 *        the dispatch handler modules (derived from dispatch.ts's
 *        `./handlers/*` imports) and every `tools/*\/server/index.ts` (the
 *        loader's contract) are asserted IN the corpus, so the surfaces the
 *        wire actually goes through can never fall out of the scan;
 *     A6 no raw exception text KEYED into a payload (`<key>: …error.message…`
 *        / `${error}`, any key — `message:` / `cause:` are log-only ONLY inside
 *        an Error constructor call, tracked across its lines; a `{ok:false,
 *        message: raw}` RESULT object is a payload) or PUSHED into a list
 *        (`.push(…error.message…)`) — the ok:true half of the ladder (SEC-18:
 *        `toErrorBody` filters `error`, nothing filters `data`). Per LINE on
 *        the code view, skipping `console.` / `throw` / `new <X>Error(` lines
 *        (log, typed throw). A DedaloError's `.message` is its LOG field and
 *        counts like any raw read (its wire sentence is `wireMessage()`); no
 *        "deliberate arm" is blanked. The measured leak class is ENUMERATED
 *        in RAW_KEYED_EXEMPTIONS with a closed reason vocabulary
 *        (RAW_KEYED_REASONS), shrink-only: it is a RATCHET on a burn-down —
 *        the admin-gated report surfaces (ontology import/export, the
 *        maintenance widgets, the tool_import_* per-file reports, the update
 *        engine) still carry raw text, and each entry says which class it is;
 *        the two SEC-16/SEC-18 doors (bulk_revert.ts, vision.ts) are at 0 and
 *        NOT exempt;
 *  B. SOURCE RATCHETS (shrink-only, frozen per file here, staleness = red):
 *     B1 hand-built failure literals: an `ok: false` object literal carrying
 *        `msg:` / `errors:` / `error:` within 3 lines. The tree still holds
 *        INTERNAL outcome shapes of that form (`{ok:false, msg}` from the ASR /
 *        translation providers, PermissionCheck, install probes) — never an
 *        envelope, but the same spelling, so the P3 burn-down decides each one:
 *        typed throw, or a renamed internal shape. Frozen 2026-08-15; may only
 *        shrink; a NEW file starts at 0;
 *     B2 prose in `errors: [ '…' ]` literals (an element with a space or an
 *        uppercase letter — a sentence where the wire wants a code). Same rule.
 *  C. VOCABULARY TOTALITY:
 *     C1 every ERROR_CODES key is thrown/referenced somewhere in src/ or tools/
 *        (as a `'code'` string, or by template construction of its domain —
 *        `external.${kind}`) OR carries a `reason` (a named exemption: parity
 *        tables, client-minted codes, reserved rows). An orphan code is dead
 *        vocabulary — delete it or say why it stays;
 *     C1c a `reason` is ONLY for a code nothing references: a referenced code
 *        carrying one would stay green after its last throw site is deleted
 *        (its why goes in a comment above the row instead);
 *     C2 every code string the CLIENT speaks resolves: the literals in
 *        client/dedalo/core/common/js/error_policy.js (CORE_POLICY keys — a
 *        `<domain>.*` wildcard needs a registered domain) and every
 *        `new ApiError({code: '<domain>.<condition>'` in client/** + tools/*\/js
 *        are registry codes or `client.*` (the transport-side family, whose
 *        labels are `error_client_*` — labels_tripwire owns those).
 *  D. RUNTIME LEG (DB-gated): for EVERY registered (class, action) pair, a
 *     handler that throws yields a body validating `apiEnvelopeSchema` with
 *     `ok:false ⇒ status ∉ 2xx` — through the real dispatch (gates included).
 *  E. ANTI-VACUITY: every matcher above fails on a synthetic offender string.
 *
 * ── HOW TO LOWER A RATCHET COUNT ─────────────────────────────────────────────
 * Convert the site (throw a registered code / rename the internal shape / drop
 * the prose element), then LOWER that file's entry in the frozen map below in
 * the same commit — the gate reports the exact per-file drift. Never raise a
 * number to get green.
 *
 * HERMETIC for A–C and E (tracked-source reads; imports the registry, which
 * imports nothing). D uses the real dispatcher against the suite database.
 *
 * Registered in engineering/TRIPWIRES.md + scripts/verify.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';
import { actionTableFor, dispatchRqo, listRegisteredActions } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import {
	ERROR_CODES,
	ERROR_REGISTRY,
	type ErrorCode,
	type ErrorSpec,
} from '../../src/core/errors/registry.ts';
import { apiEnvelopeSchema } from '../../src/core/errors/schema.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { DB_READY } from '../helpers/db_ready.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';
import { stripComments } from '../helpers/strip_comments.ts';

registerSessionCleanup();

const REPO_ROOT = join(import.meta.dir, '..', '..');

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

interface SourceFile {
	/** repo-relative, forward slashes */
	readonly path: string;
	/** comments stripped, string contents KEPT (for literal inspection) */
	readonly code: string;
	/** comments stripped AND string contents blanked (for token counting) */
	readonly tokens: string;
}

function isScanned(match: string): boolean {
	return (
		!match.endsWith('.test.ts') &&
		!match.endsWith('.d.ts') &&
		!match.includes('/node_modules/') &&
		!match.includes('/dist/') &&
		!match.startsWith('node_modules/') &&
		!match.startsWith('dist/')
	);
}

function loadCorpus(): SourceFile[] {
	const files: SourceFile[] = [];
	for (const dir of ['src', 'tools']) {
		const glob = new Glob('**/*.ts');
		for (const match of glob.scanSync({ cwd: join(REPO_ROOT, dir), followSymlinks: true })) {
			if (!isScanned(match)) continue;
			const path = `${dir}/${match.split('\\').join('/')}`;
			const raw = readFileSync(join(REPO_ROOT, path), 'utf8');
			files.push({
				path,
				code: stripComments(raw),
				tokens: stripComments(raw, { blankStrings: true }),
			});
		}
	}
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return files;
}

const CORPUS = loadCorpus();
/** Far below the measured corpus (~1400 files); proves the glob saw a tree, not a stub. */
const CORPUS_FLOOR = 400;

const inErrorsDir = (path: string) => path.startsWith('src/core/errors/');

// ---------------------------------------------------------------------------
// A. Source laws — matchers as functions (the anti-vacuity probe feeds them)
// ---------------------------------------------------------------------------

/**
 * A1 — a builder CALL: not a member access (`report.failed(`), not part of a
 * longer identifier, not the word after a closing paren (prose in a nested
 * template literal — `rebuild(s) failed (…)` — which the string blanker keeps).
 */
const BUILDER_CALL = /(?<![.\w$])(?<!\)\s{0,3})(denied|notAuthorized|notLogged|failed)\s*\(/g;
const countBuilderCalls = (tokens: string): number => (tokens.match(BUILDER_CALL) ?? []).length;

/** A2 — the PHP wire fossil as a literal. */
const RESULT_FALSE = /\bresult\s*:\s*false\b/g;
const countResultFalse = (tokens: string): number => (tokens.match(RESULT_FALSE) ?? []).length;
/** A2 (converter) — a `result:` object key or `{ result }` shorthand written by convert.ts. */
const RESULT_KEY = /(?<![\w$.])result\s*[:}]/g;
const countResultKeys = (tokens: string): number => (tokens.match(RESULT_KEY) ?? []).length;

/** A3 — the debug key written (`{ debug }` shorthand or `debug:`) or declared as an object key. */
const DEBUG_KEY = /(?<![\w$.])debug\s*[:}]/g;
const countDebugKeys = (tokens: string): number => (tokens.match(DEBUG_KEY) ?? []).length;
const DEBUG_KEY_OWNERS = ['src/core/errors/convert.ts', 'src/core/errors/schema.ts'];

/** A4 — a builtin-class check where a registry domain belongs. */
const BUILTIN_INSTANCEOF = /instanceof\s+(TypeError|RangeError|ReferenceError)\b/g;
const countBuiltinInstanceof = (tokens: string): number =>
	(tokens.match(BUILTIN_INSTANCEOF) ?? []).length;
const BUILTIN_INSTANCEOF_OWNERS = ['src/core/errors/convert.ts', 'src/core/api/process_health.ts'];

/**
 * A5/A6 — ONE spelling of "raw exception text": the message of a caught
 * exception or its String() form. Deliberately NOT narrowed away from
 * `parsed.error.message` (a zod validator's sentence about the caller's own
 * input): the matcher stays one spelling of the invariant, and the entries
 * below say why such a sentence is deliberate.
 */
const RAW_EXCEPTION_TEXT =
	/\b(?:error|err)\.message\b|String\(\s*(?:error|err)\s*\)|\((?:error|err) as Error\)\.message|\$\{\s*(?:error|err)\s*\}/;
/** A5 — a raw exception text assigned to a WIRE key. */
const RAW_ON_WIRE_KEY = new RegExp(
	`\\b(msg|errors|publicMessage)\\s*:\\s*[^,\\n]*?(?:${RAW_EXCEPTION_TEXT.source})`,
	'g',
);
const countRawOnWire = (code: string): number => (code.match(RAW_ON_WIRE_KEY) ?? []).length;

/**
 * A5 — the sites that still put raw exception text on a wire key, ENUMERATED.
 * Count per file + the reason the text is there. Shrink-only: a file above its
 * count is a regression, a file below it is a stale entry (lower it in the same
 * commit), a file absent here is capped at 0. Measured 2026-09-03.
 */
const RAW_ON_WIRE_EXEMPTIONS: Readonly<Record<string, { count: number; reason: string }>> = {
	'src/ai/agent/change_plan.ts': {
		count: 1,
		reason:
			"zod's `parsed.error.message` is the validator's sentence about the CALLER'S OWN plan document, not a caught exception; publicMessage under a public-disclosure code",
	},
	'src/ai/mcp/registry.ts': {
		count: 1,
		reason:
			"zod's `parsed.error.message` describes the MCP caller's own tool input against the declared schema; publicMessage under a public-disclosure code",
	},
	'src/core/media/tools/versions.ts': {
		count: 1,
		reason:
			'admin-only media rebuild report (`errors[]` of the maintenance widget); burn-down owned by the media tools pass',
	},
	'src/core/ontology/data_io_import.ts': {
		count: 2,
		reason:
			'developer-only ontology import report (`msg` / `errors[]` of the ontology data_io widget); burn-down owned by the ontology pass',
	},
	'src/core/tools/import_csv_execute.ts': {
		count: 1,
		reason:
			'per-row admin import report (`msg` of an IGNORED row): the importer is level-3 gated; burn-down owned by the import pass',
	},
	'src/core/tools/import_execute.ts': {
		count: 1,
		reason:
			'per-record admin import report (`msg` of an IGNORED record): the importer is level-3 gated; burn-down owned by the import pass',
	},
	'src/core/tools/transcription_local_asr.ts': {
		count: 2,
		reason:
			'internal `{ok:false, msg}` provider outcome shape of the local ASR runner (B1-ratcheted), mapped to a typed throw by its caller',
	},
	'src/diffusion/plan/compile.ts': {
		count: 1,
		reason:
			'diffusion plan diagnostics (`errors[]` of a compile report) read by the admin diffusion area; burn-down owned by the diffusion pass',
	},
	'tools/tool_import_dedalo_csv/server/index.ts': {
		count: 2,
		reason:
			'admin import tool per-file report (`errors[]`), level-3 gated; burn-down owned by the import pass',
	},
};

/**
 * A6 — raw exception text KEYED into a payload or PUSHED into a list, per line.
 * `key` is the LAST line/`{`/`,`-anchored `<identifier>:` before the raw
 * expression on that line — so prose like `bulk_revert: … failed:` inside a
 * template is never a key, and `{ a: 1, message: error.message }` resolves to
 * `message`. `message:` / `cause:` are log-only ONLY inside an Error
 * constructor call (`new <X>Error(` / `super(`, tracked across its lines by
 * paren depth): a `{ ok: false, message: raw }` RESULT object is a payload a
 * caller forwards — vision.ts's model resolver did exactly that (SEC-18) and
 * a blanket `message:` exemption made it invisible. There is NO "deliberate
 * arm": `instanceof DedaloError ? error.message : …` reads the LOG-ONLY field
 * of a DedaloError (dedalo_error.ts — `message` "never the wire"; a provider
 * constructor names its api_key_env there), so it counts like any raw read;
 * the wire sentence of a DedaloError is `wireMessage()`. Returns one hit per
 * LINE (a line is a site).
 */
const RAW_KEYED_LOG_ONLY_KEYS = new Set(['message', 'cause']);
const RAW_KEYED_SKIP_LINE = /console\.|\bthrow\b|new [A-Za-z_$][\w$]*Error\(/;
/** Where an Error constructor's fields begin: its `message`/`cause` are the log's. */
const RAW_KEYED_ERROR_CTOR = /new [A-Za-z_$][\w$]*Error\(|\bsuper\(/;
const RAW_KEYED_ANCHORED_KEY = /(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*:/g;
const parenBalance = (text: string): number =>
	(text.match(/\(/g) ?? []).length - (text.match(/\)/g) ?? []).length;
function rawKeyedLines(code: string): string[] {
	const hits: string[] = [];
	/** >0 while inside an Error constructor call opened on an earlier line. */
	let ctorDepth = 0;
	for (const raw of code.split('\n')) {
		const inCtor = ctorDepth > 0;
		const opened = RAW_KEYED_ERROR_CTOR.exec(raw);
		if (inCtor) ctorDepth = Math.max(0, ctorDepth + parenBalance(raw));
		else if (opened !== null) ctorDepth = Math.max(0, parenBalance(raw.slice(opened.index)));
		const line = raw;
		const at = RAW_EXCEPTION_TEXT.exec(line);
		if (at === null || RAW_KEYED_SKIP_LINE.test(line)) continue;
		const prefix = line.slice(0, at.index);
		let key: string | null = null;
		for (const anchored of prefix.matchAll(RAW_KEYED_ANCHORED_KEY)) key = anchored[1] ?? null;
		if (key !== null) {
			if (!(inCtor && RAW_KEYED_LOG_ONLY_KEYS.has(key))) hits.push(line.trim());
		} else if (/\.push\(/.test(prefix)) {
			hits.push(line.trim());
		}
	}
	return hits;
}
const countRawKeyed = (code: string): number => rawKeyedLines(code).length;

/** A6 — the closed reason vocabulary: every entry names exactly one class. */
const RAW_KEYED_REASONS = {
	/** an admin/developer-gated REPORT surface (maintenance widget, ontology
	 *  data_io, install probe, import tool per-file report) — the burn-down */
	admin_report: 'admin_report',
	/** an INTERNAL outcome shape (`{ok:false,…}`, a job record, a worker
	 *  message) consumed in-process, mapped by its consumer — not a wire body */
	internal_outcome: 'internal_outcome',
	/** a validator's (zod) sentence about the caller's OWN input */
	validator_sentence: 'validator_sentence',
	/** a CLI/operator-facing line (installer notes, update log) that a
	 *  multi-line log statement keeps on the raw line */
	multiline_log_line: 'multiline_log_line',
} as const;
type RawKeyedReason = (typeof RAW_KEYED_REASONS)[keyof typeof RAW_KEYED_REASONS];

/**
 * A6 — the measured leak class, ENUMERATED (2026-09-03), shrink-only. This is a
 * RATCHET on a burn-down, not a closure: every `admin_report` entry is a
 * surface where an admin still reads raw Postgres/fs text inside an ok:true
 * payload. Lower an entry when you convert a site; never raise one. The reason
 * classifies the SURFACE the file's hits ride. Two hits (hierarchy_import,
 * tool_ontology_parser: `.map((error) => `${tld}: ${error}`)` over a list of
 * SENTENCES) are the one-family `${error}` spelling meeting a string named
 * `error`, not an exception — accepted rather than teaching the matcher to
 * parse bindings; they ride the same surfaces as their files' other hits.
 */
const RAW_KEYED_EXEMPTIONS: Readonly<Record<string, { count: number; reason: RawKeyedReason }>> = {
	'src/ai/agent/change_plan.ts': { count: 1, reason: 'validator_sentence' },
	'src/ai/mcp/registry.ts': { count: 1, reason: 'validator_sentence' },
	'src/ai/mcp/tools/search.ts': { count: 1, reason: 'validator_sentence' },
	'src/core/api/counters.ts': { count: 3, reason: 'admin_report' },
	'src/core/area_maintenance/widgets/database_info.ts': { count: 2, reason: 'admin_report' },
	'src/core/area_maintenance/widgets/dataframe_control.ts': {
		count: 1,
		reason: 'admin_report',
	},
	'src/core/area_maintenance/widgets/system_info.ts': { count: 2, reason: 'admin_report' },
	'src/core/db/db_assets.ts': { count: 4, reason: 'admin_report' },
	'src/core/geoip/download.ts': { count: 3, reason: 'internal_outcome' },
	'src/core/install/directories.ts': { count: 1, reason: 'multiline_log_line' },
	'src/core/install/hierarchy_import.ts': { count: 1, reason: 'internal_outcome' },
	'src/core/install/media_tree.ts': { count: 1, reason: 'admin_report' },
	'src/core/media/file_ops.ts': { count: 1, reason: 'internal_outcome' },
	'src/core/media/jobs.ts': { count: 1, reason: 'internal_outcome' },
	'src/core/media/processing.ts': { count: 1, reason: 'internal_outcome' },
	'src/core/media/repair.ts': { count: 2, reason: 'admin_report' },
	'src/core/media/tools/rotation.ts': { count: 2, reason: 'internal_outcome' },
	'src/core/media/tools/versions.ts': { count: 1, reason: 'admin_report' },
	'src/core/ontology/data_io.ts': { count: 2, reason: 'admin_report' },
	'src/core/ontology/data_io_import.ts': { count: 4, reason: 'admin_report' },
	'src/core/ontology/hierarchy_provision.ts': { count: 2, reason: 'admin_report' },
	'src/core/ontology/ontology_state.ts': { count: 1, reason: 'admin_report' },
	'src/core/ontology/ontology_update.ts': { count: 1, reason: 'admin_report' },
	'src/core/ontology/recovery_file.ts': { count: 3, reason: 'admin_report' },
	'src/core/tools/import_csv_execute.ts': { count: 1, reason: 'admin_report' },
	'src/core/tools/import_execute.ts': { count: 1, reason: 'admin_report' },
	'src/core/tools/marc21.ts': { count: 1, reason: 'admin_report' },
	'src/core/tools/register.ts': { count: 3, reason: 'admin_report' },
	'src/core/tools/transcription_local_asr.ts': { count: 2, reason: 'internal_outcome' },
	'src/core/update/engine.ts': { count: 1, reason: 'admin_report' },
	'src/diffusion/plan/compile.ts': { count: 3, reason: 'admin_report' },
	'src/diffusion/resolve/resolver.ts': { count: 1, reason: 'admin_report' },
	'src/diffusion/targets/mariadb/delete_record.ts': { count: 1, reason: 'admin_report' },
	'src/diffusion/targets/mediastore/media_index.ts': { count: 1, reason: 'admin_report' },
	'tools/tool_import_dedalo_csv/server/csv_worker.ts': {
		count: 1,
		reason: 'internal_outcome',
	},
	'tools/tool_import_dedalo_csv/server/index.ts': { count: 3, reason: 'admin_report' },
	'tools/tool_import_files/server/index.ts': { count: 1, reason: 'admin_report' },
	'tools/tool_import_marc21/server/index.ts': { count: 1, reason: 'admin_report' },
	'tools/tool_import_zotero/server/index.ts': { count: 1, reason: 'admin_report' },
	'tools/tool_ontology_parser/server/tool_ontology_parser.ts': { count: 1, reason: 'admin_report' },
	'tools/tool_propagate_component_data/server/index.ts': { count: 1, reason: 'admin_report' },
};

/** The two doors the SEC-16 / SEC-18 fix closed: at 0 by construction, never exempt. */
const RAW_KEYED_CLOSED_DOORS = [
	'tools/tool_time_machine/server/bulk_revert.ts',
	'src/ai/identify/vision.ts',
];

/**
 * The surfaces the wire actually goes through — derived, so a new handler or
 * tool cannot fall out of the A5/A6 census: every `./handlers/<x>.ts` import
 * of dispatch.ts, and every `tools/<tool_*>/server/index.ts` (loader.ts loads
 * exactly that file per tool directory).
 */
function wireSurfaceFiles(): string[] {
	const dispatch = CORPUS.find((file) => file.path === 'src/core/api/dispatch.ts');
	const handlers = [...(dispatch?.code ?? '').matchAll(/from '\.\/handlers\/([\w]+\.ts)'/g)].map(
		(match) => `src/core/api/handlers/${match[1]}`,
	);
	const tools = CORPUS.filter((file) =>
		/^tools\/tool_[a-z0-9_]+\/server\/index\.ts$/.test(file.path),
	).map((file) => file.path);
	return [...handlers, ...tools].sort();
}
/** Floors far below the measured 15 handlers + 25 tools: a broken derivation, not a smaller tree. */
const WIRE_SURFACE_FLOOR = { handlers: 8, tools: 12 };

// ---------------------------------------------------------------------------
// B. Source ratchets — counters + the frozen per-file maps
// ---------------------------------------------------------------------------

/**
 * B1 — `ok: false` literals with a failure-shape sibling key within 3 lines
 * (before or after). Counted on the token view (strings blanked), so a
 * message that SAYS `ok:false` is never a hit.
 */
function countFailureLiterals(tokens: string): number {
	const lines = tokens.split('\n');
	let count = 0;
	for (let i = 0; i < lines.length; i++) {
		if (!/\bok\s*:\s*false\b/.test(lines[i] ?? '')) continue;
		const window = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join('\n');
		if (/\b(msg|errors|error)\s*:/.test(window)) count += 1;
	}
	return count;
}

/** B2 — `errors: [ '<prose>' …` — the first element is a string literal holding a space or an uppercase letter. */
const PROSE_ERRORS = /\berrors\s*:\s*\[\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g;
function countProseErrors(code: string): number {
	let count = 0;
	for (const match of code.matchAll(PROSE_ERRORS)) {
		const element = match[2] ?? '';
		if (/[\sA-Z]/.test(element)) count += 1;
	}
	return count;
}

/**
 * THE FROZEN MAPS (2026-08-15, P1 exit). Per-file counts; a file absent here
 * is capped at 0. Lower an entry when you convert a site; never raise one.
 */
const FAILURE_LITERAL_BASELINE: Readonly<Record<string, number>> = {
	'src/core/ai/model_fetch.ts': 1,
	'src/core/api/handlers/dd_identify_api.ts': 10,
	'src/core/api/handlers/dd_utils_api.ts': 5,
	'src/core/area_maintenance/backup.ts': 1,
	'src/core/area_maintenance/user_stats.ts': 1,
	'src/core/db/db_assets.ts': 2,
	'src/core/geoip/download.ts': 6,
	'src/core/install/config_persist.ts': 4,
	'src/core/install/hierarchy_activate.ts': 1,
	'src/core/install/hierarchy_import.ts': 2,
	'src/core/install/mailer_probe.ts': 2,
	'src/core/mailer/mailer.ts': 4,
	'src/core/media/tools/versions.ts': 1,
	'src/core/ontology/data_io.ts': 4,
	'src/core/ontology/data_io_import.ts': 3,
	'src/core/ontology/hierarchy_provision.ts': 1,
	'src/core/ontology/hierarchy_state.ts': 3,
	'src/core/ontology/ontology_delete.ts': 2,
	'src/core/ontology/ontology_state.ts': 2,
	'src/core/ontology/ontology_update.ts': 3,
	'src/core/ontology/ontology_write.ts': 1,
	'src/core/ontology/recovery_file.ts': 2,
	'src/core/relations/parent.ts': 1,
	'src/core/security/section_permissions.ts': 4,
	'src/core/tools/babel.ts': 2,
	'src/core/tools/security.ts': 3,
	'src/core/tools/transcription_asr.ts': 5,
	'src/core/tools/transcription_local_asr.ts': 6,
	'src/core/tools/translation.ts': 5,
	'src/core/update/code_build_plan.ts': 2,
	'src/core/update/engine.ts': 2,
	'src/core/update/transform/engine.ts': 1,
	'tools/tool_import_dedalo_csv/server/index.ts': 1,
};

const PROSE_ERRORS_BASELINE: Readonly<Record<string, number>> = {
	'src/core/api/process_status.ts': 4,
	'src/core/media/tools/versions.ts': 1,
	'src/core/ontology/data_io_import.ts': 1,
	'src/core/ontology/hierarchy_state.ts': 1,
	'src/core/ontology/ontology_delete.ts': 1,
	'src/core/ontology/ontology_state.ts': 1,
	'src/core/ontology/ontology_update.ts': 2,
	'src/core/ontology/ontology_update_target.ts': 4,
	'src/core/update/engine.ts': 1,
	'src/core/update/transform/engine.ts': 1,
	'src/diffusion/api/actions.ts': 3,
	'src/diffusion/jobs/pending_retry.ts': 1,
	'src/diffusion/jobs/sse.ts': 1,
};

interface Drift {
	readonly regressions: string[];
	readonly stale: string[];
}

/** Shrink-only + staleness over a frozen map. */
function driftAgainst(
	measured: Readonly<Record<string, number>>,
	baseline: Readonly<Record<string, number>>,
): Drift {
	const regressions: string[] = [];
	const stale: string[] = [];
	for (const [path, count] of Object.entries(measured)) {
		const allowed = baseline[path] ?? 0;
		if (count > allowed) regressions.push(`${path}: ${count} > ${allowed}`);
	}
	for (const [path, allowed] of Object.entries(baseline)) {
		const count = measured[path] ?? 0;
		if (count < allowed)
			stale.push(`${path}: now ${count}, entry says ${allowed} — lower the entry`);
	}
	return { regressions, stale };
}

function measure(counter: (file: SourceFile) => number): Record<string, number> {
	const out: Record<string, number> = {};
	for (const file of CORPUS) {
		if (inErrorsDir(file.path)) continue;
		const count = counter(file);
		if (count > 0) out[file.path] = count;
	}
	return out;
}

// ---------------------------------------------------------------------------
// C. Vocabulary totality
// ---------------------------------------------------------------------------

/** Every non-registry source joined once (registry.ts declares the codes; it may not "reference" them). */
const REFERENCE_CORPUS = CORPUS.filter((file) => file.path !== 'src/core/errors/registry.ts')
	.map((file) => file.code)
	.join('\n');

/** A code is referenced as a quoted literal, or its domain is built by template (`external.${kind}`). */
function isCodeReferenced(code: ErrorCode, corpus: string): boolean {
	if (corpus.includes(`'${code}'`) || corpus.includes(`"${code}"`)) return true;
	const domain = code.slice(0, code.indexOf('.'));
	return corpus.includes(`\`${domain}.\${`);
}

const CLIENT_POLICY_FILE = 'client/dedalo/core/common/js/error_policy.js';
/** The transport-side family the client owns (labels error_client_*). */
const CLIENT_CODE_PREFIX = 'client.';
/** The registry row, widened to ErrorSpec (the `as const` table narrows optional fields away per row). */
const specOf = (code: ErrorCode): ErrorSpec => ERROR_REGISTRY[code];
const REGISTERED_DOMAINS = new Set(ERROR_CODES.map((code) => code.slice(0, code.indexOf('.'))));

function readRepoFile(path: string): string {
	return readFileSync(join(REPO_ROOT, path), 'utf8');
}

/** `'<domain>.<condition|*>'` literals in a source (comments stripped, strings kept). */
function codeLiterals(source: string): string[] {
	const out: string[] = [];
	for (const match of stripComments(source).matchAll(
		/'([a-z][a-z0-9_]*\.(?:[a-z][a-z0-9_]*|\*))'/g,
	)) {
		out.push(match[1] as string);
	}
	return out;
}

/** `new ApiError({ … code: '<x.y>' …` — the code literal of a client-minted error. */
function mintedCodes(source: string): string[] {
	const out: string[] = [];
	const stripped = stripComments(source);
	for (const match of stripped.matchAll(/new ApiError\s*\(\s*\{([^}]*)\}/g)) {
		const block = match[1] ?? '';
		const code = /\bcode\s*:\s*'([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)'/.exec(block);
		if (code) out.push(code[1] as string);
	}
	return out;
}

/** Client files that mint ApiErrors: client/dedalo/**\/*.js (minus the client test harness) + tools/*\/js/**\/*.js. */
function clientMintingFiles(): string[] {
	const files: string[] = [];
	const roots: [string, string][] = [
		['client/dedalo', '**/*.js'],
		['tools', '*/js/**/*.js'],
	];
	for (const [root, pattern] of roots) {
		for (const match of new Glob(pattern).scanSync({ cwd: join(REPO_ROOT, root) })) {
			const path = `${root}/${match}`;
			if (path.startsWith('client/dedalo/test/')) continue;
			if (readRepoFile(path).includes('new ApiError(')) files.push(path);
		}
	}
	return files.sort();
}

function resolves(code: string): boolean {
	if (code.startsWith(CLIENT_CODE_PREFIX)) return true;
	if (code.endsWith('.*')) return REGISTERED_DOMAINS.has(code.slice(0, -2));
	return Object.hasOwn(ERROR_REGISTRY, code);
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('error_taxonomy_tripwire — corpus', () => {
	test(`the scan saw a real tree (≥ ${CORPUS_FLOOR} files)`, () => {
		expect(CORPUS.length).toBeGreaterThanOrEqual(CORPUS_FLOOR);
		// the two chokepoints and the registry are in it (a glob that missed them is a broken scan)
		const paths = new Set(CORPUS.map((file) => file.path));
		expect(paths.has('src/core/api/dispatch.ts')).toBe(true);
		expect(paths.has('src/core/errors/registry.ts')).toBe(true);
		expect(paths.has('src/core/tools/dispatch.ts')).toBe(true);
	});
});

describe('A. source laws (zero)', () => {
	test('A1 — no failure-body builder call (denied/notAuthorized/notLogged/failed)', () => {
		const hits = measure((file) => countBuilderCalls(file.tokens));
		expect(hits, 'a body builder is a fossil (P1 shells deleted) — THROW a DedaloError').toEqual(
			{},
		);
	});

	test('A2 — no `result: false` literal anywhere; convert.ts writes no `result:` key', () => {
		const hits = measure((file) => countResultFalse(file.tokens));
		expect(hits, 'the PHP wire fossil: throw a DedaloError instead').toEqual({});
		// src/core/errors/ is skipped by measure(): check it by name — the compat
		// block used to live there and must not come back.
		const errorsDir = CORPUS.filter((file) => inErrorsDir(file.path));
		expect(errorsDir.length).toBeGreaterThan(3);
		for (const file of errorsDir) {
			expect(
				countResultFalse(file.tokens),
				`${file.path}: result:false is the retired compat mirror`,
			).toBe(0);
		}
		const convert = CORPUS.find((file) => file.path === 'src/core/errors/convert.ts');
		expect(convert).toBeDefined();
		expect(
			countResultKeys(convert?.tokens ?? 'result:'),
			'convert.ts writes a top-level `result` key — the compat mirror was removed 2026-08-16',
		).toBe(0);
	});

	test('A3 — the `debug:` body key lives in convert.ts (writer) + schema.ts (declaration) only', () => {
		const owners: Record<string, number> = {};
		for (const file of CORPUS) {
			const count = countDebugKeys(file.tokens);
			if (count > 0) owners[file.path] = count;
		}
		expect(Object.keys(owners).sort()).toEqual([...DEBUG_KEY_OWNERS].sort());
		// non-vacuous: both owners DO carry it
		expect(owners['src/core/errors/convert.ts']).toBeGreaterThan(0);
		expect(owners['src/core/errors/schema.ts']).toBeGreaterThan(0);
	});

	test('A4 — no builtin-class instanceof outside convert.ts + process_health.ts (section_id catches use isErrorInDomain)', () => {
		const offenders: Record<string, number> = {};
		for (const file of CORPUS) {
			if (BUILTIN_INSTANCEOF_OWNERS.includes(file.path)) continue;
			const count = countBuiltinInstanceof(file.tokens);
			if (count > 0) offenders[file.path] = count;
		}
		expect(offenders).toEqual({});
		// the four catch sites key on the section_id DOMAIN
		for (const path of [
			'src/core/section/read.ts',
			'src/core/section/read_facade.ts',
			'src/core/security/permissions.ts',
			'src/core/tools/import_conform.ts',
		]) {
			const file = CORPUS.find((entry) => entry.path === path);
			expect(file, path).toBeDefined();
			expect(file?.code).toContain("isErrorInDomain(error, 'section_id')");
		}
		// …and section_id.ts throws the family, never a builtin
		const sectionId = CORPUS.find((entry) => entry.path === 'src/core/concepts/section_id.ts');
		expect(sectionId?.tokens).not.toMatch(/throw new (TypeError|RangeError)\(/);
		expect(sectionId?.tokens).toContain('new SectionIdRefused(');
	});

	test('A5 — TOTAL: no file puts raw exception text on a wire key, except the enumerated (reasoned, shrink-only) sites', () => {
		const measured = measure((file) => countRawOnWire(file.code));
		const baseline: Record<string, number> = {};
		for (const [path, entry] of Object.entries(RAW_ON_WIRE_EXEMPTIONS))
			baseline[path] = entry.count;
		const drift = driftAgainst(measured, baseline);
		expect(
			drift.regressions,
			`RAW EXCEPTION TEXT ON A WIRE KEY. The raw text is \`cause\` (log-only) or a DedaloError's \`message\` override; the wire carries a DELIBERATE sentence (SEC-17: fs messages embed absolute paths). Measured:\n${JSON.stringify(measured, null, 1)}`,
		).toEqual([]);
		expect(
			drift.stale,
			'STALE EXEMPTION: a file shrank — lower its entry in RAW_ON_WIRE_EXEMPTIONS in the same commit',
		).toEqual([]);
		// every exemption is a real sentence, and names a file the scan saw
		for (const [path, entry] of Object.entries(RAW_ON_WIRE_EXEMPTIONS)) {
			expect(entry.reason.length, path).toBeGreaterThan(40);
			expect(entry.count, path).toBeGreaterThan(0);
			expect(
				CORPUS.some((file) => file.path === path),
				`${path}: exemption names no file`,
			).toBe(true);
		}
	});

	test('A5/A6 anti-vacuity — the wire surfaces (dispatch handlers + tool entry modules) are IN the census', () => {
		const surfaces = wireSurfaceFiles();
		const handlers = surfaces.filter((path) => path.startsWith('src/core/api/handlers/'));
		const tools = surfaces.filter((path) => path.startsWith('tools/'));
		expect(handlers.length).toBeGreaterThanOrEqual(WIRE_SURFACE_FLOOR.handlers);
		expect(tools.length).toBeGreaterThanOrEqual(WIRE_SURFACE_FLOOR.tools);
		const paths = new Set(CORPUS.map((file) => file.path));
		for (const path of surfaces)
			expect(paths.has(path), `${path} fell out of the corpus`).toBe(true);
		// the whole surface is measured by BOTH counters, and exempt only by an entry
		for (const path of surfaces) {
			const file = CORPUS.find((entry) => entry.path === path);
			expect(
				countRawOnWire(file?.code ?? '') <= (RAW_ON_WIRE_EXEMPTIONS[path]?.count ?? 0),
				path,
			).toBe(true);
			expect(
				countRawKeyed(file?.code ?? '') <= (RAW_KEYED_EXEMPTIONS[path]?.count ?? 0),
				path,
			).toBe(true);
		}
	});

	test('A6 — no raw exception text KEYED into a payload or PUSHED into a list, except the enumerated (reasoned, shrink-only) sites', () => {
		const measured = measure((file) => countRawKeyed(file.code));
		const baseline: Record<string, number> = {};
		for (const [path, entry] of Object.entries(RAW_KEYED_EXEMPTIONS)) baseline[path] = entry.count;
		const drift = driftAgainst(measured, baseline);
		const detail = (path: string): string =>
			rawKeyedLines(CORPUS.find((file) => file.path === path)?.code ?? '').join('\n    ');
		expect(
			drift.regressions,
			`RAW EXCEPTION TEXT IN A PAYLOAD (SEC-18: nothing filters \`data\` on an ok:true body). Put the text in the log (with the request id) and a CODE or a deliberate sentence on the wire.\n${drift.regressions.map((line) => `${line}\n    ${detail(line.slice(0, line.indexOf(':')))}`).join('\n')}`,
		).toEqual([]);
		expect(
			drift.stale,
			'STALE EXEMPTION: a file shrank — lower its entry in RAW_KEYED_EXEMPTIONS in the same commit',
		).toEqual([]);
		const vocabulary = new Set<string>(Object.values(RAW_KEYED_REASONS));
		for (const [path, entry] of Object.entries(RAW_KEYED_EXEMPTIONS)) {
			expect(vocabulary.has(entry.reason), `${path}: reason outside the closed vocabulary`).toBe(
				true,
			);
			expect(entry.count, path).toBeGreaterThan(0);
			expect(
				CORPUS.some((file) => file.path === path),
				`${path}: exemption names no file`,
			).toBe(true);
		}
		// the two doors this rule was written for are closed, and stay unexempt
		for (const path of RAW_KEYED_CLOSED_DOORS) {
			expect(Object.hasOwn(RAW_KEYED_EXEMPTIONS, path), `${path} may not be exempted`).toBe(false);
			expect(
				CORPUS.some((file) => file.path === path),
				path,
			).toBe(true);
		}
		// the ratchet is non-vacuous: it holds a measured leak class
		expect(Object.keys(RAW_KEYED_EXEMPTIONS).length).toBeGreaterThan(10);
	});
});

describe('B. source ratchets (shrink-only, frozen per file)', () => {
	test('B1 — hand-built failure literals (`ok:false` + msg/errors/error) may only shrink', () => {
		const measured = measure((file) => countFailureLiterals(file.tokens));
		const drift = driftAgainst(measured, FAILURE_LITERAL_BASELINE);
		expect(
			drift.regressions,
			`FAILURE LITERALS GREW. A failure is a THROWN DedaloError (the converter makes the body); an INTERNAL outcome shape must not spell the envelope. Measured:\n${JSON.stringify(measured, null, 1)}`,
		).toEqual([]);
		expect(
			drift.stale,
			'STALE RATCHET: a file shrank — lower its entry in FAILURE_LITERAL_BASELINE in the same commit',
		).toEqual([]);
	});

	test('B2 — prose in `errors: [ … ]` literals may only shrink', () => {
		const measured = measure((file) => countProseErrors(file.code));
		const drift = driftAgainst(measured, PROSE_ERRORS_BASELINE);
		expect(
			drift.regressions,
			`PROSE IN errors[] GREW. The machine channel carries CODES; a sentence belongs to a label. Measured:\n${JSON.stringify(measured, null, 1)}`,
		).toEqual([]);
		expect(
			drift.stale,
			'STALE RATCHET: a file shrank — lower its entry in PROSE_ERRORS_BASELINE in the same commit',
		).toEqual([]);
	});
});

describe('C. vocabulary totality', () => {
	test('C1 — every registered code is referenced in src/ or tools/, or carries a `reason`', () => {
		const orphans = ERROR_CODES.filter(
			(code) => !isCodeReferenced(code, REFERENCE_CORPUS) && specOf(code).reason === undefined,
		);
		expect(
			orphans,
			'ORPHAN CODES: nothing throws them — delete the row, or add a `reason` (a named exemption)',
		).toEqual([]);
	});

	test('C1b — a `reason` is a real sentence', () => {
		for (const code of ERROR_CODES) {
			const reason = specOf(code).reason;
			if (reason === undefined) continue;
			expect(reason.length, code).toBeGreaterThan(20);
		}
	});

	test('C1c — a `reason` exempts only a code nothing throws (else C1 would be blind to its throw sites)', () => {
		const reasoned = ERROR_CODES.filter((code) => specOf(code).reason !== undefined);
		expect(reasoned.length).toBeGreaterThan(0); // non-vacuous: the exemption vocabulary exists
		const stale = reasoned.filter((code) => isCodeReferenced(code, REFERENCE_CORPUS));
		expect(
			stale,
			'STALE EXEMPTION: these codes carry a `reason` but src/ or tools/ references them — move the text into a comment above the row, so C1 depends on the real throw sites',
		).toEqual([]);
	});

	test('C2 — every code the CLIENT speaks resolves to the registry (or is client.*)', () => {
		const policyCodes = codeLiterals(readRepoFile(CLIENT_POLICY_FILE));
		expect(policyCodes.length).toBeGreaterThan(5); // non-vacuous: the policy table has entries
		const unresolved: string[] = [];
		for (const code of policyCodes)
			if (!resolves(code)) unresolved.push(`${CLIENT_POLICY_FILE}: ${code}`);
		const mintingFiles = clientMintingFiles();
		expect(mintingFiles.length).toBeGreaterThan(3); // api_error.js, api_transport.js, data_manager.js at least
		for (const path of mintingFiles) {
			for (const code of mintedCodes(readRepoFile(path))) {
				if (!resolves(code)) unresolved.push(`${path}: ${code}`);
			}
		}
		expect(
			unresolved,
			'a client code string must be a registry code (register it with a `reason` if the browser mints it) or `client.*`',
		).toEqual([]);
	});
});

describe.if(DB_READY)(
	'D. runtime leg — every registered (class, action) pair converts a throw',
	() => {
		const quiet = { error: console.error, warn: console.warn, info: console.info };
		const previousDebug = process.env.DEDALO_DEBUG_API_ERRORS;
		let context: {
			requestId: string;
			clientIp: string;
			session: unknown;
			csrfCandidate: string | null;
		};

		beforeAll(() => {
			process.env.DEDALO_DEBUG_API_ERRORS = 'false';
			console.error = () => {};
			console.warn = () => {};
			console.info = () => {};
			const token = createSession(-1, 'root', true);
			const session = getSession(token);
			context = {
				requestId: 'error-taxonomy-tripwire',
				clientIp: '127.0.0.1',
				session,
				csrfCandidate: session?.csrfToken ?? null,
			};
		});
		afterAll(() => {
			if (previousDebug === undefined) delete process.env.DEDALO_DEBUG_API_ERRORS;
			else process.env.DEDALO_DEBUG_API_ERRORS = previousDebug;
			console.error = quiet.error;
			console.warn = quiet.warn;
			console.info = quiet.info;
		});

		test('a handler throw → schema-valid envelope, ok:false, non-2xx, registry status (all pairs)', async () => {
			const pairs = listRegisteredActions();
			expect(pairs.length).toBeGreaterThan(50); // non-vacuous: the registry is populated
			const failures: string[] = [];
			for (const { apiClass, action } of pairs) {
				const table = actionTableFor(apiClass);
				if (table === undefined) {
					failures.push(`${apiClass}: no table`);
					continue;
				}
				const original = table[action];
				table[action] = async () => {
					throw new DedaloError('resource.conflict', { publicMessage: 'probe' });
				};
				try {
					const result = await dispatchRqo(
						{ action, dd_api: apiClass, options: {} } as Rqo,
						context as never,
					);
					const parsed = apiEnvelopeSchema.safeParse(result.body);
					if (!parsed.success)
						failures.push(`${apiClass}::${action}: body fails apiEnvelopeSchema`);
					if (result.body.ok !== false) failures.push(`${apiClass}::${action}: ok !== false`);
					if (result.status >= 200 && result.status < 300)
						failures.push(`${apiClass}::${action}: 2xx on failure (${result.status})`);
					// a pre-auth gate (install / error-report intake) may refuse FIRST with
					// its own code; either way the status is the registry status of the code
					const code = (result.body as { error?: { code?: ErrorCode } }).error?.code;
					if (code === undefined || !Object.hasOwn(ERROR_REGISTRY, code)) {
						failures.push(`${apiClass}::${action}: unregistered code ${String(code)}`);
					} else if (ERROR_REGISTRY[code].status !== result.status) {
						failures.push(
							`${apiClass}::${action}: status ${result.status} ≠ registry ${ERROR_REGISTRY[code].status} for ${code}`,
						);
					}
				} finally {
					if (original === undefined) delete table[action];
					else table[action] = original;
				}
			}
			expect(failures).toEqual([]);
		});
	},
);

describe('E. anti-vacuity — every matcher fires on a synthetic offender', () => {
	test('A1 builder call', () => {
		expect(countBuilderCalls("return denied(403, 'x');")).toBe(1);
		expect(countBuilderCalls('throw notAuthorized();')).toBe(1);
		expect(countBuilderCalls('return failed(ctx, "no");')).toBe(1);
		// member access and longer identifiers are NOT calls of the builder
		expect(countBuilderCalls('report.failed(1); const isDenied = denied2(1);')).toBe(0);
		expect(countBuilderCalls('`${n} rebuild(s) failed (kept)`')).toBe(0);
	});
	test('A2 result:false', () => {
		expect(countResultFalse('return { result: false, msg: "x" };')).toBe(1);
		expect(countResultFalse('return { result: data };')).toBe(0);
		expect(countResultKeys('return { ...x, result: data };')).toBe(1);
		expect(countResultKeys('const { result } = outcome; return { result };')).toBe(2);
		expect(countResultKeys('return outcome.result;')).toBe(0);
		expect(countResultKeys('const result_options = 1;')).toBe(0);
	});
	test('A3 debug key', () => {
		expect(countDebugKeys('const body = { debug: { stack } };')).toBe(1);
		expect(countDebugKeys('return { code, ...(debug === undefined ? {} : { debug }) };')).toBe(1);
		expect(countDebugKeys('const x = env.debug; obj.debug: 1; const debug = 1;')).toBe(0);
	});
	test('A4 builtin instanceof', () => {
		expect(countBuiltinInstanceof('if (error instanceof TypeError) return null;')).toBe(1);
		expect(countBuiltinInstanceof('if (error instanceof DedaloError) return null;')).toBe(0);
	});
	test('A5 raw on wire key', () => {
		expect(countRawOnWire('return { msg: error.message };')).toBe(1);
		expect(countRawOnWire('errors: [String(error)],')).toBe(1);
		expect(countRawOnWire('publicMessage: (error as Error).message,')).toBe(1);
		expect(countRawOnWire('publicMessage: `upload failed: ${err.message}`,')).toBe(1);
		// the DedaloError LOG-only override is not a wire key
		expect(countRawOnWire('new DedaloError(code, { message: error.message })')).toBe(0);
		// the TOTAL census: an offender planted in a file no list ever named is a regression
		const planted = { 'src/zz/never_listed.ts': 1 };
		expect(driftAgainst(planted, { 'src/zz/other.ts': 1 }).regressions).toEqual([
			'src/zz/never_listed.ts: 1 > 0',
		]);
	});
	test('A6 raw keyed / pushed', () => {
		// the offenders: keyed under any payload key, or pushed into a list
		expect(
			countRawKeyed("detail: `model '${id}' did not answer: ${(error as Error).message}`,"),
		).toBe(1);
		expect(
			countRawKeyed(
				'errors.push(`${row.section_tipo}#${row.section_id}: ${(error as Error).message}`);',
			),
		).toBe(1);
		expect(countRawKeyed('return { ok: false, error: String(error) };')).toBe(1);
		expect(countRawKeyed('payload[name] = { error: err.message };')).toBe(1);
		// there is no "deliberate arm": a DedaloError's `.message` is its LOG field
		// (its wire sentence is `wireMessage()`), so both arms are raw reads
		expect(
			countRawKeyed('detail: error instanceof DedaloError ? error.message : String(error),'),
		).toBe(1);
		expect(countRawKeyed('detail: error instanceof DedaloError ? error.message : GENERIC,')).toBe(
			1,
		);
		expect(
			countRawKeyed('detail: error instanceof DedaloError ? wireMessage(error) : GENERIC,'),
		).toBe(0);
		// the template-coercion spelling is the same raw text
		expect(countRawKeyed('detail: `model did not answer; the log records why: ${error}`,')).toBe(1);
		// the four safe shapes: log line, typed throw, an Error CONSTRUCTOR's log-only fields, a local read
		expect(countRawKeyed('console.warn(`[x] failed: ${error.message}`);')).toBe(0);
		expect(countRawKeyed('throw new Error(`wrapped: ${error.message}`);')).toBe(0);
		expect(countRawKeyed('new DedaloError(code, { message: error.message, cause: error })')).toBe(
			0,
		);
		// …across the constructor's lines, by paren depth, and closed again after it
		expect(
			countRawKeyed(
				[
					"throw new DedaloError('x', {",
					'\tmessage: `bulk_revert: createRevertBulkProcess failed: ${error.message}`,',
					'\tcause: error,',
					'});',
					'const outcome = { ok: false, message: error.message };',
				].join('\n'),
			),
		).toBe(1);
		expect(
			countRawKeyed(
				[
					'class X extends DedaloError { constructor(e: unknown) {',
					"\tsuper('x', {",
					'\t\tmessage: String(e) + String(error),',
					'\t});',
				].join('\n'),
			),
		).toBe(0);
		expect(countRawKeyed('const text = error.message;')).toBe(0);
		// `message:` OUTSIDE an Error constructor is a payload key like any other —
		// the `{ ok:false, message: raw }` RESULT object vision.ts forwarded (SEC-18)
		expect(
			countRawKeyed(
				'return { ok: false, message: `no usable vision model: ${(error as Error).message}` };',
			),
		).toBe(1);
		expect(countRawKeyed('{ code, cause: error, message: String(error) }')).toBe(1);
		expect(
			countRawKeyed('\tmessage: `bulk_revert: createRevertBulkProcess failed: ${error.message}`,'),
		).toBe(1);
		// prose with a colon inside a template is not a key; the anchored key wins
		expect(countRawKeyed('{ a: 1, message: `x: y: ${error.message}` }')).toBe(1);
		expect(countRawKeyed('{ message: 1, detail: `x: ${error.message}` }')).toBe(1);
		// one hit per LINE, even with two raw spellings on it
		expect(
			countRawKeyed(
				'errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);',
			),
		).toBe(1);
		// the derivation of the wire surfaces is a real parse
		expect(wireSurfaceFiles()).toContain('src/core/api/handlers/dd_tools_api.ts');
		expect(wireSurfaceFiles()).toContain('tools/tool_time_machine/server/index.ts');
	});
	test('B1 failure literal window', () => {
		expect(countFailureLiterals('return {\n\tok: false,\n\tmsg: "x",\n};')).toBe(1);
		expect(countFailureLiterals('return { ok: false, error: body };')).toBe(1);
		expect(countFailureLiterals('const health = { ok: false, checkedAt: 0 };')).toBe(0);
		// blanked strings: a message that mentions the shape is not a hit
		expect(
			countFailureLiterals(stripComments("log('answers ok: false, msg')", { blankStrings: true })),
		).toBe(0);
	});
	test('B2 prose errors', () => {
		expect(countProseErrors("errors: ['process file not found'],")).toBe(1);
		expect(countProseErrors("errors: ['Invalid'],")).toBe(1);
		expect(countProseErrors("errors: ['not_found'],")).toBe(0);
		expect(countProseErrors('errors: [reason],')).toBe(0);
	});
	test('C1 reference detection', () => {
		expect(isCodeReferenced('perm.denied', "throw new DedaloError('perm.denied')")).toBe(true);
		expect(isCodeReferenced('external.timeout', 'super(`external.${kind}`)')).toBe(true);
		expect(isCodeReferenced('perm.denied', "throw new DedaloError('perm.out_of_scope')")).toBe(
			false,
		);
	});
	test('C2 client code extraction + resolution', () => {
		expect(codeLiterals("'auth.not_logged': {a:1}, 'perm.*': {}, 'zzz.nope': {}")).toEqual([
			'auth.not_logged',
			'perm.*',
			'zzz.nope',
		]);
		expect(mintedCodes("new ApiError({\n\tcode: 'zzz.minted',\n\tmessage: 'x'\n})")).toEqual([
			'zzz.minted',
		]);
		expect(resolves('zzz.nope')).toBe(false);
		expect(resolves('zzz.*')).toBe(false);
		expect(resolves('client.network')).toBe(true);
		expect(resolves('perm.*')).toBe(true);
	});
	test('drift detection', () => {
		expect(driftAgainst({ 'a.ts': 2 }, { 'a.ts': 1 }).regressions).toEqual(['a.ts: 2 > 1']);
		expect(driftAgainst({ 'b.ts': 1 }, {}).regressions).toEqual(['b.ts: 1 > 0']);
		expect(driftAgainst({}, { 'a.ts': 1 }).stale).toHaveLength(1);
		expect(driftAgainst({ 'a.ts': 1 }, { 'a.ts': 1 })).toEqual({ regressions: [], stale: [] });
	});
});
