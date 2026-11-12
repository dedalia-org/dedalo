/**
 * RDF GRAPH INTERPRETATION (T1-4 / O09) — the rdf element publishes the
 * record's LINKED-DATA GRAPH, end to end on the suite database:
 * compileElementPlan → resolvePublication → the rdf writer, and `runJob` once.
 *
 * THE SITUATION IS BUILT, never read from an install: the zzdif scratch domain
 * (test/helpers/zzdif_diffusion_domain.ts) carries an rdf element with a
 * `nmo:TypeSeriesItem` class over its type section and a `nmo:NumismaticObject`
 * class over its object section, one property per process type, and the records; the
 * dd1010 publication-services record its subject IRIs come from is created by
 * test/helpers/rdf_services_fixture.ts under its own service type and swept.
 * IRIs are test IRIs (example.test / nomisma.test).
 *
 * RED ON THE PRE-T1-4 TREE: the element compiled to plain columns, the plan
 * carried no `rdf` element and no class graph, the resolver emitted rows, and
 * the writer printed `urn:dedalo:record:<tipo>:<id>` subjects with one plain
 * literal per column — no base IRI, no resource, no datatype, no nesting, no
 * linked record, no refusal.
 *
 * Deliberate divergences from PHP: WC-2026-11-12-rdf-graph-interpretation.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from '../../src/core/db/postgres.ts';
import { activityTable } from '../../src/core/diffusion_bridge/diffusion_delete.ts';
import {
	claimNextQueuedJob,
	deleteJobsForTests,
	enqueueDiffusionJob,
	getJobById,
	listActiveJobs,
} from '../../src/diffusion/jobs/queue.ts';
import { pauseScheduler, resumeScheduler } from '../../src/diffusion/jobs/scheduler.ts';
import { bumpOntologyRevision } from '../../src/diffusion/plan/cache.ts';
import { compileElementPlan, PlanCompileError } from '../../src/diffusion/plan/compile.ts';
import type { PublicationPlan, SectionPlan } from '../../src/diffusion/plan/types.ts';
import {
	buildVirtualDiffusionTree,
	type VirtualDiffusionTree,
} from '../../src/diffusion/plan/virtual_tree.ts';
import { RdfNamespaceTable } from '../../src/diffusion/resolve/rdf_graph_ir.ts';
import { type ResolvedBatch, resolvePublication } from '../../src/diffusion/resolve/resolver.ts';
import { runJob } from '../../src/diffusion/runner.ts';
import { rdfRecordFileName } from '../../src/diffusion/writers/rdf.ts';
import { serialiseRdfXml } from '../../src/diffusion/writers/rdf_xml_serialiser.ts';
import { ensureDiffusionScratchTables } from '../helpers/diffusion_scratch_tables.ts';
import { scratchMediaRoot } from '../helpers/media_scratch_root.ts';
import {
	ensureRdfServicesRecord,
	removeRdfServicesRecord,
} from '../helpers/rdf_services_fixture.ts';
import {
	dropZzdifDomain,
	ensureZzdifDomain,
	ZZDIF_DOMAIN_NAME,
	ZZDIF_RDF_BASES,
	ZZDIF_RDF_BROKEN_ELEMENT,
	ZZDIF_RDF_CODE_COMPONENT,
	ZZDIF_RDF_ELEMENT,
	ZZDIF_RDF_EX_NAMESPACE,
	ZZDIF_RDF_OBJECT_CLASS,
	ZZDIF_RDF_OBJECT_SECTION,
	ZZDIF_RDF_SERVICE_NAME,
	ZZDIF_RDF_SERVICE_TYPE,
	ZZDIF_RDF_TYPE_CLASS,
	ZZDIF_RDF_TYPE_IDS,
	ZZDIF_RDF_TYPE_SECTION,
	ZZDIF_RDF_UNPUBLISHABLE_OBJECT,
} from '../helpers/zzdif_diffusion_domain.ts';

const RUN_STARTED_AT = 1_751_700_000;
const OWNER = -1;
const [FULL_TYPE, MINIMAL_TYPE] = ZZDIF_RDF_TYPE_IDS;

/**
 * The full type record's document, PINNED (maxLevels 1). Every rule the graph
 * builder ports has a line here — read it as the specification:
 * - subject = the dd1010 base titled with the class name + var_uri `code`;
 * - dc:title (dcterms IRI, EasyRdf's `dc` prefix) one literal PER LANG the
 *   record carries, tags stripped; ex:label text_format with the eng slot of
 *   the untranslated `${b}` filled from the main lang; ex:note php_formula
 *   {type:'empty'} on an empty condition;
 * - nmo:hasMint the stored IRI CONTAINING the `nomisma` base, case-insensitively
 *   (the other IRI ignored); start/end years typed gYear; the 2.5 weight a
 *   decimal; ex:id the section_id; ex:seeAlso `<nomisma base><code>`;
 * - nmo:hasObverse NESTS its portal resource (`#obverse` fragment last); the
 *   empty hasReverse portal produces NOTHING;
 * - void:inDataset a standalone typed resource with an empty body;
 * - the `rdf` link inlines the FIRST PUBLISHABLE linked object only (941102 is
 *   unpublishable and extends the cap), whose own link back to this type is
 *   the cycle — not rebuilt.
 */
const FULL_TYPE_DOCUMENT = `<?xml version="1.0" encoding="utf-8" ?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:nmo="http://nomisma.org/ontology#"
         xmlns:dc="http://purl.org/dc/terms/"
         xmlns:ex="http://example.test/ex#"
         xmlns:void="http://rdfs.org/ns/void#">

  <nmo:TypeSeriesItem rdf:about="https://example.test/type/type-1">
    <dc:title xml:lang="es">Denario ibérico</dc:title>
    <dc:title xml:lang="en">Iberian denarius</dc:title>
    <ex:label xml:lang="es">Denario ibérico / Cabeza</ex:label>
    <ex:label xml:lang="en">Iberian denarius / Cabeza</ex:label>
    <ex:note xml:lang="es">type-1</ex:note>
    <nmo:hasMint rdf:resource="http://NOMISMA.test/id/castulo"/>
    <nmo:hasStartDate rdf:datatype="http://www.w3.org/2001/XMLSchema#gYear">-25</nmo:hasStartDate>
    <nmo:hasEndDate rdf:datatype="http://www.w3.org/2001/XMLSchema#gYear">10</nmo:hasEndDate>
    <nmo:hasWeight rdf:datatype="http://www.w3.org/2001/XMLSchema#decimal">2.5</nmo:hasWeight>
    <ex:id>941001</ex:id>
    <ex:seeAlso rdf:resource="http://nomisma.test/id/type-1"/>
    <nmo:hasObverse>
      <rdf:Description rdf:about="https://example.test/type/type-1#obverse">
        <ex:legend xml:lang="es">Cabeza</ex:legend>
      </rdf:Description>
    </nmo:hasObverse>

  </nmo:TypeSeriesItem>

  <void:inDataset rdf:about="https://example.test/dataset/941001">
  </void:inDataset>

  <nmo:NumismaticObject rdf:about="https://example.test/object/941101">
    <dc:title xml:lang="es">Moneda 941101</dc:title>
    <nmo:hasWeight rdf:datatype="http://www.w3.org/2001/XMLSchema#integer">1</nmo:hasWeight>
  </nmo:NumismaticObject>

</rdf:RDF>
`;

let tree: VirtualDiffusionTree;
let plan: PublicationPlan;
let filesRoot: string | undefined;
const savedEnv: Record<string, string | undefined> = {};
const createdJobIds: string[] = [];

function setEnv(key: string, value: string): void {
	if (!(key in savedEnv)) savedEnv[key] = process.env[key];
	process.env[key] = value;
}

async function resolveTypes(maxLevels: number): Promise<ResolvedBatch[]> {
	const batches: ResolvedBatch[] = [];
	for await (const batch of resolvePublication(plan, {
		sectionTipo: ZZDIF_RDF_TYPE_SECTION,
		runStartedAt: RUN_STARTED_AT,
		tree,
		maxLevels,
	})) {
		batches.push(batch);
	}
	return batches;
}

function documentsOf(batches: ResolvedBatch[]): Map<number, string> {
	const namespaces = new RdfNamespaceTable(plan.rdf?.namespaces ?? []);
	const documents = new Map<number, string>();
	for (const batch of batches) {
		for (const document of batch.graphs ?? []) {
			documents.set(Number(document.sectionId), serialiseRdfXml(document.graph, namespaces));
		}
	}
	return documents;
}

function typeSectionPlan(): SectionPlan {
	const section = plan.sections.find((entry) => entry.sectionTipo === ZZDIF_RDF_TYPE_SECTION);
	if (section === undefined) throw new Error('the rdf plan has no type section');
	return section;
}

async function deleteActivityRows(): Promise<void> {
	await sql.unsafe(
		`DELETE FROM "${activityTable()}" WHERE section_tipo = 'dd1758'
		   AND relation->'dd1763'->0->>'section_tipo' = $1`,
		[ZZDIF_RDF_TYPE_SECTION],
	);
}

beforeAll(async () => {
	await ensureDiffusionScratchTables();
	pauseScheduler();
	await ensureZzdifDomain();
	await ensureRdfServicesRecord(ZZDIF_RDF_SERVICE_TYPE, ZZDIF_RDF_BASES);
	const built = await buildVirtualDiffusionTree(ZZDIF_DOMAIN_NAME);
	if (built === null) throw new Error(`no dd1190 domain node is named '${ZZDIF_DOMAIN_NAME}'`);
	tree = built;
	plan = await compileElementPlan(ZZDIF_RDF_ELEMENT, { tree });
});

/** TOTAL teardown: every step runs; failures are rethrown together. */
afterAll(async () => {
	const failures: unknown[] = [];
	const step = async (run: () => unknown): Promise<void> => {
		try {
			await run();
		} catch (error) {
			failures.push(error);
		}
	};
	await step(() => deleteJobsForTests(createdJobIds));
	await step(() => deleteActivityRows());
	await step(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	await step(() => bumpOntologyRevision());
	await step(() => resumeScheduler());
	await step(() => {
		if (filesRoot !== undefined) rmSync(filesRoot, { recursive: true, force: true });
	});
	await step(() => removeRdfServicesRecord());
	await step(async () => {
		const residue = await dropZzdifDomain();
		if (residue !== 0) throw new Error(`zzdif situation residue after drop: ${residue} rows`);
	});
	if (failures.length > 0) throw failures[0];
});

describe('compile: an rdf element compiles to a GRAPH plan', () => {
	test('the element carries its xmlns (properties.diffusion.xmlns) and service type', () => {
		expect(plan.format).toBe('rdf');
		// in STORED order: jsonb keeps object keys shortest-first, never the author's
		expect(plan.rdf).toEqual({
			namespaces: [
				['ex', ZZDIF_RDF_EX_NAMESPACE],
				['nmo', 'http://nomisma.org/ontology#'],
				['void', 'http://rdfs.org/ns/void#'],
			],
			serviceType: String(ZZDIF_RDF_SERVICE_TYPE),
		});
		expect(plan.warnings).toEqual([]);
	});

	test('each owl:Class is a section with its class graph; every process type compiles', () => {
		const type = typeSectionPlan();
		expect(type.tableName).toBe('nmo:TypeSeriesItem');
		expect(type.rdfClass?.classTipo).toBe(ZZDIF_RDF_TYPE_CLASS);
		expect(type.rdfClass?.typeUri).toBe('http://nomisma.org/ontology#TypeSeriesItem');
		expect(type.rdfClass?.subject).toEqual({
			baseTitle: 'nmo:TypeSeriesItem',
			baseComponentTipo: 'dd1014',
			varUri: [{ componentTipo: ZZDIF_RDF_CODE_COMPONENT, model: 'component_input_text' }],
		});
		expect(type.rdfClass?.properties.map((property) => property.kind)).toEqual([
			'literal',
			'literal',
			'literal',
			'data_uri',
			'data_date',
			'data_date',
			'data_number',
			'section_id',
			'resource_link',
			'portal',
			'portal',
			'typed_resource',
			'link',
		]);
		const object = plan.sections.find((entry) => entry.sectionTipo === ZZDIF_RDF_OBJECT_SECTION);
		expect(object?.rdfClass?.classTipo).toBe(ZZDIF_RDF_OBJECT_CLASS);
		expect(object?.rdfClass?.properties.map((property) => property.kind)).toEqual([
			'literal',
			'data_number',
			'link',
		]);
	});

	test('a malformed rdf element is REFUSED, every reason named at once', async () => {
		let caught: unknown;
		try {
			await compileElementPlan(ZZDIF_RDF_BROKEN_ELEMENT, { tree });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(PlanCompileError);
		const errors = (caught as PlanCompileError).compileErrors.join('\n');
		for (const reason of [
			"top-level 'xmlns' is the v6 spelling",
			'missing properties.diffusion.service_type',
			'(nmo:NoSubject) → section',
			"'undeclared:title' is not an expandable QName",
			'get_data_date needs process.get_date',
			"declares a relation_list 'config'",
			'php_formula is a bare string',
		]) {
			expect(errors, `missing refusal: ${reason}`).toContain(reason);
		}
	});
});

describe('resolve: one published record → one graph document', () => {
	let batches: ResolvedBatch[];
	let documents: Map<number, string>;

	beforeAll(async () => {
		batches = await resolveTypes(1);
		documents = documentsOf(batches);
	});

	test('the batch carries GRAPHS, no rows, no error', () => {
		expect(batches.flatMap((batch) => batch.errors)).toEqual([]);
		expect(batches.flatMap((batch) => batch.rows)).toEqual([]);
		expect([...documents.keys()].sort()).toEqual([FULL_TYPE, MINIMAL_TYPE]);
	});

	test('the full record publishes the pinned document', () => {
		expect(documents.get(FULL_TYPE)).toBe(FULL_TYPE_DOCUMENT);
	});

	test('a record with only a title still gets its subject; empty properties publish nothing', () => {
		const document = documents.get(MINIMAL_TYPE) as string;
		expect(document).toContain('<nmo:TypeSeriesItem rdf:about="https://example.test/type/type-2">');
		expect(document).toContain('<dc:title xml:lang="es">Segundo tipo</dc:title>');
		expect(document).not.toContain('nmo:hasMint');
		expect(document).not.toContain('nmo:hasObverse');
		expect(document).not.toContain('nmo:NumismaticObject');
		expect(document).not.toContain('urn:dedalo');
	});

	test('the link cap is the run levels: 2 levels inline the next PUBLISHABLE object too', async () => {
		const wider = documentsOf(await resolveTypes(2)).get(FULL_TYPE) as string;
		expect(wider).toContain('rdf:about="https://example.test/object/941101"');
		expect(wider).toContain('rdf:about="https://example.test/object/941103"');
		expect(wider).not.toContain(`object/${ZZDIF_RDF_UNPUBLISHABLE_OBJECT}`);
	});

	test('no publication-services record for the entity: the record is NOT written, the report names the title', async () => {
		await removeRdfServicesRecord();
		try {
			const refused = await resolveTypes(1);
			expect(refused.flatMap((batch) => batch.graphs ?? [])).toEqual([]);
			const errors = refused.flatMap((batch) => batch.errors);
			expect(errors.map((error) => Number(error.sectionId)).sort()).toEqual([
				FULL_TYPE,
				MINIMAL_TYPE,
			]);
			for (const error of errors) {
				expect(error.message).toContain('record NOT written');
				expect(error.message).toContain("no base IRI titled 'nmo:TypeSeriesItem'");
			}
		} finally {
			await ensureRdfServicesRecord(ZZDIF_RDF_SERVICE_TYPE, ZZDIF_RDF_BASES);
		}
	});
});

describe('runJob: the rdf element publishes one file per record + the merged document', () => {
	let outputDir: string;

	beforeAll(async () => {
		filesRoot = scratchMediaRoot('dedalo_diffusion_rdf_graph_');
		setEnv('DEDALO_DIFFUSION_FILES_ROOT', filesRoot);
		setEnv('DEDALO_DIFFUSION_DOMAIN', ZZDIF_DOMAIN_NAME);
		bumpOntologyRevision();
		const stale = (await listActiveJobs()).filter((row) => row.state === 'queued');
		await deleteJobsForTests(stale.map((row) => row.job_id));
		await deleteActivityRows();
		const { job, attached } = await enqueueDiffusionJob({
			ownerUserId: OWNER,
			clientProcessId: `process_diffusion_${OWNER}_${ZZDIF_RDF_ELEMENT}_${ZZDIF_RDF_TYPE_SECTION}`,
			spec: {
				diffusion_element_tipo: ZZDIF_RDF_ELEMENT,
				section_tipo: ZZDIF_RDF_TYPE_SECTION,
				type: 'rdf',
				sqo: { section_tipo: ZZDIF_RDF_TYPE_SECTION },
				estimated_total: ZZDIF_RDF_TYPE_IDS.length,
				options: {},
			},
		});
		createdJobIds.push(job.job_id);
		if (attached) throw new Error('attached to a pre-existing active rdf run');
		const claimed = await claimNextQueuedJob('diffusion_rdf_graph_native');
		if (claimed === null || claimed.job_id !== job.job_id) {
			throw new Error(`claimed ${claimed?.job_id ?? 'nothing'} instead of ${job.job_id}`);
		}
		await runJob(claimed.job_id, claimed.attempt);
		const finished = await getJobById(job.job_id);
		expect(finished?.state).toBe('completed');
		expect(finished?.result?.errors).toEqual([]);
		outputDir = join(filesRoot, 'rdf', ZZDIF_RDF_SERVICE_NAME);
	}, 120_000);

	test('each published type has its own document, named by the delete-side grammar', () => {
		const section = typeSectionPlan();
		for (const id of ZZDIF_RDF_TYPE_IDS) {
			const path = join(outputDir, rdfRecordFileName(section, id));
			expect(existsSync(path), `missing ${path}`).toBe(true);
			const document = readFileSync(path, 'utf-8');
			expect(document).toContain(`rdf:about="https://example.test/type/type-${id - 941000}"`);
			expect(document).not.toContain('urn:dedalo');
		}
		// no stray artifacts: two records, the merged document, its zip
		expect(readdirSync(outputDir).sort()).toEqual(
			[
				rdfRecordFileName(section, FULL_TYPE),
				rdfRecordFileName(section, MINIMAL_TYPE),
				'diffusion_rdf.zip',
				'diffusion_rdf_merged.rdf',
			].sort(),
		);
	});

	test('the merged document is ONE envelope over every record subject', () => {
		const merged = readFileSync(join(outputDir, 'diffusion_rdf_merged.rdf'), 'utf-8');
		expect(merged.match(/<rdf:RDF/g)?.length).toBe(1);
		expect(merged).toContain('rdf:about="https://example.test/type/type-1"');
		expect(merged).toContain('rdf:about="https://example.test/type/type-2"');
		expect(merged).toContain(`xmlns:ex="${ZZDIF_RDF_EX_NAMESPACE}"`);
	});
});
