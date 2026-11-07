/**
 * ERROR REGISTRY — totality gate (engineering/ERRORS_SPEC.md §1-2).
 *
 * The registry is a data table; this gate proves the table is closed and
 * self-consistent: grammar, labels, placeholders ≡ details_keys, status ↔
 * category, external retryable agreement with the component_external state
 * map, every former MCP HINT mapped, LEGACY_TOKEN_MAP total, label reuse
 * coherent — and that the checker itself fails a synthetic bad spec.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	EXTERNAL_STATE_LABEL_KEY,
	EXTERNAL_STATE_RETRYABLE,
	stateForKind,
} from '../../src/core/components/component_external/value.ts';
import {
	CATEGORY_STATUS,
	defaultLabelKey,
	ERROR_CODE_PATTERN,
	ERROR_CODES,
	ERROR_REGISTRY,
	type ErrorCode,
	type ErrorSpec,
	EXTERNAL_ERROR_KINDS,
	isErrorCode,
	LEGACY_TOKEN_MAP,
	MCP_HINT_CODES,
	REASON_KEY,
	REASON_KEY_CODES,
	REASON_KEY_PATTERN,
	STATUS_EXEMPTIONS,
} from '../../src/core/errors/registry.ts';
import type { ExternalErrorKind } from '../../src/external/errors.ts';

const MASTER: Record<string, string> = JSON.parse(
	readFileSync(resolve(import.meta.dir, '../../src/core/labels/master.json'), 'utf8'),
);

/** Every translated catalog (src/core/labels/catalog/lg-*.json), by file name. */
const CATALOG_DIR = resolve(import.meta.dir, '../../src/core/labels/catalog');
const CATALOGS: [string, Record<string, string>][] = readdirSync(CATALOG_DIR)
	.filter((name) => /^lg-[a-z]+\.json$/.test(name))
	.map((name) => [name, JSON.parse(readFileSync(join(CATALOG_DIR, name), 'utf8'))]);

/**
 * A placeholder the client never fills: `{key}` without the `$`. The renderer
 * (client/dedalo/core/common/js/common.js format_label) replaces `${key}` only, so
 * a bare `{key}` reaches the user verbatim ("The link into '{section_tipo}'…").
 * PLACEHOLDER above matches both spellings, which is how twenty labels shipped
 * that way unseen.
 */
const UNFILLED_PLACEHOLDER = /(?<!\$)\{[a-z0-9_]+\}/;

/** `label_key → offending text` for every error label that spells a bare `{key}`. */
function unfilledPlaceholders(labels: Record<string, string>): string[] {
	return Object.entries(labels)
		.filter(([key, text]) => key.startsWith('error_') && UNFILLED_PLACEHOLDER.test(text))
		.map(([key]) => key);
}

/** The table viewed as a plain string-keyed record (loops over arbitrary strings below). */
const TABLE: Record<string, ErrorSpec> = ERROR_REGISTRY;

const PLACEHOLDER = /\{([a-z0-9_]+)\}/g;
function placeholders(text: string): string[] {
	return [...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string).sort();
}

/**
 * The checker, as a function over an arbitrary (code, spec) pair so the
 * anti-vacuity probe below can feed it a synthetic offender.
 */
function specViolations(code: string, spec: ErrorSpec, master: Record<string, string>): string[] {
	const out: string[] = [];
	if (!ERROR_CODE_PATTERN.test(code)) out.push(`grammar: ${code}`);
	if (!(spec.label_key in master)) out.push(`label missing: ${spec.label_key}`);
	const expected = CATEGORY_STATUS[spec.category];
	if (spec.status !== expected && !STATUS_EXEMPTIONS.includes(code)) {
		out.push(`status ${spec.status} ≠ ${expected} for category ${spec.category}: ${code}`);
	}
	if (spec.message.trim() === '') out.push(`empty message: ${code}`);
	// `reason_key` is the one detail that names no placeholder: it selects a TOOL's
	// label (client error_text), it never fills the core one — so it is exempt from
	// the placeholders ≡ details_keys equality, and a code that carries it must be
	// public (its publicMessage is the fallback sentence; an operator code would
	// never put it on the wire).
	const keys = [...(spec.details_keys ?? [])].filter((key) => key !== REASON_KEY).sort();
	if (spec.details_keys?.includes(REASON_KEY) && spec.disclosure !== 'public') {
		out.push(`reason_key requires disclosure 'public' (the fallback sentence): ${code}`);
	}
	const labelParams = placeholders(master[spec.label_key] ?? '');
	if (JSON.stringify(keys) !== JSON.stringify(labelParams)) {
		out.push(
			`placeholders ${JSON.stringify(labelParams)} ≠ details_keys ${JSON.stringify(keys)}: ${code}`,
		);
	}
	if (spec.label_key !== defaultLabelKey(code) && spec.label_key.startsWith('error_')) {
		out.push(`label_key deviates from convention without reusing a pre-existing key: ${code}`);
	}
	return out;
}

describe('error registry — totality', () => {
	test('anti-vacuity floor: the table is populous', () => {
		expect(ERROR_CODES.length).toBeGreaterThan(80);
	});

	test('every code passes the checker (grammar, label, status↔category, placeholders ≡ details_keys)', () => {
		const violations = ERROR_CODES.flatMap((code) =>
			specViolations(code, TABLE[code] as ErrorSpec, MASTER),
		);
		expect(violations).toEqual([]);
	});

	test('anti-vacuity: a synthetic bad spec fails the checker on every axis', () => {
		const bad: ErrorSpec = {
			category: 'caller',
			status: 500,
			label_key: 'error_nope_missing',
			message: '',
			severity: 'warn',
			disclosure: 'operator',
			retryable: false,
			details_keys: ['x'],
		};
		const violations = specViolations('BadCode', bad, MASTER);
		expect(violations.some((v) => v.startsWith('grammar'))).toBe(true);
		expect(violations.some((v) => v.startsWith('label missing'))).toBe(true);
		expect(violations.some((v) => v.startsWith('status'))).toBe(true);
		expect(violations.some((v) => v.startsWith('empty message'))).toBe(true);
		expect(violations.some((v) => v.startsWith('placeholders'))).toBe(true);
		// A label with a placeholder the spec does not declare is also caught.
		const master = { ...MASTER, error_probe_x: 'Hello {who}' };
		const spec: ErrorSpec = { ...bad, status: 400, message: 'm', label_key: 'error_probe_x' };
		expect(specViolations('probe.x', spec, master).some((v) => v.startsWith('placeholders'))).toBe(
			true,
		);
	});

	test('reason_key: exempt from placeholders ≡ details_keys, but only on a public code — and the checker still bites around it', () => {
		const base: ErrorSpec = {
			category: 'caller',
			status: 400,
			label_key: 'error_probe_reason',
			message: 'm',
			severity: 'warn',
			disclosure: 'public',
			retryable: false,
			details_keys: ['reason_key'],
		};
		const master = { ...MASTER, error_probe_reason: 'Plain sentence' };
		// control: public + a placeholder-free label is clean
		expect(specViolations('probe.reason', base, master)).toEqual([]);
		// an operator code may not carry it
		expect(
			specViolations('probe.reason', { ...base, disclosure: 'operator' }, master).some((v) =>
				v.startsWith('reason_key requires'),
			),
		).toBe(true);
		// the exemption covers ONLY reason_key: another declared key without a placeholder is still red
		expect(
			specViolations(
				'probe.reason',
				{ ...base, details_keys: ['reason_key', 'site'] },
				master,
			).some((v) => v.startsWith('placeholders')),
		).toBe(true);
		// …and a label that fills ${reason_key} is red (it would show the key, not a sentence)
		const filled = { ...master, error_probe_reason: 'Because ${reason_key}' };
		expect(
			specViolations('probe.reason', base, filled).some((v) => v.startsWith('placeholders')),
		).toBe(true);
		// a declared placeholder next to it still has to match
		const withSite = { ...master, error_probe_reason: 'At ${site}' };
		expect(
			specViolations('probe.reason', { ...base, details_keys: ['site', 'reason_key'] }, withSite),
		).toEqual([]);
	});

	test('REASON_KEY_CODES is the pinned opt-in set (adding a code that may carry reason_key is deliberate)', () => {
		expect([...REASON_KEY_CODES].sort()).toEqual([
			'media.too_large',
			'request.invalid_options',
			'resource.not_found',
			'tool.source_unavailable',
			'tool.unsupported_target',
		]);
		// derived from the table, not a second list: every code listing the key is in it and vice versa
		const listing = ERROR_CODES.filter((code) =>
			(TABLE[code] as ErrorSpec).details_keys?.includes(REASON_KEY),
		);
		expect([...listing].sort()).toEqual([...REASON_KEY_CODES].sort());
		for (const code of REASON_KEY_CODES) {
			expect((TABLE[code] as ErrorSpec).disclosure, code).toBe('public');
		}
	});

	test('REASON_KEY_PATTERN is the label-name grammar: lowercase word, ≤48 chars, no punctuation', () => {
		for (const ok of ['bad_bbox', 'a', 'wms_layer_missing_2', `a${'b'.repeat(47)}`]) {
			expect(REASON_KEY_PATTERN.test(ok), ok).toBe(true);
		}
		for (const bad of [
			'',
			'Bad',
			'1x',
			'_x',
			'a-b',
			'a b',
			'a.b',
			'a;b',
			`a${'b'.repeat(48)}`,
			'x\ny',
		]) {
			expect(REASON_KEY_PATTERN.test(bad), JSON.stringify(bad)).toBe(false);
		}
	});

	test('every error label spells its placeholders ${key} — the only form the client fills', () => {
		expect(unfilledPlaceholders(MASTER), 'master.json').toEqual([]);
		for (const [name, labels] of CATALOGS) {
			expect(unfilledPlaceholders(labels), name).toEqual([]);
		}
		// Anti-vacuity: the catalogs were read, and a bare {key} is caught while ${key}
		// and the positional {0} of non-error labels are not.
		expect(CATALOGS.length).toBeGreaterThan(5);
		expect(
			unfilledPlaceholders({
				error_probe_bare: 'Into {section_tipo}',
				error_probe_filled: 'Into ${section_tipo}',
				open_probe_positional: 'Open {0}',
			}),
		).toEqual(['error_probe_bare']);
	});

	test('STATUS_EXEMPTIONS entries are registered codes (and empty today)', () => {
		expect(STATUS_EXEMPTIONS.filter((code) => !isErrorCode(code))).toEqual([]);
		expect(STATUS_EXEMPTIONS).toEqual([]);
	});

	test('the eight categories map to the eight statuses', () => {
		expect(CATEGORY_STATUS).toEqual({
			caller: 400,
			auth: 401,
			permission: 403,
			not_found: 404,
			conflict: 409,
			limit: 429,
			unavailable: 503,
			internal: 500,
		});
	});

	test('label reuse is coherent: a shared label key is a reused pre-existing key, and shared codes agree on category', () => {
		const byLabel = new Map<string, string[]>();
		for (const code of ERROR_CODES) {
			const key = (TABLE[code] as ErrorSpec).label_key;
			byLabel.set(key, [...(byLabel.get(key) ?? []), code]);
		}
		for (const [key, codes] of byLabel) {
			if (codes.length < 2) continue;
			expect(
				key.startsWith('error_'),
				`default-convention key ${key} shared by ${codes.join(',')}`,
			).toBe(false);
			const categories = new Set(codes.map((c) => (TABLE[c] as ErrorSpec).category));
			expect(categories.size, `${key}: ${codes.join(',')} disagree on category`).toBe(1);
		}
	});
});

describe('error registry — vocabulary fold-ins', () => {
	test('external.<kind> is total over ExternalErrorKind and agrees with the value.ts state map', () => {
		const kinds: readonly ExternalErrorKind[] = EXTERNAL_ERROR_KINDS;
		expect(kinds.length).toBe(11);
		for (const kind of kinds) {
			const code = `external.${kind}`;
			expect(isErrorCode(code), code).toBe(true);
			const spec = TABLE[code] as ErrorSpec;
			const state = stateForKind(kind);
			expect(spec.retryable, `${code} retryable`).toBe(EXTERNAL_STATE_RETRYABLE[state]);
			expect(spec.label_key, `${code} label`).toBe(EXTERNAL_STATE_LABEL_KEY[state] as string);
		}
	});

	// The former src/ai/mcp/envelope.ts HINTS keys (the table is deleted; the
	// registry `hint` is the one home). Frozen here so the fold-in cannot lose one.
	const FORMER_MCP_HINT_KEYS = [
		'invalid_tipo',
		'permission_denied',
		'out_of_scope',
		'section_not_writable',
		'label_ambiguous',
		'ambiguous_match',
		'not_found',
		'invalid_request',
		'media_path_disabled',
		'media_too_large',
		'plan_hash_mismatch',
		'egress_restricted',
	];

	test('every former MCP HINTS key is mapped and its code carries a hint', () => {
		for (const key of FORMER_MCP_HINT_KEYS) {
			const code = MCP_HINT_CODES[key];
			expect(code, `HINTS.${key} unmapped`).toBeDefined();
			expect((TABLE[code as string] as ErrorSpec).hint, `${code} hint`).toBeDefined();
			expect(LEGACY_TOKEN_MAP[key], `LEGACY_TOKEN_MAP.${key}`).toBe(code as ErrorCode);
		}
		expect(Object.keys(MCP_HINT_CODES).sort()).toEqual([...FORMER_MCP_HINT_KEYS].sort());
	});

	test('LEGACY_TOKEN_MAP values are all registered codes', () => {
		const bad = Object.entries(LEGACY_TOKEN_MAP).filter(([, code]) => !isErrorCode(code));
		expect(bad).toEqual([]);
		expect(Object.keys(LEGACY_TOKEN_MAP).length).toBeGreaterThan(60);
	});

	test('the identify decline codes and section_id refusals are registered', () => {
		for (const token of [
			'missing_seed',
			'forbidden',
			'invalid_profile',
			'no_profile',
			'rag_disabled',
			'media_disabled',
			'missing_image',
			'image_too_large',
			'invalid_image',
			'egress_forbidden',
			'provider_unavailable',
			'embed_failed',
			'empty_index',
			'invalid_source',
			'missing_section',
			'no_type_section',
			'no_link_component',
		]) {
			expect(LEGACY_TOKEN_MAP[token], token).toBeDefined();
		}
		for (const code of [
			'section_id.not_an_address',
			'section_id.numeric_shaped',
			'section_id.unusable_type',
		]) {
			expect(isErrorCode(code), code).toBe(true);
			expect((TABLE[code] as ErrorSpec).category).toBe('caller');
		}
	});

	test('the parity-table codes exist and carry a reason (never thrown by the engine)', () => {
		for (const code of ['php_fault.not_reproduced', 'envelope.not_an_envelope'] as const) {
			expect(ERROR_REGISTRY[code].reason).toBeDefined();
		}
		expect(ERROR_REGISTRY['record.delete_children_refused'].details_keys).toEqual(['not_deleted']);
	});
});
