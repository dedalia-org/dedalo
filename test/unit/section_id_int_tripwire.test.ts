/**
 * SECTION_ID INT TRIPWIRE (WC-2026-08-10-section-id-int-canonical, D11).
 *
 * Two shrink-only ratchets guarding the int-canonical law:
 *
 * 1. WRITER SITES — `section_id: String(...)` / `section_id = String(...)`
 *    minting is allowed ONLY at the NAMED PERMANENT EXEMPTIONS below (each
 *    with its law). Everything else was fixed in the P2 flip; a NEW site is a
 *    recontamination source and fails here. No grandfathering.
 *
 * 2. TYPE DECLS — `section_id: number | string` unions, counted per file
 *    against a frozen ceiling. The P5/P6 burn-down DRAINS this list (lower a
 *    ceiling / remove a row when you narrow a type); raising a ceiling or
 *    adding a file requires editing the WC entry with the justification.
 *
 * Staleness self-test: an allowlist row whose file no longer matches at all is
 * itself a failure — dead rows hide real regressions behind a green gate.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src', 'tools'];

function walkTsFiles(dir: string, out: string[]): string[] {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stats = statSync(path);
		if (stats.isDirectory()) {
			if (entry === 'node_modules' || entry === 'samples') continue;
			walkTsFiles(path, out);
		} else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
			out.push(path);
		}
	}
	return out;
}

const files = ROOTS.flatMap((root) => walkTsFiles(root, []));

// ---------------------------------------------------------------------------
// Ratchet 1 — writer sites
// ---------------------------------------------------------------------------

const WRITER_PATTERN = /section_id\s*[:=]\s*String\(/;

/**
 * The NAMED PERMANENT EXEMPTIONS (WC entry "Pinned edges" + the probe/key
 * classes). value = max allowed matches in that file (shrink-only ceiling).
 */
const WRITER_EXEMPTIONS = new Map<string, { max: number; law: string }>([
	// The dual-probe VARIANT generator — the String form here is one leg of the
	// tolerance pair, not a producer.
	['src/core/search/containment.ts', { max: 1, law: 'dual-probe variant' }],
	// user_stats userLocatorFilterPair legacy leg — same class.
	['src/core/area_maintenance/user_stats.ts', { max: 1, law: 'dual-probe variant' }],
	// diffusion_delete legacy-shape probe leg (read-both tolerance, D16).
	['src/core/diffusion_bridge/diffusion_delete.ts', { max: 1, law: 'legacy probe leg' }],
	// Diffusion → MariaDB published bytes: external consumers, publication v1
	// PHP LIKE-probes the quoted form. Pinned edge, never "fixed".
	// Census refresh 2026-08-22 (WC entry addendum): fa11f2e440, 2026-08-13,
	// added legs INSIDE these already-named classes — the v6 index-edge
	// projection (rewriters 390/410), the pinned published-shape coercion
	// (resolver 846), the root-parent / relation-list StoredLocators that feed
	// the same publish (resolver 1349/1676), and the STRING leg of the
	// rootHierarchyParentId DUAL PROBE (resolver 1280, a read-tolerance pair —
	// same class as containment.ts, and the one leg here that DIES at
	// contraction, unlike the published shape which never does).
	['src/diffusion/resolve/rewriters.ts', { max: 4, law: 'MariaDB published shape' }],
	[
		'src/diffusion/resolve/resolver.ts',
		{ max: 4, law: 'MariaDB published shape + dual-probe variant' },
	],
	['src/diffusion/writers/markdown.ts', { max: 1, law: 'frontmatter published shape' }],
	// dedalo_ts_component_locks text-column KEY normalization (D14, tables only).
	['src/core/section/locks.ts', { max: 1, law: 'locks text-table key' }],
	// In-text person tag MARKER serialization (D18 — publication v1 consumes
	// the string bytes inside text scalars).
	['src/core/components/component_text_area/tags_persons.ts', { max: 1, law: 'inline tag marker' }],
	// (The four 'q-builder (drainable)' rows — record_scope, raw_view,
	// rag/retrieval, mcp/records_read — were drained to 0 in P5 and deleted.)
]);

// ---------------------------------------------------------------------------
// Ratchet 2 — number|string type decls (per-file ceilings, shrink-only)
// ---------------------------------------------------------------------------

const DECL_PATTERN = /section_id\??\s*:\s*(number\s*\|\s*string|string\s*\|\s*number)/g;

/**
 * Census 2026-08-10 (post-P5 drain: 42 files / 64 decls, from 52 files / 85
 * post-P2). Every remaining row is a KEPT union with its reason comment at the
 * decl (stored/wire/external-id shapes). The burn-down lowers these to zero.
 */
const DECL_CEILINGS = new Map<string, number>([
	['src/ai/identify/vision.ts', 1],
	['src/core/api/handlers/section_terms.ts', 1],
	['src/core/components/component_info/widgets/numisdata/get_coins_by_period.ts', 1],
	['src/core/components/component_info/widgets/widget_common.ts', 1],
	['src/core/components/component_text_area/tags_persons.ts', 1],
	['src/core/identify/types.ts', 1],
	['src/core/ontology/hierarchy_provision.ts', 1],
	['src/core/ontology/ontology_write.ts', 1],
	['src/core/ontology/parser.ts', 1],
	['src/core/relations/children.ts', 1],
	['src/core/relations/models/relation_related.ts', 1],
	['src/core/relations/parent.ts', 4],
	['src/core/relations/related.ts', 5],
	['src/core/relations/relation_core.ts', 1],
	['src/core/relations/request_config/filters.ts', 3],
	['src/core/relations/save.ts', 2],
	['src/core/resolve/component_data.ts', 1],
	['src/core/resolve/dd_info.ts', 4],
	['src/core/resolve/related_sections.ts', 1],
	['src/core/search/search_related.ts', 1],
	['src/core/section/indexation_grid.ts', 2],
	['src/core/section/read_facade.ts', 1],
	['src/core/section/record/delete_record.ts', 1],
	// observers.ts drained 2→0 (2026-10-30): its StoredLocator + peerBag moved to
	// external_laws/, plus the new DesiredLocator (a law's wanted item, copied from a
	// stored bag) — WC-2026-08-10-section-id-int-canonical § Addendum 2026-10-30 (external laws).
	['src/core/section/record/external_laws/inverse_search.ts', 1],
	['src/core/section/record/external_laws/types.ts', 2],
	['src/core/security/permissions.ts', 2],
	['src/core/tools/register.ts', 1],
	['src/core/tools/registry.ts', 2],
	['src/core/ts_object/node_repository.ts', 1],
	['src/core/ts_object/search.ts', 1],
	['src/core/ts_object/term_resolver.ts', 2],
	['src/core/ts_object/ts_object.ts', 1],
	['src/diffusion/export/atoms.ts', 2],
	['src/diffusion/jobs/queue.ts', 2],
	['src/diffusion/jobs/sse.ts', 1],
	['src/diffusion/parsers/parser_locator.ts', 1],
	['src/diffusion/parsers/types.ts', 1],
	['src/diffusion/resolve/resolver.ts', 2],
	['src/diffusion/targets/mediastore/media_index.ts', 1],
	['src/diffusion/writers/json.ts', 1],
	['tools/tool_import_files/server/index.ts', 2],
	['tools/tool_posterframe/server/index.ts', 1],
]);

describe('section_id int tripwire (WC-2026-08-10-section-id-int-canonical)', () => {
	test('the scan sees files (a zero-length pass is not a pass)', () => {
		expect(files.length).toBeGreaterThan(400);
	});

	test('writer sites: String(...) minting only at the named permanent exemptions', () => {
		const offenders: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, 'utf-8');
			const matches = text.split('\n').filter((line) => WRITER_PATTERN.test(line)).length;
			if (matches === 0) continue;
			const exemption = WRITER_EXEMPTIONS.get(file);
			if (exemption === undefined) {
				offenders.push(`${file}: ${matches} unexempted String(section_id) writer site(s)`);
			} else if (matches > exemption.max) {
				offenders.push(
					`${file}: ${matches} > ceiling ${exemption.max} (${exemption.law}) — a NEW string writer appeared`,
				);
			}
		}
		expect(
			offenders,
			'New string-form section_id writer(s). The canonical form is INT (canonicalizeStoredSectionId); ' +
				'a permanent exemption needs a WC-entry edit + a named row here.',
		).toEqual([]);
	});

	test('writer exemption rows are not stale', () => {
		const stale: string[] = [];
		for (const [file, exemption] of WRITER_EXEMPTIONS) {
			let matches = 0;
			try {
				matches = readFileSync(file, 'utf-8')
					.split('\n')
					.filter((line) => WRITER_PATTERN.test(line)).length;
			} catch {
				stale.push(`${file}: file gone`);
				continue;
			}
			if (matches === 0) stale.push(`${file}: no match left (${exemption.law}) — delete the row`);
		}
		expect(stale).toEqual([]);
	});

	test('type decls: number|string unions within the frozen per-file ceilings', () => {
		const offenders: string[] = [];
		for (const file of files) {
			const text = readFileSync(file, 'utf-8');
			const count = (text.match(DECL_PATTERN) ?? []).length;
			if (count === 0) continue;
			const ceiling = DECL_CEILINGS.get(file) ?? 0;
			if (count > ceiling) {
				offenders.push(`${file}: ${count} > ceiling ${ceiling}`);
			}
		}
		expect(
			offenders,
			'New section_id `number | string` union(s). New code takes the branded SectionId ' +
				'(concepts/section_id.ts) or a plain number; widen only via a WC-entry edit.',
		).toEqual([]);
	});

	test('decl ceilings are not stale (drained files leave the list)', () => {
		const stale: string[] = [];
		for (const [file, ceiling] of DECL_CEILINGS) {
			let count = 0;
			try {
				count = (readFileSync(file, 'utf-8').match(DECL_PATTERN) ?? []).length;
			} catch {
				stale.push(`${file}: file gone`);
				continue;
			}
			if (count === 0) stale.push(`${file}: drained to 0 — delete the row (ceiling ${ceiling})`);
		}
		expect(stale).toEqual([]);
	});
});
