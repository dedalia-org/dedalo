/**
 * VENDOR ADVISORY TRIPWIRE (DEC-12) — a vendored third-party tree may not sit
 * inside a published advisory, and may not go unreviewed past its own window.
 *
 * WHY THIS EXISTS (CLI-26, S1, 2026-08-28). `vendor/pdfjs` was 5.7.284 —
 * inside GHSA-hq66-cqwq-w95j / CVE-2026-16633 (HIGH, "arbitrary JavaScript
 * execution upon opening a malicious PDF", `>= 5.6.83, < 6.2.108`, published
 * 2026-08-06) — for 22 days with every gate GREEN, in a viewer iframe that is
 * same-origin with the application under the operator's own session. Nothing in
 * the repo could see it:
 *   - `bun audit` reads lockfiles, and `vendor/` has none;
 *   - the vendor staleness axis was a documented NUDGE that "NUDGES, never
 *     fails" — it printed `pdfjs 5.7.284 — reviewed 2026-07-12 (46 days ago)`
 *     with the advisory 25 days inside that window, and exited 0;
 *   - `dependency_integrity_tripwire` says in its own header that it proves a
 *     digest EXISTS and matches, never that the bytes are benign.
 * Three green gates over an unpatched remote-code-execution surface. This file is
 * the axis none of them covered. The tree went to 6.2.108 (also the npm dist-tag
 * `latest`, so the advisory fix and the latest-stable law were one move) — but the
 * gate, not the bump, is the durable half: the bump ages, the question does not.
 *
 * WHAT IT ASSERTS. **Census: TOTAL** over `vendor/vendor_manifest.json` rows —
 * every vendored tree, no exemption list:
 *   1. every row declares an advisory coordinate (`ecosystem`+`package`+`version`,
 *      the identity a feed is keyed to) or STATES why no coordinate exists;
 *   2. the machine `advisory.version` and the human `version` have not drifted;
 *   3. the DECLARED VERSION IS THE VERSION THE BYTES SAY — `version_evidence` names
 *      a file inside the lib's own tree and a literal that must appear in it, and
 *      the literal must itself contain the declared version. Added by the CLI-26
 *      review, and it closes the same hole one level up: a row reading 6.2.108 over
 *      a 5.7.284 tree satisfied the digest (it hashes whatever is there), the range
 *      check and the feed query all at once, because all three read the LABEL.
 *      A tree that states no version anywhere (json-view) says so, in a reason a
 *      human wrote and this gate requires;
 *   4. `reviewed` is inside the row's own `review_window_days` — a HARD FAIL, which
 *      is the whole difference from the nudge it replaces. This leg, and the
 *      acceptance expiry in 5, read the CALENDAR: since 2026-09-26 the push gate
 *      runs them only where time is the input (DEDALO_VENDOR_DATED_CHECKS, below —
 *      scripts/ci/audit.ts on a lockfile/vendor change, and nightly.yml every day,
 *      which warns 21 days before either window closes);
 *   5. the declared version is not inside any ledgered advisory range, unless the
 *      row carries an acceptance with a closed-set reason code, an unexpired date
 *      and at least one `verify` clause that the checker RE-PROVES against the
 *      tree on this run.
 * Plus the mitigation that survives a revert of the bump, asserted on BOTH facts it
 * rests on and then EXECUTED rather than believed: the mount forces
 * `enableScripting:false` (the advisory's own stated workaround) and, before it,
 * `disablePreferences:true`. The second is not decoration — `enableScripting` is a
 * PREFERENCE-kind option, so `pdfjs.preferences` in localStorage is applied over it
 * by `AppOptions.setAll(prefs, true)` after the mount's handler returns. The gate
 * runs the vendored `AppOptions` implementation itself (the `web/app_options.js`
 * chunk of `vendor/pdfjs/web/viewer.mjs`, evaluated with a stub `navigator`) and
 * proves the whole chain on the real bytes: the default is ON, the mount's `set()`
 * turns it OFF, a preference write turns it BACK ON, and `disablePreferences` is
 * what makes `_checkDisablePreferences()` return true — the guard the viewer's
 * `Preferences` constructor consults before applying any of them.
 *
 * WHY OFFLINE. `bun test` must be credless and hermetic, so the ledger is
 * committed data and this gate never touches the network. The other half —
 * discovering an advisory nobody has ledgered yet — is in `scripts/ci/audit.ts`,
 * which asks the GitHub advisory feed the same question per coordinate. Its
 * three-way outcome (finding / rejected request / degraded lookup) is a POLICY, and
 * `classifyAdvisoryFeedStatus` is tested here on constructed statuses, because the
 * case that matters — an anonymous 403 rate limit rendering as a vulnerability, on a
 * shared runner IP — is not one a test can produce on demand.
 *
 * HONEST LIMITS.
 *   - A vulnerability with no advisory entry, or one keyed to a package name a
 *     vendored bundle does not share, is invisible to BOTH halves. `vendor/json-view`
 *     carries no version string at all, so nothing can be keyed to it — its row says
 *     so, and its review window is then the only signal it has.
 *   - "Inside a range" is a version comparison, not an exploitability judgement. An
 *     acceptance is where exploitability is argued, and it must be argued in a form
 *     a machine re-checks (a plugin absent from the served bundle), never in prose
 *     alone.
 *   - `version_evidence` binds a LABEL to a LITERAL, not to provenance. It refuses a
 *     mislabelled tree; it cannot refuse a tree whose upstream build was tampered
 *     with before we fetched it. That is `archive_sha256`'s job, and only the rows that
 *     record one have it (pdfjs, lz-string, swagger-ui, transformers).
 *   - The executed `AppOptions` control proves the option machinery, not the browser:
 *     that the mount's handler runs before the viewer constructs is asserted
 *     structurally (no `await` before the `set()`), and was measured by hand in a
 *     real browser on 2026-08-28.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	auditRunDecision,
	auditTriggerMatcher,
	classifyAdvisoryFeedStatus,
} from '../../scripts/ci/audit.ts';
import {
	ADVISORY_REASON_CODES,
	checkVendorAdvisories,
	checkVendorAdvisoriesIn,
	checkVendorRootsIn,
	checkVendorVersionEvidence,
	checkVendorVersionEvidenceIn,
	compareVersions,
	listVendorDirs,
	parseVersion,
	readManifest,
	VENDOR_WINDOW_WARNING_DAYS,
	type VendorAdvisoryBlock,
	type VendorAdvisoryCheckOptions,
	type VendorAdvisoryRecord,
	type VendorManifest,
	type VendorVersionEvidenceClause,
	vendorWindowWarningsIn,
	versionInRange,
} from '../../scripts/vendor_verify.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');

/** The row ids whose tree is `vendor/<id>` — the half the complement law is over. */
function rowsUnderVendor(libs: VendorManifest['libs']): string[] {
	return Object.entries(libs)
		.filter(([, entry]) => typeof entry.root !== 'string')
		.map(([id]) => id)
		.sort();
}

describe('vendor advisory tripwire — the manifest is queryable', () => {
	test('every vendored tree carries an advisory block (TOTAL census, no exemptions)', () => {
		const libs = readManifest().libs;
		const dirs = listVendorDirs();
		// Anti-empty guard: an advisory gate over zero rows is the vacuous green this
		// whole file exists to remove.
		expect(dirs.length).toBeGreaterThan(0);
		// The census is EVERY row. vendor/ dirs equal the rows that live there by
		// default; a row with an explicit `root` (swagger-ui inside the v1 publication
		// API) lives elsewhere and is checked by checkVendorRootsIn — it is a row all
		// the same, and every assertion below runs over it.
		expect(rowsUnderVendor(libs)).toEqual(dirs);
		expect(Object.keys(libs).length).toBeGreaterThan(dirs.length);
		expect(checkVendorRootsIn(readManifest())).toEqual([]);

		const missing: string[] = [];
		for (const [id, entry] of Object.entries(libs)) {
			const block = entry.advisory as VendorAdvisoryBlock | undefined;
			if (block === undefined) {
				missing.push(id);
				continue;
			}
			const keyed =
				typeof block.ecosystem === 'string' &&
				typeof block.package === 'string' &&
				typeof block.version === 'string';
			if (!keyed && (block.unkeyable_reason ?? '').length < 40) missing.push(id);
		}
		expect(missing, 'rows with no advisory coordinate and no stated reason').toEqual([]);
	});

	test('a ledgered advisory row is substantive enough to be checkable', () => {
		// The ledger is hand-written data. A row missing its range or its id would make
		// the range check silently skip — a narrowing this gate must refuse out loud.
		const thin: string[] = [];
		for (const [id, entry] of Object.entries(readManifest().libs)) {
			// Tolerant of a missing block on purpose: its ABSENCE is the first test's
			// failure, and a throw here would bury that message under a stack trace.
			for (const advisory of entry.advisory?.advisories ?? []) {
				if (!/^GHSA-[0-9a-z-]+$/.test(advisory.id)) thin.push(`${id}: bad id "${advisory.id}"`);
				if (!/^\d{4}-\d{2}-\d{2}$/.test(advisory.published)) {
					thin.push(`${id}/${advisory.id}: published "${advisory.published}" is not an ISO date`);
				}
				if ((advisory.vulnerable_range ?? '').trim() === '') {
					thin.push(`${id}/${advisory.id}: no vulnerable_range`);
				}
				if ((advisory.summary ?? '').trim().length < 10) {
					thin.push(`${id}/${advisory.id}: no summary`);
				}
			}
		}
		expect(thin).toEqual([]);
	});
});

describe('vendor advisory tripwire — the declared version is the version the bytes are', () => {
	// CLI-26 was a real tree sitting inside a real advisory. The failure ONE LEVEL UP is
	// a row that says 6.2.108 over bytes that are 5.7.284: the digest still matches (it
	// hashes whatever is there), the range check still passes (it compares the label)
	// and the feed query still comes back empty (it asks about the label). Three green
	// gates, same unpatched surface, no bump required. This is the axis that costs the
	// label something.

	// The two tests that run against the REAL pdfjs bytes take the declared version from
	// the manifest, so a bump re-points them instead of turning them red (2026-11-26,
	// 6.2.108 → 6.5.438). The synthetic-only REDs keep a literal: they never read bytes
	// that hold it.
	const PDFJS_VERSION = readManifest().libs.pdfjs?.version ?? 'pdfjs row missing';

	test('every row either evidences its version in its own bytes, or says why it cannot', () => {
		expect(checkVendorVersionEvidence()).toEqual([]);
	});

	test('the census is TOTAL and not vacuous — every tree carries the field', () => {
		const libs = readManifest().libs;
		expect(rowsUnderVendor(libs)).toEqual(listVendorDirs());
		const shapes: string[] = [];
		let withClauses = 0;
		for (const [id, entry] of Object.entries(libs)) {
			const evidence = entry.version_evidence;
			if (evidence === undefined || evidence === null) {
				shapes.push(`${id}: no version_evidence`);
				continue;
			}
			if (!Array.isArray(evidence.clauses)) shapes.push(`${id}: clauses is not an array`);
			else if (evidence.clauses.length > 0) withClauses++;
			else if ((evidence.unprovable_reason ?? '').trim().length < 40) {
				shapes.push(`${id}: no clauses and no substantive unprovable_reason`);
			}
		}
		expect(shapes).toEqual([]);
		// Anti-vacuity: if EVERY row declared itself unprovable the census above would be
		// green over nothing. Measured 2026-09-24 — 5 of the 6 trees state their version
		// (all but json-view, which genuinely cannot).
		expect(withClauses).toBeGreaterThanOrEqual(5);
	});

	test('CONSTRUCTED RED — a row whose bytes do not carry the declared version', () => {
		// The exact mislabel: the declared version on the row, and a viewer literal the
		// vendored bytes do not contain (what an older tree under a newer label looks like).
		const problems = checkEvidenceSynthetic({
			version: PDFJS_VERSION,
			clauses: [
				{ file: 'vendor/pdfjs/build/pdf.mjs', must_contain: `const version = "${PDFJS_VERSION}";` },
				{
					file: 'vendor/pdfjs/web/viewer.mjs',
					must_contain: `const viewerVersion = "${PDFJS_VERSION}-nope";`,
				},
			],
		});
		expect(problems.join('\n')).toContain('DECLARED VERSION IS NOT IN THE BYTES');
		expect(problems.join('\n')).toContain('viewer.mjs');
		// ...and the clause that DOES hold is not reported: the message must name the
		// broken binding, not the whole row.
		expect(problems.join('\n')).not.toContain('build/pdf.mjs does not contain');
	});

	test('CONSTRUCTED RED — evidence that does not mention the declared version at all', () => {
		// The lazy clause: `must_contain: "pdf.js"` holds forever and proves nothing.
		const problems = checkEvidenceSynthetic({
			version: '6.2.108',
			clauses: [{ file: 'vendor/pdfjs/web/viewer.mjs', must_contain: 'PDFViewerApplication' }],
		});
		expect(problems.join('\n')).toContain('does not contain the declared version');
		expect(problems.join('\n')).toContain('could pass on any version');
	});

	test('CONSTRUCTED RED — evidence taken from OUTSIDE the vendored tree', () => {
		// Our own prose about a tree is not evidence of what the tree IS. The manifest
		// itself contains "6.2.108" many times over, so without this rule a row could
		// evidence its version against the very file that declares it.
		const problems = checkEvidenceSynthetic({
			version: '6.2.108',
			clauses: [{ file: 'vendor/vendor_manifest.json', must_contain: '6.2.108' }],
		});
		expect(problems.join('\n')).toContain('outside vendor/pdfjs/');
	});

	test('CONSTRUCTED RED — a clause naming a file that does not exist', () => {
		const problems = checkEvidenceSynthetic({
			version: '6.2.108',
			clauses: [{ file: 'vendor/pdfjs/build/gone.mjs', must_contain: '6.2.108' }],
		});
		expect(problems.join('\n')).toContain('does not exist');
	});

	test('CONSTRUCTED RED — no clauses and no reason, and the hedge that carries both', () => {
		expect(checkEvidenceSynthetic({ version: '6.2.108', clauses: [] }).join('\n')).toContain(
			'no substantive unprovable_reason',
		);
		expect(
			checkEvidenceSynthetic({
				version: '6.2.108',
				clauses: [
					{ file: 'vendor/pdfjs/web/viewer.mjs', must_contain: 'const viewerVersion = "6.2.108";' },
				],
				unprovable_reason: 'x'.repeat(50),
			}).join('\n'),
		).toContain('BOTH clauses and an unprovable_reason');
	});

	test('CONSTRUCTED GREEN — the real pdfjs clauses hold against the real bytes', () => {
		// The other direction, and the one that proves the checker is not simply always
		// red: the shipped clauses, run through the same function, over the real tree.
		expect(
			checkEvidenceSynthetic({
				version: PDFJS_VERSION,
				clauses: [
					{
						file: 'vendor/pdfjs/build/pdf.mjs',
						must_contain: `const version = "${PDFJS_VERSION}";`,
					},
					{
						file: 'vendor/pdfjs/build/pdf.worker.mjs',
						must_contain: `const workerVersion = "${PDFJS_VERSION}";`,
					},
					{
						file: 'vendor/pdfjs/web/viewer.mjs',
						must_contain: `const viewerVersion = "${PDFJS_VERSION}";`,
					},
				],
			}),
		).toEqual([]);
	});
});

/**
 * THE CALENDAR KEY (2026-09-26). `DEDALO_VENDOR_DATED_CHECKS=0` drops the two
 * wall-clock legs (a lapsed review window, an expired acceptance) from the
 * load-bearing assertion below — scripts/ci/hermetic.sh sets it, because on the push
 * gate those legs turned the same sha red overnight. Unset (a developer's `bun test`,
 * scripts/verify.ts) they run. Where they run in CI regardless of this key:
 * scripts/ci/audit.ts calls the SAME checker with `dated: true` on the
 * lockfile/vendor path of hermetic.sh and every night (.github/workflows/nightly.yml).
 * ci_workflow_tripwire rule 12 holds that hermetic.sh sets the key and that THIS
 * file reads it here.
 */
const DATED_CHECKS = process.env.DEDALO_VENDOR_DATED_CHECKS !== '0';

describe('vendor advisory tripwire — the load-bearing assertion', () => {
	test('no vendored version is inside a published advisory (tree-only legs — every run)', () => {
		// THE assertion. It is deliberately one call: the same function scripts/ci/audit.ts
		// runs, so a developer's `bun test` and CI cannot disagree about what is red.
		// `dated: false` is a pure function of the committed tree: same sha, same answer.
		expect(checkVendorAdvisories(new Date(), { dated: false })).toEqual([]);
	});

	test.skipIf(!DATED_CHECKS)(
		'no review window has lapsed and no acceptance has expired (the calendar legs — skipped under DEDALO_VENDOR_DATED_CHECKS=0)',
		() => {
			expect(checkVendorAdvisories()).toEqual([]);
		},
	);
});

describe('vendor advisory tripwire — the time split and the warning window', () => {
	test('dated:false drops EXACTLY the two calendar legs, and nothing else', () => {
		// A lapsed window: red with the calendar, silent without it.
		const lapsed = checkSynthetic({ version: '6.2.108', reviewed: '2026-01-01' });
		expect(lapsed.join('\n')).toContain('past its 90-day window');
		expect(
			checkSynthetic({ version: '6.2.108', reviewed: '2026-01-01' }, { dated: false }),
		).toEqual([]);
		// An expired acceptance: same.
		const expired = {
			version: '5.7.284',
			advisories: [
				inRangeAdvisory({
					reason_code: 'feature_absent',
					reason: 'x'.repeat(50),
					assessed: '2020-01-01',
					expires: '2020-06-01',
					evidence: 'audits/2026-08-26_deep/FINDINGS.md',
					verify: [{ file: 'vendor/vendor_manifest.json', must_contain: 'tree_sha256' }],
				}),
			],
		};
		expect(checkSynthetic(expired).join('\n')).toContain('EXPIRED on 2020-06-01');
		expect(checkSynthetic(expired, { dated: false })).toEqual([]);
		// ...and every TREE-ONLY leg still fires with the calendar off — the split may not
		// become a way past an in-range advisory, a failed clause or a missing date.
		expect(
			checkSynthetic(
				{ version: '5.7.284', advisories: [inRangeAdvisory(null)] },
				{ dated: false },
			).join('\n'),
		).toContain('is INSIDE published advisory');
		expect(
			checkSynthetic(
				{
					version: '5.7.284',
					advisories: [
						inRangeAdvisory({
							reason_code: 'feature_absent',
							reason: 'x'.repeat(50),
							assessed: '2026-08-28',
							expires: '2027-02-28',
							evidence: 'audits/2026-08-26_deep/FINDINGS.md',
							verify: [{ file: 'vendor/vendor_manifest.json', must_not_contain: 'tree_sha256' }],
						}),
					],
				},
				{ dated: false },
			).join('\n'),
		).toContain('FAILED');
		expect(
			checkSynthetic({ version: '6.2.108', reviewed: 'not-a-date' }, { dated: false }).join('\n'),
		).toContain('not a parseable date');
	});

	test('the warning starts VENDOR_WINDOW_WARNING_DAYS (21) before a review window closes, and stops when it has closed', () => {
		expect(VENDOR_WINDOW_WARNING_DAYS).toBe(21);
		// TODAY is 2026-08-28; the synthetic row's window is 90 days.
		const warnFor = (reviewed: string) =>
			vendorWindowWarningsIn(syntheticManifest({ version: '6.2.108', reviewed }), TODAY);
		// 69 days old → 21 left: the first warning day.
		expect(warnFor('2026-06-20').join('\n')).toContain('closes in 21 days');
		// 68 days old → 22 left: not yet.
		expect(warnFor('2026-06-21')).toEqual([]);
		// 90 days old → 0 left: the last day, still a warning and still NOT red.
		expect(warnFor('2026-05-30').join('\n')).toContain('closes in 0 days');
		expect(checkSynthetic({ version: '6.2.108', reviewed: '2026-05-30' })).toEqual([]);
		// 91 days old → closed: a problem (red), never also a warning.
		expect(warnFor('2026-05-29')).toEqual([]);
		expect(checkSynthetic({ version: '6.2.108', reviewed: '2026-05-29' }).join('\n')).toContain(
			'past its 90-day window',
		);
		// A lead time is a parameter the nightly dispatch can lower or raise.
		expect(
			vendorWindowWarningsIn(
				syntheticManifest({ version: '6.2.108', reviewed: '2026-08-01' }),
				TODAY,
				70,
			).join('\n'),
		).toContain('closes in 63 days');
		expect(() =>
			vendorWindowWarningsIn(syntheticManifest({ version: '6.2.108' }), TODAY, -1),
		).toThrow();
	});

	test('an acceptance that still bites warns before it expires; one that no longer bites does not', () => {
		const accepted = (expires: string) =>
			inRangeAdvisory({
				reason_code: 'feature_absent',
				reason: 'x'.repeat(50),
				assessed: '2026-08-01',
				expires,
				evidence: 'audits/2026-08-26_deep/FINDINGS.md',
				verify: [{ file: 'vendor/vendor_manifest.json', must_contain: 'tree_sha256' }],
			});
		const warn = (version: string, expires: string) =>
			vendorWindowWarningsIn(
				syntheticManifest({ version, advisories: [accepted(expires)] }),
				TODAY,
			).join('\n');
		expect(warn('5.7.284', '2026-09-18')).toContain('expires in 21 days');
		expect(warn('5.7.284', '2026-09-19')).toBe('');
		expect(warn('5.7.284', '2026-08-28')).toContain('expires in 0 days');
		expect(warn('5.7.284', '2026-08-27')).toBe(''); // expired → a problem, not a warning
		// Out of range: the acceptance is a static problem already; no second voice.
		expect(warn('6.2.108', '2026-09-01')).toBe('');
	});

	test('the committed manifest is parsed by the warning function without throwing', () => {
		// Not an assertion that nothing is close (that is the calendar, and nightly's job):
		// only that the real rows are within the function's grammar.
		expect(Array.isArray(vendorWindowWarningsIn(readManifest(), new Date()))).toBe(true);
	});
});

describe('vendor advisory tripwire — when the push gate runs the audit', () => {
	const isTrigger = auditTriggerMatcher(['publication/server_api/v1/docu/ui/swagger-ui']);
	const decide = (
		changed: readonly string[] | null,
		extra: Partial<{ force: boolean; given: boolean }> = {},
	) =>
		auditRunDecision({
			force: extra.force ?? false,
			changedSinceGiven: extra.given ?? true,
			reference: 'abc123',
			changed,
			isTrigger,
		});

	test('every lockfile, every package.json, vendor/, a manifest root and the audit inputs trigger it', () => {
		for (const path of [
			'bun.lock',
			'package.json',
			'publication/site_builder/bun.lock',
			'publication/site_builder/templates/basic/package.json',
			'publication/server_api/v2/package.json',
			'vendor/vendor_manifest.json',
			'vendor/pdfjs/web/viewer.mjs',
			'publication/server_api/v1/docu/ui/swagger-ui/swagger-ui-bundle.js',
			'engineering/dependency_audit_baseline.json',
			'scripts/ci/audit.ts',
			'scripts/vendor_verify.ts',
			'scripts/lib/reason_validator.ts',
			'.bun-version',
		]) {
			expect(isTrigger(path), path).toBe(true);
		}
		for (const path of [
			'src/core/section/read.ts',
			'client/dedalo/core/component_pdf/js/view_default_edit_pdf.js',
			'vendorish/x.js',
			'node_modules/foo/package.json',
			'docs/package.json.md',
		]) {
			expect(isTrigger(path), path).toBe(false);
		}
	});

	test('a push that touched none of its inputs SKIPS, and says where the time-based half runs', () => {
		const skipped = decide(['src/core/section/read.ts', 'test/unit/x.test.ts']);
		expect(skipped.run).toBe(false);
		expect(skipped.why).toContain('abc123');
		expect(skipped.why).toContain('nightly.yml');
		expect(skipped.why).toContain('DEDALO_CI_FORCE_AUDIT=1');
	});

	test('a push that touched one RUNS, and names it', () => {
		const ran = decide(['src/a.ts', 'publication/site_builder/bun.lock']);
		expect(ran.run).toBe(true);
		expect(ran.why).toContain('publication/site_builder/bun.lock');
	});

	test('FAIL-SAFE: an undiffable base RUNS — never read as an empty change set', () => {
		expect(decide(null).run).toBe(true);
		// ...while a genuinely empty diff is a skip (the base resolved, nothing changed).
		expect(decide([]).run).toBe(false);
	});

	test('force and a bare invocation always run', () => {
		expect(decide(['src/a.ts'], { force: true }).run).toBe(true);
		expect(decide(['src/a.ts'], { given: false }).run).toBe(true);
	});
});

describe('vendor advisory tripwire — the pdf.js mount keeps the advisory workaround', () => {
	// The vendored bump is the fix; this is the part that survives a revert. The
	// advisory's own Workarounds section is "Set enableScripting to false", and the
	// manifest note CLAIMS the mount does it — a claim in the tree gets a gate.
	const MOUNT = 'client/dedalo/core/component_pdf/js/view_default_edit_pdf.js';

	/** Source with `//` line comments removed — a scan that reads prose is a scan that lies. */
	function codeOnly(text: string): string {
		return text
			.split('\n')
			.map((line) => {
				const at = line.indexOf('//');
				return at === -1 ? line : line.slice(0, at);
			})
			.join('\n');
	}

	/** A line that turns PDF scripting ON. Narrow on purpose: naming the option in a comment or an error message is not setting it. */
	function turnsScriptingOn(line: string): boolean {
		return /enableScripting["']?\s*(,|:|=)\s*(true|!0)/.test(line);
	}

	/** The vendored viewer bundle, read once — several assertions below index into it. */
	const VIEWER = readFileSync(join(REPO_ROOT, 'vendor/pdfjs/web/viewer.mjs'), 'utf-8');

	/**
	 * Run `fn` with `console.warn` muted, and always put it back.
	 *
	 * The vendored `_checkDisablePreferences()` warns by design when preferences are
	 * still enabled after a manual set — which is the exact state two controls below
	 * assert. Muting it keeps the suite's output about the suite; the try/finally is
	 * what stops a throw from leaving the next file's warnings on the floor.
	 */
	function withoutConsoleWarn<T>(fn: () => T): T {
		const original = console.warn;
		console.warn = (): void => {};
		try {
			return fn();
		} finally {
			console.warn = original;
		}
	}

	/**
	 * Evaluate the vendored viewer's own `web/app_options.js` chunk and hand back what
	 * it defines.
	 *
	 * WHY EVALUATE RATHER THAN READ. Every other assertion here proves a STRING is
	 * present. The mitigation is a BEHAVIOUR — "the option we set is the option the
	 * viewer reads, and setting it changes what the viewer would do" — and a string is
	 * not that. AppOptions silently ignores an unknown name and a type mismatch, so the
	 * difference between a working control and a no-op is invisible to any grep.
	 *
	 * The slice is bounded by the bundle's own chunk markers, so it is the whole module
	 * and nothing else, and a fresh evaluation per call means no test can see another's
	 * mutations. `navigator` is the only global the chunk touches (a UA sniff for
	 * mobile canvas limits, and `navigator.language` for a default); it is stubbed so
	 * the control is deterministic rather than dependent on whatever Bun exposes.
	 */
	function loadVendoredAppOptions(): {
		// biome-ignore lint/suspicious/noExplicitAny: the shape is upstream's, not ours — the assertions are the contract.
		AppOptions: any;
		// biome-ignore lint/suspicious/noExplicitAny: as above.
		OptionKind: any;
		// biome-ignore lint/suspicious/noExplicitAny: as above.
		defaultOptions: any;
	} {
		const start = VIEWER.indexOf(';// ./web/app_options.js');
		const end = VIEWER.indexOf(';// ./web/pdfjs.js');
		expect(start, 'the app_options chunk marker moved — re-read the viewer').toBeGreaterThan(-1);
		expect(end, 'the chunk after app_options moved — re-read the viewer').toBeGreaterThan(start);
		const chunk = VIEWER.slice(start, end);
		// Anti-vacuity: an empty or truncated slice would evaluate to nothing and every
		// assertion below would then be about a stub of our own making.
		expect(chunk).toContain('class AppOptions');
		expect(chunk).toContain('static setAll(options, prefs = false)');
		const factory = new Function(
			'navigator',
			`${chunk}\nreturn { AppOptions, OptionKind, defaultOptions };`,
		);
		return factory({
			maxTouchPoints: 0,
			platform: 'Linux x86_64',
			userAgent: 'dedalo-vendor-advisory-tripwire',
			language: 'en-US',
		});
	}

	test('the viewer mount forces enableScripting off, before any await', () => {
		const source = readFileSync(join(REPO_ROOT, MOUNT), 'utf-8');
		expect(source).toContain("pdf_viewer_options.set('enableScripting', false)");

		// And the line that makes it STICK. PDF.js reads localStorage['pdfjs.preferences']
		// and AppOptions.setAll()s it after this handler runs, so without
		// disablePreferences the control above is silently overridden by same-origin
		// browser state — measured, not theorised (2026-08-28, pdf.js 6.2.108: the
		// viewer came up with scripting ON and a scripting manager attached).
		expect(source).toContain("pdf_viewer_options.set('disablePreferences', true)");
		expect(
			source.indexOf("set('disablePreferences', true)"),
			'disablePreferences must be set before enableScripting',
		).toBeLessThan(source.indexOf("set('enableScripting', false)"));

		// The ORDER is load-bearing, not decorative: PDF.js dispatches 'webviewerloaded'
		// and calls run() on the next statement, so an await between the event and the
		// set() would write the option into a viewer that is already constructing.
		// Comments are stripped first — the comment that EXPLAINS the race contains the
		// word `await`, and a scan that counted it would fail on its own documentation.
		const code = codeOnly(source);
		const handler = code.slice(code.indexOf('const fn_webviewerloaded'));
		const setAt = handler.indexOf("set('enableScripting', false)");
		const awaitAt = handler.indexOf('await ');
		expect(setAt).toBeGreaterThan(-1);
		expect(
			awaitAt === -1 || setAt < awaitAt,
			'enableScripting must be set before the handler awaits anything',
		).toBe(true);
	});

	test('nothing in the client turns PDF scripting back on', () => {
		// TOTAL over the component's own js: a second mount path that set it true would
		// reopen the precondition while this gate stayed green on the first one.
		const dir = join(REPO_ROOT, 'client/dedalo/core/component_pdf/js');
		const offenders: string[] = [];
		let scanned = 0;
		for (const name of readdirSync(dir)) {
			if (!name.endsWith('.js')) continue;
			scanned++;
			for (const line of codeOnly(readFileSync(join(dir, name), 'utf-8')).split('\n')) {
				if (turnsScriptingOn(line)) offenders.push(`${name}: ${line.trim()}`);
			}
		}
		// Anti-empty guard: a renamed directory must be a red, not a green over nothing.
		expect(scanned).toBeGreaterThan(0);
		expect(offenders).toEqual([]);
	});

	test('POSITIVE CONTROL — the scan catches every shape that turns scripting on, and no comment', () => {
		// Constructed inputs, because a scan is only worth what it refuses.
		expect(turnsScriptingOn("options.set('enableScripting', true)")).toBe(true);
		expect(turnsScriptingOn('options.set("enableScripting", true);')).toBe(true);
		expect(turnsScriptingOn('  enableScripting: true,')).toBe(true);
		expect(turnsScriptingOn('const enableScripting = true')).toBe(true);
		expect(turnsScriptingOn('enableScripting:!0')).toBe(true);
		expect(turnsScriptingOn("options.set('enableScripting', false)")).toBe(false);
		expect(turnsScriptingOn("console.error('enableScripting could not be forced off')")).toBe(
			false,
		);
		// And the comment stripper, on the exact shape that fooled the first draft of
		// this gate: the WHY-comment above the set() call contains the word `await`.
		expect(codeOnly('	x() // an await here yields a microtask').trim()).toBe('x()');
	});

	test('the vendored viewer still defaults enableScripting to TRUE (the reason the line exists)', () => {
		// If upstream ever flipped the default, this assertion is what tells us the
		// mitigation became redundant — instead of the comment quietly going stale.
		const at = VIEWER.indexOf('"enableScripting", {');
		expect(at).toBeGreaterThan(-1);
		expect(VIEWER.slice(at, at + 120)).toContain('value: true');
	});

	test('the vendored viewer still HAS disablePreferences, and prefs cannot switch it off', () => {
		// The SECOND upstream fact the mitigation rests on, and until the CLI-26 review
		// nothing asserted it: `pdf_viewer_options.set('disablePreferences', true)` on an
		// upstream that dropped the option is a silent no-op — AppOptions.setAll() skips
		// any name that is not in `defaultOptions` — and enableScripting would then be
		// quietly overridden by a stored preference with this gate still green.
		const at = VIEWER.indexOf('"disablePreferences", {');
		expect(at).toBeGreaterThan(-1);
		const declaration = VIEWER.slice(at, at + 120);
		expect(declaration).toContain('value: false');
		// VIEWER-kind, NOT PREFERENCE-kind: an option a stored preference could itself
		// set would be a guard the thing it guards can disarm.
		expect(declaration).toContain('kind: OptionKind.VIEWER\n}');
	});

	test('enableScripting is PREFERENCE-kind — which is WHY disablePreferences is load-bearing', () => {
		// State the reason mechanically instead of in a comment. If upstream ever made
		// enableScripting non-PREFERENCE, the stored-preference override disappears and
		// this gate says so rather than leaving two lines of prose to rot.
		const at = VIEWER.indexOf('"enableScripting", {');
		expect(VIEWER.slice(at, at + 120)).toContain('OptionKind.PREFERENCE');
	});

	test('the viewer applies stored preferences ONLY past the disablePreferences guard', () => {
		// The structural half: find the one call that applies preferences
		// (`AppOptions.setAll({...browserPrefs, ...prefs}, true)`) and prove the guard
		// stands immediately before it. A future upstream that reordered these would
		// leave the mount setting an option nothing consults.
		const applyAt = VIEWER.indexOf('AppOptions.setAll({\n        ...browserPrefs,');
		expect(applyAt, 'the preference-application call moved — re-read the viewer').toBeGreaterThan(
			-1,
		);
		const before = VIEWER.slice(Math.max(0, applyAt - 200), applyAt);
		expect(before).toContain('if (AppOptions._checkDisablePreferences()) {');
		expect(before).toContain('return;');
	});

	test('POSITIVE CONTROL — the vendored AppOptions, EXECUTED: setAll takes effect and the guard trips', () => {
		// Everything above reads bytes. This RUNS them: the `web/app_options.js` chunk of
		// the vendored viewer, evaluated with a stub `navigator` (the only global it
		// touches), so the mitigation is proved on the real implementation instead of
		// being asserted by hope. No mock, no re-implementation.
		const { AppOptions, OptionKind, defaultOptions } = loadVendoredAppOptions();

		// 1. the default really is ON — the reason the mount sets anything at all.
		expect(AppOptions.get('enableScripting')).toBe(true);
		expect(AppOptions.get('disablePreferences')).toBe(false);

		// 2. THE CONTROL THE REVIEW ASKED FOR: the mount's own call shape takes effect.
		//    `AppOptions.set(name, value)` delegates to setAll({[name]: value}), and setAll
		//    silently SKIPS an unknown name or a type mismatch — so "the option is set" is
		//    a claim until the getter answers.
		AppOptions.set('enableScripting', false);
		expect(AppOptions.get('enableScripting')).toBe(false);

		// 3. and the hole it does NOT close on its own: a preference write — exactly what
		//    the viewer does with localStorage['pdfjs.preferences'] — puts it back.
		AppOptions.setAll({ enableScripting: true }, true);
		expect(
			AppOptions.get('enableScripting'),
			'a PREFERENCE-kind write must be able to override a manual set — if it cannot, disablePreferences is redundant and this gate should say so',
		).toBe(true);

		// 4. which is what disablePreferences stops: with it set, the guard the viewer's
		//    Preferences constructor consults returns true and that setAll never happens.
		expect(withoutConsoleWarn(() => AppOptions._checkDisablePreferences())).toBe(false);
		AppOptions.set('disablePreferences', true);
		expect(AppOptions._checkDisablePreferences()).toBe(true);

		// 5. the kinds, read off the executed module rather than off a regex: the option
		//    prefs can reach, and the guard they cannot.
		expect(defaultOptions.get('enableScripting').kind & OptionKind.PREFERENCE).toBe(
			OptionKind.PREFERENCE,
		);
		expect(defaultOptions.get('disablePreferences').kind & OptionKind.PREFERENCE).toBe(0);
	});

	test('POSITIVE CONTROL — an unknown option name is silently dropped by setAll', () => {
		// The failure shape the assertion above exists to catch, demonstrated: this is
		// what `set('disablePreferences', …)` would do on an upstream that removed the
		// option — no throw, no warning, no effect.
		const { AppOptions } = loadVendoredAppOptions();
		AppOptions.set('disablePreferencesTypo', true);
		expect(AppOptions.get('disablePreferencesTypo')).toBe(undefined);
		expect(withoutConsoleWarn(() => AppOptions._checkDisablePreferences())).toBe(false);
	});
});

describe('vendor advisory tripwire — positive controls', () => {
	test('the range grammar the advisory feed actually emits', () => {
		// The real CLI-26 range, and the real ckeditor one.
		expect(versionInRange('5.7.284', '>= 5.6.83, < 6.2.108')).toBe(true);
		expect(versionInRange('6.2.108', '>= 5.6.83, < 6.2.108')).toBe(false);
		expect(versionInRange('5.6.82', '>= 5.6.83, < 6.2.108')).toBe(false);
		expect(versionInRange('5.6.83', '>= 5.6.83, < 6.2.108')).toBe(true);
		expect(versionInRange('42.0.1', '>= 29.0.0, < 47.6.0')).toBe(true);
		expect(versionInRange('47.6.0', '>= 29.0.0, < 47.6.0')).toBe(false);
		// Single-clause and equality forms.
		expect(versionInRange('1.2.3', '< 2.0.0')).toBe(true);
		expect(versionInRange('1.2.3', '> 1.2.3')).toBe(false);
		expect(versionInRange('1.2.3', '<= 1.2.3')).toBe(true);
		expect(versionInRange('1.2.3', '= 1.2.3')).toBe(true);
		// Numeric, never lexical: "5.7.284" < "6.2.108" and "1.2.10" > "1.2.9".
		expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
		expect(compareVersions('5.7.284', '6.2.108')).toBe(-1);
		// A prerelease sorts below its own release, which is what `< 6.2.108` means.
		expect(compareVersions('6.2.108-rc.1', '6.2.108')).toBe(-1);
	});

	test('an unparseable version or range THROWS rather than passing', () => {
		// The failure that would matter most: a shape we do not understand must never
		// read as "outside the range".
		expect(() => parseVersion('5.7')).toThrow();
		expect(() => parseVersion('v5.7.284')).toThrow();
		expect(() => versionInRange('1.0.0', '~> 1.0')).toThrow();
		expect(() => versionInRange('1.0.0', '')).toThrow();
	});

	test('CONSTRUCTED RED — an in-range advisory with no acceptance is refused', () => {
		// The exact CLI-26 shape, run through the checker's own decision function on a
		// synthetic manifest so the control does not depend on the tree being broken.
		const problems = checkSynthetic({
			version: '5.7.284',
			advisories: [inRangeAdvisory(null)],
		});
		expect(problems.length).toBeGreaterThan(0);
		expect(problems.join('\n')).toContain('is INSIDE published advisory');
		expect(problems.join('\n')).toContain('6.2.108');
	});

	test('CONSTRUCTED RED — an acceptance whose verify clause no longer holds is refused', () => {
		const problems = checkSynthetic({
			version: '5.7.284',
			advisories: [
				inRangeAdvisory({
					reason_code: 'feature_absent',
					reason: 'x'.repeat(50),
					assessed: '2026-08-28',
					expires: '2027-02-28',
					evidence: 'audits/2026-08-26_deep/FINDINGS.md',
					// This string IS in that file — so a must_not_contain clause over it must fail.
					verify: [{ file: 'vendor/vendor_manifest.json', must_not_contain: 'tree_sha256' }],
				}),
			],
		});
		expect(problems.join('\n')).toContain('acceptance of GHSA-hq66-cqwq-w95j FAILED');
	});

	test('CONSTRUCTED RED — an expired acceptance is refused even when its clause holds', () => {
		const problems = checkSynthetic({
			version: '5.7.284',
			advisories: [
				inRangeAdvisory({
					reason_code: 'feature_absent',
					reason: 'x'.repeat(50),
					assessed: '2020-01-01',
					expires: '2020-06-01',
					evidence: 'audits/2026-08-26_deep/FINDINGS.md',
					verify: [{ file: 'vendor/vendor_manifest.json', must_contain: 'tree_sha256' }],
				}),
			],
		});
		expect(problems.join('\n')).toContain('EXPIRED on 2020-06-01');
	});

	test('CONSTRUCTED RED — an acceptance with no verify clause is a rubber stamp', () => {
		const problems = checkSynthetic({
			version: '5.7.284',
			advisories: [
				inRangeAdvisory({
					reason_code: 'feature_absent',
					reason: 'x'.repeat(50),
					assessed: '2026-08-28',
					expires: '2027-02-28',
					evidence: 'audits/2026-08-26_deep/FINDINGS.md',
					verify: [],
				}),
			],
		});
		expect(problems.join('\n')).toContain('rubber stamp');
	});

	test('CONSTRUCTED RED — a lapsed review window fails, and one inside it does not', () => {
		// Date arithmetic proved on constructed inputs, not by waiting for a calendar.
		const lapsed = checkSynthetic({ version: '6.2.108', reviewed: '2026-01-01' });
		expect(lapsed.join('\n')).toContain('past its 90-day window');
		const fresh = checkSynthetic({ version: '6.2.108', reviewed: '2026-08-01' });
		expect(fresh).toEqual([]);
	});

	test('CONSTRUCTED RED — a reason code outside the closed set is refused', () => {
		const problems = checkSynthetic({
			version: '5.7.284',
			advisories: [
				inRangeAdvisory({
					reason_code: 'looks_fine_to_me' as never,
					reason: 'x'.repeat(50),
					assessed: '2026-08-28',
					expires: '2027-02-28',
					evidence: 'audits/2026-08-26_deep/FINDINGS.md',
					verify: [{ file: 'vendor/vendor_manifest.json', must_contain: 'tree_sha256' }],
				}),
			],
		});
		expect(problems.join('\n')).toContain('is not one of');
		expect(ADVISORY_REASON_CODES).not.toContain('looks_fine_to_me' as never);
	});

	test('CONSTRUCTED RED — an out-of-range advisory may not keep its acceptance', () => {
		// Otherwise a later downgrade inherits a decision nobody made about it.
		const problems = checkSynthetic({
			version: '6.2.108',
			advisories: [
				inRangeAdvisory({
					reason_code: 'feature_absent',
					reason: 'x'.repeat(50),
					assessed: '2026-08-28',
					expires: '2027-02-28',
					evidence: 'audits/2026-08-26_deep/FINDINGS.md',
					verify: [{ file: 'vendor/vendor_manifest.json', must_contain: 'tree_sha256' }],
				}),
			],
		});
		expect(problems.join('\n')).toContain('still carries an acceptance');
	});

	test('CONSTRUCTED RED — a drifted human/machine version pair is refused', () => {
		const problems = checkSynthetic({ version: '6.2.108', humanVersion: '5.7.284' });
		expect(problems.join('\n')).toContain('have drifted');

		// The prose field may WRAP the version (ckeditor's row reads "CKEditor 5 42.0.1
		// (custom Dédalo build)"), so the match is bounded rather than exact...
		expect(
			checkSynthetic({ version: '42.0.1', humanVersion: 'CKEditor 5 42.0.1 (custom build)' }),
		).toEqual([]);
		// ...and bounded rather than a bare substring: 1.2.1 is inside 1.2.10.
		expect(checkSynthetic({ version: '1.2.1', humanVersion: '1.2.10' }).join('\n')).toContain(
			'have drifted',
		);
	});
});

describe('vendor advisory tripwire — the human-facing table says what the manifest says', () => {
	// CLI-26's review found docs/development/vendored_library_versions.md still listing
	// pdfjs 5.7.284 the day the tree became 6.2.108. Fixing that sentence is worth one
	// day; gating it is worth every bump after. Only the VENDORED rows are covered here
	// — the doc's npm rows are GENERATED from package.json + the client-lib registry and
	// byte-gated by client_lib_versions_doc_tripwire (2026-10-02).
	const DOC = 'docs/development/vendored_library_versions.md';

	test('every vendored row in the doc table carries the manifest version', () => {
		const text = readFileSync(join(REPO_ROOT, DOC), 'utf-8');
		// The table's vendored rows: `| <id> | *(vendor)* | <version> | …`
		const rows = new Map<string, string>();
		for (const line of text.split('\n')) {
			const match = /^\|\s*([a-z0-9-]+)\s*\|\s*\*\(vendor\)\*\s*\|\s*([^|]*?)\s*\|/.exec(line);
			if (match !== null) rows.set(match[1] as string, match[2] as string);
		}
		const libs = readManifest().libs;
		// Anti-vacuity in both directions: a renamed table column, a reworded cell or a
		// row silently dropped must be a red, not a green over an empty map.
		expect([...rows.keys()].sort(), 'the doc table no longer lists every vendored lib').toEqual(
			Object.keys(libs).sort(),
		);

		const drifted: string[] = [];
		for (const [id, cell] of rows) {
			const entry = libs[id];
			if (entry === undefined) continue;
			const declared = entry.advisory?.version;
			if (typeof declared !== 'string') {
				// An unkeyable row (json-view) has no version to compare. The doc must not
				// invent one — an em dash is the honest cell, and a number here would be a
				// claim the manifest itself refuses to make.
				if (/\d+\.\d+/.test(cell))
					drifted.push(`${id}: doc says "${cell}", manifest has no version`);
				continue;
			}
			if (!cell.includes(declared)) {
				drifted.push(`${id}: doc says "${cell}", manifest declares "${declared}"`);
			}
		}
		expect(drifted, `${DOC} has drifted from vendor/vendor_manifest.json`).toEqual([]);
	});
});

describe('vendor advisory tripwire — the CI network policy', () => {
	// The networked arm lives in scripts/ci/audit.ts and cannot run here (bun test is
	// credless and hermetic). Its POLICY can, and must: the first draft treated ANY
	// non-ok HTTP as a vulnerability, and that script runs from scripts/ci/hermetic.sh
	// against an endpoint that is anonymous at 60 requests/hour PER IP. On a shared
	// runner an exhausted quota would have failed the tier and named a vulnerability
	// that did not exist — and a security gate that cries wolf gets commented out,
	// which is how this repo lost 45 commits of signal once already.

	test('a feed that will not serve us right now is DEGRADED, never a finding', () => {
		// 403 is the status GitHub returns for the anonymous per-IP limit — reproduced
		// against the live API on 2026-08-28 by exhausting it (`remaining 0`), which is
		// exactly the shape that used to red a build.
		expect(classifyAdvisoryFeedStatus(403)).toBe('degraded');
		expect(classifyAdvisoryFeedStatus(429)).toBe('degraded');
		expect(classifyAdvisoryFeedStatus(408)).toBe('degraded');
		for (const status of [500, 502, 503, 504]) {
			expect(classifyAdvisoryFeedStatus(status)).toBe('degraded');
		}
	});

	test('a feed that REFUSES our request is RED — that half is ours', () => {
		// Measured against the live API, 2026-08-28: a bad ecosystem answers 422, a moved
		// URL shape 404, a rejected token 401. None of those is a network condition, and
		// letting them hide behind the word "offline" would be the silent narrowing the
		// degraded branch is otherwise accused of.
		expect(classifyAdvisoryFeedStatus(422)).toBe('red');
		expect(classifyAdvisoryFeedStatus(404)).toBe('red');
		expect(classifyAdvisoryFeedStatus(401)).toBe('red');
		expect(classifyAdvisoryFeedStatus(400)).toBe('red');
		expect(classifyAdvisoryFeedStatus(410)).toBe('red');
		// Default for an unlisted 4xx is RED: an unclassified client error is our
		// request, and the safe direction for an unknown is to be looked at.
		expect(classifyAdvisoryFeedStatus(418)).toBe('red');
	});

	test('the review window is what a degraded lookup cannot postpone', () => {
		// The load-bearing half of tolerating a degraded lookup: what it loses is only
		// DISCOVERY. The committed ledger and the per-row window still hard-fail offline,
		// so a permanently rate-limited runner cannot silently drop the axis — it can
		// only defer the search for advisories nobody has ledgered yet.
		const lapsed = checkSynthetic({ version: '6.2.108', reviewed: '2026-01-01' });
		expect(lapsed.join('\n')).toContain('past its 90-day window');
		// And that window is real data, not a placeholder: pdfjs, the actively-released
		// tree, carries the short one.
		const pdfjs = readManifest().libs.pdfjs;
		expect(pdfjs, 'the pdfjs row vanished — that is a red, not a skip').toBeDefined();
		expect(
			(pdfjs as { advisory: VendorAdvisoryBlock }).advisory.review_window_days,
		).toBeLessThanOrEqual(90);
	});
});

/* ── synthetic-manifest harness ──────────────────────────────────────────────
 * The controls call `checkVendorAdvisoriesIn`, which is the SAME function
 * `checkVendorAdvisories` (and therefore CI) runs — only with the manifest passed
 * in instead of read off disk. No mock, no second copy of the rules: a control that
 * exercised a re-implementation would prove nothing about the gate that ships.
 * ────────────────────────────────────────────────────────────────────────── */

const TODAY = new Date('2026-08-28T00:00:00Z');

/** The real CLI-26 advisory row, with whatever acceptance the control wants to test. */
function inRangeAdvisory(accepted: unknown): VendorAdvisoryRecord {
	return {
		id: 'GHSA-hq66-cqwq-w95j',
		cve: 'CVE-2026-16633',
		severity: 'high',
		published: '2026-08-06',
		vulnerable_range: '>= 5.6.83, < 6.2.108',
		first_patched_version: '6.2.108',
		summary: 'PDF.js: Arbitrary JavaScript execution upon opening a malicious PDF',
		accepted: accepted as VendorAdvisoryRecord['accepted'],
	};
}

type SyntheticRow = {
	version: string;
	humanVersion?: string;
	reviewed?: string;
	advisories?: VendorAdvisoryRecord[];
};

/** One synthetic pdfjs-shaped row, checked by the real checker. */
function checkSynthetic(options: SyntheticRow, check: VendorAdvisoryCheckOptions = {}): string[] {
	return checkVendorAdvisoriesIn(syntheticManifest(options), TODAY, check);
}

/** The synthetic manifest itself — shared by the checker and the warning-window controls. */
function syntheticManifest(options: SyntheticRow): VendorManifest {
	return {
		note: 'synthetic',
		libs: {
			pdfjs: {
				version: options.humanVersion ?? options.version,
				upstream: 'https://example.invalid/pdfjs.zip',
				archive_sha256: null,
				tree_sha256: '0'.repeat(64),
				files: 1,
				reviewed: options.reviewed ?? '2026-08-28',
				note: 'synthetic row used by the vendor_advisory_tripwire positive controls.',
				advisory: {
					ecosystem: 'npm',
					package: 'pdfjs-dist',
					version: options.version,
					unkeyable_reason: null,
					review_window_days: 90,
					advisories: options.advisories ?? [],
				},
				// Not the axis under test here; `checkEvidenceSynthetic` below drives it.
				version_evidence: {
					unprovable_reason:
						'synthetic row for the advisory controls — the version-binding axis has its own harness below.',
					clauses: [],
				},
				// Nor is the licence axis (dependency_integrity_tripwire drives it).
				licence: { spdx: 'Apache-2.0', file: 'LICENSE' },
			},
		},
	};
}

/**
 * One synthetic pdfjs-shaped row driven through the REAL version-evidence checker.
 *
 * The clauses point at the REAL vendored tree on purpose: a control that invented its
 * own files would prove the string comparison and nothing about the bytes this repo
 * actually ships.
 */
function checkEvidenceSynthetic(options: {
	version: string;
	clauses: VendorVersionEvidenceClause[];
	unprovable_reason?: string;
}): string[] {
	const manifest: VendorManifest = {
		note: 'synthetic',
		libs: {
			pdfjs: {
				version: options.version,
				upstream: 'https://example.invalid/pdfjs.zip',
				archive_sha256: null,
				tree_sha256: '0'.repeat(64),
				files: 1,
				reviewed: '2026-08-28',
				note: 'synthetic row used by the vendor_advisory_tripwire version-evidence controls.',
				advisory: {
					ecosystem: 'npm',
					package: 'pdfjs-dist',
					version: options.version,
					unkeyable_reason: null,
					review_window_days: 90,
					advisories: [],
				},
				version_evidence: {
					unprovable_reason: options.unprovable_reason ?? null,
					clauses: options.clauses,
				},
				licence: { spdx: 'Apache-2.0', file: 'LICENSE' },
			},
		},
	};
	return checkVendorVersionEvidenceIn(manifest);
}
