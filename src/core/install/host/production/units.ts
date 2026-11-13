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
} from '../systemd/render.ts';
import {
	isShippedDigest,
	readShippedDigests,
	type ShippedDigests,
} from '../systemd/shipped_digests.ts';
import { exec, probe, probeOk, ran, remember, stampOf, systemctl, verdictOf } from './common.ts';

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

export function unitCommands(ctx: HostPlanCtx): HostCommand[] {
	return [
		...templateWrites(ctx),
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

/** A template present with bytes no release shipped is someone else's: refused, never overwritten. */
function assertNoForeignTemplate(ctx: HostCtx): TemplateVerdict[] {
	const verdicts = templateVerdicts(ctx, ctx.fs);
	const foreign = verdicts.filter((v) => v.verdict === 'foreign');
	if (foreign.length > 0) {
		hostRefuse('install.state_conflict', foreignTemplateSentence(foreign.map((v) => v.path)));
	}
	return verdicts;
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
				...[...templateWrites(ctx), ...dropinWrites(ctx)].map((write): [boolean, string] => [
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
		// An earlier release's template is upgraded by the same write (C33): the
		// commands write every template; a foreign one refused the step above.
		const upgraded = assertNoForeignTemplate(ctx).filter((v) => v.verdict === 'shipped');
		await executeCommands(unitCommands(ctx), ctx);
		updateEntry(ctx.fs, ctx.paths, { templates: true });
		const note =
			upgraded.length === 0
				? ''
				: `; ${upgraded.length} template(s) of an earlier release upgraded to this one (${upgraded.map((v) => v.name).join(', ')} — the other instances on this host run it at their next restart)`;
		return ran(`${serverUnit(ctx)} enabled (not started yet)${note}`);
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
