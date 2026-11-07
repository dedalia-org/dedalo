// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals */
/*eslint no-undef: "error"*/

// imports
import { ui } from '../../../../common/js/ui.js';
import {
	CHANNELS,
	channel_label,
	check_counts,
	check_row,
	fact_row,
	fold_section,
	release_facts,
	section,
	verdict,
} from '../../update_code/js/render_update_status.js';

/**
 * RENDER_SERVE_CODE
 * View layer of the serve_code widget: this installation as a CODE SERVER.
 * Split out of update_code (2026-09-28) — the same split as serve_ontology.
 *
 * Layout (2026-11-07, for non-technical operators — the update_code pattern):
 * a role note, the published release, the verdict with ONLY what blocks (note +
 * fix steps), the build rows (one per channel, its BUILD button beside the
 * archive it writes), then ONE closed "Details" fold holding every other fact
 * (all checks, build source, tags, other archives, what is offered), then the
 * response surface the build form reports into.
 *
 * Widget value shape (serve_code.ts getValue):
 *   { is_a_code_server: boolean, code_server: Object|null }
 * `code_server` is null on the development entity when it is not a code server:
 * the panel then says which key makes it one, and offers no build.
 */
// a CONSTRUCTOR: its .prototype carries list(); an arrow function has none
// biome-ignore lint/complexity/useArrowFunction: needs .prototype
export const render_serve_code = function () {
	return true;
}; //end render_serve_code

/**
 * LIST
 * Entry point for both 'edit' and 'list' modes. `render_level` 'content' returns
 * the content_data node only (widget_common.load repaint path).
 * @param {Object} options
 * @returns {Promise<HTMLElement>}
 */
render_serve_code.prototype.list = async function (options) {
	const render_level = options.render_level || 'full';

	// content_data
	const content_data = get_content_data_edit(this);
	if (render_level === 'content') {
		return content_data;
	}

	// wrapper
	const wrapper = ui.widget.build_wrapper_edit(this, {
		content_data: content_data,
	});
	wrapper.content_data = content_data;

	return wrapper;
}; //end list

/**
 * GET_CONTENT_DATA_EDIT
 * @param {Object} self - serve_code widget instance
 * @returns {HTMLElement} content_data
 */
const get_content_data_edit = (self) => {
	const value = self.value || {};

	const content_data = ui.create_dom_element({
		element_type: 'div',
		class_name: 'content_data',
	});

	// role note
	ui.create_dom_element({
		element_type: 'div',
		class_name: 'dd_note serve_code_note',
		text_content: value.code_server
			? get_label.serve_code_note ||
				'This installation is a code server: it builds releases from GIT and serves them to the installations that ask it for updates.'
			: get_label.serve_code_not_server ||
				'This installation is not a code server. Set IS_A_CODE_SERVER=true in ../private/.env and restart to build and serve releases.',
		parent: content_data,
	});

	// body_response: the build form reports here (appended at the end)
	const body_response = ui.create_dom_element({
		element_type: 'div',
		class_name: 'body_response',
	});

	// the readout, re-rendered after every build
	const content_data_body = ui.create_dom_element({
		element_type: 'div',
		class_name: 'serve_code_body',
		parent: content_data,
	});
	// The readout lays out one row per channel and calls back to mount
	// the build action into it, so the button and the archive it writes
	// are one entry instead of two disconnected blocks.
	//
	// It is rendered through a function because a BUILD invalidates it:
	// the archive list, and what a consumer at this version is offered,
	// are both answers about the disk that the build just changed. The
	// pair is mutually recursive by design — the mounter needs the
	// refresh, the refresh needs a mounter built from the FRESH value —
	// and `refresh_code_server` is only ever read at call time.
	const render_code_server_half = (code_server, build_mark) => {
		// a build re-renders the half: Details stays as the operator left it
		const details_open = content_data_body.querySelector('.serve_details')?.open === true;
		while (content_data_body.firstChild) {
			content_data_body.removeChild(content_data_body.firstChild);
		}
		render_code_server_status(
			content_data_body,
			code_server,
			make_builder_mounter(self, body_response, code_server, refresh_code_server),
			build_mark,
			details_open,
		);
	};
	// `build_mark` is {channel, previous} — the row whose button was just
	// pressed and the facts it showed BEFORE. It survives exactly one
	// render: the re-read below replaces the whole half, and without it
	// the new archive line appears in place of the old one with nothing
	// saying which of the two the operator is looking at.
	const refresh_code_server = async (build_mark) => {
		try {
			const fresh = await self.get_value();
			if (!fresh || !fresh.code_server) {
				return;
			}
			// keep the instance coherent too: the next render reads self.value
			self.value = fresh;
			render_code_server_half(fresh.code_server, build_mark);
		} catch (error) {
			// a failed refresh must never take the panel down: the build
			// already reported its own outcome in body_response
			console.error('serve_code: could not refresh the code-server readout', error);
		}
	};
	render_code_server_half(value.code_server);

	content_data.appendChild(body_response);

	return content_data;
}; //end get_content_data_edit

/**
 * RENDER_CODE_SERVER_STATUS
 * The master half, in reading order: the published release, the verdict with
 * only what BLOCKS a publish, the build rows, then every other fact under one
 * closed "Details" fold.
 * @param {HTMLElement} parent
 * @param {Object|null} code_server - value.code_server, null on a plain install
 * @param {Function|null} mount_builder
 * @param {Object} [build_mark]
 * @param {boolean} [details_open] - re-open Details (a post-build re-render)
 * @returns {HTMLElement|null}
 */
const render_code_server_status = (
	parent,
	code_server,
	mount_builder,
	build_mark,
	details_open,
) => {
	if (!code_server) return null;

	const wrapper = ui.create_dom_element({
		element_type: 'div',
		class_name: 'update_status code_server_status',
		parent: parent,
	});

	const source = code_server.source || {};
	const releases = code_server.releases || [];

	// THE PUBLISHED RELEASE — the one fact always in view: what installations
	// are offered as a stable release. The pairing key is the version a build
	// of each channel would produce (see is_target below).
	const target_versions = {
		master: source.release_version || null,
		prerelease: source.prerelease_ref ? String(source.prerelease_ref).replace(/^v/, '') : null,
		dev: source.dev_version || null,
	};
	const is_target = (release) => {
		const target = target_versions[release.channel];
		const key = release.channel === 'prerelease' ? release.identity : release.version;
		return target === null || target === undefined || key === target;
	};
	const published =
		releases.find((release) => release.channel === 'master' && is_target(release)) ||
		releases.find((release) => release.channel === 'master');
	const headline = ui.create_dom_element({
		element_type: 'div',
		class_name: 'status_block published_version',
		parent: wrapper,
	});
	ui.create_dom_element({
		element_type: 'div',
		class_name: 'dd_eyebrow',
		text_content: get_label.serve_code_published_release || 'Published release',
		parent: headline,
	});
	ui.create_dom_element({
		element_type: 'div',
		class_name: 'published_version_value mono' + (published ? '' : ' none'),
		text_content: published
			? published.version
			: get_label.serve_code_nothing_published || 'Nothing published yet',
		parent: headline,
	});

	// VERDICT + what blocks it (note and fix steps), nothing else
	const checks = code_server.checks || [];
	const readiness = ui.create_dom_element({
		element_type: 'div',
		class_name: 'status_block readiness_block',
		parent: wrapper,
	});
	verdict(
		readiness,
		code_server.ready === true,
		get_label.serve_code_publish_ready || 'Ready to publish',
		get_label.serve_code_publish_blocked || 'Cannot publish',
	);
	const blocking = checks.filter((check) => check.state === 'blocked');
	if (blocking.length) {
		const attention = ui.create_dom_element({
			element_type: 'div',
			class_name: 'dd_readout attention_checks',
			parent: readiness,
		});
		blocking.forEach((check) => {
			check_row(attention, check);
		});
	}

	// BUILD AND PUBLISH — ONE ENTRY PER CHANNEL: the action, and the archive
	// that action produces, on the same row. The row shows the artifact the
	// button beside it would write (is_target); a prerelease pairs by its
	// IDENTITY (several betas of one triple share a version).
	const build = section(wrapper, get_label.serve_code_build_publish || 'Build and publish');
	CHANNELS.forEach((channel) => {
		const row = ui.create_dom_element({
			element_type: 'div',
			class_name: 'dd_row build_row',
			parent: build,
		});
		const action = ui.create_dom_element({
			element_type: 'div',
			class_name: 'dd_k build_action',
			parent: row,
		});
		// THE ARTIFACT CELL IS CREATED BEFORE THE BUTTON IS MOUNTED, and is
		// handed to the mounter: while a build runs, the row that says what
		// is on disk is the row that has to say it is being rewritten.
		const value = ui.create_dom_element({
			element_type: 'div',
			class_name: 'dd_v build_file',
			parent: row,
		});
		const built = releases.find((release) => release.channel === channel && is_target(release));
		if (mount_builder) {
			mount_builder(channel, action, value, built || null);
		} else {
			// no form builder on this page: name the channel anyway
			action.textContent = channel_label(channel);
		}
		// the verdict belongs to the channel whose button was pressed
		const mark = build_mark && build_mark.channel === channel ? build_mark : null;
		if (!built) {
			value.classList.add('none');
			value.textContent = get_label.update_code_not_built || 'Not built yet';
			return;
		}
		release_facts(value, built, mark);
	});

	// DETAILS — closed on every first render: the reference facts one click away
	const details = ui.create_dom_element({
		element_type: 'details',
		class_name: 'status_block dd_fold serve_details',
		parent: wrapper,
	});
	details.open = details_open === true;
	const details_summary = ui.create_dom_element({
		element_type: 'summary',
		parent: details,
	});
	ui.create_dom_element({
		element_type: 'span',
		class_name: 'dd_eyebrow',
		text_content: get_label.update_code_details || 'Details',
		parent: details_summary,
	});
	const details_body = ui.create_dom_element({
		element_type: 'div',
		class_name: 'serve_details_body',
		parent: details,
	});

	// every check, with per-state counts on the closed fold
	const all_checks = fold_section(
		details_body,
		'serve_checks',
		get_label.update_code_all_checks || 'All checks',
	);
	check_counts(all_checks.summary, checks);
	checks.forEach((check) => {
		check_row(all_checks.body, check);
	});

	// the tree releases are built FROM
	const build_source = fold_section(
		details_body,
		'serve_source',
		get_label.serve_code_build_source || 'Build source',
		{ hint: source.branch || '' },
	).body;
	fact_row(
		build_source,
		get_label.update_code_check_git_dir || 'Git source directory',
		source.git_dir,
		true,
	);
	fact_row(build_source, get_label.update_code_commit || 'Commit', source.head_sha, true);
	fact_row(
		build_source,
		get_label.update_code_current_build || 'Current build',
		source.head_date,
		true,
	);
	fact_row(
		build_source,
		get_label.serve_code_head_branch || 'Checked-out branch',
		source.branch,
		true,
	);
	fact_row(build_source, get_label.update_code_bun || 'Bun runtime', source.bun_pin, true);

	// THE CHANNEL REFS — what each build is actually made from: a RELEASE is the
	// newest `vX.Y.Z` tag, a DEVELOPER build the tip of `master`.
	const refs = fold_section(
		details_body,
		'serve_refs',
		get_label.serve_code_release_ref || 'Release tag',
		{ hint: source.release_ref || '' },
	).body;
	fact_row(refs, get_label.serve_code_release_ref || 'Release tag', source.release_ref, true);
	fact_row(refs, get_label.serve_code_release_commit || 'Release commit', source.release_sha, true);
	fact_row(refs, get_label.serve_code_release_date || 'Release date', source.release_date, true);
	fact_row(
		refs,
		get_label.serve_code_prerelease_ref || 'Prerelease tag',
		source.prerelease_ref,
		true,
	);
	fact_row(refs, get_label.serve_code_dev_ref || 'Development branch', source.dev_ref, true);
	fact_row(refs, get_label.serve_code_dev_commit || 'Development commit', source.dev_sha, true);
	fact_row(
		refs,
		get_label.serve_code_dev_version || 'Development version',
		source.dev_version,
		true,
	);
	if (source.divergence) {
		const behind_row = fact_row(
			refs,
			get_label.serve_code_behind || "Commits on 'master' not in the release",
			String(source.divergence.behind),
		);
		if (source.divergence.behind > 0) {
			const behind_value = behind_row.querySelector('.dd_v');
			ui.create_dom_element({
				element_type: 'span',
				class_name: 'dd_badge',
				text_content: source.dev_ref || 'master',
				parent: behind_value,
			});
			ui.create_dom_element({
				element_type: 'div',
				class_name: 'check_note',
				text_content: get_label.update_code_note_release_ref_current || '',
				parent: behind_value,
			});
		}
	}

	// Archives on disk for OTHER versions: no builder, but they take disk space
	// and a manifest may still advertise one.
	const others = releases.filter((release) => !is_target(release));
	if (others.length) {
		const other_block = fold_section(
			details_body,
			'serve_other',
			get_label.serve_code_other_archives || 'Other archives on disk',
			{ hint: String(others.length) },
		).body;
		others.forEach((release) => {
			const row = fact_row(other_block, release.file, '', true);
			release_facts(row.querySelector('.dd_v'), release);
		});
	}

	// what a consumer is ACTUALLY offered, one row per reachable consumer version
	const advertises = code_server.advertises || { files: [], rungs: [] };
	const offered = fold_section(
		details_body,
		'serve_offered',
		get_label.serve_code_advertised || 'Offered to an installation at this version',
	).body;
	const rungs =
		advertises.rungs && advertises.rungs.length
			? advertises.rungs
			: [{ for_version: advertises.for_version, files: advertises.files }];
	rungs.forEach((rung) => {
		if (!rung.files.length) {
			fact_row(
				offered,
				rung.for_version,
				get_label.serve_code_note_advertised_empty || 'No release is offered.',
			);
			return;
		}
		rung.files.forEach((file) => {
			fact_row(offered, `${rung.for_version} → ${file.version}`, file.url, true);
		});
	});

	return wrapper;
}; //end render_code_server_status

/**
 * MAKE_BUILDER_MOUNTER
 * Builds the "mount a build button HERE" function the code-server readout uses.
 *
 * The buttons and the archives they produce used to be two separate blocks —
 * 'Code builders from GIT' floating below a 'Published releases' list — so
 * nothing on screen said that pressing the first writes the second. Now the
 * readout owns the layout (one row per channel: the action and its artifact
 * side by side) and calls back here to mount the action, which is the only part
 * that needs the widget's wire machinery (`self.caller.init_form`).
 *
 * Three channels, and the difference is load-bearing (policy 2026-09-29,
 * prereleases 2026-10-15):
 *   - 'master'     → `<v>.zip`          — the published release, built from the
 *                                          newest `vX.Y.Z` release TAG (the wire
 *                                          keeps the historical token 'master')
 *   - 'prerelease' → `<v>-beta.N.zip`   — the newest `vX.Y.Z-(alpha|beta|rc).N`
 *                                          tag above that release; IMMUTABLE
 *                                          like a release (the server refuses to
 *                                          rebuild a published identity)
 *   - 'dev'        → `<v>-dev.zip`      — the tip of branch `master`; never
 *                                          overwrites a release archive
 * The button sends only the CHANNEL; the server resolves the ref.
 *
 * No cross-widget event on completion: a build writes an archive for OTHER
 * installations and changes nothing this install runs, so no other panel has
 * anything to refresh. (The 'build_code_done' publish it used to fire had no
 * subscriber anywhere — removed 2026-09-28.)
 *
 * @param {Object} self - serve_code widget instance
 * @param {HTMLElement} body_response - the response area passed to init_form
 * @param {Object} code_server - value.code_server (its source.release_version
 *   is THE version a build will produce; see below)
 * @param {Function} [on_built] - called after a build finishes, so the readout
 *   that lists the archives can re-read them: the row next to the button is a
 *   claim about the disk, and a stale one is worse than none.
 * @returns {Function|null} (channel, node) => void, or null when this page
 *   provides no form builder
 */
const make_builder_mounter = (self, body_response, code_server, on_built) => {
	if (!self.caller?.init_form) {
		return null;
	}

	// on_done. On build completion, execute this function
	const on_done = (build_mark) => {
		// COHERENCE: the archive list sitting beside these buttons was read
		// BEFORE the build. Leaving it is how a panel comes to show '7.0.0.zip ·
		// 16:25' next to a button that has just rewritten that very file — or
		// 'Not built yet' next to a build that succeeded.
		//
		// The mark rides along so the row that comes back can say WHICH of the
		// two values it is (see render_update_status.js release_facts).
		if (on_built) {
			on_built(build_mark);
		}
	};

	// THE VERSION EACH BUILD WILL ACTUALLY PRODUCE — the one its REF declares,
	// which the server sends as source.release_version (the release tag's) and
	// source.dev_version (master's). NEVER the running process's version
	// (page_globals.dedalo_version): naming the artifact after it is exactly the
	// bug that let a 7.0.0 master publish an uninstallable 7.0.0.zip. A channel
	// whose ref declares no readable version offers no button at all (below).
	const source = (code_server && code_server.source) || {};
	const version_parts = (declared) => {
		const ar_version = String(declared || '?.?.?').split('.');
		return {
			version: [ar_version[0], ar_version[1], ar_version[2]].join('.'),
			release_dir: `<DEDALO_CODE_FILES_DIR>/${ar_version[0]}/${ar_version[0]}.${ar_version[1]}/`,
		};
	};
	const release_parts = version_parts(source.release_version);
	const dev_parts = version_parts(source.dev_version);

	// THE REFS ARE THE SERVER'S. A release is the newest `vX.Y.Z` tag
	// (source.release_ref, null when the checkout has none); a developer build
	// is the tip of source.dev_ref (`master`). Neither is ever a literal baked
	// into the client — the old hardcoded 'v7' refused on every server that did
	// not carry that branch.
	const release_tag = source.release_ref || null;
	const prerelease_tag = source.prerelease_ref || null;
	// the identity a prerelease build names its archive after: the tag minus 'v'
	const prerelease_identity = prerelease_tag ? String(prerelease_tag).replace(/^v/, '') : '';
	const prerelease_parts = version_parts(source.prerelease_version);
	const dev_ref = source.dev_ref || 'master';
	// a ref whose own version file cannot be read cannot name its archive
	const version_unknown = (ref) =>
		(
			get_label.serve_code_build_version_unknown ||
			"Nothing to build: the version of '%ref%' cannot be read from its src/core/update/version.ts"
		).replaceAll('%ref%', String(ref));

	const channels = {
		master: {
			// the panel's main publishing action — filled (widget_kit .primary)
			button_class: 'primary',
			submit_label: get_label.serve_code_build_master || 'Build release',
			// %tag% is NAMED, not positional (see the dev text below)
			confirm_text: (
				get_label.serve_code_build_master_confirm ||
				"A release of version %s will be created from tag '%tag%' as: %s"
			)
				.replace('%s', release_parts.version)
				.replace('%s', `\n\n${release_parts.release_dir}${release_parts.version}.zip\n`)
				.replaceAll('%tag%', String(release_tag)),
			// no stable tag is the normal state while a major is in beta: its
			// code then reaches installations as prereleases or developer builds
			unavailable: !release_tag
				? get_label.serve_code_build_master_unavailable ||
					'No release yet: a release is built from a stable vX.Y.Z tag of this engine (a prerelease tag is built with Build prerelease). Until one exists, installations get this code only as prereleases or developer builds'
				: !source.release_version
					? version_unknown(release_tag)
					: null,
		},
		prerelease: {
			// a release in every respect but stability: same weight as dev
			button_class: 'light',
			submit_label: get_label.serve_code_build_prerelease || 'Build prerelease',
			// NAMED placeholders only: the identity, tag and file appear in a
			// different order in each translated sentence
			confirm_text: (
				get_label.serve_code_build_prerelease_confirm ||
				"Prerelease %identity% will be created from tag '%tag%' as: %file% A published prerelease is immutable: it is never rebuilt."
			)
				.replaceAll('%identity%', prerelease_identity)
				.replaceAll('%file%', `\n\n${prerelease_parts.release_dir}${prerelease_identity}.zip\n\n`)
				// LAST: a tag name is the only value that is not ours
				.replaceAll('%tag%', String(prerelease_tag)),
			// none above the newest release: nothing to build, say why
			unavailable: !prerelease_tag
				? get_label.serve_code_build_prerelease_unavailable ||
					'No prerelease to build: a prerelease is built from the newest vX.Y.Z-(alpha|beta|rc).N tag of this engine that sorts above the newest release tag'
				: !source.prerelease_version
					? version_unknown(prerelease_tag)
					: null,
		},
		dev: {
			// secondary, but still unmistakably a control (see .build_action button)
			button_class: 'light',
			submit_label: get_label.serve_code_build_developer || 'Build developer release',
			// %branch% is NAMED, not positional: the branch appears in a
			// different place in each translated sentence, and a third '%s'
			// would land wherever that language happens to put it.
			confirm_text: (
				get_label.serve_code_build_developer_confirm ||
				"A developer release of version %s will be created from branch '%branch%' as: %s The release build of the same version is kept."
			)
				.replace('%s', dev_parts.version)
				.replace('%s', `\n\n${dev_parts.release_dir}${dev_parts.version}-dev.zip\n\n`)
				// LAST: a branch name may legally contain '%s', and substituting it
				// first would hand the positional pass a token of its own.
				.replaceAll('%branch%', String(dev_ref)),
			// No `master`, nothing to build. And when master IS the release
			// commit there is no development work to publish: a '<v>-dev.zip'
			// byte-identical to the release would be a lie, so the row says so
			// instead of offering a button.
			unavailable:
				source.has_master_ref === false
					? get_label.serve_code_build_developer_no_ref ||
						"No 'master' branch in the build checkout"
					: !source.dev_version
						? version_unknown(dev_ref)
						: source.divergence && source.divergence.behind === 0
							? get_label.serve_code_build_developer_unavailable ||
								"Nothing to build: 'master' has no commits beyond the release tag"
							: null,
		},
	};

	return (channel, node, artifact_cell, built_before) => {
		const def = channels[channel];
		if (!def) {
			return;
		}

		// a channel with nothing to build says why, instead of a button
		if (def.unavailable) {
			node.classList.add('none');
			node.textContent = def.unavailable;
			return;
		}

		const form = self.caller.init_form({
			submit_label: def.submit_label,
			confirm_text: def.confirm_text,
			body_info: node,
			body_response: body_response,
			trigger: {
				dd_api: 'dd_area_maintenance_api',
				action: 'widget_request',
				source: {
					type: 'widget',
					model: 'serve_code',
					action: 'build_version_from_git_master',
				},
				// the CHANNEL only — the server resolves its ref
				options: {
					channel: channel,
				},
			},
			// the mark travels from the row that was pressed to the row that
			// comes back — captured HERE, at mount time, because the refresh
			// destroys this half before anything could read it back off the DOM.
			on_done: () =>
				on_done({
					channel: channel,
					previous: built_before ? { bytes: built_before.bytes, stamp: built_before.stamp } : null,
				}),
		});
		// build_form always emits `light button_submit`; the channel's own weight
		// is added here (it exposes the node for exactly this kind of reach-in).
		if (form && form.button_submit) {
			form.button_submit.classList.add('build_button', def.button_class);
		}

		// IN FLIGHT: say WHICH artifact is being rewritten, on the artifact.
		// The button's spinner reports that a request is running; it does not
		// say that the line beside it — the file name, the size, the date — is
		// about to stop being true. A build takes tens of seconds and rewrites
		// the file in place, so for that whole time the row states something
		// the operator cannot act on and cannot tell is stale.
		//
		// build_form's lifecycle is the hook: its submit handler runs the
		// window.confirm gate SYNCHRONOUSLY and only then adds `button_spinner`,
		// before its first await. A listener registered after it therefore runs
		// once the request is under way — and never when the operator cancelled
		// the confirm. Pinned by test/unit/client_update_code_render.test.ts.
		if (form && form.button_submit && artifact_cell) {
			form.addEventListener('submit', () => {
				if (!form.button_submit.classList.contains('button_spinner')) {
					return; // the confirm was declined: nothing is being built
				}
				artifact_cell.classList.add('building');
				ui.create_dom_element({
					element_type: 'span',
					class_name: 'dd_badge pill_warning build_verdict',
					text_content: get_label.serve_code_build_building || 'building…',
					parent: artifact_cell,
				});
			});
		}
	};
}; //end make_builder_mounter

// @license-end
