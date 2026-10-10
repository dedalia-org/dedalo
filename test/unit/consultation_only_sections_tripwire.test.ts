/**
 * TRIPWIRE — consultation-only (read-only) sections are unwritable by EVERY
 * door, and stay so as the set grows.
 *
 * Some sections are for consultation only from a user's point of view: the
 * system logs (Activity dd542, Time Machine dd15) and any future section marked
 * strictly read-only. "The user can never modify the information" is the
 * directive; this test pins the two mechanical layers that enforce it, keyed on
 * the single source of truth CONSULTATION_ONLY_SECTIONS:
 *
 *   1. getSectionPermissions caps the SECTION-level permission at read (1),
 *      even for the superuser — so the create/duplicate/delete API gates
 *      (level >= 2) refuse and the client renders the section read-only. This
 *      MUST NOT leak into getPermissions itself, which stays a faithful mirror
 *      of PHP common::get_permissions (the differential parity contract).
 *   2. the write ENGINES (createSectionRecord / duplicateSectionRecord /
 *      deleteSectionRecord / deleteSectionData / saveComponentData) hard-refuse
 *      a write to these sections BEFORE touching the DB — the belt covering the
 *      MCP tools, the agent, and any future caller that reaches the engine
 *      directly.
 *   3. getSectionTools returns [] for a consultation-only section (TODO-042):
 *      a read-only log carries no section toolbar, since every tool it would
 *      offer acts on records the user can never modify.
 *   4. the CLIENT list views mount no other-buttons drawer/toggle for these
 *      sections — both read ONE shared NON_EDITABLE_SECTION_TIPOS list, so a
 *      tipo cannot be suppressed in one view and shown in the other.
 *
 * These assertions are pure (no DB, no PHP oracle): the superuser permission
 * path and every engine guard resolve before any I/O.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules): the NON-consultation control section is the phase-2 `test` clone (src/core/test_data/test_tld_tipo_map.json); the registry itself is seed-shipped dd.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Preload the component-model registry so buildStructureContext can resolve
// component models (the resolver requires it; server/test-preload entrypoints do).
import '../../src/core/components/registry.ts';
import {
	CONSULTATION_ONLY_SECTIONS,
	isConsultationOnlySection,
} from '../../src/core/concepts/section.ts';
import { buildStructureContext } from '../../src/core/resolve/structure_context.ts';
import { readSection } from '../../src/core/section/read.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import {
	deleteSectionData,
	deleteSectionRecord,
} from '../../src/core/section/record/delete_record.ts';
import { duplicateSectionRecord } from '../../src/core/section/record/duplicate_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import {
	getPermissions,
	getSectionPermissions,
	type Principal,
} from '../../src/core/security/permissions.ts';
import { getSectionTools } from '../../src/core/tools/registry.ts';
import { refusalOf } from '../helpers/refusal.ts';

// The superuser (user_id -1) resolves to level 3 WITHOUT any DB read — the ideal
// probe for the cap: the raw level is the maximum, so a capped value proves the
// cap fired rather than an absent grant.
const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: false };

describe('consultation-only sections are read-only for every door', () => {
	test('the registry is non-empty and includes Activity (dd542) + Time Machine (dd15)', () => {
		expect(CONSULTATION_ONLY_SECTIONS.size).toBeGreaterThanOrEqual(2);
		expect(isConsultationOnlySection('dd542')).toBe(true);
		expect(isConsultationOnlySection('dd15')).toBe(true);
		expect(isConsultationOnlySection('test6813')).toBe(false);
	});

	test('a consultation-only section offers NO section toolbar (TODO-042)', async () => {
		// Activity (dd542) + Time Machine (dd15) are strictly read-only system
		// logs (WC-010); their section toolbar would act on records no user may
		// modify, so getSectionTools returns [] before touching the registry or
		// the DB. Keyed on the same single source as the permission cap.
		// WC-2026-10-06-consultation-only-no-section-tools.
		for (const sectionTipo of CONSULTATION_ONLY_SECTIONS) {
			const { tools, ledgered } = await getSectionTools(sectionTipo);
			expect(tools).toEqual([]);
			expect(ledgered).toEqual([]);
		}
	});

	test('the no-toolbar rule is scoped to consultation-only sections', async () => {
		// Control: an ordinary section still resolves its section toolbar — a
		// blanket [] would pass the test above while breaking every other section.
		const normal = await getSectionTools('dd128'); // Users — a normal section
		expect(normal.tools.length).toBeGreaterThan(0);
	});

	test('getSectionPermissions caps every consultation-only section at read (1), even for the superuser', async () => {
		for (const sectionTipo of CONSULTATION_ONLY_SECTIONS) {
			expect(await getSectionPermissions(SUPERUSER, sectionTipo)).toBeLessThanOrEqual(1);
		}
	});

	test('the cap does NOT leak into getPermissions (PHP common::get_permissions fidelity)', async () => {
		// dd15 is separately hard-capped inside getPermissions (admin-only rule),
		// so probe fidelity with Activity, which getPermissions must NOT cap:
		// the superuser still reads level 3 there. The section-level cap lives
		// only in getSectionPermissions.
		expect(await getPermissions(SUPERUSER, 'dd542', 'dd542')).toBe(3);
		// A non-consultation section is never capped by getSectionPermissions.
		expect(await getSectionPermissions(SUPERUSER, 'test6813')).toBe(3);
	});

	// The engine backstops throw the TYPED refusal the API door throws
	// (`perm.denied`, ERRORS_SPEC §4); the sentence stays the log message.
	async function expectConsultationRefusal(run: Promise<unknown>): Promise<void> {
		const refusal = await refusalOf(run);
		expect(refusal.code).toBe('perm.denied');
		expect(refusal.message).toMatch(/consultation-only/);
	}

	test('createSectionRecord refuses a consultation-only section before any DB access', async () => {
		for (const sectionTipo of CONSULTATION_ONLY_SECTIONS) {
			await expectConsultationRefusal(createSectionRecord(sectionTipo, 1));
		}
	});

	test('duplicateSectionRecord refuses a consultation-only section', async () => {
		for (const sectionTipo of CONSULTATION_ONLY_SECTIONS) {
			await expectConsultationRefusal(duplicateSectionRecord(sectionTipo, 1, 1));
		}
	});

	test('deleteSectionRecord / deleteSectionData refuse a consultation-only section', async () => {
		for (const sectionTipo of CONSULTATION_ONLY_SECTIONS) {
			await expectConsultationRefusal(deleteSectionRecord(sectionTipo, 1, 1));
			await expectConsultationRefusal(deleteSectionData(sectionTipo, 1, 1));
		}
	});

	test('buildStructureContext caps client editability at read for a consultation-only section, even when handed admin level 3', async () => {
		// The record read path (section/read.ts, resolve/read_tm.ts) stamps a
		// COARSE per-request permission (3 for admins). This is the single
		// chokepoint that makes the client render the section read-only — every
		// element emitted for a consultation-only section must come back <= 1, so
		// the client's `disabled_component` path fires (permission < 2). This is
		// the assertion that would have caught the "'Who' column still editable"
		// regression (the section-level cap alone did not stop it).
		const activitySection = await buildStructureContext({
			tipo: 'dd542',
			sectionTipo: 'dd542',
			mode: 'list',
			lang: 'lg-nolan',
			permissions: 3,
		});
		expect(activitySection?.permissions).toBe(1);
		const activityWho = await buildStructureContext({
			tipo: 'dd132', // 'Who' — the exact component reported as editable
			sectionTipo: 'dd542',
			mode: 'list',
			lang: 'lg-nolan',
			permissions: 3,
		});
		expect(activityWho?.permissions).toBe(1);
		// Control: a NON-consultation section keeps the level it was handed —
		// the cap is scoped, not a blanket downgrade.
		const normal = await buildStructureContext({
			tipo: 'dd132',
			sectionTipo: 'dd64',
			mode: 'list',
			lang: 'lg-nolan',
			permissions: 3,
		});
		expect(normal?.permissions).toBe(3);
	});

	test('readSection emits NO editable element for a consultation-only section, including cross-section portal subdatum', async () => {
		// End-to-end: read the Activity (dd542) list as the superuser and assert
		// EVERY emitted ddo is <= 1. This covers the section's own columns AND the
		// 'Who' portal's username subdatum (dd132, whose own section is dd128/Users
		// and would otherwise inherit the admin-3 stamp and render editable — the
		// reported "section list still editable" bug). Requires the shared DB.
		const superuser: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: false };
		const rqo = {
			source: { tipo: 'dd542', section_tipo: 'dd542', mode: 'list' },
			sqo: { section_tipo: ['dd542'], limit: 5, offset: 0 },
		} as never;
		const { context } = await readSection(rqo, superuser);
		const ddos = (context as { typo?: string; tipo?: string; permissions?: number }[]).filter(
			(c) => c.typo === 'ddo',
		);
		expect(ddos.length).toBeGreaterThan(1); // real coverage, not a vacuous pass
		const editable = ddos.filter((c) => (c.permissions ?? 0) > 1);
		expect(editable).toEqual([]);
	});

	test('saveComponentData refuses a real-record save to a consultation-only section', async () => {
		for (const sectionTipo of CONSULTATION_ONLY_SECTIONS) {
			const result = await saveComponentData({
				componentTipo: 'dd577',
				sectionTipo,
				sectionId: 1,
				lang: 'lg-nolan',
				changedData: [],
				userId: 1,
			});
			expect(result.ok).toBe(false);
			expect(result.message).toMatch(/read-only/);
		}
	});
});

/**
 * THE CLIENT HALF (layer 4) — the same policy in the section list views. The
 * other-buttons drawer and its `show_other_buttons_button` toggle must be absent
 * for a consultation-only section. Both list views read ONE shared list
 * (`NON_EDITABLE_SECTION_TIPOS`, render_common_section.js), so a tipo added in
 * one place can never drift out of the other — the dd15 defect: dd542 was listed
 * in both views, dd15 in neither, so the Time Machine list kept a dead toggle
 * while Activity correctly had none.
 *
 * SOURCE SCAN, hermetic: these are browser modules (`window`/`get_label`
 * globals), so the assertion is on the served source, not an import.
 */
describe('consultation-only sections carry no other-buttons toggle (client list views)', () => {
	const sectionJs = join(import.meta.dir, '..', '..', 'client', 'dedalo', 'core', 'section', 'js');
	const read = (name: string): string => readFileSync(join(sectionJs, name), 'utf8');

	test('the shared list names Activity and Time Machine', () => {
		const src = read('render_common_section.js');
		const block = src.slice(src.indexOf('export const NON_EDITABLE_SECTION_TIPOS'));
		const list = block.slice(0, block.indexOf(']'));
		for (const tipo of ['dd542', 'dd15']) {
			expect(list, `${tipo} must be in NON_EDITABLE_SECTION_TIPOS`).toContain(`'${tipo}'`);
		}
	});

	test('the shared predicate also drops the toolbar for section_tool process pages (TODO-041)', () => {
		// A section_tool page (oh81 Transcription, …) reroutes to its target
		// section, so its section instance carries the TARGET's tipo — a tipo
		// list can never match. `is_non_tools_section` keys the second case on
		// `config.source_model === 'section_tool'`, the only surviving marker.
		const src = read('render_common_section.js');
		const block = src.slice(src.indexOf('export const is_non_tools_section'));
		const fn = block.slice(0, block.indexOf('\n}'));
		expect(fn, 'the section_tool marker must be in is_non_tools_section').toContain(
			"self?.config?.source_model === 'section_tool'",
		);
	});

	test('both list views read the shared predicate and never re-inline a list', () => {
		// The toggle creation site (the class string appears only there, never in
		// the surrounding prose), and the guard that must run before it.
		const TOGGLE = 'icon_arrow show_other_buttons_button';
		const GUARD = 'is_non_tools_section(self)';
		for (const name of ['view_default_list_section.js', 'view_graph_list_section.js']) {
			const src = read(name);
			expect(src, `${name} must import the shared predicate`).toContain('is_non_tools_section');
			expect(src, `${name} must not re-inline the list`).not.toContain(
				'const non_editable_sections',
			);
			const guard = src.indexOf(GUARD);
			const toggle = src.indexOf(TOGGLE);
			expect(guard, `${name}: guard missing`).toBeGreaterThan(-1);
			expect(toggle, `${name}: toggle missing`).toBeGreaterThan(-1);
			expect(guard, `${name}: guard must precede the toggle`).toBeLessThan(toggle);
		}
	});
});
