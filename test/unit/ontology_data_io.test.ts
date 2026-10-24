/**
 * ONTOLOGY DATA IO unit gate (PHP class.ontology_data_io.php +
 * tool_ontology_parser::export_ontologies :301-409).
 *
 * Covers, WITHOUT any live psql/matrix write (the PHP export mutates the
 * shared oracle — export_ontologies is deliberately NOT in the parity suite):
 *   - COMP-06 input validation: safe_tld regex, section_tipo bare-identifier
 *     regex, and the exportToFile early reject (no side effects on bad tld);
 *   - the versioned IO dir resolution/creation (setOntologyIoPath);
 *   - the export pipeline's STRICT ordering and abort/continue semantics
 *     (stubbed five IO fns: call order, hard aborts on steps 1-2, per-TLD
 *     fail-and-continue on step 3, thrown-step full abort — PHP outer catch);
 *   - the LLM-map shape on a small injected fixture (per-section
 *     catch-and-continue skip collection).
 */
// Generic-TLD migration 2026-08-20 (AGENTS.md hard rule). The `rsc`/`oh` tipos this
// gate names are SEED-SHIPPED ontology — they exist on every installation, so they are
// generic already and stay. They are spelled through `seed()` so the census can tell an
// install BINDING from a seed reference, and so the intent is explicit at each site.

import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildLlmMap } from '../../src/ai/mcp/tools/llm_map.ts';
import {
	exportToFile,
	isSafeSectionTipo,
	type OntologyIoResponse,
	safeTld,
	setOntologyIoPath,
} from '../../src/core/ontology/data_io.ts';
import type { OntologySubtreeNode } from '../../src/core/ontology/resolver.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import type { ToolActionContext } from '../../src/core/tools/module.ts';
import {
	type OntologyExportIo,
	runExportOntologies,
} from '../../tools/tool_ontology_parser/server/tool_ontology_parser.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { scratchDir } from '../helpers/scratch_dir.ts';

/** Seed-shipped tipo, spelled so the census sees a reference, not a binding. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

function makeContext(options: Record<string, unknown>, isDeveloper = true): ToolActionContext {
	return {
		principal: { isDeveloper } as unknown as Principal,
		userId: 77,
		options,
		background: false,
	};
}

const ok = (msg: string): OntologyIoResponse => ({ ok: true, msg, errors: [] });
const fail = (msg: string, errors: string[]): OntologyIoResponse => ({
	ok: false,
	msg,
	errors,
});

/** A recording stub of the five IO calls; per-call behavior overridable. */
function makeIo(calls: string[], overrides: Partial<OntologyExportIo> = {}): OntologyExportIo {
	return {
		updateOntologyInfo: async (userId) => {
			calls.push(`update_ontology_info:${userId}`);
			return true;
		},
		exportOntologyInfo: async () => {
			calls.push('export_ontology_info');
			return ok('OK. Request done');
		},
		exportToFile: async (tld) => {
			calls.push(`export_to_file:${tld}`);
			return ok(`OK. Request done: ${tld}0`);
		},
		exportPrivateListsToFile: async () => {
			calls.push('export_private_lists_to_file');
			return ok('OK. Request done');
		},
		exportLlmMap: async () => {
			calls.push('export_llm_map');
			return ok('OK. LLM map exported: 2 sections');
		},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// COMP-06 validation
// ---------------------------------------------------------------------------

describe('COMP-06 identifier validation', () => {
	test('safeTld accepts only 2+ lowercase ascii letters', () => {
		for (const good of ['dd', 'oh', 'ontology', 'rsc']) {
			expect(safeTld(good)).toBe(true);
		}
		for (const bad of ['', 'd', 'DD', 'dd0', 'dd-x', 'dd x', "dd'", 'dd;rm -rf /', 'dd\\']) {
			expect(safeTld(bad)).toBe(false);
		}
	});

	test('isSafeSectionTipo accepts only bare identifiers', () => {
		expect(isSafeSectionTipo('dd0')).toBe(true);
		expect(isSafeSectionTipo(seed('rsc', 170))).toBe(true);
		for (const bad of ["dd0'", 'dd0;--', 'dd 0', '', "dd0' TO PROGRAM"]) {
			expect(isSafeSectionTipo(bad)).toBe(false);
		}
	});

	test('exportToFile soft-rejects an invalid tld before any IO', async () => {
		for (const bad of ['DD', 'dd0', "dd'; rm -rf /", '']) {
			const response = await exportToFile(bad);
			expect(response.ok).toBe(false);
			expect(response.msg).toBe(`Error. Invalid tld: ${bad}`);
			expect(response.errors).toEqual([`Invalid tld: ${bad}`]);
		}
	});
});

// ---------------------------------------------------------------------------
// setOntologyIoPath
// ---------------------------------------------------------------------------

describe('setOntologyIoPath', () => {
	test('creates and returns the versioned <base>/<major>.<minor> dir', () => {
		const base = scratchDir('dd_ontology_io_test');
		try {
			const ioPath = setOntologyIoPath(base);
			expect(ioPath).toBe(join(base, '7.0'));
			expect(existsSync(ioPath as string)).toBe(true);
			// idempotent (mkdir recursive on an existing dir)
			expect(setOntologyIoPath(base)).toBe(join(base, '7.0'));
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// export_ontologies pipeline: ordering + abort/continue semantics
// ---------------------------------------------------------------------------

describe('runExportOntologies ordering/abort semantics (PHP :301-409)', () => {
	test('non-developer callers are refused before any IO', async () => {
		const calls: string[] = [];
		const refusal = await refusalOf(
			runExportOntologies(makeContext({ selected_ontologies: ['dd'] }, false), makeIo(calls)),
		);
		expect(refusal.code).toBe('perm.developer_required');
		expect(calls).toEqual([]);
	});

	test('empty or non-array selected_ontologies is rejected before any IO', async () => {
		const calls: string[] = [];
		for (const bad of [undefined, null, [], 'dd', 42]) {
			const refusal = await refusalOf(
				runExportOntologies(makeContext({ selected_ontologies: bad }), makeIo(calls)),
			);
			expect(refusal.code).toBe('request.invalid_options');
			expect(refusal.publicMessage).toBe('selected_ontologies must be a non-empty array');
		}
		expect(calls).toEqual([]);
	});

	test('happy path runs the five steps in PHP order and counts done', async () => {
		const calls: string[] = [];
		const response = await runExportOntologies(
			makeContext({ selected_ontologies: ['aa', 'bb'] }),
			makeIo(calls),
		);
		// The per-TLD exports (step 3) now run BOUNDED-PARALLEL, so their
		// relative order is not guaranteed — assert only that both happen,
		// AFTER export_ontology_info and BEFORE export_private_lists_to_file.
		expect(calls).toContain('export_to_file:aa');
		expect(calls).toContain('export_to_file:bb');
		const infoIndex = calls.indexOf('export_ontology_info');
		const privateIndex = calls.indexOf('export_private_lists_to_file');
		for (const tld of ['aa', 'bb']) {
			const tldIndex = calls.indexOf(`export_to_file:${tld}`);
			expect(tldIndex).toBeGreaterThan(infoIndex);
			expect(tldIndex).toBeLessThan(privateIndex);
		}
		// The sequential steps keep their strict order around the parallel block.
		expect(calls[0]).toBe('update_ontology_info:77');
		expect(calls[1]).toBe('export_ontology_info');
		expect(calls[calls.length - 2]).toBe('export_private_lists_to_file');
		expect(calls[calls.length - 1]).toBe('export_llm_map');
		expect(response.ok).toBe(true);
		const report = response.data as { summary: string; ar_msg: string[] };
		// Summary names the count + the target I/O directory (absolute, env-derived).
		expect(report.summary).toContain('Exported 2 ontologies to ');
		// ar_msg: one line per TLD + private lists + llm map
		expect(report.ar_msg).toEqual([
			'OK. Request done: aa0',
			'OK. Request done: bb0',
			'OK. Request done',
			'OK. LLM map exported: 2 sections',
		]);
	});

	test('per-TLD exports run BOUNDED-PARALLEL yet ar_msg stays in input order', async () => {
		const calls: string[] = [];
		// More TLDs than EXPORT_CONCURRENCY so the pool must cap the fan-out.
		const tlds = ['ta', 'tb', 'tc', 'td', 'te', 'tf', 'tg', 'th', 'ti'];
		let inFlight = 0;
		let maxInFlight = 0;
		const response = await runExportOntologies(
			makeContext({ selected_ontologies: tlds }),
			makeIo(calls, {
				exportToFile: async (tld) => {
					inFlight++;
					maxInFlight = Math.max(maxInFlight, inFlight);
					// Resolve earlier-input TLDs LATER, so completion order is the
					// REVERSE of input order — this proves ar_msg is ordered by input
					// position, not by which psql subprocess finished first.
					const position = tlds.indexOf(tld);
					await new Promise((resolve) => setTimeout(resolve, (tlds.length - position) * 2));
					inFlight--;
					return ok(`OK. Request done: ${tld}0`);
				},
			}),
		);
		// Concurrency actually happened (>1 at once) but was BOUNDED — never all
		// nine at once (the pool caps it below the input size). Constant-agnostic:
		// unbounded would reach tlds.length, strictly sequential would stay at 1.
		expect(maxInFlight).toBeGreaterThan(1);
		expect(maxInFlight).toBeLessThan(tlds.length);
		expect(response.ok).toBe(true);
		const parallelReport = response.data as { summary: string; ar_msg: string[] };
		// done counts every success.
		expect(parallelReport.summary).toContain(`Exported ${tlds.length} ontologies to `);
		// ar_msg per-TLD lines are in INPUT order despite the reversed completion.
		expect(parallelReport.ar_msg.slice(0, tlds.length)).toEqual(
			tlds.map((tld) => `OK. Request done: ${tld}0`),
		);
	});

	test('updateOntologyInfo failure HARD-aborts before any file is written', async () => {
		const calls: string[] = [];
		const refusal = await refusalOf(
			runExportOntologies(
				makeContext({ selected_ontologies: ['dd'] }),
				makeIo(calls, {
					updateOntologyInfo: async (userId) => {
						calls.push(`update_ontology_info:${userId}`);
						return false;
					},
				}),
			),
		);
		expect(calls).toEqual(['update_ontology_info:77']);
		expect(refusal.code).toBe('tool.action_failed');
		expect(refusal.message).toContain(
			'Unable to update ontology information in dd1 (ontology40_1)',
		);
		expect(refusal.extend?.errors).toEqual(['unable to update_ontology_info']);
	});

	test('exportOntologyInfo failure HARD-aborts before the per-TLD loop', async () => {
		const calls: string[] = [];
		const refusal = await refusalOf(
			runExportOntologies(
				makeContext({ selected_ontologies: ['dd'] }),
				makeIo(calls, {
					exportOntologyInfo: async () => {
						calls.push('export_ontology_info');
						return fail('Error. Request failed', ['disk full']);
					},
				}),
			),
		);
		expect(calls).toEqual(['update_ontology_info:77', 'export_ontology_info']);
		expect(refusal.code).toBe('tool.action_failed');
		expect(refusal.message).toContain('Unable to export the ontology information JSON file');
		expect(refusal.extend?.errors).toEqual(['unable to export ontology info JSON file']);
	});

	test('a per-TLD SOFT failure continues the loop; private lists + LLM map still run', async () => {
		const calls: string[] = [];
		const refusal = await refusalOf(
			runExportOntologies(
				makeContext({ selected_ontologies: ['aa', 'bb', 'cc'] }),
				makeIo(calls, {
					exportToFile: async (tld) => {
						calls.push(`export_to_file:${tld}`);
						return tld === 'bb'
							? fail(`Error. Request failed: ${tld}`, [`Invalid tld: ${tld}`])
							: ok(`OK. Request done: ${tld}0`);
					},
				}),
			),
		);
		expect(calls).toEqual([
			'update_ontology_info:77',
			'export_ontology_info',
			'export_to_file:aa',
			'export_to_file:bb',
			'export_to_file:cc',
			'export_private_lists_to_file',
			'export_llm_map',
		]);
		expect(refusal.code).toBe('tool.action_failed');
		expect(refusal.message).toContain('Errors found. Export Ontologies request failed.');
		expect(refusal.extend?.errors).toEqual(['Invalid tld: bb']);
		expect(refusal.extend?.ar_msg).toEqual([
			'OK. Request done: aa0',
			'Error. Request failed: bb',
			'OK. Request done: cc0',
			'OK. Request done',
			'OK. LLM map exported: 2 sections',
		]);
	});

	test('a THROWN step (COPY file not created) aborts everything — PHP outer catch', async () => {
		const calls: string[] = [];
		const refusal = await refusalOf(
			runExportOntologies(
				makeContext({ selected_ontologies: ['aa', 'bb'] }),
				makeIo(calls, {
					exportToFile: async (tld) => {
						calls.push(`export_to_file:${tld}`);
						throw new Error(`Error Processing Request. File /io/${tld}.copy.gz not created!`);
					},
				}),
			),
		);
		// Under bounded-parallel step 3 the in-flight exports (aa AND bb) may both
		// launch, but a thrown export still aborts: the remaining sequential steps
		// (private lists, llm map) never run, and the FIRST (input-order) rejection
		// is re-thrown to the outer catch — so msg/errors carry aa's message alone.
		expect(calls).toContain('export_to_file:aa');
		expect(calls).not.toContain('export_private_lists_to_file');
		expect(calls).not.toContain('export_llm_map');
		expect(refusal.code).toBe('tool.action_failed');
		expect(refusal.message).toContain('File /io/aa.copy.gz not created!');
		expect(refusal.extend?.errors).toEqual([
			'Error Processing Request. File /io/aa.copy.gz not created!',
		]);
	});

	test('private-lists and LLM-map failures are merged but never abort', async () => {
		const calls: string[] = [];
		const refusal = await refusalOf(
			runExportOntologies(
				makeContext({ selected_ontologies: ['aa'] }),
				makeIo(calls, {
					exportPrivateListsToFile: async () => {
						calls.push('export_private_lists_to_file');
						return fail('Error. Request failed', ['private lists failed']);
					},
					exportLlmMap: async () => {
						calls.push('export_llm_map');
						return fail('Error. Request failed', ['llm map failed']);
					},
				}),
			),
		);
		expect(calls).toEqual([
			'update_ontology_info:77',
			'export_ontology_info',
			'export_to_file:aa',
			'export_private_lists_to_file',
			'export_llm_map',
		]);
		expect(refusal.code).toBe('tool.action_failed');
		expect(refusal.extend?.errors).toEqual(['private lists failed', 'llm map failed']);
	});
});

// ---------------------------------------------------------------------------
// LLM-map shape (fixture-injected deps — no DB)
// ---------------------------------------------------------------------------

function fieldNode(tipo: string, model: string, term: Record<string, string>): OntologySubtreeNode {
	return {
		tipo,
		parent: 'zz1',
		model,
		term,
		properties: null,
		relations: null,
		orderNumber: 1,
	};
}

describe('buildLlmMap shape (PHP export_llm_map)', () => {
	test('emits {tipo,label,fields:[{tipo,label,type,target?}]} per section', async () => {
		const { map, skipped } = await buildLlmMap({
			listSectionNodes: async () => [
				{ tipo: 'zz1', term: { 'lg-eng': 'Things', 'lg-spa': 'Cosas' } },
			],
			sectionFieldNodes: async () => [
				fieldNode('zz4', 'component_input_text', { 'lg-eng': 'Title' }),
				fieldNode('zz5', 'component_portal', { 'lg-eng': 'Informant' }),
				fieldNode('zz6', 'component_date', { 'lg-eng': 'Date' }),
			],
			linkTargetSections: async (componentTipo) =>
				componentTipo === 'zz5' ? [seed('rsc', 197), seed('rsc', 176)] : [],
		});
		expect(skipped).toEqual([]);
		expect(map).toEqual([
			{
				tipo: 'zz1',
				label: { 'lg-eng': 'Things', 'lg-spa': 'Cosas' },
				fields: [
					{ tipo: 'zz4', label: { 'lg-eng': 'Title' }, type: 'text' },
					// link field: simplified type 'link' + EVERY declared target.
					// Not the first one: a multi-target link truncated to [0] reads as a
					// single-target node and is wrong for every node that declares more
					// than one (picker plan §13.1).
					{
						tipo: 'zz5',
						label: { 'lg-eng': 'Informant' },
						type: 'link',
						target_sections: [seed('rsc', 197), seed('rsc', 176)],
					},
					{ tipo: 'zz6', label: { 'lg-eng': 'Date' }, type: 'date' },
				],
			},
		]);
		// scalar fields must NOT carry a target key at all (PHP omits it)
		expect(
			Object.hasOwn((map[0] as { fields: object[] }).fields[0] as object, 'target_sections'),
		).toBe(false);
	});

	test('a failing section is skipped and collected; the rest still build', async () => {
		const { map, skipped } = await buildLlmMap({
			listSectionNodes: async () => [
				{ tipo: 'zz1', term: { 'lg-eng': 'Good' } },
				{ tipo: 'zz9', term: { 'lg-eng': 'Broken' } },
				{ tipo: 'zz2', term: null },
			],
			sectionFieldNodes: async (sectionTipo) => {
				if (sectionTipo === 'zz9') throw new Error('broken subtree');
				return [];
			},
			linkTargetSections: async () => [],
		});
		expect(skipped).toEqual(['zz9']);
		expect(map).toEqual([
			{ tipo: 'zz1', label: { 'lg-eng': 'Good' }, fields: [] },
			// null term → empty label object (PHP `?? new stdClass()`)
			{ tipo: 'zz2', label: {}, fields: [] },
		]);
	});

	test('unknown models fall back to type "text"', async () => {
		const { map } = await buildLlmMap({
			listSectionNodes: async () => [{ tipo: 'zz1', term: {} }],
			sectionFieldNodes: async () => [
				fieldNode('zz7', 'component_totally_new', { 'lg-eng': 'Mystery' }),
			],
			linkTargetSections: async () => [],
		});
		expect((map[0] as { fields: { type: string }[] }).fields[0]?.type).toBe('text');
	});
});
