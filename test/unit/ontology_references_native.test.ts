/**
 * HERMETIC gate of the shared measurement layer the installer unification
 * builds on (no database, no network, no file written):
 *
 *   - src/core/db/copy_text.ts — THE src-side COPY text codec: every escape the
 *     format defines decodes, encode ∘ decode is the identity on hostile text,
 *     a plain dump's COPY blocks are found with their columns and rows.
 *   - src/core/ontology/ontology_references.ts — the structural reference
 *     classifier: parent/model/relations are extracted from dd_ontology-shaped
 *     rows AND from raw package lines (the same fixture both ways must agree),
 *     the three classes follow their rules (graft = a foreign PARENT,
 *     diffusion = relations FROM a node whose model descends from the diffusion
 *     grouper, everything else a dependency), and a PLANTED offender is found.
 *   - src/core/test_data/ontology_package_fixture.ts — the package bytes the
 *     DB/installer gates build their sources from (scratch TLDs only).
 *
 * Every TLD here is a `zz…` scratch TLD built by the test; the only
 * non-scratch tipos are the ones the modules export as constants.
 *
 * Mutations that turn it red (verified by hand when written): drop a key of
 * the decoder's escape table (escape legs); make classifyReference ignore the
 * parent's TLD (graft leg); stop walking below the diffusion root (diffusion
 * subtree leg); let relationColumn swallow bad JSON (corrupt-line leg).
 */

import { describe, expect, test } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import {
	copyBlockRecords,
	copyBlocks,
	decodeCopyField,
	encodeCopyField,
	splitCopyRow,
} from '../../src/core/db/copy_text.ts';
import { MATRIX_COPY_COLUMNS } from '../../src/core/db/matrix_write.ts';
import { CORE_ONTOLOGY_TLDS, isCoreOntologyTld } from '../../src/core/ontology/core_tlds.ts';
import {
	classifyReference,
	danglingDependencies,
	diffusionModelSet,
	foreignDependencyTlds,
	type OntologyReference,
	referencesOfCopyRows,
	referencesOfRows,
	SOFT_REFERENCE_CLASSES,
} from '../../src/core/ontology/ontology_references.ts';
import { DIFFUSION_MODEL_ROOT } from '../../src/core/ontology/ontology_tipos.ts';
import {
	buildOntologyPackage,
	type FixtureOntologyTld,
	ontologyCopyRow,
} from '../../src/core/test_data/ontology_package_fixture.ts';
import { refusalOfSync } from '../helpers/refusal.ts';

// ---------------------------------------------------------------------------
// the codec
// ---------------------------------------------------------------------------

describe('copy_text — the COPY text codec', () => {
	test('every escape of the format decodes; \\N is NULL', () => {
		expect(decodeCopyField('\\N')).toBeNull();
		expect(decodeCopyField('plain')).toBe('plain');
		expect(decodeCopyField('a\\\\b')).toBe('a\\b');
		expect(decodeCopyField('\\t\\n\\r\\b\\f\\v')).toBe('\t\n\r\b\f\v');
		expect(decodeCopyField('\\101\\x42')).toBe('AB'); // octal + hex bytes
		expect(decodeCopyField('\\303\\251')).toBe('é'); // numeric escapes are BYTES (UTF-8 pair)
		expect(decodeCopyField('\\q')).toBe('q'); // any other backslashed char is itself
		expect(decodeCopyField('\\\\N')).toBe('\\N'); // an escaped backslash + N is text, not NULL
	});

	test('encode ∘ decode is the identity on hostile text, and NULL round-trips', () => {
		const hostile = [
			'',
			'tab\there',
			'line\nbreak\r\n',
			'back\\slash \\N',
			'{"a":"q\\"uote","t":"\\t"}',
			'ctl\b\f\v',
			'ünïcödé — 漢字',
		];
		for (const value of hostile) {
			const encoded = encodeCopyField(value);
			expect(encoded).not.toMatch(/[\t\n\r]/);
			expect(decodeCopyField(encoded)).toBe(value);
		}
		expect(encodeCopyField(null)).toBe('\\N');
		expect(splitCopyRow([encodeCopyField('a\tb'), '\\N', encodeCopyField('c')].join('\t'))).toEqual(
			['a\tb', null, 'c'],
		);
	});

	test('copyBlocks finds every block of a plain dump, unqualified names, rows up to \\.', () => {
		const dump = [
			'-- PostgreSQL database dump',
			'COPY public.zz_one (section_id, "section_tipo", data) FROM stdin;',
			'1\tzzrq0\t{}',
			'2\tzzrq0\t\\N',
			'\\.',
			'',
			'SELECT 1;',
			'COPY zz_two (tipo) FROM stdin;',
			'\\.',
			'COPY public.zz_three (tipo, parent) FROM stdin;',
			'zzrq1\tzzrq0',
		].join('\n');
		const blocks = copyBlocks(dump);
		expect(blocks.map((block) => [block.table, block.columns, block.rows.length])).toEqual([
			['zz_one', ['section_id', 'section_tipo', 'data'], 2],
			['zz_two', ['tipo'], 0],
			['zz_three', ['tipo', 'parent'], 1], // unterminated at EOF: returned with what it has
		]);
		expect(copyBlockRecords(blocks[0] as (typeof blocks)[number])).toEqual([
			{ section_id: '1', section_tipo: 'zzrq0', data: '{}' },
			{ section_id: '2', section_tipo: 'zzrq0', data: null },
		]);
	});
});

// ---------------------------------------------------------------------------
// the classifier
// ---------------------------------------------------------------------------

/**
 * A model provider `zzrm` (its own diffusion-like grouper zzrm1 with a model
 * zzrm2 below it, and a plain model zzrm3) and a domain `zzra` using it:
 *   zzra1 model zzrm3, relations zzra2 (own) + zzrb5 (foreign dependency)
 *   zzra2 model zzrm2 (diffusion), relations zzrx7 (soft: diffusion)
 *   zzra3 parent zzrd9 (soft: graft), model zzrm3
 */
const MODELS: FixtureOntologyTld = {
	tld: 'zzrm',
	name: 'zz model provider',
	typologyId: 15,
	nodes: [
		{ id: 1, parent: 'zzrm0', model: 'zzrm9', term: 'zz grouper', isModel: true },
		{ id: 2, parent: 'zzrm1', model: 'zzrm9', term: 'zz table alias', isModel: true },
		{ id: 3, parent: 'zzrm0', model: 'zzrm9', term: 'zz component', isModel: true },
	],
};

const DOMAIN: FixtureOntologyTld = {
	tld: 'zzra',
	name: 'zz domain',
	typologyId: 15,
	dependencies: [{ tld: 'zzrm', main: 'ontology35', mandatory: true }],
	nodes: [
		{ id: 1, parent: 'zzra0', model: 'zzrm3', term: 'zz section', relations: ['zzra2', 'zzrb5'] },
		{ id: 2, parent: 'zzra1', model: 'zzrm2', term: 'zz alias', relations: ['zzrx7'] },
		{ id: 3, parent: 'zzrd9', model: 'zzrm3', term: 'zz grafted' },
	],
};

function packageLines(definition: FixtureOntologyTld): string[] {
	const bytes = buildOntologyPackage([definition]).get(`${definition.tld}.copy.gz`);
	if (bytes === undefined) throw new Error('the fixture produced no copy file');
	return new TextDecoder()
		.decode(gunzipSync(bytes))
		.split('\n')
		.filter((line) => line !== '');
}

const DIFFUSION_ROOT = 'zzrm1';
const diffusionModels = diffusionModelSet(
	MODELS.nodes.map((node) => ({ tipo: `zzrm${node.id}`, parent: node.parent })),
	DIFFUSION_ROOT,
);

const OWN: ReadonlySet<string> = new Set(['zzra']);
const refs = referencesOfCopyRows(packageLines(DOMAIN));

function find(from: string, to: string): OntologyReference {
	const ref = refs.find((candidate) => candidate.from === from && candidate.to === to);
	if (ref === undefined) throw new Error(`no reference ${from} → ${to}`);
	return ref;
}

describe('ontology_references — the structural classifier', () => {
	test('the package fixture emits one MATRIX_COPY_COLUMNS line per node, scratch TLDs only', () => {
		const lines = packageLines(DOMAIN);
		expect(lines.length).toBe(DOMAIN.nodes.length);
		for (const line of lines) expect(splitCopyRow(line).length).toBe(MATRIX_COPY_COLUMNS.length);
		expect(refusalOfSync(() => buildOntologyPackage([{ ...DOMAIN, tld: 'dd' }])).code).toBe(
			'internal.invariant',
		);
		const longModel = {
			...DOMAIN,
			nodes: [{ id: 1, parent: 'zzra0', model: 'zzramodel1', term: 't' }],
		};
		expect(refusalOfSync(() => buildOntologyPackage([longModel])).code).toBe('internal.invariant');
	});

	test('parent / model / relations are read from package lines, in order', () => {
		expect(
			refs.filter((ref) => ref.from === 'zzra1').map((ref) => [ref.field, ref.to, ref.fromModel]),
		).toEqual([
			['parent', 'zzra0', 'zzrm3'],
			['model', 'zzrm3', 'zzrm3'],
			['relations', 'zzra2', 'zzrm3'],
			['relations', 'zzrb5', 'zzrm3'],
		]);
		expect(new Set(refs.map((ref) => ref.fromTld))).toEqual(new Set(['zzra']));
	});

	test('rows and package lines are ONE measurement (the same fixture both ways)', () => {
		const rows = DOMAIN.nodes.map((node) => ({
			tipo: `zzra${node.id}`,
			parent: node.parent,
			model_tipo: node.model,
			relations: (node.relations ?? []).map((tipo) => ({ tipo })),
		}));
		const shape = (list: OntologyReference[]): string[] =>
			list.map((ref) => `${ref.from}|${ref.field}|${ref.to}|${ref.fromModel}`).sort();
		expect(shape(referencesOfRows(rows))).toEqual(shape(refs));
	});

	test('the diffusion model set is the subtree of the root (root included), nothing else', () => {
		expect([...diffusionModels].sort()).toEqual(['zzrm1', 'zzrm2']);
		// the default root is the engine's named grouper
		expect(diffusionModelSet([{ tipo: 'zzrm7', parent: DIFFUSION_MODEL_ROOT }]).has('zzrm7')).toBe(
			true,
		);
	});

	test('classes: a foreign parent is a graft, a diffusion node relation is diffusion, the rest dependency', () => {
		const klass = (from: string, to: string): string =>
			classifyReference(find(from, to), OWN, diffusionModels);
		expect(klass('zzra3', 'zzrd9')).toBe('graft');
		expect(klass('zzra2', 'zzrx7')).toBe('diffusion');
		expect(klass('zzra1', 'zzrb5')).toBe('dependency');
		expect(klass('zzra1', 'zzrm3')).toBe('dependency'); // a model is always needed
		expect(klass('zzra2', 'zzra1')).toBe('dependency'); // an OWN parent must resolve
		// a predicate works like the set
		expect(classifyReference(find('zzra2', 'zzrx7'), OWN, (tipo) => tipo === 'zzrm2')).toBe(
			'diffusion',
		);
		// both soft classes carry a reason, and no tipo literal
		for (const reason of Object.values(SOFT_REFERENCE_CLASSES)) {
			expect(reason.length).toBeGreaterThan(20);
			expect(reason).not.toMatch(/\b[a-z]+\d+\b/);
		}
	});

	test('dangling dependencies: the PLANTED offender is found, soft references never are', () => {
		const present = new Set(['zzra0', 'zzra1', 'zzra2', 'zzra3', 'zzrm2', 'zzrm3']);
		expect(danglingDependencies(refs, OWN, present, diffusionModels).map((ref) => ref.to)).toEqual([
			'zzrb5',
		]);
		// with the offender present, nothing dangles — the soft ones stay soft
		expect(
			danglingDependencies(refs, OWN, new Set([...present, 'zzrb5']), diffusionModels),
		).toEqual([]);
		// a missing MODEL is a dependency too
		const noModel = new Set([...present, 'zzrb5'].filter((tipo) => tipo !== 'zzrm3'));
		expect(
			new Set(danglingDependencies(refs, OWN, noModel, diffusionModels).map((ref) => ref.to)),
		).toEqual(new Set(['zzrm3']));
	});

	test('foreign dependency TLDs: the model provider and the planted foreign relation, sorted', () => {
		expect(foreignDependencyTlds(refs, OWN, diffusionModels)).toEqual(['zzrb', 'zzrm']);
		// own TLDs widen → those leave the foreign set
		expect(foreignDependencyTlds(refs, new Set(['zzra', 'zzrm']), diffusionModels)).toEqual([
			'zzrb',
		]);
	});

	test('a corrupt relation column is LOUD, never a silently clean package', () => {
		const line = ontologyCopyRow('zzra', { id: 4, parent: 'zzra0', model: 'zzrm3', term: 'x' });
		const fields = line.split('\t');
		fields[MATRIX_COPY_COLUMNS.indexOf('relation')] = '{not json';
		expect(refusalOfSync(() => referencesOfCopyRows([fields.join('\t')])).code).toBe(
			'internal.invariant',
		);
		// a line of another table shape (not an ontology section) is not an ontology record
		expect(referencesOfCopyRows(['1\tzz_not_ontology\t{}'])).toEqual([]);
	});
});

describe('core_tlds — the one core list', () => {
	test('six core TLDs, frozen; the predicate trims and ignores case', () => {
		expect(CORE_ONTOLOGY_TLDS.length).toBe(6);
		expect(Object.isFrozen(CORE_ONTOLOGY_TLDS)).toBe(true);
		for (const tld of CORE_ONTOLOGY_TLDS) {
			expect(isCoreOntologyTld(` ${tld.toUpperCase()} `)).toBe(true);
		}
		expect(isCoreOntologyTld('zzra')).toBe(false);
	});
});
