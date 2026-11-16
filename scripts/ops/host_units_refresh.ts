/**
 * RE-RENDER A PRODUCTION INSTANCE'S SYSTEMD UNITS from its frozen install plan
 * (owner rulings C32 / C33, 2026-11-13) — the ROOT command the server's
 * writable-roots manifest, the engine's boot refusal and the update panel name:
 *
 *   sudo /opt/dedalo/bun/<pin>/bun run <tree>/scripts/ops/host_units_refresh.ts --instance <i>
 *
 * Templates absent or of an earlier shipped release are written / upgraded —
 * a shipped one only once every other instance on the host runs this release's
 * drop-ins (units.ts THE SIBLING LAW; otherwise kept, the blockers named with
 * their own command) —, a foreign template refuses the whole refresh, the
 * drop-ins and the manifest are rewritten from the plan, then `systemctl
 * daemon-reload`. The instance is NOT
 * restarted — the operator chooses when (`systemctl restart dedalo-ts@<i>`).
 * The logic: src/core/install/host/production/units_refresh.ts (gated by
 * install_host_steps_native); this file is the argv and the exit code.
 */

import { hostFs } from '../../src/core/install/host/fs.ts';
import { readHostRecord } from '../../src/core/install/host/host_executor.ts';
import { refreshInstanceUnits } from '../../src/core/install/host/production/units_refresh.ts';
import { readHostRootSeam } from '../../src/core/install/host/scratch.ts';

const args = Bun.argv.slice(2);
const at = args.indexOf('--instance');
const instance = at >= 0 ? args[at + 1] : undefined;
if (instance === undefined || args.length !== 2) {
	console.error('usage: host_units_refresh.ts --instance <i>   (as root)');
	process.exit(2);
}
// The scratch seam (a drill under a fake root) is the one exception to root.
const seam = readHostRootSeam();
if (seam === null && process.getuid?.() !== 0) {
	console.error(`host_units_refresh: run it as root (sudo) — /etc/systemd is root's`);
	process.exit(77);
}
try {
	const report = refreshInstanceUnits(instance, {
		fs: hostFs(seam?.root ?? ''),
		readRecord: (name) => readHostRecord({ route: 'production', instance: name }),
		systemctl: (argv) => {
			const run = Bun.spawnSync(['systemctl', ...argv], { stdout: 'inherit', stderr: 'inherit' });
			if (run.exitCode !== 0) throw new Error(`systemctl ${argv.join(' ')} exited ${run.exitCode}`);
		},
	});
	for (const path of report.written) console.log(`written   ${path}`);
	for (const path of report.upgraded) console.log(`upgraded  ${path}`);
	for (const path of report.kept) console.log(`current   ${path}`);
	for (const path of report.deferred)
		console.log(`kept      ${path} (an earlier release's — see below)`);
	for (const path of report.dropins) console.log(`rendered  ${path}`);
	console.log(report.next);
	process.exit(0);
} catch (error) {
	console.error(`host_units_refresh: ${(error as Error).message}`);
	process.exit(1);
}
