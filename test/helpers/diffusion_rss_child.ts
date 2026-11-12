/**
 * THE MEASURED PROCESS of diffusion_artifact_rss_native (PERF-2/DIFF-4).
 *
 * A peak-RSS ceiling can only be measured in a process that does ONE thing:
 * the peak RSS is a high-water mark (KiB) of the whole process (peakKiB), so
 * the gate spawns this file per measurement and reads the delta it prints as
 * the last stdout line (JSON). The BASELINE is the CURRENT resident
 * size after a full GC (`process.memoryUsage().rss`), never the high-water mark
 * itself: a phase before the measured one (the rdf mode's writes) may have
 * peaked higher than where the process now sits, and measuring from that peak
 * would hide every byte the measured step grows back up to it. Modes:
 *
 *   control <file>            read the file WHOLE — the positive control proving
 *                             the unit and the probe (its delta must be large);
 *   zip <out.zip> <file>...   the production `createZip` over big files;
 *   rdf-write <count> <bytes> an rdf writer session writes <count> records of
 *                             ~<bytes> each (batches of 10, GC between them)
 *                             through `writeGraphs` — the production record files;
 *   rdf-close <count>         a FRESH session (same plan, same job) runs `close()`
 *                             — the consolidation (merge + zip) — over them, from
 *                             the BASELINE: the measured delta is close()'s alone.
 *
 * TWO PROCESSES, because maxRSS is a LIFETIME high-water mark nothing resets: in
 * one process the write phase's peak (measured 920 MiB on Linux in the CI image,
 * 2026-10-01 — the process then sat at 54 MiB) was reported as close()'s growth.
 * The close gets the synthetic run context the runner passes (the artifact
 * manifest = every record written, in order), so it consolidates files another
 * process wrote — a close that consolidated only its own writes would archive
 * nothing, and the gate's archive check (every record named, CRCs) reds it.
 *
 * The environment is the parent's (DEDALO_DIFFUSION_FILES_ROOT points at a
 * MARKED scratch root; the test media guard is inherited armed).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { FieldPlan, PublicationPlan, SectionPlan } from '../../src/diffusion/plan/types.ts';

const [mode, ...args] = process.argv.slice(2);

/**
 * LINUX: the peak is the kernel's VmHWM, RESET at the baseline. getrusage's
 * ru_maxrss SURVIVES execve on Linux, so a spawned child starts with its
 * PARENT's high-water mark: measured 2026-10-01 in the CI image, every rdf child
 * began at 791 MiB (the gate process had just read A's 320 MiB archive whole to
 * check its CRCs) and reported that as close()'s growth. `clear_refs` 5 resets
 * VmHWM to the current RSS. Elsewhere (macOS: not inherited) ru_maxrss stands.
 */
const PROC_STATUS = '/proc/self/status';
const resettablePeak = existsSync(PROC_STATUS);

function peakKiB(): number {
	if (!resettablePeak) return process.resourceUsage().maxRSS;
	const hwm = /^VmHWM:\s+(\d+) kB$/m.exec(readFileSync(PROC_STATUS, 'utf8'));
	if (hwm === null) throw new Error('diffusion_rss_child: no VmHWM in /proc/self/status');
	return Number(hwm[1]);
}

/** The resident size NOW (KiB), after a full collection — the delta's baseline. */
function baselineKiB(): number {
	Bun.gc(true);
	if (resettablePeak) writeFileSync('/proc/self/clear_refs', '5');
	return Math.floor(process.memoryUsage().rss / 1024);
}

function report(baseline: number, extra: Record<string, unknown> = {}): void {
	const peak = peakKiB();
	console.log(
		JSON.stringify({
			mode,
			baselineKiB: baseline,
			peakKiB: peak,
			deltaKiB: peak - baseline,
			...extra,
		}),
	);
}

if (mode === 'control') {
	const [path] = args;
	const baseline = baselineKiB();
	const bytes = new Uint8Array(await Bun.file(path as string).arrayBuffer());
	let checksum = 0;
	for (let index = 0; index < bytes.length; index += 4096)
		checksum = (checksum + (bytes[index] ?? 0)) | 0;
	report(baseline, { checksum });
} else if (mode === 'zip') {
	const [outPath, ...inputs] = args;
	const { createZip } = await import('../../src/diffusion/writers/files.ts');
	const baseline = baselineKiB();
	await createZip(inputs, outPath as string);
	report(baseline);
} else if (mode === 'rdf-write' || mode === 'rdf-close') {
	const count = Number(args[0]);
	const partBytes = Number(args[1] ?? 0);
	const { rdfWriter } = await import('../../src/diffusion/writers/rdf.ts');
	const { TEST_RDF_ELEMENT, testRdfDocument } = await import('./rdf_test_documents.ts');
	const titleField: FieldPlan = {
		id: 'rss_title',
		columnName: 'dc:title',
		sourceChain: [],
		transform: [],
		column: { fieldModel: 'field_text' },
		policy: {},
		excludeColumn: false,
	};
	const section: SectionPlan = {
		sectionTipo: 'test6100',
		tableName: 'nmo:NumismaticObject',
		tableTipo: 'test6100_table',
		fields: [titleField],
	};
	const plan: PublicationPlan = {
		planId: 'rss_rdf',
		elementTipo: 'test6112',
		format: 'rdf',
		serviceName: 'rss_rdf',
		target: { kind: 'files', serviceName: 'rss_rdf' },
		sections: [section],
		recursion: { maxLevels: 0 },
		langPolicy: { langs: ['lg-eng'], mainLang: 'lg-eng' },
		warnings: [],
		rdf: TEST_RDF_ELEMENT,
	} as PublicationPlan;
	const open = rdfWriter.open as unknown as (
		plan: PublicationPlan,
		context?: { jobId: string; resume: unknown },
	) => Promise<{
		ensureSchema(): Promise<void>;
		writeGraphs(
			section: SectionPlan,
			documents: ReturnType<typeof testRdfDocument>[],
		): Promise<unknown>;
		close(context?: unknown): Promise<{ tables: { table_name: string }[] }>;
	}>;
	const session = await open(plan, { jobId: '00000000-0000-4000-8000-00000000f00d', resume: null });
	await session.ensureSchema();
	if (mode === 'rdf-write') {
		const filler = 'a'.repeat(partBytes);
		for (let first = 1; first <= count; first += 10) {
			const documents: ReturnType<typeof testRdfDocument>[] = [];
			for (let id = first; id < first + 10 && id <= count; id++) {
				documents.push(testRdfDocument(id, [[`${id} ${filler}`, 'en']]));
			}
			await session.writeGraphs(section, documents);
			Bun.gc(true);
		}
		report(baselineKiB());
		process.exit(0);
	}
	const context = {
		async *manifest() {
			for (let id = 1; id <= count; id++) yield { sectionTipo: section.sectionTipo, sectionId: id };
		},
		async *removed() {},
	};
	const baseline = baselineKiB();
	const summary = await session.close(context);
	report(baseline, { tables: summary.tables.map((table) => table.table_name) });
} else {
	console.error(`diffusion_rss_child: unknown mode '${mode}'`);
	process.exit(2);
}
process.exit(0);
