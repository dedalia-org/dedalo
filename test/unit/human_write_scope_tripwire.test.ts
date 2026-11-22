/**
 * TRIPWIRE: human-tool write handlers scope-check EVERY record they write
 * (TOOLS-01, 2026-07-28 audit) — the human-registry counterpart of
 * mcp_write_scope_tripwire.
 *
 * tool_propagate_component_data checks a permission gate ONCE against the
 * client-declared (section_tipo, component_tipo), then writes to whatever rows a
 * separate client SQO returns — rows that can address a DIFFERENT, non-projects-
 * gated section (dd128 users) which buildSearchSql does not narrow. Without a
 * per-ROW authorization a tool-granted editor writes an arbitrary component
 * (dd515 developer, dd133 password) onto records they cannot reach → admin.
 *
 * A true behavioural proof needs a partial-grant principal + a cross-section
 * fixture; this is pinned as a SOURCE INVARIANT (deterministic + credless, the
 * pattern the audit remediations use): the write loop must authorize each row
 * (principalCanAccessRecord) BEFORE the per-record write. Deleting the
 * security lines fails here, not in production.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

describe('TOOLS-01 — propagate_component_data authorizes every write target', () => {
	const src = read('tools/tool_propagate_component_data/server/index.ts');

	test('the write loop asks the WRITE DOOR for each row before its record write', () => {
		// Scope to the per-row loop body: the run's OWN bulk-process bookkeeping
		// record (createBulkProcess) is written before it, and is not a
		// user-targeted data write — the loop over `rows` is the vulnerable write.
		// Since 2026-09-27 the per-record write is `propagateOneRecord(…)` (locked
		// read → saveComponentData under the run's bulk id,
		// WC-2026-09-27-bulk-revert-undo-log); since T2-S06 the row's write door is
		// `authorizeRow(principal, row, …)` (authorizeRecordAccess on the ROW's own
		// coordinates) and its GRANT is what the write is addressed with. The
		// OUTCOME (a refused row is never written; a section-0 profile is refused)
		// is measured by authz_door_matrix_native's propagate probe; this pins the
		// order in the source so the security line cannot drift below the write.
		const loopSrc = src.slice(src.indexOf('for (const row of rows)'));
		const doorAt = loopSrc.indexOf('authorizeRow(principal, row');
		const writeAt = loopSrc.indexOf('propagateOneRecord(grant');
		expect(doorAt, 'per-row authorizeRow(principal, row…) must exist in the loop').toBeGreaterThan(
			-1,
		);
		expect(
			writeAt,
			'the data write propagateOneRecord(grant…) must exist in the loop',
		).toBeGreaterThan(-1);
		// …and the helper is what writes: its body reaches the save door, and no
		// OTHER direct write door sits in the loop ahead of the door.
		const helper = src.slice(src.indexOf('async function propagateOneRecord('));
		expect(helper.slice(0, helper.indexOf('\n}\n')).includes('saveComponentData(')).toBe(true);
		for (const door of ['persistRecordKeys(', 'saveComponentData(', 'updateMatrixKeyData(']) {
			const at = loopSrc.indexOf(door);
			expect(at === -1 || at > doorAt, `${door} precedes the write door`).toBe(true);
		}
		expect(doorAt).toBeLessThan(writeAt);
	});

	test('the row door is the WRITE DOOR on the ROW section and record — no hand-rolled pair', () => {
		// The ACTUAL target section and record, not the client-declared section_tipo
		// (TOOLS-01); the write door carries the dd128 own-record rule (SEC-03) and
		// the section floor (T2-S06).
		const helper = src.slice(src.indexOf('async function authorizeRow('));
		const body = helper.slice(0, helper.indexOf('\n}\n'));
		expect(body.includes('authorizeRecordAccess(')).toBe(true);
		expect(body.includes('row.section_tipo') && body.includes('row.section_id')).toBe(true);
		expect(body.includes('sectionFloor: 1')).toBe(true);
		// The hand-rolled checks it replaced must not come back.
		for (const raw of [
			'getPermissions(',
			'getRecordComponentPermission(',
			'principalCanAccessRecord(',
		]) {
			expect(src.includes(raw), `${raw} is back in the propagate server`).toBe(false);
		}
	});
});

describe('TOOLS-02 — export applies the read ACL before it reads records', () => {
	const src = read('src/diffusion/export/grid.ts');

	test('read permission (Gate A+B) is checked BEFORE buildSearchSql', () => {
		// The tool gate only checks the DECLARED section; the export reads whatever
		// options.sqo targets and emits whatever ddo paths ask for. Without this,
		// dd133 password hashes / dd996 API keys (not projects-gated) leak.
		// The gates live in ONE function (assertExportDeclarationReadable), shared
		// with every re-check of a finished export. THE ORDER — gate before the
		// selection is built or read — is NOT a substring claim (a source-order pin
		// is exactly what authz_substring_gate_tripwire forbids): it is DRIVEN in
		// export_gate_b_native by TWO legs, one per half of the gate, each poisoning
		// the selection so whichever runs first answers: 'THE ORDER: the
		// declaration gate refuses BEFORE the selection is built or read' (the
		// ddo-SEGMENT half — a denied column) and 'THE ORDER, section half: the
		// in-walk per-SQO-section gate refuses BEFORE the selection is built or
		// read' (the SQO-SECTION half — readable columns, an unreadable SQO
		// section). Mutation-verified 2026-09-24: the per-SQO-section loop moved
		// after the selection query reds the section-half leg while the segment
		// leg stays green — which is why both exist. Only the decisions' location
		// is pinned here.
		expect(src.includes('buildSearchSql(sqo'), 'buildSearchSql read must exist').toBe(true);
		expect(
			src.includes('getPermissions(principal, targetSectionTipo, targetSectionTipo)'),
			'per-SQO-section getPermissions must exist',
		).toBe(true);
	});

	test('every exported ddo-path component is permission-checked', () => {
		expect(src.includes('getPermissions(principal, seg.section_tipo, seg.component_tipo)')).toBe(
			true,
		);
	});
});

// TOOLS-05 / TOOLS-06 used to be pinned here by SPELLING (`scopeIfRecordTargeted`,
// `gateRecord(mediaDdo, ctx, 1)`). Since closure Step 3 both decisions are the write
// door's (src/core/security/write_door.ts) and are DRIVEN, not spelled:
//   TOOLS-05 — the section / tipo kinds scope a named record, and refuse a garbage or
//              non-positive one: test/unit/write_door_native.test.ts legs e / f / b;
//   TOOLS-06 — automatic_transcription reads its media SOURCE through the write door's
//              READ mode: test/unit/tool_transcription_gate_native.test.ts, the two
//              legs whose identity PASSES the transcript's write gate and fails ONLY on
//              the source — "transcript writable (2), the AV at 0 → perm.denied ON
//              test94" (textOnly) and "ONLY the media record out of scope →
//              perm.out_of_scope ON that record". (Its NO_COMPONENT / OUT_OF_SCOPE
//              record-door legs are refused by the write gate first and say nothing
//              about the source.) Mutation TR6 (the media gate bypassed) reds both.
