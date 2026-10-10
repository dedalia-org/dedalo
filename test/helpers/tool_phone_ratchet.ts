/**
 * TOOL PHONE RATCHET — which tools are proven usable on a phone, and how each
 * is opened to prove it.
 *
 * Read by two gates:
 *  - test/unit/tool_phone_tripwire.test.ts (static, hermetic): every directory
 *    under tools/ is in EXACTLY one of NOT_YET_PHONE / PHONE_CASES, and no
 *    name is stale.
 *  - scripts/tool_viewport_check.ts (`bun run test:tools:phone`, browser, suite
 *    DB): opens each case at @min_target_viewport and judges it. A PHONE_CASES
 *    tool that fails is red; a NOT_YET_PHONE tool that has a probe here and
 *    PASSES is red too (shrink-only — move it across).
 *
 * The contract judged (tools_common/css/tool_responsive.less): no page-level
 * horizontal scroll, every visible control inside the viewport and at least
 * 44px on its shortest side, no console error.
 */

/** The phone floor — equal to `@min_target_viewport` in vars.less (pinned by the tripwire). */
export const PHONE_VIEWPORT = { width: 360, height: 740 } as const;

/** Minimum hit target (WCAG 2.5.5) — equal to `@phone_hit_target` in tool_responsive.less. */
export const PHONE_HIT_TARGET_PX = 44;

/**
 * How the harness opens a tool — always the path a user's click takes, on the
 * SUITE database. Six kinds:
 *
 *  - `context` (default): the caller's page, then `open_tool` on the LIVE
 *    caller instance whose `context.tools` (or `tools`) offers the tool, with
 *    that instance's own tool_context (its open_as, its tool_config).
 *  - `button`: a list section's button_trigger — `open_tool` with the button's
 *    `tools[0]`, caller the section (view_default_list_section.js).
 *  - `section_tool`: an area's section_tool node listed, a record selected,
 *    `open_tool` with its `config.tool_context` (render_list_section.js).
 *  - `click`: a page URL and the selectors a user clicks, in order (menu
 *    buttons, the error-report tab). `root` names the node to judge when the
 *    tool is not a `.wrapper_tool` (the assistant is a panel).
 *  - `method`: a live instance's own open handler (menu.open_tool_user_admin_handler)
 *    — for a door the suite's root login cannot click (root's username link is
 *    `noevents`: the profile tool is for non-root users).
 *  - `module`: a launcher's own exported open function (the site-builder
 *    maintenance widget's `open_site_builder`), called as its button does —
 *    minus the gate that enables the button (a reachable daemon).
 *
 * `build` (context/button/section_tool): create ONE scratch record in that
 * section through createSectionRecord before opening, sweep it after
 * (run_created_records) — the tests-build-their-situation law. `'target'` on a
 * section_tool means the section_tool's own target_section_tipo, read from the
 * ontology at run time.
 */
export type ToolPhoneProbe =
	| {
			kind?: 'context';
			caller: {
				tipo: string;
				section_tipo: string;
				/** `'built'` = the id of the record `build` created. */
				section_id: number | string | null;
				mode: 'edit' | 'list';
				model: string;
				lang: string;
			};
			build?: string;
	  }
	| { kind: 'button'; section: string; button: string; build?: string }
	| { kind: 'section_tool'; section_tool: string; build?: 'target' }
	| { kind: 'click'; url: string; clicks: string[]; root?: string }
	/** a live instance's own handler, where the UI door is closed to the suite's root login */
	| {
			kind: 'method';
			url: string;
			model: string;
			method: string;
			/**
			 * run as a NON-ADMIN fixture user instead of the suite root login
			 * (test/helpers/read_door_identity_fixture.ts, installed and swept
			 * around the probe) — for tools that are a non-root user's own
			 */
			as?: 'door_reader';
	  }
	/** a launcher's own exported open function, called as its button does */
	| { kind: 'module'; url: string; module: string; fn: string; root?: string };

/** A caller on the canonical test3/1 record (the suite database's playground). */
const test3 = (tipo: string, model: string, lang = 'lg-nolan'): ToolPhoneProbe => ({
	caller: { tipo, section_tipo: 'test3', section_id: 1, mode: 'edit', model, lang },
});
const test3Section = (): ToolPhoneProbe => test3('test3', 'section', 'lg-spa');

/** Tools PROVEN on a phone: probe must pass. Grows only by moving a tool out of NOT_YET_PHONE. */
export const PHONE_CASES: Record<string, ToolPhoneProbe> = {
	// 2026-09-28: the shared phone tier (tool_responsive.less) + local fixes, screenshots reviewed
	tool_assistant: {
		kind: 'click',
		url: 'tipo=test3&mode=list',
		clicks: ['.ai_assistant_button'],
		root: '.assistant_container',
	},
	tool_cataloging: { kind: 'button', section: 'test6099', button: 'test6415', build: 'test6099' },
	tool_dd_label: {
		caller: {
			tipo: 'dd1372',
			section_tipo: 'dd1324',
			section_id: 1,
			mode: 'edit',
			model: 'component_json',
			lang: 'lg-nolan',
		},
	},
	tool_dev_template: test3('test100', 'component_geolocation'),
	tool_diffusion: {
		caller: {
			tipo: 'test7289',
			section_tipo: 'test7289',
			section_id: 'built',
			mode: 'edit',
			model: 'section',
			lang: 'lg-spa',
		},
		build: 'test7289',
	},
	tool_error_report: {
		kind: 'click',
		url: 'tipo=test3&mode=list&menu=false',
		clicks: ['.error_report_edge_tab'],
	},
	tool_export: test3Section(),
	tool_hierarchy: {
		// hierarchy1/244 = `lg`, the CORE hierarchy every install seed ships (its registry
		// record is in install/db/seed/matrix_hierarchy_main.copy.gz; install_seed_drift
		// _tripwire keeps that registry = CORE exactly). Was /1 (`ts`), which the compiled
		// seed no longer ships: it has no installable data file (2026-10-09).
		caller: {
			tipo: 'hierarchy1',
			section_tipo: 'hierarchy1',
			section_id: 244,
			mode: 'edit',
			model: 'section',
			lang: 'lg-spa',
		},
	},
	tool_identify: test3Section(),
	tool_image_rotation: test3('test99', 'component_image'),
	tool_import_dedalo_csv: test3Section(),
	tool_import_files: {
		caller: {
			tipo: 'test1090',
			section_tipo: 'test1030',
			section_id: 'built',
			mode: 'edit',
			model: 'component_portal',
			lang: 'lg-nolan',
		},
		build: 'test1030',
	},
	tool_import_marc21: { kind: 'button', section: 'rsc205', button: 'rsc363', build: 'rsc205' },
	tool_import_zotero: { kind: 'button', section: 'rsc205', button: 'rsc227', build: 'rsc205' },
	tool_indexation: { kind: 'section_tool', section_tool: 'test6879', build: 'target' },
	tool_lang: test3('test52', 'component_input_text', 'lg-spa'),
	tool_lang_multi: test3('test52', 'component_input_text', 'lg-spa'),
	tool_media_versions: test3('test26', 'component_3d'),
	tool_numisdata_epigraphy: { kind: 'section_tool', section_tool: 'test6269', build: 'target' },
	tool_numisdata_order_coins: { kind: 'section_tool', section_tool: 'test6413', build: 'target' },
	tool_ontology: {
		caller: {
			tipo: 'test0',
			section_tipo: 'test0',
			section_id: 1,
			mode: 'edit',
			model: 'section',
			lang: 'lg-spa',
		},
	},
	tool_ontology_parser: {
		caller: {
			tipo: 'dd5',
			section_tipo: 'dd5',
			section_id: null,
			mode: 'list',
			model: 'area',
			lang: 'lg-spa',
		},
	},
	tool_pdf_extractor: test3('test85', 'component_pdf'),
	tool_posterframe: test3('test26', 'component_3d'),
	tool_print: test3Section(),
	tool_propagate_component_data: test3('test88', 'component_check_box'),
	tool_qr: { kind: 'button', section: 'test7007', button: 'test7151', build: 'test7007' },
	// the probe reaches the 'not configured' state (no site-builder daemon on the
	// suite); the 3-pane workspace stacks to one column below @width_break_point_0
	// (tool_sitebuilder.less) — judged when a daemon is available
	tool_sitebuilder: {
		kind: 'module',
		url: 'tipo=test3&mode=list&menu=false',
		module:
			'/dedalo/core/area_maintenance/widgets/site_builder_status/js/render_site_builder_status.js',
		fn: 'open_site_builder',
		root: 'div.tool_sitebuilder',
	},
	tool_tc: {
		caller: {
			tipo: 'rsc36',
			section_tipo: 'rsc167',
			section_id: 'built',
			mode: 'edit',
			model: 'component_text_area',
			lang: 'lg-spa',
		},
		build: 'rsc167',
	},
	tool_time_machine: test3('test52', 'component_input_text', 'lg-spa'),
	tool_tr_print: {
		caller: {
			tipo: 'rsc36',
			section_tipo: 'rsc167',
			section_id: 'built',
			mode: 'edit',
			model: 'component_text_area',
			lang: 'lg-spa',
		},
		build: 'rsc167',
	},
	tool_transcription: { kind: 'section_tool', section_tool: 'test6877', build: 'target' },
	tool_update_cache: test3Section(),
	tool_upload: test3('test26', 'component_3d'),
};

/**
 * Tools NOT YET proven, shrink-only. `probe` (optional) lets the harness try
 * one anyway: a listed tool that passes is red, so the list cannot go stale.
 * `phase` refers to the responsive-tools plan.
 */
export const NOT_YET_PHONE: Record<
	string,
	{ phase: 1 | 2 | 3 | 4; reason: string; probe?: ToolPhoneProbe }
> = {
	// phase 1 — shared foundation should suffice, small fixes
	tool_user_admin: {
		phase: 1,
		reason:
			"NEEDS A NON-ADMIN FIXTURE WITH A PROFILE, not layout: the tool is a non-root user's own (root's username link is noevents; root's dd128/-1 fields answer an empty context); the read-door fixture user is refused (perm.denied) — its profile grants neither tool_user_admin nor its own dd128 fields",
		probe: {
			kind: 'method',
			url: 'tipo=test3&mode=list',
			model: 'menu',
			method: 'open_tool_user_admin_handler',
			as: 'door_reader',
		},
	},
	// phase 2 — modal-hosted tools become sheets
	tool_bibliography_acquisition: {
		phase: 2,
		reason:
			'NEW TOOL (this PR, open_as: modal) — not yet run against a phone viewport. No probe is listed because no test-TLD section is currently wired to offer this tool (register.json is show_in_component only, against the real rsc205/rsc3 tipos); writing one without a suite DB to verify it against would risk a false claim.',
	},
	tool_numisdata_acquisition: {
		phase: 2,
		reason:
			'NEW TOOL (this PR, open_as: modal) — not yet run against a phone viewport. No probe is listed because no test-TLD section is currently wired to offer this tool (register.json is show_in_component only, against the real numisdata4 tipo); writing one without a suite DB to verify it against would risk a false claim.',
	},
	// phase 3 — CSS relayout
	tool_import_rdf: {
		phase: 3,
		reason:
			'UNREACHABLE ON THE TEST TLD: its register limits it to numisdata310 (dd1350); the test TLD twin test6324 is not in that list, so no generic element offers it',
		probe: {
			caller: {
				tipo: 'test6324',
				section_tipo: 'test6099',
				section_id: 'built',
				mode: 'edit',
				model: 'component_iri',
				lang: 'lg-nolan',
			},
			build: 'test6099',
		},
	},
	// phase 4 — layout + JS (pane switch / up-down reorder / touch)
	tool_subtitles: {
		phase: 4,
		reason:
			'BLOCKED BY A TOOL BUG, not layout: its subtitles_component ddo_map role does not resolve on rsc167, render reads .context of undefined (the value[0] crash before it is fixed 2026-09-28)',
		probe: {
			caller: {
				tipo: 'rsc36',
				section_tipo: 'rsc167',
				section_id: 'built',
				mode: 'edit',
				model: 'component_text_area',
				lang: 'lg-spa',
			},
			build: 'rsc167',
		},
	},
};
