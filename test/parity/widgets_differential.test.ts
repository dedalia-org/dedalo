/**
 * Phase 6 gate: maintenance-area widget catalog vs live PHP.
 *
 * PHP area_maintenance_json attaches the full get_ar_widgets catalog as the
 * data item's `datalist`. The TS catalog (src/core/area_maintenance/widgets/registry.ts) must
 * match BYTE-FOR-BYTE — every widget's id, category, css class, resolved
 * label (same generated dictionary), background flag, and the item's
 * envelope fields. Also asserts the non-admin denial (PHP maintenance is an
 * admin area).
 *
 * NOT A TLD-BOUND GATE (checked 2026-08-19): it names only seed-shipped `dd`
 * ontology and creates no record, so it needs no generic-TLD migration and no
 * corpus.
 *
 * ── MEASURED 2026-08-19: STILL RED, on ONE class, and it is a deliberate
 * engine-side change, not a defect ──
 * Every remaining difference in the catalog is the widget `label`, and the
 * whole of it is the LABEL SUBSYSTEM MOVE (WC-033/WC-034: program strings left
 * the per-install dd_ontology label rows for repo-owned catalogs in
 * src/core/labels/). Two sub-classes, measured:
 *   - SIX slots where the frozen side is `<mark>key</mark>` — the engine's
 *     missing-label rendering, i.e. an ABSENCE, not a label. Handled below,
 *     with both sides asserted and the count required to be non-zero.
 *   - NINE slots where the frozen label is the PHP-era ALL-CAPS term
 *     ("DATABASE INFO", "DEDALO COUNTERS STATUS") and the repo catalog now
 *     serves sentence case with correct diacritics ("Database info", "Dédalo
 *     counters status"). LEDGERED 2026-08-23:
 *     WC-2026-08-23-maintenance-widget-label-case — normalized below with both
 *     sides asserted (frozen all-caps, TS sentence-cased, diacritic-fold-equal)
 *     and the matched count pinned non-zero.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { requireSuiteMariadb, SUITE_MARIADB_DATABASES } from '../helpers/suite_mariadb.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

const READ_RQO = {
	action: 'read',
	dd_api: 'dd_core_api',
	prevent_lock: true,
	source: {
		model: 'area_maintenance',
		tipo: 'dd88',
		section_tipo: 'dd88',
		action: 'get_data',
		mode: 'list',
		lang: 'lg-spa',
	},
};

let phpItem: Record<string, unknown> | null = null;
let tsItem: Record<string, unknown> | null = null;
let phpContext: Record<string, unknown>[] = [];
let tsContext: Record<string, unknown>[] = [];

beforeAll(async () => {
	// The area read computes check_config's EAGER value, whose published-language audit
	// opens a pool per diffusion target the ontology declares: acquire the lane's suite
	// MariaDB first (PUB-05) so those pools are proved to land there. Unconditional — a
	// set file that never acquires is red in the MariaDB tier.
	await requireSuiteMariadb(import.meta.path, SUITE_MARIADB_DATABASES());
	if (!hasPhpCredentials()) return;
	const php = new PhpApiClient();
	await php.login(config.phpReference.username as string, config.phpReference.password as string);
	const phpResult = await php.call(READ_RQO as unknown as Record<string, unknown>);
	const phpBody = (
		phpResult.body as {
			result?: { data?: unknown[]; context?: Record<string, unknown>[] };
		}
	).result;
	phpItem = (phpBody?.data?.[0] ?? null) as Record<string, unknown> | null;
	phpContext = phpBody?.context ?? [];

	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	const principal = await resolvePrincipal(-1);
	const tsResult = await dispatchRqo(
		READ_RQO as never,
		{
			requestId: 't',
			clientIp: '127.0.0.1',
			session,
			csrfCandidate: session?.csrfToken ?? null,
			principal,
		} as never,
	);
	const tsBody = (
		tsResult.body as {
			data?: { data?: unknown[]; context?: Record<string, unknown>[] };
		}
	).data;
	tsItem = (tsBody?.data?.[0] ?? null) as Record<string, unknown> | null;
	tsContext = tsBody?.context ?? [];
}, 120_000); // a cold suite MariaDB lane installs and starts a server

describe.if(hasPhpCredentials())('maintenance widget catalog differential', () => {
	test('the widget catalog METADATA matches PHP byte-for-byte (all 30, WC-030 merge normalized)', () => {
		expect(phpItem).not.toBeNull();
		expect(tsItem).not.toBeNull();
		// php_runtime (WC-030) is PHP-ONLY now: it was merged into runtime_info
		// (the former php_info slot) rather than kept as a separate TS twin —
		// normalize it out of the PHP side before the byte-compare, the mirror
		// image of the error_reports (WC-018) TS-only normalization below.
		const phpList = ((phpItem as { datalist?: Record<string, unknown>[] }).datalist ?? []).filter(
			(item) => (item as { id?: unknown }).id !== 'php_runtime',
		);
		// error_reports (WC-018) is TS-ONLY: it has no PHP twin — normalize it
		// out before the byte-compare.
		// site_builder_status (WC-035) is likewise TS-ONLY: the Site Builder subsystem
		// is a native TS addition with no PHP oracle twin (see TS_ONLY_TOOLS for its
		// tool counterpart) — normalize it out the same way. Its own shape is asserted
		// natively by test/unit/site_builder_status_widget.test.ts.
		// ai_models (WC-2026-08-13-maintenance-ai-models-widget) is TS-ONLY too: the
		// local AI model store it reports on has no PHP peer — the engine that owns it
		// did not exist there. Its own shape is asserted natively by
		// test/unit/ai_models_widget_native.test.ts.
		// reconcile_status (WC-2026-09-03-maintenance-reconcile-status-widget) is
		// TS-ONLY as well: the reconcile REGISTRY it lists (src/core/reconcile, audit
		// 2026-08-26 S-10) has no PHP peer. Its own shape is asserted natively by
		// test/unit/reconcile_registry_native.test.ts (the widget door legs).
		// serve_ontology (WC-2026-09-28-maintenance-serve-ontology-widget) is TS-ONLY:
		// the provider-side readout split out of update_ontology. Its own shape is
		// asserted natively by test/unit/serve_ontology_widget.test.ts.
		// serve_code (WC-2026-09-28-maintenance-serve-code-widget) is TS-ONLY: the
		// code-server half split out of update_code, catalogued only on a code
		// server or the development entity. Asserted natively by
		// test/unit/serve_code_widget_native.test.ts.
		// publication_hosts (WC-2026-10-03-publication-hosts-widget) is TS-ONLY: the
		// publication-host registry and agent channel have no PHP peer. Asserted
		// natively by test/unit/publication_host_widget_native.test.ts.
		const TS_ONLY_WIDGET_IDS = new Set([
			'error_reports',
			'site_builder_status',
			'ai_models',
			'reconcile_status',
			'serve_ontology',
			'serve_code',
			'publication_hosts',
		]);
		const tsList = ((tsItem as { datalist?: Record<string, unknown>[] }).datalist ?? []).filter(
			(item) => !TS_ONLY_WIDGET_IDS.has((item as { id?: string }).id ?? ''),
		);
		expect(tsList.length).toBe(phpList.length);
		/** Slots where the FROZEN side carries the missing-label marker (see below). */
		let untranslatedLabels = 0;
		/** Slots where the frozen label is the ALL-CAPS PHP-era term (see below). */
		let caseChangedLabels = 0;
		/** Diacritic-fold + lowercase, so `DEDALO` (accent lost at the freeze) still twins `Dédalo`. */
		const fold = (value: string): string =>
			value
				.normalize('NFD')
				.replace(/[\u0300-\u036f]/g, '')
				.toLowerCase();
		for (let index = 0; index < phpList.length; index++) {
			// `value` is EXCLUDED: 11 widgets embed a per-widget payload computed
			// by their own PHP widget class (migration form catalogs, sequence
			// status, PHP-engine facts) — each is its own execution endpoint,
			// ledgered with widget_request. The TS catalog ships them null.
			// `label` is ALSO excluded for diffusion_server_control: that widget was
			// re-homed onto the native diffusion engine (job queue + scheduler), so
			// its TS label ('Diffusion engine & queue') INTENTIONALLY diverges from
			// the PHP daemon-era term. The id (and every other metadata field) still
			// matches, so the catalog stays aligned everywhere it should.
			const isDiffusionControl =
				(tsList[index] as { id?: unknown }).id === 'diffusion_server_control';
			// `id`, `label` AND `class` are ALSO excluded at PHP's php_info slot (WC-030):
			// the TS engine merged php_info AND php_runtime into ONE native runtime_info
			// widget at this position — id/label deliberately diverge from the frozen PHP
			// oracle term, and the widget keeps php_runtime's plain layout (no `class`)
			// rather than php_info's 'violet fit width_100' iframe styling. Every other
			// metadata field still matches.
			const isRuntimeInfo = (phpList[index] as { id?: unknown }).id === 'php_info';
			// THE UNTRANSLATED-LABEL SLOT (WC-033/WC-034, repo-owned label
			// catalogs). `<mark>key</mark>` is the engine's MISSING-LABEL rendering:
			// at the 2026-07-11 freeze the install's label store had no lg-spa entry
			// for these widget keys, and the TS catalog — which is repo-owned and
			// shipped, not per-install — has since gained one. The frozen side is
			// therefore not stating a label at all, it is stating an absence, and
			// comparing it would pin the engine to a translation gap. Both sides are
			// asserted below (marker on the frozen side, a REAL non-marker string on
			// the TS side) and the count is required to be non-zero, so the
			// exclusion can never quietly widen.
			const phpLabel = (phpList[index] as { label?: unknown }).label;
			const isUntranslatedLabel =
				typeof phpLabel === 'string' && /^<mark>[^<]*<\/mark>$/.test(phpLabel);
			if (isUntranslatedLabel) {
				const tsLabel = (tsList[index] as { label?: unknown }).label;
				expect(typeof tsLabel).toBe('string');
				expect(tsLabel).not.toMatch(/^<mark>/);
				expect(String(tsLabel).length).toBeGreaterThan(0);
				untranslatedLabels++;
			}
			// THE CASE-CHANGED SLOT (WC-2026-08-23-maintenance-widget-label-case):
			// the frozen label is the PHP-era ALL-CAPS install term and the repo
			// catalog now serves sentence case with restored diacritics. The
			// exclusion applies ONLY where the frozen side is all-caps AND the two
			// labels are diacritic-fold-equal (same words, case/accents apart), the
			// TS side is asserted to actually BE sentence-cased (not all-caps), and
			// the matched count is required non-zero below.
			const tsLabelRaw = (tsList[index] as { label?: unknown }).label;
			const isCaseChangedLabel =
				!isDiffusionControl &&
				!isRuntimeInfo &&
				!isUntranslatedLabel &&
				typeof phpLabel === 'string' &&
				typeof tsLabelRaw === 'string' &&
				phpLabel !== tsLabelRaw &&
				phpLabel === phpLabel.toUpperCase() &&
				fold(phpLabel) === fold(tsLabelRaw);
			if (isCaseChangedLabel) {
				expect(tsLabelRaw).not.toBe(String(tsLabelRaw).toUpperCase());
				caseChangedLabels++;
			}
			const omit = isDiffusionControl
				? ['value', 'label']
				: isRuntimeInfo
					? ['value', 'id', 'label', 'class']
					: isUntranslatedLabel || isCaseChangedLabel
						? ['value', 'label']
						: ['value'];
			const strip = (item: Record<string, unknown>): Record<string, unknown> =>
				Object.fromEntries(Object.entries(item).filter(([key]) => !omit.includes(key)));
			const phpMeta = strip(phpList[index] as Record<string, unknown>);
			const tsMeta = strip(tsList[index] as Record<string, unknown>);
			expect(JSON.stringify(tsMeta)).toBe(JSON.stringify(phpMeta));
		}
		// Exercised-or-refused: a declaration that matches nothing is a stale
		// exemption, and would mean this gate stopped comparing labels for free.
		expect(untranslatedLabels).toBeGreaterThan(0);
		expect(caseChangedLabels).toBeGreaterThan(0);
	});

	test('the read returns a non-empty context matching PHP (client render contract)', () => {
		// The client (area_maintenance.js) renders the dashboard BLANK when
		// result.context is empty — the TS read used to return []. Pin the
		// non-empty context + its client-load-bearing fields against PHP.
		expect(tsContext.length).toBe(1);
		const php = phpContext[0] ?? {};
		const ts = tsContext[0] ?? {};
		for (const key of ['tipo', 'model', 'type', 'typo', 'section_tipo', 'label', 'permissions']) {
			expect({ key, value: ts[key] }).toEqual({ key, value: php[key] });
		}
		// request_config MUST be a non-empty array: area_maintenance.js calls
		// context.request_config.find(el => el.type==='main') unguarded, so a
		// missing key throws (undefined.find) and the dashboard renders blank.
		// Byte-equal to PHP (the 'main' skeleton with the area's own sqo ddo).
		expect(Array.isArray(ts.request_config)).toBe(true);
		expect(ts.request_config).toEqual(php.request_config);
	});

	test('the data item envelope matches PHP', () => {
		const strip = (item: Record<string, unknown>): Record<string, unknown> => {
			const { datalist: _datalist, ...rest } = item;
			return rest;
		};
		expect(strip(tsItem as Record<string, unknown>)).toEqual(
			strip(phpItem as Record<string, unknown>),
		);
	});

	test('non-admins are denied (maintenance is an admin area)', async () => {
		const token = createSession(999999, 'nobody', false);
		const session = getSession(token);
		const principal = await resolvePrincipal(999999);
		const result = await dispatchRqo(
			READ_RQO as never,
			{
				requestId: 't',
				clientIp: '127.0.0.1',
				session,
				csrfCandidate: session?.csrfToken ?? null,
				principal,
			} as never,
		);
		expect(result.status).toBe(403);
	});
});
