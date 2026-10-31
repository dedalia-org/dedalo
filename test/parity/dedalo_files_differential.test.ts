/**
 * S1-19 gate: authenticated get_dedalo_files differential vs the live PHP
 * oracle. This is the service-worker pre-cache manifest whose absence stalled
 * every production-posture login (the SW got HTTP 400 and never posted
 * 'finish').
 *
 * Compared byte-for-byte: the {type,url} entry shape (including the PHP
 * quirk that tools-branch css entries are typed 'js'), main.css pinned first,
 * and the FULL file SET. Normalizations (each justified, nothing else):
 *  - ORDER: PHP emits RecursiveDirectoryIterator (filesystem-dependent) order;
 *    TS emits sorted order. The SW only maps el.url into a Set, so order is
 *    not contractual beyond files[0] = main.css — compared as sets.
 *  - TOOL_COMMON URL: PHP serves the tool_common client machinery from
 *    tools/tool_common (/dedalo/tools/tool_common/…); the TS server relocated
 *    the TS client keeps it at client/dedalo/core/tools_common, served at
 *    /dedalo/core/tools_common/… (WC-006). Same files, TS-resolvable URL — PHP
 *    urls are mapped to the TS base before comparing.
 *  - DEDALO_VERSION: a deploy stamp (PHP constant vs the TS install literal) —
 *    asserted non-empty string on both sides, not byte-equal.
 */

import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { config } from '../../src/config/config.ts';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { resolveToolAssetPath } from '../../src/core/tools/paths.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

registerSessionCleanup();

interface ManifestEntry {
	type: string;
	url: string;
}
/** The FROZEN PHP-era body: `result` + the `msg` prose (untouched, fixture-side). */
interface PhpManifestBody {
	result: ManifestEntry[];
	dedalo_version: string;
	msg: string;
}
/** Envelope v2 (ERRORS_SPEC §3): the manifest rides in `data`, the SW cache key
 * `dedalo_version` as a handler extension key. No `result`/`msg` mirror
 * (WC-2026-08-16-error-envelope-compat-removal). */
interface TsManifestBody {
	ok: boolean;
	data: ManifestEntry[];
	dedalo_version: string;
}

const RQO = { action: 'get_dedalo_files', dd_api: 'dd_utils_api' };

/** Root of the copied client tree the TS server serves at /dedalo/. */
const CLIENT_ROOT = resolve(import.meta.dir, '../../client/dedalo');

/** Normalize one entry to a comparable line, mapping the tool_common seam —
 * a LEDGERED wire divergence (engineering/wire_contract/ WC-006). */
function comparableLine(entry: ManifestEntry): string {
	const url = entry.url.replace('/dedalo/tools/tool_common/', '/dedalo/core/tools_common/');
	return `${entry.type} ${url}`;
}

/** tool_assistant is TS-NATIVE since the server-driven rewrite — its file
 * census deliberately diverges from the PHP tree's copy (11 js → 9 js; the
 * in-browser engine died). LEDGERED: engineering/wire_contract/ WC-013. Filtered
 * from BOTH sides of the set compare; the every-TS-url-resolves test below
 * still validates the new files serve. */
function isToolAssistantEntry(entry: ManifestEntry): boolean {
	return entry.url.startsWith('/dedalo/tools/tool_assistant/');
}

/** TS-ONLY packages with no PHP twin (the WC-013 normalization pattern):
 *  - tool_error_report (WC-019) — TS-only tool in the TS-owned tools/ tree;
 *  - error_reports maintenance widget (WC-018) — TS-owned client files,
 *    excluded from sync_client.sh like diffusion_server_control;
 *  - tool_sitebuilder + site_builder_status widget (WC-035) — the site-builder
 *    subsystem, a TS-native addition (proxy tool + ops widget for the
 *    standalone publication/site_builder daemon);
 *  - tool_identify (WC-062) — the object-identification curator panel
 *    (engineering/IDENTIFY_SPEC.md), TS-native with no PHP twin.
 *  - ai_models maintenance widget
 *    (WC-2026-08-13-maintenance-ai-models-widget) — the display-only panel over
 *    the native local AI model store (src/core/ai/), which has no PHP peer.
 *  - serve_ontology maintenance widget
 *    (WC-2026-09-28-maintenance-serve-ontology-widget) — the provider-side
 *    readout split out of update_ontology.
 *  - serve_code maintenance widget
 *    (WC-2026-09-28-maintenance-serve-code-widget) — the code-server half
 *    split out of update_code.
 *  - publication_hosts maintenance widget
 *    (WC-2026-10-03-publication-hosts-widget) — the panel over the native
 *    publication-host registry and agent channel, which have no PHP peer.
 * Their files exist only in the TS census; filtered from BOTH sides. */
function isTsOnlyEntry(entry: ManifestEntry): boolean {
	return (
		entry.url.startsWith('/dedalo/tools/tool_error_report/') ||
		entry.url.startsWith('/dedalo/core/area_maintenance/widgets/error_reports/') ||
		entry.url.startsWith('/dedalo/tools/tool_sitebuilder/') ||
		entry.url.startsWith('/dedalo/core/area_maintenance/widgets/site_builder_status/') ||
		entry.url.startsWith('/dedalo/tools/tool_identify/') ||
		entry.url.startsWith('/dedalo/core/area_maintenance/widgets/ai_models/') ||
		// WC-2026-09-03-maintenance-reconcile-status-widget (audit S-10, TS-only registry)
		entry.url.startsWith('/dedalo/core/area_maintenance/widgets/reconcile_status/') ||
		entry.url.startsWith('/dedalo/core/area_maintenance/widgets/serve_ontology/') ||
		entry.url.startsWith('/dedalo/core/area_maintenance/widgets/serve_code/') ||
		// WC-2026-10-03-publication-hosts-widget (TS-only publication-host panel)
		entry.url.startsWith('/dedalo/core/area_maintenance/widgets/publication_hosts/') ||
		// WC-2026-10-07-acquisition-tools-ts-only (TS-native acquisition tools, no PHP twin)
		entry.url.startsWith('/dedalo/tools/tool_numisdata_acquisition/') ||
		entry.url.startsWith('/dedalo/tools/tool_bibliography_acquisition/')
	);
}

/** php_info and php_runtime were merged into ONE TS-native runtime_info widget
 * (WC-030): php_info (a phpinfo() iframe with no Bun equivalent) is gone, and
 * php_runtime's real Bun-runtime panel took over the runtime_info slot under
 * new file names. The frozen PHP oracle still serves BOTH old php_info/ and
 * php_runtime/ files (as two separate widgets); the TS census now serves only
 * runtime_info/. Filtered from BOTH sides of the set compare, like the WC-013
 * pattern. */
function isRuntimeInfoRenameEntry(entry: ManifestEntry): boolean {
	return (
		entry.url.startsWith('/dedalo/core/area_maintenance/widgets/php_info/') ||
		entry.url.startsWith('/dedalo/core/area_maintenance/widgets/php_runtime/') ||
		entry.url.startsWith('/dedalo/core/area_maintenance/widgets/runtime_info/')
	);
}

/** The generated JS lang files are GONE from the TS client tree (WC-035):
 * UI labels are repo catalogs under src/core/labels/catalog/, served only
 * through get_environment's `get_label` — the client never fetched these
 * files directly, so the SW pre-caching them was dead weight. The frozen PHP
 * oracle still lists its generated core/common/js/lang/*.js; filtered from
 * BOTH sides of the set compare, like the WC-013 pattern. */
function isLangFileEntry(entry: ManifestEntry): boolean {
	return entry.url.startsWith('/dedalo/core/common/js/lang/');
}

/** TS-native core client files with no PHP twin (WC-063): the idle-session
 * countdown (session_expiry.js, behaviour ledgered under WC-051) and the two
 * search client panels. Filtered from BOTH
 * sides; the every-TS-url-resolves gate still proves they serve. */
function isTsNativeCoreFileEntry(entry: ManifestEntry): boolean {
	return (
		entry.url === '/dedalo/core/common/js/session_expiry.js' ||
		entry.url === '/dedalo/core/search/js/preset_scope.js' ||
		entry.url === '/dedalo/core/search/js/render_semantic.js'
	);
}

/** The php_user maintenance widget administered the PHP engine's system user —
 * meaningless since the cutover (WC-064). The frozen oracle still censuses its
 * files; the TS tree no longer has them. Same pattern as WC-030. */
function isPhpUserRemovalEntry(entry: ManifestEntry): boolean {
	return entry.url.startsWith('/dedalo/core/area_maintenance/widgets/php_user/');
}

/** The modules the service_dropzone fold ADDED to service_upload
 * (WC-2026-08-03-service-dropzone-folded-into-service-upload): the abandoned
 * dropzone@5.9.3 dependency is being deleted and its multi-file upload-queue UI
 * rebuilt in-house, split into a DOM-free wire core, a DOM-free queue model, the
 * directory-drop traversal and the queue renderer. TS-only: the frozen oracle's
 * service_upload package (captured 2026-07-11) predates all four.
 *
 * EXACT URLs, not a `startsWith` prefix — deliberately unlike the removal
 * predicates. A prefix over service_upload/ would stop comparing the whole
 * package, including the two files that DO have a PHP twin
 * (service_upload.js, render_edit_service_upload.js). Every future addition
 * here must be listed by name, which is the point: each one costs a line of
 * reviewable paperwork rather than silently widening the hole. */
function isServiceUploadFoldAdditionEntry(entry: ManifestEntry): boolean {
	return (
		entry.url === '/dedalo/core/services/service_upload/js/upload_transport.js' ||
		entry.url === '/dedalo/core/services/service_upload/js/upload_queue.js' ||
		entry.url === '/dedalo/core/services/service_upload/js/dropped_files.js' ||
		entry.url === '/dedalo/core/services/service_upload/js/render_edit_service_upload_queue.js'
	);
}

/** The two modules the transcription STATUS PANEL added
 * (WC-2026-08-13-transcription-status-panel): the DOM-free failure classifier
 * (`transcription_report.js`) and the panel renderer that every user-facing
 * failure now flows through instead of an `alert()`
 * (`render_transcription_status.js`). TS-only: the frozen oracle's
 * `tool_transcription` package (captured 2026-07-11) predates both.
 *
 * EXACT URLs, not a `startsWith` prefix, for the same reason as the
 * service_upload fold above: `tool_transcription/` HAS a PHP twin, and a prefix
 * over it would stop comparing the whole tool. Every future TS-only addition to
 * a twinned package must be listed by name — one line of reviewable paperwork
 * each, rather than silently widening the hole. */
function isTranscriptionStatusAdditionEntry(entry: ManifestEntry): boolean {
	return (
		entry.url === '/dedalo/tools/tool_transcription/js/transcription_report.js' ||
		entry.url === '/dedalo/tools/tool_transcription/js/render_transcription_status.js'
	);
}

/** `service_dropzone` is DELETED
 * (WC-2026-08-03-service-dropzone-folded-into-service-upload, deletion half):
 * the package's two modules — `js/service_dropzone.js` and
 * `js/render_edit_service_dropzone.js` — plus its css/img are gone from the TS
 * tree, their multi-file UI having been rebuilt inside `service_upload`. The
 * frozen oracle (2026-07-11) still censuses them.
 *
 * A `startsWith` PREFIX, unlike the additive predicate above, and the asymmetry
 * is deliberate: this is a REMOVAL of a whole package, so there is nothing left
 * on the TS side for a prefix to stop comparing — the package is empty by
 * construction, which the positive assertion below proves. The additive
 * predicate must stay exact for the opposite reason: `service_upload/` still
 * holds files with a PHP twin that MUST keep being compared. */
function isDropzoneServiceRemovalEntry(entry: ManifestEntry): boolean {
	return entry.url.startsWith('/dedalo/core/services/service_dropzone/');
}

/** TS client files ADDED after the 2026-07-11 harvest froze the oracle census
 * (WC-2026-08-23-dedalo-files-post-harvest-census — the census consequence of
 * each cited entry, none of which touched this gate when it landed). EXACT
 * URLs by the service_upload-fold rule: every future addition costs a line of
 * reviewable paperwork. The recovery assertion below proves each one ACTUALLY
 * serves. */
const POST_HARVEST_CLIENT_ADDITIONS: readonly string[] = [
	// diffusion_server_control live panel (WC-069, commit c7111777fa)
	'/dedalo/core/area_maintenance/widgets/diffusion_server_control/js/live_diffusion_server_control.js',
	'/dedalo/core/area_maintenance/widgets/diffusion_server_control/js/progress_model.js',
	'/dedalo/core/area_maintenance/widgets/diffusion_server_control/js/rollup_panel.js',
	// its measured time-remaining estimate — census-adopted post-harvest addition
	'/dedalo/core/area_maintenance/widgets/diffusion_server_control/js/time_remaining_model.js',
	// thesaurus picker (WC-2026-08-14-thesaurus-picker-caller-declared)
	'/dedalo/core/area_thesaurus/js/thesaurus_picker.js',
	// errors v2 client contract (WC-2026-08-16-error-envelope-compat-removal,
	// WC-2026-08-15-error-status-is-a-channel; error_dispatch is the same
	// family's dispatcher — engineering/ERRORS_SPEC.md client contract)
	'/dedalo/core/common/js/api_error.js',
	'/dedalo/core/common/js/api_transport.js',
	// error_dispatch also DECLARES the page-wide error signal the error-report
	// launcher tab listens to (it had its own module until 2026-09-23, which
	// cost a cold-boot request for one CustomEvent)
	'/dedalo/core/common/js/error_dispatch.js',
	'/dedalo/core/common/js/error_policy.js',
	'/dedalo/core/common/js/render_api_error.js',
	// media-job visibility surface (WC-2026-08-12-media-job-visibility)
	'/dedalo/core/common/js/floating_dock.js',
	'/dedalo/core/common/js/job_follow.js',
	'/dedalo/core/page/js/job_tray.js',
	// external record services client render (WC-2026-08-06-external-client-render)
	'/dedalo/core/component_external/js/external_render.js',
	// the ONE render-boundary escaper (WC-2026-09-04-context-render-class)
	'/dedalo/core/common/js/utils/render_escape.js',
	// the client limit bound + the row window (WC-2026-09-04-client-limit-bound,
	// audit P2-31 / CLI-29 / CLI-30)
	'/dedalo/core/common/js/sqo_limit.js',
	'/dedalo/core/common/js/row_window.js',
	// the section/portal row box (WC-2026-10-30-section-record-row-box): the pure
	// record window that replaces row_window for sections and portals
	'/dedalo/core/section_record/js/record_window.js',
	// inverse search render — census-adopted post-harvest addition
	'/dedalo/core/component_inverse/js/render_search_component_inverse.js',
	// TM list view replacing the service_time_machine package
	// (WC-2026-08-14-tm-scope-server-owned and WC-2026-08-14-tm-ddo-mode-retired)
	'/dedalo/core/section/js/view_tm_list_section.js',
	// diffusion job result record panel (WC-2026-08-15-diffusion-job-result-record)
	'/dedalo/tools/tool_diffusion/js/report_model.js',
	// ontologies filter — census-adopted post-harvest addition
	'/dedalo/tools/tool_ontology_parser/js/ontologies_filter.js',
	// the maintenance area's cross-widget event leaf (OPEN_WIDGET_EVENT: media_control's
	// line opening publication_hosts; WC-2026-10-03-publication-hosts-widget)
	'/dedalo/core/area_maintenance/js/maintenance_events.js',
	// the add_hierarchy widget's thesaurus import block, extracted from the removed
	// browser installer (WC-2026-10-12-install-surface-removed)
	'/dedalo/core/area_maintenance/widgets/add_hierarchy/js/render_hierarchies_import.js',
];
function isPostHarvestClientAdditionEntry(entry: ManifestEntry): boolean {
	return POST_HARVEST_CLIENT_ADDITIONS.includes(entry.url);
}

/** The service_time_machine PACKAGE and worker_data.js are REMOVED from the
 * TS tree (WC-2026-08-23-dedalo-files-post-harvest-census, removal half): the
 * TM list moved into the section family (view_tm_list_section.js above,
 * WC-2026-08-14-tm-scope-server-owned entry) and worker_data's polling was superseded by the
 * media-job surface (WC-2026-08-12-media-job-visibility). The frozen oracle
 * (2026-07-11) still censuses all seven files. A PREFIX for the package (a
 * removal leaves nothing for the prefix to stop comparing — the TS-side-empty
 * mirror below proves it) plus the one exact worker_data.js URL. */
function isTimeMachineServiceRemovalEntry(entry: ManifestEntry): boolean {
	return (
		entry.url.startsWith('/dedalo/core/services/service_time_machine/') ||
		entry.url === '/dedalo/core/common/js/worker_data.js'
	);
}

/** Committed third-party bundles REMOVED from the client tree
 * (WC-2026-09-04-committed-third-party-bundles-leave-the-client-tree, audit
 * P2-5-residue / CLI-12): `utils/lzstring.js` (lz-string 1.4.5, now the
 * digest-pinned `vendor/lz-string` row served as `/dedalo/lib/lz-string/`),
 * `ui-search.js` (an unreferenced findAndReplaceDOMText 0.4.6 UMD — dead) and
 * `tool_lang/js/tool_lang-min.js` (an unreferenced stale minified copy of
 * tool_lang.js). The frozen oracle (2026-07-11) still censuses all three.
 * EXACT URLs, by the service_upload-fold rule. */
const THIRD_PARTY_BUNDLE_REMOVALS: readonly string[] = [
	'/dedalo/core/common/js/utils/lzstring.js',
	'/dedalo/core/common/js/ui-search.js',
	'/dedalo/tools/tool_lang/js/tool_lang-min.js',
];
function isThirdPartyBundleRemovalEntry(entry: ManifestEntry): boolean {
	return THIRD_PARTY_BUNDLE_REMOVALS.includes(entry.url);
}

/** The browser installer's client is REMOVED (WC-2026-10-12-install-surface-removed:
 * one installer, in the terminal). The frozen oracle (2026-07-11) still censuses its two
 * JS files. A PREFIX: a removal leaves nothing on the TS side for a prefix to stop
 * comparing — the TS-side-empty mirror below proves it. */
function isInstallerRemovalEntry(entry: ManifestEntry): boolean {
	return entry.url.startsWith('/dedalo/core/installer/');
}

describe.if(hasPhpCredentials())('get_dedalo_files differential (S1-19 gate)', () => {
	let phpBody: PhpManifestBody;
	let tsBody: TsManifestBody;
	let tsStatus = 0;

	beforeAll(async () => {
		const client = new PhpApiClient();
		await client.login(
			config.phpReference.username as string,
			config.phpReference.password as string,
		);
		const { body } = await client.call(RQO);
		phpBody = body as unknown as PhpManifestBody;

		const token = createSession(-1, 'root', true);
		const session = getSession(token);
		const principal = await resolvePrincipal(-1);
		const tsResult = await dispatchRqo(RQO as unknown as Rqo, {
			requestId: 't',
			clientIp: '127.0.0.1',
			session,
			csrfCandidate: session?.csrfToken ?? null,
			principal,
		});
		tsStatus = tsResult.status;
		tsBody = tsResult.body as unknown as TsManifestBody;
	});

	test('anonymous call is refused (authenticated action, like PHP)', async () => {
		const result = await dispatchRqo(RQO as unknown as Rqo, {
			requestId: 't-anon',
			clientIp: '127.0.0.1',
			session: null,
			csrfCandidate: null,
		});
		expect(result.status).toBe(401);
		expect(result.body.ok).toBe(false);
		expect(result.body.ok === false ? result.body.error.code : null).toBe('auth.not_logged');
	});

	test('envelope: success signalled, dedalo_version present on both', () => {
		// v2 restatement of the old `msg` byte-equality: PHP carried its success
		// prose in `msg`; envelope v2 signals success with `ok:true` + 200 and
		// carries no prose (WC-2026-08-16-error-envelope-compat-removal). The
		// frozen PHP prose is still pinned so a fixture drift reddens.
		expect(tsStatus).toBe(200);
		expect(tsBody.ok).toBe(true);
		expect(phpBody.msg).toBe('OK. Request done successfully');
		// Deploy stamp — presence/type only (see header note).
		expect(typeof tsBody.dedalo_version).toBe('string');
		expect(tsBody.dedalo_version.length).toBeGreaterThan(0);
		expect(typeof phpBody.dedalo_version).toBe('string');
		expect(phpBody.dedalo_version.length).toBeGreaterThan(0);
	});

	test('main.css is pinned first on both sides (the one contractual order)', () => {
		expect(tsBody.data[0]).toEqual({ type: 'css', url: '/dedalo/core/page/css/main.css' });
		expect(phpBody.result[0]).toEqual({ type: 'css', url: '/dedalo/core/page/css/main.css' });
	});

	test('entry shape: exactly {type,url}, type js|css, root-relative url', () => {
		expect(tsBody.data.length).toBeGreaterThan(100);
		for (const entry of tsBody.data) {
			expect(Object.keys(entry).sort()).toEqual(['type', 'url']);
			expect(['js', 'css']).toContain(entry.type);
			expect(entry.url.startsWith('/dedalo/')).toBe(true);
		}
	});

	test('file set matches the oracle exactly (order + tool_common + WC-013 normalized)', () => {
		const keep = (entry: ManifestEntry) =>
			!isToolAssistantEntry(entry) &&
			!isTsOnlyEntry(entry) &&
			!isRuntimeInfoRenameEntry(entry) &&
			!isLangFileEntry(entry) &&
			!isTsNativeCoreFileEntry(entry) &&
			!isPhpUserRemovalEntry(entry) &&
			!isServiceUploadFoldAdditionEntry(entry) &&
			!isTranscriptionStatusAdditionEntry(entry) &&
			!isDropzoneServiceRemovalEntry(entry) &&
			!isPostHarvestClientAdditionEntry(entry) &&
			!isTimeMachineServiceRemovalEntry(entry) &&
			!isThirdPartyBundleRemovalEntry(entry) &&
			!isInstallerRemovalEntry(entry);
		const phpSet = phpBody.result.filter(keep).map(comparableLine).sort();
		const tsSet = tsBody.data.filter(keep).map(comparableLine).sort();
		expect(tsSet).toEqual(phpSet);

		// Two-sided filtering is what keeps the frozen store honest (it records what
		// PHP really served on 2026-07-11 and can never be re-harvested), but it
		// costs the assertion that the TS side is what we think it is. Recover that
		// explicitly: the four fold modules must ACTUALLY be present, not merely
		// normalized away. Without this, deleting one of them — or never shipping
		// it — would slip through as silently as adding it.
		expect(tsBody.data.filter(isServiceUploadFoldAdditionEntry).length).toBe(4);
		expect(phpBody.result.filter(isServiceUploadFoldAdditionEntry)).toEqual([]);

		// Same recovery for the transcription status panel: both modules must
		// ACTUALLY serve, not merely be normalized away.
		expect(tsBody.data.filter(isTranscriptionStatusAdditionEntry).length).toBe(2);
		expect(phpBody.result.filter(isTranscriptionStatusAdditionEntry)).toEqual([]);

		// Mirror image for the removal half: the TS census must contain NO
		// service_dropzone file at all. Without this, a prefix filter would
		// happily normalize away a resurrected (or never-deleted) package.
		expect(tsBody.data.filter(isDropzoneServiceRemovalEntry)).toEqual([]);
		expect(phpBody.result.filter(isDropzoneServiceRemovalEntry).length).toBeGreaterThan(0);

		// Recovery for the post-harvest client additions: every listed URL must
		// ACTUALLY serve on the TS side (a listed file that stopped shipping
		// would otherwise vanish from coverage), and none may appear in the
		// frozen oracle (if one does, it predates the harvest and belongs in
		// the ordinary compare, not this filter).
		const servedAdditions = new Set(
			tsBody.data.filter(isPostHarvestClientAdditionEntry).map((entry) => entry.url),
		);
		for (const url of POST_HARVEST_CLIENT_ADDITIONS) {
			expect(servedAdditions.has(url), `post-harvest addition not served by TS: ${url}`).toBe(true);
		}
		expect(phpBody.result.filter(isPostHarvestClientAdditionEntry)).toEqual([]);

		// Mirror for the time-machine/worker_data removal: nothing left on the
		// TS side, all seven files still in the frozen oracle census.
		expect(tsBody.data.filter(isTimeMachineServiceRemovalEntry)).toEqual([]);
		expect(phpBody.result.filter(isTimeMachineServiceRemovalEntry).length).toBe(7);

		// Mirror for the committed-bundle removals: none of the three serves on the
		// TS side any more, all three are still in the frozen oracle census.
		expect(tsBody.data.filter(isThirdPartyBundleRemovalEntry)).toEqual([]);
		expect(phpBody.result.filter(isThirdPartyBundleRemovalEntry).length).toBe(
			THIRD_PARTY_BUNDLE_REMOVALS.length,
		);

		// Mirror for the browser installer's removal: nothing under core/installer/
		// serves on the TS side, both of its JS files are still in the frozen census.
		expect(tsBody.data.filter(isInstallerRemovalEntry)).toEqual([]);
		expect(phpBody.result.filter(isInstallerRemovalEntry).length).toBe(2);
	});

	test('WC-013: the TS tool_assistant census is the server-driven file set', () => {
		const tsAssistant = tsBody.data
			.filter(isToolAssistantEntry)
			.map((entry) => entry.url.split('/').pop())
			.sort();
		expect(tsAssistant).toEqual([
			'agent_stream.js',
			// compat alias the frozen client's edit-menu panel imports by name
			'ai_assistant.js',
			'assistant_controller.js',
			'chat_render.js',
			'client_context.js',
			'conversation_store.js',
			'index.js',
			'markdown.js',
			'render_tool_assistant.js',
			'tool_assistant.css',
			'tool_assistant.js',
			// the UI-label bridge added with the WC-033 label catalogs
			'tool_labels.js',
		]);
	});

	test('every TS url resolves through the static surfaces the server serves', () => {
		for (const entry of tsBody.data) {
			let servedPath: string | null = null;
			// tools_common needs no arm of its own since WC-006's 2026-08-16
			// amendment: it is client source under client/dedalo/core/, so the
			// generic client branch below resolves it like any other asset.
			if (entry.url.startsWith('/dedalo/tools/')) {
				const rest = entry.url.slice('/dedalo/tools/'.length);
				const [name = '', ...restPath] = rest.split('/');
				servedPath = resolveToolAssetPath(name, restPath.join('/'));
			} else {
				// Generic copied-client asset (server.ts serveClientAsset mapping),
				// confined the same way: strip /dedalo, resolve under CLIENT_ROOT.
				const candidate = resolve(CLIENT_ROOT, entry.url.slice('/dedalo/'.length));
				if (
					(candidate === CLIENT_ROOT || candidate.startsWith(CLIENT_ROOT + sep)) &&
					existsSync(candidate)
				) {
					servedPath = candidate;
				}
			}
			if (servedPath === null) {
				throw new Error(`manifest url does not resolve on the TS server: ${entry.url}`);
			}
		}
	});
});
