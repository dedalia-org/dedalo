/**
 * host_units — THE INSTANCE'S SYSTEMD UNITS (terminal installer phase 4,
 * 2026-10-12): the shared template units (deploy/systemd/*@*, one copy per
 * host) and this instance's drop-ins (systemd/render.ts), then
 * `daemon-reload` and `enable dedalo-ts@<i>.service` — WITHOUT --now (the
 * first boot is its own step) and WITHOUT the watchdog (armed only after the
 * first boot completed — host_watchdog) or the backup timer (enabled only
 * after a verified first backup — host_backup_verify, critique A7).
 *
 * A template that already exists with OTHER bytes is judged by the SHIPPED
 * DIGEST LEDGER (owner ruling C33, 2026-11-13; systemd/shipped_digests.ts):
 * bytes an EARLIER RELEASE shipped are the installer's own and are UPGRADED
 * in place (every instance on this host runs the new template at its next
 * restart — a release's unit, not a stranger's); bytes no release ever shipped
 * (another installer's, an operator's edit, a single-instance unit of the same
 * name) are REFUSED — never overwritten. Templates are removed on --abort only
 * when no other instance still uses them (the registry's refcount — whichever
 * instance wrote them); an upgraded template that stays is a shipped one.
 *
 * THE SIBLING LAW (C32/C33 review gap, 2026-11-14): a template's render is
 * PAIRED with each instance's drop-ins (`ProtectSystem=strict` relies on the
 * drop-in's `ReadWritePaths=`), so a shipped template is upgraded only once
 * every OTHER instance on the host runs this release's drop-ins; otherwise the
 * upgrade is DEFERRED and the earlier template kept — `siblingUnitsBlockers`,
 * `templateUpgradeDecision`. A shared-template upgrade can never make a sibling
 * read-only at its next restart.
 */

import type {
	HostCommand,
	HostCtx,
	HostPlanCtx,
	HostStepDefinition,
	WriteCommand,
} from '../contract.ts';
import { executeCommands } from '../execute.ts';
import { type HostFs, sha256Text } from '../fs.ts';
import { hostRefuse } from '../refuse.ts';
import { otherEntries, updateEntry } from '../registry.ts';
import {
	instanceDropins,
	instanceManifests,
	renderTemplate,
	SYSTEMD_DIR,
	UNIT_TEMPLATES,
	type UnitTemplate,
	unitsRefreshCommand,
} from '../systemd/render.ts';
import {
	isShippedDigest,
	readShippedDigests,
	type ShippedDigests,
} from '../systemd/shipped_digests.ts';
import { exec, probe, probeOk, ran, remember, stampOf, systemctl, verdictOf } from './common.ts';
import { type RecordReader, readRecordVia, recordedPlanContext } from './instance_record.ts';

/** The template writes (0644 root). */
export function templateWrites(ctx: HostPlanCtx): WriteCommand[] {
	return UNIT_TEMPLATES.map((name) => ({
		kind: 'write',
		path: `${SYSTEMD_DIR}/${name}`,
		mode: 0o644,
		owner: 'root',
		group: 'root',
		content: renderTemplate(name, ctx.row, ctx.source),
		label: `template unit ${name}`,
	}));
}

/** The drop-in writes (0644 root) — and the writable-roots manifest beside the server's (C32). */
export function dropinWrites(ctx: HostPlanCtx): WriteCommand[] {
	const stamp = stampOf(ctx);
	return [
		...instanceDropins(ctx.paths, ctx.row, ctx.answers, stamp).map(
			(dropin): WriteCommand => ({
				kind: 'write',
				path: dropin.path,
				mode: 0o644,
				owner: 'root',
				group: 'root',
				content: dropin.content,
				label: `drop-in ${dropin.path.slice(SYSTEMD_DIR.length + 1)}`,
			}),
		),
		...instanceManifests(ctx.paths, ctx.answers, stamp).map(
			(manifest): WriteCommand => ({
				kind: 'write',
				path: manifest.path,
				mode: 0o644,
				owner: 'root',
				group: 'root',
				content: manifest.content,
				label: `writable-roots manifest ${manifest.path.slice(SYSTEMD_DIR.length + 1)}`,
			}),
		),
	];
}

/** The server unit of the instance. */
export function serverUnit(ctx: HostPlanCtx): string {
	return `dedalo-ts@${ctx.paths.instance}.service`;
}

/** The step's commands as the Review lists them: every template, the drop-ins, reload, enable. */
export function unitCommands(ctx: HostPlanCtx): HostCommand[] {
	return unitCommandsWriting(ctx, templateWrites(ctx));
}

/** The run's commands under a decision: only the templates it writes (a deferred one is kept). */
export function unitCommandsFor(
	ctx: HostPlanCtx,
	decision: TemplateUpgradeDecision,
): HostCommand[] {
	const written = new Set(decision.write.map((verdict) => verdict.path));
	return unitCommandsWriting(
		ctx,
		templateWrites(ctx).filter((write) => written.has(write.path)),
	);
}

function unitCommandsWriting(ctx: HostPlanCtx, templates: WriteCommand[]): HostCommand[] {
	return [
		...templates,
		...dropinWrites(ctx),
		systemctl(ctx, 'daemon-reload', [], 'reload systemd'),
		systemctl(
			ctx,
			'enable',
			[serverUnit(ctx)],
			`enable ${serverUnit(ctx)} (started by the first-boot step)`,
		),
	];
}

/** What the host holds at a template's path, judged against this release's render and the shipped ledger. */
export interface TemplateVerdict {
	readonly name: UnitTemplate;
	readonly path: string;
	/**
	 * absent: nothing there; current: byte-equal to this release's render; shipped:
	 * an EARLIER release's render (its digest in deploy/systemd/shipped_digests.json —
	 * the installer's own, upgraded in place); foreign: bytes no release shipped
	 * (another installer's, a hand edit — refused, never overwritten).
	 */
	readonly verdict: 'absent' | 'current' | 'shipped' | 'foreign';
}

/**
 * Every template's verdict on this host (the `fs` seam: a gate's scratch root,
 * the refresh CLI's real one; the ledger is the SOURCE tree's — the release
 * being installed remembers what the earlier ones wrote).
 */
export function templateVerdicts(
	ctx: HostPlanCtx,
	fs: HostFs,
	ledger: ShippedDigests = readShippedDigests(ctx.source),
): TemplateVerdict[] {
	return templateWrites(ctx).map((write, index) => {
		const name = UNIT_TEMPLATES[index] as UnitTemplate;
		const text = fs.readText(write.path);
		if (text === null) return { name, path: write.path, verdict: 'absent' };
		if (text === write.content) return { name, path: write.path, verdict: 'current' };
		if (isShippedDigest(ledger, name, sha256Text(text))) {
			return { name, path: write.path, verdict: 'shipped' };
		}
		return { name, path: write.path, verdict: 'foreign' };
	});
}

/** The refusal sentence for templates no release shipped (host_units and the refresh share it). */
export function foreignTemplateSentence(paths: readonly string[]): string {
	return `${paths.join(', ')} already exist(s) with other content than any release shipped — another installer's or an edited copy; the installer never overwrites it (compare it with deploy/systemd/, then remove it or keep this host's instances on it)`;
}

/** Why another instance on this host is not ready for this release's shared templates. */
export interface SiblingBlocker {
	readonly instance: string;
	readonly reason: string;
	/** That instance's own root re-render command (absent when its record cannot be read). */
	readonly refresh?: string;
}

/**
 * THE SIBLING LAW (see the header). Every OTHER registered instance that uses
 * the templates (`templates: true`) is rendered from its own frozen record
 * (instance_record.ts — the same derivation its refresh uses) and is READY when
 * each of its drop-ins and its manifest is byte-equal on disk. Not ready: a
 * stale or absent instance file (an earlier release's drop-in, a pre-C32 one
 * without `ReadWritePaths=`), or a record that cannot be read (fail closed —
 * nothing is known about its drop-ins). Each blocker carries that instance's
 * own re-render command; running it judges the others in turn, so the LAST
 * instance brought to this release upgrades the template.
 */
export function siblingUnitsBlockers(
	ctx: HostPlanCtx,
	fs: HostFs,
	readRecord: RecordReader = readRecordVia(fs),
): SiblingBlocker[] {
	const blockers: SiblingBlocker[] = [];
	for (const entry of otherEntries(fs, ctx.paths)) {
		if (!entry.templates) continue;
		let sibling: HostPlanCtx;
		try {
			sibling = recordedPlanContext(entry.instance, { fs, readRecord, source: ctx.source });
		} catch (error) {
			blockers.push({
				instance: entry.instance,
				reason: `its install record cannot be read (${(error as Error).message}) — finish, abort or re-render that instance first`,
			});
			continue;
		}
		const stale = dropinWrites(sibling)
			.filter((write) => fs.readText(write.path) !== write.content)
			.map((write) => write.path.slice(SYSTEMD_DIR.length + 1));
		if (stale.length === 0) continue;
		blockers.push({
			instance: entry.instance,
			reason: `its units are not this release's render (${stale.join(', ')})`,
			refresh: unitsRefreshCommand(sibling.paths),
		});
	}
	return blockers;
}

/** What host_units / the refresh do with each template: write it, keep it (deferred), or refuse (foreign). */
export interface TemplateUpgradeDecision {
	readonly verdicts: TemplateVerdict[];
	/** Templates no release shipped: the caller refuses, nothing is written. */
	readonly foreign: TemplateVerdict[];
	/** Templates written now: absent ones, and the shipped ones when no sibling blocks. */
	readonly write: TemplateVerdict[];
	/** Shipped templates KEPT at the earlier render — `blockers` are not ready. */
	readonly deferred: TemplateVerdict[];
	readonly blockers: SiblingBlocker[];
}

/**
 * Judge the templates and decide the upgrade by the sibling law. The sibling
 * check runs only when a shipped template is there to upgrade and no foreign
 * one refuses: a host whose templates are current or absent reads no other
 * instance's record.
 */
export function templateUpgradeDecision(
	ctx: HostPlanCtx,
	fs: HostFs,
	readRecord: RecordReader = readRecordVia(fs),
	ledger?: ShippedDigests,
): TemplateUpgradeDecision {
	const verdicts = templateVerdicts(ctx, fs, ledger);
	const foreign = verdicts.filter((v) => v.verdict === 'foreign');
	const absent = verdicts.filter((v) => v.verdict === 'absent');
	const shipped = verdicts.filter((v) => v.verdict === 'shipped');
	if (foreign.length > 0) return { verdicts, foreign, write: [], deferred: [], blockers: [] };
	const blockers = shipped.length === 0 ? [] : siblingUnitsBlockers(ctx, fs, readRecord);
	return blockers.length === 0
		? { verdicts, foreign, write: [...absent, ...shipped], deferred: [], blockers }
		: { verdicts, foreign, write: absent, deferred: shipped, blockers };
}

/** The sentence a deferred upgrade is reported with (host_units' line and the refresh's `next`). */
export function deferredTemplateSentence(
	decision: TemplateUpgradeDecision,
	ctx: HostPlanCtx,
): string {
	const names = decision.deferred.map((v) => v.name).join(', ');
	const who = decision.blockers
		.map(
			(b) =>
				`${b.instance}: ${b.reason}${b.refresh === undefined ? '' : ` — re-render it as root: ${b.refresh}`}`,
		)
		.join('; ');
	return `${decision.deferred.length} template(s) of an earlier release KEPT (${names}): a shared template is upgraded only once every instance on this host runs this release's drop-ins, and these do not — ${who}. The last instance re-rendered upgrades the template; then re-render this one: ${unitsRefreshCommand(ctx.paths)}`;
}

/** The step's decision; a template present with bytes no release shipped is someone else's: refused, never overwritten. */
function decideTemplates(ctx: HostCtx): TemplateUpgradeDecision {
	const decision = templateUpgradeDecision(ctx, ctx.fs);
	if (decision.foreign.length > 0) {
		hostRefuse(
			'install.state_conflict',
			foreignTemplateSentence(decision.foreign.map((v) => v.path)),
		);
	}
	return decision;
}

/** The verify's template checks: current, or a shipped render the sibling law keeps; a foreign one is drift. */
function templateChecks(ctx: HostCtx): [boolean, string][] {
	const decision = templateUpgradeDecision(ctx, ctx.fs);
	const deferred = new Set(decision.deferred.map((v) => v.path));
	return templateWrites(ctx).map((write): [boolean, string] => [
		ctx.fs.readText(write.path) === write.content || deferred.has(write.path),
		`${write.path} differs from its render`,
	]);
}

/**
 * Remove the templates when no other instance still uses them — decided by the
 * REGISTRY's refcount, not by who wrote them: the instance that wrote them may
 * have been aborted first, and the last user must still clean them up. Only a
 * template byte-equal to this release's render goes (an installer's own file,
 * whichever instance wrote it); another byte content is someone else's.
 */
async function removeTemplates(ctx: HostCtx): Promise<string> {
	if (otherEntries(ctx.fs, ctx.paths).some((entry) => entry.templates)) {
		return 'templates kept (another instance uses them)';
	}
	const ours = templateWrites(ctx).filter((write) => ctx.fs.readText(write.path) === write.content);
	for (const write of ours) ctx.fs.remove(write.path);
	if (ours.length === 0) return 'no installer template left to remove';
	return `${ours.length} template(s) removed (no instance uses them)`;
}

export const host_units: HostStepDefinition = {
	id: 'host_units',
	privilege: 'root',
	kind: 'action',
	needs: [],
	label: (plan) =>
		`systemd units: dedalo-ts@${String(plan.answers.instance)} and its backup/watchdog templates`,
	commands: unitCommands,
	verify: async (ctx) =>
		verdictOf(
			[
				// A template kept at an earlier shipped render under the sibling law is
				// what the run meant: judged again here (read-only), it is not drift.
				...templateChecks(ctx),
				...dropinWrites(ctx).map((write): [boolean, string] => [
					ctx.fs.readText(write.path) === write.content,
					`${write.path} differs from its render`,
				]),
				[
					await probeOk(ctx, probe(ctx, 'systemctl', ['is-enabled', serverUnit(ctx)], 'enabled')),
					`${serverUnit(ctx)} is not enabled`,
				],
			],
			`${UNIT_TEMPLATES.length} templates, the drop-ins, ${serverUnit(ctx)} enabled`,
		),
	run: async (ctx) => {
		// An earlier release's template is upgraded by the same write (C33) — unless
		// a sibling instance is not ready for it (the sibling law: kept, said); a
		// foreign one refuses the step.
		const decision = decideTemplates(ctx);
		await executeCommands(unitCommandsFor(ctx, decision), ctx);
		updateEntry(ctx.fs, ctx.paths, { templates: true });
		const upgraded = decision.write.filter((v) => v.verdict === 'shipped');
		const notes = [
			upgraded.length === 0
				? ''
				: `; ${upgraded.length} template(s) of an earlier release upgraded to this one (${upgraded.map((v) => v.name).join(', ')} — the other instances on this host run it at their next restart)`,
			decision.deferred.length === 0 ? '' : `; ${deferredTemplateSentence(decision, ctx)}`,
		];
		return ran(`${serverUnit(ctx)} enabled (not started yet)${notes.join('')}`);
	},
	intent: (ctx) => {
		for (const write of templateWrites(ctx))
			if (!ctx.fs.exists(write.path)) remember(ctx.created.units, write.path);
		for (const write of dropinWrites(ctx)) remember(ctx.created.dropins, write.path);
		remember(ctx.created.enabled, serverUnit(ctx));
	},
	undo: async (ctx) => {
		const i = ctx.paths.instance;
		await executeCommands(
			[
				exec(
					ctx,
					'systemctl',
					[
						'disable',
						'--now',
						serverUnit(ctx),
						`dedalo-ts-watchdog@${i}.timer`,
						`dedalo-backup@${i}.timer`,
					],
					'stop and disable the instance units',
					{ okExit: [0, 1, 5] },
				),
			],
			ctx,
		);
		for (const path of ctx.created.dropins) {
			ctx.fs.remove(path);
			ctx.fs.rmdirIfEmpty(path.slice(0, path.lastIndexOf('/')));
		}
		updateEntry(ctx.fs, ctx.paths, { templates: false });
		const templates = await removeTemplates(ctx);
		await executeCommands([systemctl(ctx, 'daemon-reload', [], 'reload systemd')], ctx);
		return `units disabled, drop-ins removed; ${templates}`;
	},
};
