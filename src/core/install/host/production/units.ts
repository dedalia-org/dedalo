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
 * read-only at its next restart. Each blocker's REMEDY is judged on that
 * sibling's TREE (`siblingTreeVerdict`): its own re-render command when the
 * tree is this release; "update that instance first" when it is an earlier one
 * — a sibling on an earlier release has no re-render command in its tree, and
 * its own refresh would render its release's drop-ins, never this one's.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILD_INFO_PATH, parseBuildInfo } from '../../../update/release_identity.ts';
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
	UNITS_REFRESH_SCRIPT,
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
	/**
	 * What brings it to this release's render, as a sentence: the command alone
	 * when its tree IS this release; `update … first, then …` when its tree is an
	 * earlier release (the command is a missing file there, and an earlier
	 * release renders ITS OWN drop-ins, which never byte-equal this render).
	 */
	readonly remedy?: string;
}

/** What a sibling's TREE is, judged for the remedy (siblingTreeVerdict). */
export type SiblingTreeVerdict =
	/** No re-render command in it: a release before 2026-11-13 (or no tree at all). */
	| 'no_command'
	/** Both build stamps read and equal: the same source, the same render. */
	| 'same_release'
	/** Both build stamps read and differ: another release. */
	| 'other_release'
	/** A stamp missing or unexpanded (a checkout): the trees cannot be compared. */
	| 'unknown';

/** This tree's build sha (build_info.txt), or null on a checkout / a tree without the stamp. */
function sourceBuildSha(source: string): string | null {
	try {
		return parseBuildInfo(readFileSync(join(source, BUILD_INFO_PATH), 'utf8')).sha;
	} catch {
		return null;
	}
}

/**
 * Judge another instance's tree (through the host fs — a scratch root in a
 * gate) against this source tree: does the re-render command exist there, and
 * is it the SAME SOURCE (the archive's commit sha in build_info.txt — the one
 * per-source identity both a release and a dev-channel build carry; a checkout
 * holds the placeholder and compares with nothing).
 */
export function siblingTreeVerdict(fs: HostFs, tree: string, source: string): SiblingTreeVerdict {
	if (!fs.exists(`${tree}/${UNITS_REFRESH_SCRIPT}`)) return 'no_command';
	const sibling = parseBuildInfo(fs.readText(`${tree}/${BUILD_INFO_PATH}`) ?? '').sha;
	const ours = sourceBuildSha(source);
	if (sibling === null || ours === null) return 'unknown';
	return sibling === ours ? 'same_release' : 'other_release';
}

/** The remedy sentence for a stale sibling, by its tree's verdict. */
function siblingRemedy(verdict: SiblingTreeVerdict, tree: string, refresh: string): string {
	switch (verdict) {
		case 'same_release':
			return `re-render it as root: ${refresh}`;
		case 'unknown':
			return `make sure ${tree} runs this release (its build cannot be compared with this tree's: no build stamp), then re-render it as root: ${refresh}`;
		case 'no_command':
			return `its tree ${tree} is an earlier release (no ${UNITS_REFRESH_SCRIPT} in it) — update that instance to this release first (its Maintenance panel), then re-render it as root: ${refresh}`;
		case 'other_release':
			return `its tree ${tree} is another release's build (an earlier release renders its own drop-ins, never this release's) — update that instance to this release first (its Maintenance panel), then re-render it as root: ${refresh}`;
	}
}

/**
 * THE SIBLING LAW (see the header). Every OTHER registered instance that uses
 * the templates (`templates: true`) is rendered from its own frozen record
 * (instance_record.ts — the same derivation its refresh uses) and is READY when
 * each of its drop-ins and its manifest is byte-equal on disk. Not ready: a
 * stale or absent instance file (an earlier release's drop-in, a pre-C32 one
 * without `ReadWritePaths=`), or a record that cannot be read (fail closed —
 * nothing is known about its drop-ins; a reader that THROWS on a corrupt file
 * is caught HERE, so the refreshing instance's own files are still rewritten
 * and the sibling is named, never the exception's text). Each blocker carries
 * that instance's own re-render command AND the remedy that makes it apply:
 * the command alone when its tree is this release; an update of that instance
 * first when its tree is an earlier one (the command is a missing file there,
 * and its own refresh renders ITS release's drop-ins). Running the remedies
 * judges the others in turn, so the LAST instance brought to this release
 * upgrades the template.
 */
export function siblingUnitsBlockers(
	ctx: HostPlanCtx,
	fs: HostFs,
	readRecord: RecordReader = readRecordVia(fs),
): SiblingBlocker[] {
	const blockers: SiblingBlocker[] = [];
	for (const entry of otherEntries(fs, ctx.paths)) {
		if (!entry.templates) continue;
		const blocker = siblingBlocker(entry.instance, ctx, fs, readRecord);
		if (blocker !== null) blockers.push(blocker);
	}
	return blockers;
}

/** ONE sibling's judgment: null = ready (its instance files are this release's render). */
function siblingBlocker(
	instance: string,
	ctx: HostPlanCtx,
	fs: HostFs,
	readRecord: RecordReader,
): SiblingBlocker | null {
	// Classified BEFORE the render, so the blocker's reason is this module's own
	// sentence (never an exception's text): no record, or no measured facts.
	const record = readRecordOrNull(readRecord, instance);
	const facts = record?.state?.preflight.host?.facts;
	if (record === null || facts === undefined || facts.os === null) {
		return {
			instance,
			reason:
				record === null
					? `its install record cannot be read (/var/lib/dedalo-install/${instance}/) — finish, abort or re-render that instance first`
					: `its install record holds no measured host facts (the System check never ran to completion) — finish or abort that install first`,
		};
	}
	const sibling = recordedPlanContext(instance, { fs, readRecord, source: ctx.source });
	const stale = dropinWrites(sibling)
		.filter((write) => fs.readText(write.path) !== write.content)
		.map((write) => write.path.slice(SYSTEMD_DIR.length + 1));
	if (stale.length === 0) return null;
	const refresh = unitsRefreshCommand(sibling.paths);
	return {
		instance,
		reason: `its units are not this release's render (${stale.join(', ')})`,
		refresh,
		remedy: siblingRemedy(
			siblingTreeVerdict(fs, sibling.paths.tree, ctx.source),
			sibling.paths.tree,
			refresh,
		),
	};
}

/**
 * A sibling's record through ANY reader: the CLI's (host_executor.ts
 * readHostRecord — THROWS `install.state_conflict` on a corrupt or other-schema
 * file) and the gate's alike. Unreadable is "no record" here: a sibling check
 * fails closed on that sibling, never out of the refreshing instance's own
 * refresh (its drop-ins would stay un-rendered and the engine unbootable).
 */
function readRecordOrNull(readRecord: RecordReader, instance: string): ReturnType<RecordReader> {
	try {
		return readRecord(instance);
	} catch {
		return null;
	}
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
		.map((b) => `${b.instance}: ${b.reason}${b.remedy === undefined ? '' : ` — ${b.remedy}`}`)
		.join('; ');
	return `${decision.deferred.length} template(s) of an earlier release KEPT (${names}): a shared template is upgraded only once every instance on this host runs this release's drop-ins, and these do not — ${who}. The last instance brought to this release upgrades the template; then re-render this one: ${unitsRefreshCommand(ctx.paths)}`;
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
