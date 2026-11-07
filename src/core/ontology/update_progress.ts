/**
 * ONTOLOGY UPDATE PROGRESS — where an ontology import is, for the operator's
 * progress bar (the update_ontology panel runs the import as a background job
 * and streams these frames through the job's data channel).
 *
 * A REQUEST-SCOPED sink (AsyncLocalStorage), never a module-level callback:
 * the import is shared with the installer's ontology door, which reports to no
 * one, and two imports may never write into each other's job. No sink → every
 * report is a no-op, so the shared layer's signatures stay as they are.
 *
 * `done` counts the items of `stage` FINISHED before the one named by `tld`
 * (0-based progress: "importing es, 3 of 12 done"). Stages run in this order:
 * download → import → derive → finish. The client weighs them (the stage
 * durations differ per install); the server reports facts, never percentages.
 *
 * LEAF module: the import layers import it, it imports none of them.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type OntologyProgressStage = 'download' | 'import' | 'derive' | 'finish';

export interface OntologyProgressFrame {
	/** Plain-text line for a generic job viewer (render_stream shows `data.msg`). */
	msg: string;
	progress: {
		stage: OntologyProgressStage;
		done: number;
		total: number;
		tld?: string;
	};
}

const sink = new AsyncLocalStorage<(frame: OntologyProgressFrame) => void>();

/** Runs `fn` with `report` receiving every progress frame `fn`'s import emits. */
export function withOntologyProgress<T>(
	report: (frame: OntologyProgressFrame) => void,
	fn: () => Promise<T>,
): Promise<T> {
	return sink.run(report, fn);
}

/** One step of `stage`: `done` of `total` finished, `tld` the one starting now. */
export function reportOntologyProgress(
	stage: OntologyProgressStage,
	done: number,
	total: number,
	tld?: string,
): void {
	const report = sink.getStore();
	if (report === undefined) return;
	report({
		msg: `${stage}${tld === undefined ? '' : ` ${tld}`} (${done}/${total})`,
		progress: { stage, done, total, ...(tld === undefined ? {} : { tld }) },
	});
}
