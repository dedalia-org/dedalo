/**
 * Multi-section projects filter (sql_assembler::buildMultiSectionProjectsFilter,
 * 2026-07-09) — the per-record ACL for a NON-ADMIN searching several sections
 * at once (the autocomplete picker's normal shape). Replaces the Phase 5c
 * fail-closed throw: these tests pin the now-covered contract so the removed
 * loud throw is genuinely replaced, not silently dropped.
 *
 * Semantics pinned (WC-011, deliberate strictly-safer divergence): each
 * section is scoped by its OWN component_filter tipo behind a section_tipo
 * guard — NOT PHP's main-section-only clause (trait.where.php:743-744), which
 * is fail-open when the first section is ungated. The cross-engine result-set
 * assertions live in test/parity/projects_filter_differential.test.ts; this
 * file pins the emitted SQL shape without needing the PHP oracle.
 *
 * Fixtures (the generic `test` TLD clone + the seed's own ontology):
 *   test6310  gated by component_filter test6107
 *   testmint1 gated by component_filter testmint1013
 *   test6369  ungated — one of the twenty cloned sections with no
 *             component_filter anywhere on the virtual→real chain; the
 *             "fixture assumptions" case re-derives that, so a clone that
 *             later gains a filter reddens instead of passing vacuously
 *   rsc170 → rsc2 → rsc28: the seed's own VIRTUAL image section, the
 *             regression carrier for the virtual→real filter lookup
 *   hierarchy20: the seed's Thesaurus section — GATED (hierarchy55) but in
 *             matrix_hierarchy, so the table exemption must win over the gate
 *
 * IDENTITIES ARE MINTED, NOT ASSUMED. The suite database holds three `dd128`
 * users and none of them has a project, so a "user 16 → project 7" fixture is
 * satisfiable at zero-versus-zero (the green-suite trap). This gate installs
 * the synthetic ACL identities (test/helpers/acl_identity_fixture.ts) and reads
 * the non-admin's ONE project id back out of the emitted bound parameter.
 *
 * @twin-of      test/parity/projects_filter_differential.test.ts
 * @twin-status  supplement
 */
// Migrated to the generic `test` TLD 2026-08-19 (AGENTS.md hard rules): every
// install tipo was rewritten through src/core/test_data/test_tld_tipo_map.json;
// seed-shipped ontology (dd/rsc/hierarchy/lg) stays and is spelled through `seed()`,
// which keeps it out of the install-TLD census's `<tld><digits>` token grammar.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql as db } from '../../src/core/db/postgres.ts';
import { getComponentFilterTipo } from '../../src/core/ontology/resolver.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import {
	ACL_NON_ADMIN_USER_ID,
	ACL_PROJECT_ID,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

/** Seed-shipped ontology, spelled out of the install-TLD census's token grammar. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

const GATED_A = 'test6310'; // filter tipo test6107
const GATED_A_FILTER = 'test6107';
const GATED_B = 'testmint1'; // filter tipo testmint1013
const GATED_B_FILTER = 'testmint1013';
const UNGATED = 'test6369';

/** The seed's VIRTUAL image section and the real section whose filter gates it. */
const VIRTUAL_SECTION = seed('rsc', 170);
const VIRTUAL_REAL_FILTER = seed('rsc', 28);
/** The seed's Thesaurus section: GATED, but in the exempt matrix_hierarchy. */
const EXEMPT_TABLE_SECTION = seed('hierarchy', 20);

/** The one project the minted non-admin may see. */
const PROJECT_ID = String(ACL_PROJECT_ID);
const projectsParam = (filterTipo: string): string =>
	`{"${filterTipo}":[{"section_id":"${PROJECT_ID}"}]}`;

const NON_ADMIN: Principal = {
	userId: ACL_NON_ADMIN_USER_ID,
	isGlobalAdmin: false,
	isDeveloper: false,
};
const ADMIN: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const NO_PROJECTS_USER: Principal = { userId: 999999, isGlobalAdmin: false, isDeveloper: false };

function sqoOver(sections: string[]): never {
	return { section_tipo: sections, limit: 10, offset: 0 } as never;
}

let dbReady = false;
beforeAll(async () => {
	try {
		await db`SELECT 1`;
		dbReady = true;
	} catch {
		dbReady = false; // no shared DB on this machine — cases skip honestly
		return;
	}
	await installAclIdentityFixture();
});

afterAll(async () => {
	if (!dbReady) return;
	await removeAclIdentityFixture();
});

describe('multi-section projects filter (non-admin, per-section ACL)', () => {
	test('fixture assumptions hold (drift must redden, not vacuously pass)', async () => {
		if (!dbReady) return;
		expect(await getComponentFilterTipo(GATED_A)).toBe(GATED_A_FILTER);
		expect(await getComponentFilterTipo(GATED_B)).toBe(GATED_B_FILTER);
		expect(await getComponentFilterTipo(UNGATED)).toBeNull();
	});

	test('mixed gated/ungated: no throw; gated section guarded by its OWN filter, ungated survives bare', async () => {
		if (!dbReady) return;
		const { sql, params } = await buildSearchSql(sqoOver([GATED_A, UNGATED]), {
			principal: NON_ADMIN,
		});
		// GIN-indexable whole-column containment (never the frozen-PHP EXISTS
		// scan), keyed to the gated section's own filter tipo via a bound param.
		expect(sql).toMatch(/mix\.relation @> \$\d+::text::jsonb/);
		expect(sql).not.toContain('jsonb_array_elements');
		expect(params).toContain(projectsParam(GATED_A_FILTER));
		// The predicate is a disjunction of section_tipo-guarded branches:
		// (mix.section_tipo = $a AND (mix.relation @> …)) OR (mix.section_tipo = $b)
		// The gated branch is the section guard AND the section-id DUAL PROBE
		// (int-canonical + legacy string, WC-2026-08-10 — search_containment_dual_probe
		// owns that contract), so the containment is a two-term disjunction.
		expect(sql).toMatch(
			/\(mix\.section_tipo = \$\d+::text AND \(\(mix\.relation @> \$\d+::text::jsonb OR mix\.relation @> \$\d+::text::jsonb\)\)\)/,
		);
		expect(sql).toMatch(/ OR \(mix\.section_tipo = \$\d+::text\)\)/);
	});

	test('two gated sections with DIFFERENT filter tipos each get their own predicate (anti main-only)', async () => {
		if (!dbReady) return;
		const { params } = await buildSearchSql(sqoOver([GATED_A, GATED_B]), {
			principal: NON_ADMIN,
		});
		expect(params).toContain(projectsParam(GATED_A_FILTER));
		expect(params).toContain(projectsParam(GATED_B_FILTER));
	});

	test('ungated-FIRST ordering still filters the gated section (the PHP fail-open case)', async () => {
		if (!dbReady) return;
		// PHP keys the filter off the FIRST section only: ungated-first emits NO
		// filter and leaks every gated record. TS must filter regardless of order.
		const { params } = await buildSearchSql(sqoOver([UNGATED, GATED_A]), {
			principal: NON_ADMIN,
		});
		expect(params).toContain(projectsParam(GATED_A_FILTER));
	});

	test('global admin bypasses the filter entirely', async () => {
		if (!dbReady) return;
		const { sql, params } = await buildSearchSql(sqoOver([GATED_A, UNGATED]), {
			principal: ADMIN,
		});
		expect(sql).not.toContain('relation @>');
		expect(sql).not.toContain(GATED_A_FILTER);
		expect(params.join('|')).not.toContain(GATED_A_FILTER);
	});

	test('VIRTUAL section resolves the REAL section filter tipo (fail-open regression 2026-07-19)', async () => {
		if (!dbReady) return;
		// The seed's image section is VIRTUAL: records are STORED under it but
		// gated by the real section's component_filter. The strict own-subtree
		// lookup returned null here, silently disabling the projects ACL for
		// every virtual section — non-admins saw the whole table.
		expect(await getComponentFilterTipo(VIRTUAL_SECTION)).toBe(VIRTUAL_REAL_FILTER);
		const { sql, params } = await buildSearchSql(sqoOver([VIRTUAL_SECTION]), {
			principal: NON_ADMIN,
		});
		expect(sql).toMatch(/relation @> \$\d+::text::jsonb/);
		expect(params).toContain(projectsParam(VIRTUAL_REAL_FILTER));
	});

	test('projects-less non-admin gets the impossible clause on gated sections only', async () => {
		if (!dbReady) return;
		const { sql } = await buildSearchSql(sqoOver([GATED_A, UNGATED]), {
			principal: NO_PROJECTS_USER,
		});
		expect(sql).toContain('IMPOSSIBLE VALUE (User without projects)');
	});
});

describe('projects-filter table exemption (PHP $ar_tables_skip_projects)', () => {
	test('thesaurus/vocabulary sections are never project-gated (the empty-thesaurus regression, 2026-07-20)', async () => {
		if (!dbReady) return;
		// The seed's Thesaurus section CARRIES a component_filter — the gate is
		// not vacuous — but it lives in matrix_hierarchy, which PHP auto-exempts
		// from the projects filter. Before this rule was ported, non-admin
		// autocomplete/thesaurus searches returned EMPTY once the virtual→real
		// filter fallback landed.
		expect(await getComponentFilterTipo(EXEMPT_TABLE_SECTION)).not.toBeNull();
		const { sql } = await buildSearchSql(sqoOver([EXEMPT_TABLE_SECTION]), {
			principal: NON_ADMIN,
		});
		expect(sql).not.toContain('relation @>');
		expect(sql).not.toContain('IMPOSSIBLE VALUE');
		// mixed matrix + hierarchy: only the matrix-table section is gated
		const mixed = await buildSearchSql(sqoOver([GATED_A, EXEMPT_TABLE_SECTION]), {
			principal: NON_ADMIN,
		});
		expect(mixed.sql).toContain('relation @>'); // the gated branch
		expect(mixed.sql).toMatch(/\(mix\.section_tipo = \$\d+::text\)/); // the exempt bare guard
	});
});
