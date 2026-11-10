/**
 * THE EL DRILL RECORD RATCHET (engineering/PUBLICATION_HOST_SPEC.md §9.11). Everything SELinux,
 * fapolicyd and a real EL systemd do to the guided install is proven only by the EL drill
 * (`bun run test:pubhost:init:el`, scripts/publication_host_init_drill.ts) on a disposable
 * SELinux-enforcing RHEL/Rocky/Alma VM — no CI runner has an EL kernel. Its `--record`, after a
 * GREEN run, writes engineering/el_drill_record.json; this gate holds the tree to it:
 *
 *   - INPUTS: the record's `inputs_digest` is the digest of TODAY's EL-relevant sources
 *     (`EL_DRILL_INPUTS`, publication/host_agent/src/provision/selinux.ts, read in a child — this
 *     gate imports no agent module), recomputed with the drill's own elDrillInputsDigest. Any
 *     change to one of them is RED until the drill runs again on the VMs and re-records.
 *   - HOSTS: every recorded host was SELinux enforcing; each supported EL major (9, 10) is
 *     recorded, or named in PENDING_EL_HOSTS with its reason. A pending major that the record
 *     now names is a stale row (red): delete it.
 *   - LEGS: EACH host's recorded run passed every REQUIRED EL-family leg (legsFor), skipped none.
 *   - LEG INPUTS: EACH host carries `legs_inputs` (sha256 per file: the drill script and every file
 *     a leg DECLARES it proves, `Leg.inputs`) and `legs_digest` over them. Recomputed from the
 *     working tree here: a changed declared input (copy-media-web-user's agent media code, the
 *     engine rule builder…) is RED, naming the file, until the drill re-records. `sha` is only the
 *     BASE HEAD the run's tree was checked out at; `tree_dirty` says its bytes were not HEAD's.
 *   - MEASURED: EACH host carries the facts the spec says the drill measures (the two booleans,
 *     the home's traverse type, the home layout's v2 tree type, the v1 PHP floor, its systemd's supported directives) — its own:
 *     a host is one run on one VM (its sha, its time), and recording one major never rewrites
 *     another's (mergeRecord, judged here on synthetic records).
 *
 * HERMETIC: one file read, one `bun -e` child for the input list, the digest over tracked files.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import {
	AGENT_DIR,
	captureCommands,
	changedLegInputs,
	controlNamed,
	debianInPlaceRefusal,
	EL_DRILL_RECORD,
	type ElDrillRecord,
	type ElHost,
	elDrillInputs,
	elDrillInputsDigest,
	LEG_INPUT_SELF,
	legInputHashes,
	legInputPaths,
	legsDigest,
	legsFor,
	mergeRecord,
	parseDrillArgs,
	REPO_ROOT,
	SELINUX_CONTROL_DIR,
	SELINUX_CONTROL_FILE,
	SELINUX_CONTROL_URL,
	selinuxControlConf,
	selinuxControlVerdict,
} from '../../scripts/publication_host_init_drill.ts';

/** Every EL major the guided install supports (owner decision 2026-10-08: the EL family is 9 and 10). */
const SUPPORTED_EL = ['el9', 'el10'] as const;

/**
 * A supported major the record does not name YET — each with why. Shrink-only: the day the drill
 * records that major, its row reddens and is deleted.
 */
const PENDING_EL_HOSTS: Readonly<Record<string, string>> = {};

const record = (): ElDrillRecord => {
	expect(existsSync(EL_DRILL_RECORD), `${EL_DRILL_RECORD} is missing`).toBe(true);
	return JSON.parse(readFileSync(EL_DRILL_RECORD, 'utf8')) as ElDrillRecord;
};

describe('the EL drill record holds the tree', () => {
	test("INPUTS: the record's digest is today's EL inputs' digest", async () => {
		const inputs = await elDrillInputs();
		expect(inputs.length).toBeGreaterThanOrEqual(10); // anti-vacuity: the spec's list, not an empty one
		expect(inputs).toContain('src/provision/selinux.ts');
		expect(inputs).toContain('deploy/install.sh');
		const today = elDrillInputsDigest(AGENT_DIR, inputs);
		expect(
			record().inputs_digest,
			`an EL drill input changed since the last recorded EL drill (${inputs.join(', ')}). ` +
				'Run `bun run test:pubhost:init:el -- --media-nfs <host:/export> --record` as root on the disposable ' +
				'SELinux-enforcing EL VMs (docs: engineering/PUBLICATION_HOST_SPEC.md §9.11) and commit the new record',
		).toBe(today);
	});

	test('the digest moves with an input (the ratchet is not vacuous)', async () => {
		const inputs = await elDrillInputs();
		expect(elDrillInputsDigest(AGENT_DIR, inputs.slice(1))).not.toBe(
			elDrillInputsDigest(AGENT_DIR, inputs),
		);
	});

	test('HOSTS: enforcing, every supported major recorded or pending — and no stale pending row', () => {
		const { hosts } = record();
		expect(hosts.length).toBeGreaterThan(0);
		for (const host of hosts) {
			expect(host.selinux).toBe('enforcing');
			expect(SUPPORTED_EL as readonly string[]).toContain(host.os);
			expect(host.kernel).toMatch(/\.el(9|10)[._]/);
		}
		const recorded = new Set<string>(hosts.map((host) => host.os));
		const missing = SUPPORTED_EL.filter(
			(os) => !recorded.has(os) && PENDING_EL_HOSTS[os] === undefined,
		);
		expect(missing, 'a supported EL major has no drill record and no pending reason').toEqual([]);
		const stale = Object.keys(PENDING_EL_HOSTS).filter((os) => recorded.has(os));
		expect(stale, 'PENDING_EL_HOSTS rows the record now names — delete them').toEqual([]);
		for (const os of Object.keys(PENDING_EL_HOSTS))
			expect(SUPPORTED_EL as readonly string[]).toContain(os);
	});

	test('LEGS: every host passed every required EL-family leg, none skipped', () => {
		const args = parseDrillArgs(['--family', 'el', '--in-place']);
		if ('error' in args) throw new Error(args.error);
		const required = legsFor(args)
			.filter((leg) => leg.required)
			.map((leg) => leg.name);
		expect(required).toContain('selinux-labels');
		expect(required).toContain('fapolicyd');
		expect(required).toContain('system-layout-v2');
		expect(required).toContain('home-v2-migration');
		for (const host of record().hosts) {
			expect(host.skipped, `${host.os} skipped legs`).toEqual([]);
			expect(
				required.filter((name) => !host.legs.includes(name)),
				`${host.os} did not pass`,
			).toEqual([]);
		}
	});

	test("LEG INPUTS: every host proved TODAY's bytes of the drill and of every declared leg input", () => {
		const args = parseDrillArgs(['--family', 'el', '--in-place']);
		if ('error' in args) throw new Error(args.error);
		const paths = legInputPaths(legsFor(args));
		// anti-vacuity: the drill itself and the T0-6 leg's agent + engine files are in the set
		expect(paths).toContain(LEG_INPUT_SELF);
		expect(paths).toContain('publication/host_agent/src/media/fs_modes.ts');
		expect(paths).toContain('publication/host_agent/src/media/repair.ts');
		expect(paths).toContain('src/core/publication_host/rules.ts');
		const today = legInputHashes(REPO_ROOT, paths);
		for (const host of record().hosts) {
			expect(typeof host.tree_dirty, `${host.os} tree_dirty`).toBe('boolean');
			expect(host.legs_digest, `${host.os} legs_digest is not its legs_inputs' digest`).toBe(
				legsDigest(host.legs_inputs ?? {}),
			);
			const changed = changedLegInputs(host.legs_inputs ?? {}, today);
			expect(
				changed,
				`${host.os}: these leg inputs differ from what its recorded run proved — re-record: run ` +
					'`bun run test:pubhost:init:el -- --media-nfs <host:/export> --record` as root on the disposable ' +
					'SELinux-enforcing EL VMs (engineering/PUBLICATION_HOST_SPEC.md §9.11) and commit the new record',
			).toEqual([]);
			expect(legsDigest(today), `${host.os} legs_digest`).toBe(host.legs_digest);
		}
	});

	test('the legs digest moves with ONE byte of a declared input, and names that file (not vacuous)', () => {
		const args = parseDrillArgs(['--family', 'el', '--in-place']);
		if ('error' in args) throw new Error(args.error);
		const paths = legInputPaths(legsFor(args));
		const target = 'publication/host_agent/src/media/fs_modes.ts';
		const real = legInputHashes(REPO_ROOT, paths);
		const mutated = legInputHashes(REPO_ROOT, paths, (path) => {
			const bytes = new Uint8Array(readFileSync(path));
			if (path.endsWith(target)) bytes[0] = (bytes[0] ?? 0) ^ 1;
			return bytes;
		});
		expect(legsDigest(mutated)).not.toBe(legsDigest(real));
		expect(changedLegInputs(real, mutated)).toEqual([target]);
		// a dropped or added input is named too
		const { [target]: _dropped, ...without } = real;
		expect(changedLegInputs(real, without)).toEqual([target]);
	});

	test('MEASURED: per host, the booleans, the home traverse type, the home v2 type, the v1 PHP floor, the supported directives', () => {
		for (const host of record().hosts) {
			const { measured, sha, at } = host;
			expect(sha, `${host.os} sha`).toMatch(/^[0-9a-f]{40}$/);
			expect(Number.isNaN(Date.parse(at)), `${host.os} at`).toBe(false);
			expect(Object.keys(measured.booleans).sort()).toEqual([
				'httpd_can_network_relay',
				'httpd_enable_homedirs',
			]);
			expect(measured.home_traverse_type, `${host.os} home traverse type`).toBe('home_root_t');
			// One v2 type on every layout (owner decision 2026-10-09): the home layout's v2 tree, measured.
			expect(measured.home_v2_type, `${host.os} home v2 type`).toBe('dedalo_publication_v2_t');
			// The system layout's default type under /srv is not readable to systemd: why the policy module exists.
			expect(measured.system_default_readable, `${host.os} system default readable`).toBe(false);
			expect(measured.v1_php_floor, `${host.os} v1 PHP floor`).toMatch(/^\d+\.\d+$/);
			expect(Object.keys(measured.supported_directives).length).toBeGreaterThan(0);
		}
		const majors = record().hosts.map((host) => host.os);
		expect(new Set(majors).size, 'one entry per EL major').toBe(majors.length);
	});
});

/** A synthetic host entry (mergeRecord is pure: no VM, no file). */
const host = (os: ElHost['os'], sha: string, php: string): ElHost => ({
	os,
	id: 'rhel',
	version: os === 'el9' ? '9.8' : '10.2',
	kernel: os === 'el9' ? '5.14.0-1.el9_8.aarch64' : '6.12.0-1.el10_2.aarch64',
	selinux: 'enforcing',
	sha: sha.repeat(40),
	at: '2026-10-09T00:00:00.000Z',
	measured: {
		booleans: {},
		supported_directives: { [os]: [] },
		home_traverse_type: 'home_root_t',
		home_v2_type: 'dedalo_publication_v2_t',
		system_default_readable: null,
		v1_php_floor: php,
		nginx_floor: null,
	},
	legs: ['fresh-converge'],
	skipped: [],
	legs_inputs: {},
	legs_digest: '',
	tree_dirty: false,
});

describe('mergeRecord: one major recorded never rewrites another', () => {
	const el9 = host('el9', 'a', '8.1');
	const el10 = host('el10', 'b', '8.3');

	test('same digest: the new major is added, the other entry kept byte for byte', () => {
		const merged = mergeRecord(
			{ inputs_digest: 'd', hosts: [el9] },
			{ inputs_digest: 'd', hosts: [el10] },
		);
		expect(merged.hosts.map((h) => h.os)).toEqual(['el10', 'el9']);
		expect(merged.hosts.find((h) => h.os === 'el9')).toEqual(el9);
		expect(merged.hosts.find((h) => h.os === 'el10')).toEqual(el10);
	});

	test('same digest, same major: the run replaces that entry only', () => {
		const again = host('el10', 'c', '8.3');
		const merged = mergeRecord(
			{ inputs_digest: 'd', hosts: [el9, el10] },
			{ inputs_digest: 'd', hosts: [again] },
		);
		expect(merged.hosts.find((h) => h.os === 'el10')?.sha).toBe('c'.repeat(40));
		expect(merged.hosts.find((h) => h.os === 'el9')).toEqual(el9);
	});

	test('another digest: a fresh record — every host must be measured again', () => {
		const merged = mergeRecord(
			{ inputs_digest: 'old', hosts: [el9] },
			{ inputs_digest: 'new', hosts: [el10] },
		);
		expect(merged).toEqual({ inputs_digest: 'new', hosts: [el10] });
	});
});

describe('the drill around the record: in place on Debian, and what a capture names', () => {
	const constants = {
		units: ['apache2', 'httpd', 'nginx'],
		props: ['LoadState'],
		booleans: ['httpd_can_network_relay'],
	};
	const files = (host: Parameters<typeof captureCommands>[1]) =>
		captureCommands(constants, host).map(([file]) => file);

	test("an EL capture names its unit list after the host's EL major (never el9 on an EL 10 VM)", () => {
		expect(files({ family: 'el', major: '10' })).toContain('list_units_el10.txt');
		expect(files({ family: 'el', major: '10' })).not.toContain('list_units_el9.txt');
		expect(files({ family: 'el', major: '9' })).toContain('list_units_el9.txt');
	});

	test('a Debian capture reads apache2ctl, php-fpm<v> and AppArmor — no SELinux tool', () => {
		const commands = captureCommands(constants, { family: 'debian', php: '8.3' });
		const byFile = new Map(commands.map(([file, command]) => [file, command]));
		expect(byFile.get('apache_S.txt')).toBe('apache2ctl -S');
		expect(byFile.get('fpm_tt.txt')).toBe('/usr/sbin/php-fpm8.3 -tt');
		expect(byFile.get('ls_pool_d.txt')).toBe('ls -1 /etc/php/8.3/fpm/pool.d');
		expect(byFile.has('aa_status.txt')).toBe(true);
		expect(
			commands.some(([, command]) =>
				/semanage|getenforce|restorecon|\/usr\/sbin\/httpd/.test(command),
			),
		).toBe(false);
		// One file per name: a capture never overwrites itself.
		expect(new Set(commands.map(([file]) => file)).size).toBe(commands.length);
	});

	test('--capture is in place only; a Debian in-place run accepts Debian and Ubuntu only', () => {
		expect(parseDrillArgs(['--capture', '/root/c'])).toEqual({
			error: "--capture keeps a real host's discovery outputs: --in-place only",
		});
		expect('error' in parseDrillArgs(['--in-place', '--capture', '/root/c'])).toBe(false);
		expect(debianInPlaceRefusal('ID=ubuntu\nVERSION_ID="24.04"\n')).toBeNull();
		expect(debianInPlaceRefusal('ID=debian\nVERSION_ID="13"\n')).toBeNull();
		expect(debianInPlaceRefusal('ID="rocky"\nVERSION_ID="9.8"\n')).toContain('Debian or Ubuntu');
	});

	test("the AppArmor leg runs in place only: the container shares its daemon's kernel", () => {
		const names = (argv: string[]) =>
			legsFor(
				parseDrillArgs(argv) as Exclude<ReturnType<typeof parseDrillArgs>, { error: string }>,
			).map((l) => l.name);
		expect(names(['--family', 'debian', '--in-place'])).toContain('no-apparmor-denial');
		expect(names(['--family', 'debian'])).not.toContain('no-apparmor-denial');
		expect(names(['--family', 'el', '--in-place'])).not.toContain('no-apparmor-denial');
	});

	test("the agent's root grant runs in every world, required: no drill passes without the agent's own sudo door", () => {
		const legs = (argv: string[]) =>
			legsFor(
				parseDrillArgs(argv) as Exclude<ReturnType<typeof parseDrillArgs>, { error: string }>,
			);
		for (const argv of [
			['--family', 'debian'],
			['--family', 'debian', '--in-place'],
			['--family', 'el', '--in-place'],
		]) {
			const all = legs(argv);
			const grant = all.find((l) => l.name === 'agent-root-grant');
			expect(grant?.required).toBe(true);
			// After the nginx legs: the push targets the running nginx instance.
			expect(all.findIndex((l) => l.name === 'agent-root-grant')).toBeGreaterThan(
				all.findIndex((l) => l.name === 'nginx-host-map'),
			);
		}
	});
});

describe('system-layout-v2: the httpd control measures SELinux alone', () => {
	const type = 'dedalo_publication_v2_t';
	const avc = `type=AVC msg=audit(1.1:2): avc:  denied  { read } for  pid=1 comm="httpd" name="${SELINUX_CONTROL_FILE}" dev="dm-0" ino=3 scontext=system_u:system_r:httpd_t:s0 tcontext=unconfined_u:object_r:${type}:s0 tclass=file permissive=0`;
	const good = {
		baseline: { status: 200, body: 'dd-control\n' },
		refused: { status: 403 },
		avc,
		errorLog: '',
		type,
	};

	test('the control grants its own directory (EL denies every directory httpd.conf does not name)', () => {
		const conf = selinuxControlConf();
		expect(conf).toContain(`Alias ${SELINUX_CONTROL_URL} ${SELINUX_CONTROL_DIR}`);
		expect(conf).toContain(`<Directory ${SELINUX_CONTROL_DIR}>\n    Require all granted`);
	});

	test('passes only when the label alone made the difference', () => {
		expect(selinuxControlVerdict(good)).toBeNull();
		// measured RHEL 9.8: the stat is denied first, and that record names the path, not the name
		const getattr = `type=AVC msg=audit(1791571731.029:10818): avc:  denied  { getattr } for  pid=225710 comm="httpd" path="${SELINUX_CONTROL_DIR}/${SELINUX_CONTROL_FILE}" dev="dm-0" ino=100666481 scontext=system_u:system_r:httpd_t:s0 tcontext=unconfined_u:object_r:${type}:s0 tclass=file permissive=0`;
		expect(selinuxControlVerdict({ ...good, avc: getattr })).toBeNull();
		expect(controlNamed(getattr) && controlNamed(avc)).toBe(true);
		expect(controlNamed(avc.replace(SELINUX_CONTROL_FILE, 'other.txt'))).toBe(false);
	});

	test('a baseline that is not 200 with its bytes is a broken control, never a pass (measured: AH01630 403 under a home DocumentRoot)', () => {
		expect(selinuxControlVerdict({ ...good, baseline: { status: 403, body: '' } })).toMatch(
			/proves nothing/,
		);
		expect(selinuxControlVerdict({ ...good, baseline: { status: 200, body: 'other' } })).toMatch(
			/proves nothing/,
		);
	});

	test("a 403 that is Apache's authorization, a read that succeeds, or no AVC for the type: red", () => {
		const authz = `[authz_core:error] AH01630: client denied by server configuration: ${SELINUX_CONTROL_DIR}/${SELINUX_CONTROL_FILE}`;
		expect(selinuxControlVerdict({ ...good, errorLog: authz })).toMatch(/Apache's authorization/);
		expect(selinuxControlVerdict({ ...good, refused: { status: 200 } })).toMatch(/httpd read/);
		expect(selinuxControlVerdict({ ...good, avc: '' })).toMatch(/no AVC denial/);
		expect(selinuxControlVerdict({ ...good, avc: avc.replace(':httpd_t:', ':init_t:') })).toMatch(
			/no AVC denial/,
		);
		expect(selinuxControlVerdict({ ...good, avc: avc.replace(`:${type}:`, ':var_t:') })).toMatch(
			/no AVC denial/,
		);
	});
});
