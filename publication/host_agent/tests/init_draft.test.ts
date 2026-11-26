/**
 * init/draft.ts + init/draft_schema.ts — the draft and its completion (spec S1, S6, §4.3
 * `declaration.*`, decision B). Facts are literals (tests/fixtures/init_drafts.ts); every
 * completed declaration that should be valid is put through the REAL parseDeclaration (zod +
 * derive), so a completion cannot drift from what `provision apply` accepts.
 */
import { describe, expect, test } from 'bun:test';
import type { DraftCompletion, DraftDeclaration } from '../src/provision/init/draft';
import { DEFAULTS, LAYOUTS, addressFamily, completeDraft, describeVhost, draftServesV1, fpmOptionId, homeCannotBeRoot, layoutDecisionFor, versionAtLeast, vhostSha8 } from '../src/provision/init/draft';
import { DRAFT_APIS, DraftError, draftSchema, parseDraft } from '../src/provision/init/draft_schema';
import type { HostFacts } from '../src/provision/init/types';
import { DECLARATION_KEY_ORDER, canonicalDeclaration, parseDeclaration } from '../src/provision/schema';
import { unixDeclaration } from './fixtures/provision_declaration';
import { DOMAIN, HOME, INSTANCE, appStreamFpm, debianFpm, debianHost, declaredFresh, draft, elHost, remiFpm, v2Draft, vhost, workUnit } from './fixtures/init_drafts';

function valid(completion: DraftCompletion) {
  expect(completion.unfilled).toEqual([]);
  expect(completion.layoutError).toBeNull();
  const decl = completion.declaration;
  if (decl === null) throw new Error('no declaration');
  return parseDeclaration(JSON.parse(canonicalDeclaration(decl)), 'completed');
}

const decision = (completion: DraftCompletion, id: string) => completion.decisions.find(row => row.id === id);
const answers = (pairs: Record<string, string>) => new Map(Object.entries(pairs));

/* ── parseDraft ──────────────────────────────────────────────────────────────────────── */

describe('parseDraft (draft_schema.ts)', () => {
  test('a minimal draft: instance, a site domain, media', () => {
    expect(parseDraft(draft(), 'd').site?.domain).toBe(DOMAIN);
    expect(parseDraft({ instance: INSTANCE, media: { mode: 'none' } }, 'd').site).toBeUndefined();
  });

  test('a final declaration is itself a draft (spec §1.2: without --draft it is the draft)', () => {
    expect(parseDraft(unixDeclaration(), 'd').state_root).toBe(unixDeclaration().state_root);
  });

  test('instance and media are required; unknown keys and bad values are refused, all at once', () => {
    let error: unknown;
    try {
      parseDraft({ site: { domain: 'Bad_Domain' }, nonsense: 1, layout: 'cloud' }, '/stage/draft.json');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DraftError);
    const paths = (error as DraftError).issues.map(issue => issue.path).sort();
    expect(paths).toEqual(expect.arrayContaining(['instance', 'media', 'site.domain', 'layout']));
    expect((error as DraftError).message).toContain('/stage/draft.json');
    expect(() => parseDraft({ ...draft(), web: { server: 'apache', extra: 1 } }, 'd')).toThrow(DraftError);
    expect(() => parseDraft({ ...draft(), site: { domain: DOMAIN, fpm: { flavor: 'suse', version: '8.2' } } }, 'd')).toThrow(DraftError);
  });

  test("every draft key but 'layout' and 'apis' is a declaration key (built from schema.ts, never restated)", () => {
    const keys = Object.keys(draftSchema.shape).filter(key => key !== 'layout' && key !== 'apis');
    expect(keys.sort()).toEqual(Object.keys(DECLARATION_KEY_ORDER).sort());
    expect(LAYOUTS).toEqual(['home', 'system']);
    expect(draftSchema.shape.layout.unwrap().options).toEqual([...LAYOUTS]);
    expect(draftSchema.shape.apis.unwrap().options).toEqual([...DRAFT_APIS]);
  });
});

/* ── completeDraft: layouts (decision B, S6) ─────────────────────────────────────────── */

describe('completeDraft: layout', () => {
  test('a site with nothing said proposes the home layout, the four paths under /home/<domain>', () => {
    const completion = completeDraft(draft(), debianHost());
    const { declaration, layout } = valid(completion);
    expect(completion.kind).toBe('home');
    expect(declaration.state_root).toBe(`${HOME}/dedalo`);
    expect(declaration.agent_dir).toBe(`${HOME}/host_agent`);
    expect(declaration.bun_bin).toBe(`${HOME}/.bun/bin/bun`);
    // owner decision 1(c): the site's web logs are outside the home, in the distribution's log dir.
    expect(layout.site?.webLogsDir).toBe(`/var/log/apache2/${DOMAIN}`);
    const row = decision(completion, 'declaration.layout');
    expect(row?.options.map(option => option.id)).toEqual(['home', 'system']);
    expect(row?.defaultOption).toBe('home');
    expect(row?.blocking).toBe(false);
    expect(completion.sources.get('state_root')).toBe('the home layout');
  });

  test('no site: the system layout, and no layout decision (no domain, no home)', () => {
    const completion = completeDraft(draft({ site: undefined }), debianHost());
    const { declaration } = valid(completion);
    expect(completion.kind).toBe('system');
    expect(completion.kindSource).toBe('no_site');
    expect(declaration.state_root).toBe(`/srv/dedalo_publication_host/${INSTANCE}`);
    expect(declaration.agent_dir).toBe('/opt/dedalo_publication_host/host_agent');
    expect(declaration.bun_bin).toBe('/opt/dedalo_publication_host/bun/bin/bun');
    expect(decision(completion, 'declaration.layout')).toBeUndefined();
  });

  test("a draft naming the layout settles it; an answer re-lays even the draft's own paths", () => {
    const named = completeDraft(draft({ layout: 'system' }), debianHost());
    expect(valid(named).declaration.state_root).toBe(`/srv/dedalo_publication_host/${INSTANCE}`);
    expect(decision(named, 'declaration.layout')).toBeUndefined();
    const home = valid(completeDraft(draft(), debianHost())).declaration;
    const rerun = completeDraft(home, debianHost(), { existing: home, answers: answers({ 'selinux.home_traverse': 'relocate' }) });
    expect(rerun.kind).toBe('system');
    expect(valid(rerun).declaration.agent_dir).toBe('/opt/dedalo_publication_host/host_agent');
    const back = completeDraft(home, debianHost(), { existing: home, answers: answers({ 'declaration.layout': 'system' }) });
    expect(back.kind).toBe('system');
  });

  test("the shared-media SELinux consent (selinux.media_access=act) is declared, and kept for the same root only", () => {
    const shared = draft({ media: { mode: 'shared', root: '/mnt/dedalo_media' } });
    expect(valid(completeDraft(shared, elHost())).declaration.media).toEqual({ mode: 'shared', root: '/mnt/dedalo_media' });
    const consented = valid(completeDraft(shared, elHost(), { answers: answers({ 'selinux.media_access': 'act' }) })).declaration;
    expect(consented.media).toEqual({ mode: 'shared', root: '/mnt/dedalo_media', selinux_label: true });
    // A later run with the original draft (no answer) keeps it from the existing declaration...
    expect(valid(completeDraft(shared, elHost(), { existing: consented })).declaration.media.selinux_label).toBe(true);
    // ...but not for another root, nor for copy mode (always labelled; the field is shared-only).
    expect(valid(completeDraft(draft({ media: { mode: 'shared', root: '/mnt/other' } }), elHost(), { existing: consented })).declaration.media.selinux_label).toBeUndefined();
    expect(valid(completeDraft(draft({ media: { mode: 'copy', root: '/mnt/dedalo_media' } }), elHost(), { existing: consented, answers: answers({ 'selinux.media_access': 'act' }) })).declaration.media.selinux_label).toBeUndefined();
  });

  test('a re-run (the final declaration as the draft) completes to the same bytes, its layout inferred', () => {
    const first = valid(completeDraft(draft(), debianHost())).declaration;
    const again = completeDraft(first, debianHost(), { existing: first });
    expect(again.kindSource).toBe('paths');
    expect(again.kind).toBe('home');
    expect(canonicalDeclaration(valid(again).declaration)).toBe(canonicalDeclaration(first));
    expect(again.sources.size).toBe(0);
    expect(again.decisions).toEqual([]);
    const system = valid(completeDraft(draft({ layout: 'system' }), debianHost())).declaration;
    expect(completeDraft(system, debianHost(), { existing: system }).kind).toBe('system');
    // A separate draft without paths: the existing declaration fixes the layout.
    expect(completeDraft(draft(), debianHost(), { existing: system }).kindSource).toBe('existing');
    expect(completeDraft(draft(), debianHost(), { existing: system }).kind).toBe('system');
  });

  const nfsHome = (): HostFacts => ({
    ...debianHost(),
    mounts: [
      { mountPoint: '/', fsType: 'ext4', readOnly: false, noexec: false, seclabel: false, context: null },
      { mountPoint: '/home', fsType: 'nfs4', readOnly: false, noexec: false, seclabel: false, context: null },
    ],
  });

  test('the home cannot be given to root → only system (default) and manual, and the paths fall back', () => {
    const completion = completeDraft(draft(), nfsHome());
    expect(completion.homeReasons.join(' ')).toMatch(/nfs4/);
    expect(completion.kind).toBe('system');
    const row = decision(completion, 'declaration.layout');
    expect(row?.options.map(option => option.id)).toEqual(['system', 'manual']);
    expect(row?.defaultOption).toBe('system');
    expect(row?.blocking).toBe(true);
    expect(valid(completion).declaration.state_root).toBe(`/srv/dedalo_publication_host/${INSTANCE}`);
    // A draft insisting on home keeps it, but the decision is blocking.
    const insisted = completeDraft(draft({ layout: 'home' }), nfsHome());
    expect(insisted.kind).toBe('home');
    expect(decision(insisted, 'declaration.layout')?.blocking).toBe(true);
    // 'home' is not an option then: answering it changes nothing.
    expect(completeDraft(draft(), nfsHome(), { answers: answers({ 'declaration.layout': 'home' }) }).kind).toBe('system');
  });

  test('each home-cannot-be-root reason (S6), and a panel is not one', () => {
    const base = debianHost();
    const reasons = (facts: HostFacts, declared = declaredFresh()) => homeCannotBeRoot(HOME, facts, facts.fpm[0] ?? null, declared);
    expect(reasons(base)).toEqual([]);
    expect(reasons({ ...base, panel: 'plesk' })).toEqual([]);
    expect(reasons({ ...base, mounts: [...base.mounts, { mountPoint: '/home', fsType: 'ext4', readOnly: false, noexec: true, seclabel: false, context: null }] })[0]).toMatch(/noexec/);
    expect(reasons({ ...base, mounts: [...base.mounts, { mountPoint: HOME, fsType: 'fuse.sshfs', readOnly: false, noexec: false, seclabel: false, context: null }] })[0]).toMatch(/fuse\.sshfs/);
    expect(reasons({ ...base, web: { ...base.web, unitSandbox: { protectHome: 'yes', protectSystem: 'no', inaccessible: [], readOnly: [], tmpfs: [] } } })[0]).toMatch(/web server's unit.*ProtectHome=yes/);
    expect(reasons({ ...base, web: { ...base.web, unitSandbox: { protectHome: 'no', protectSystem: 'no', inaccessible: [], readOnly: [], tmpfs: ['/home'] } } })[0]).toMatch(/TemporaryFileSystem/);
    expect(reasons({ ...base, fpm: [debianFpm('8.2', { unitSandbox: { protectHome: 'no', protectSystem: 'no', inaccessible: ['/home'], readOnly: [], tmpfs: [] } })] })[0]).toMatch(/PHP-FPM unit.*InaccessiblePaths/);
    const fresh = declaredFresh();
    expect(reasons(base, { ...fresh, home: { ...fresh.home, facts: { type: 'symlink', uid: 1002, gid: 1002, mode: 0o777, target: '/data/site' } } })[0]).toMatch(/symlink.*\/data\/site/);
    expect(reasons(base, { ...fresh, home: { ...fresh.home, facts: { type: 'file', uid: 0, gid: 0, mode: 0o644 } } })[0]).toMatch(/not a directory/);
    expect(reasons(base, { ...fresh, paths: new Map([['/home', { type: 'dir', uid: 1000, gid: 0, mode: 0o755 }]]) })[0]).toMatch(/\/home .*not root-owned/);
    expect(reasons(base, { ...fresh, paths: new Map([['/home', { type: 'dir', uid: 0, gid: 0, mode: 0o775 }]]) })[0]).toMatch(/group- or other-writable/);
    expect(reasons(base, { ...fresh, paths: new Map([['/home', { type: 'symlink', uid: 0, gid: 0, mode: 0o777 }]]) })[0]).toMatch(/\/home .*symlink/);
  });

  test('the declared pass settles relocations: foreign .bun / host_agent / a foreign state root', () => {
    const fresh = declaredFresh();
    const declared = { ...fresh, home: { ...fresh.home, layoutDirs: { ...fresh.home.layoutDirs, '.bun': { type: 'dir' as const, uid: 1002, gid: 1002, mode: 0o755 } } } };
    const relocated = valid(completeDraft(draft(), debianHost(), { declared, answers: answers({ 'declaration.layout_dirs': 'relocate', 'declaration.state_root': 'relocate' }) })).declaration;
    expect(relocated.bun_bin).toBe(`${HOME}/.dedalo_bun/bin/bun`);
    expect(relocated.agent_dir).toBe(`${HOME}/host_agent`);
    expect(relocated.state_root).toBe(`${HOME}/dedalo_publication`);
    // Without the declared pass an answered relocation moves both (nothing proves either is ours).
    const blind = valid(completeDraft(draft(), debianHost(), { answers: answers({ 'declaration.layout_dirs': 'relocate' }) })).declaration;
    expect(blind.agent_dir).toBe(`${HOME}/dedalo_host_agent`);
  });

  test('layoutDecisionFor: settled and reason-free asks nothing', () => {
    expect(layoutDecisionFor({ home: HOME, instance: INSTANCE, reasons: [], kind: 'home', kindSource: 'draft' })).toBeNull();
    expect(layoutDecisionFor({ home: HOME, instance: INSTANCE, reasons: ['x'], kind: 'system', kindSource: 'paths' })).toBeNull();
    expect(layoutDecisionFor({ home: HOME, instance: INSTANCE, reasons: ['x'], kind: 'home', kindSource: 'existing' })?.blocking).toBe(true);
  });
});

/* ── completeDraft: what discovery fills ─────────────────────────────────────────────── */

describe('completeDraft: fields', () => {
  test('Debian: the S5 FPM row, the derived web user, accounts proposed per instance, a source per field', () => {
    const completion = completeDraft(draft(), debianHost());
    const { declaration, layout } = valid(completion);
    expect(declaration.site?.fpm).toEqual({ flavor: 'debian', version: '8.2' });
    expect(layout.site?.v1?.fpm.listen).toBe(`/run/php/dedalo-${INSTANCE}-v1.sock`);
    expect(layout.site?.v1?.fpm.webUser).toBe('www-data');
    expect(declaration.php_bin).toBe('/usr/bin/php8.2');
    expect(declaration.agent_user).toBe(DEFAULTS.agentUser(INSTANCE));
    expect(declaration.v1?.user).toBe(`${INSTANCE}_v1`);
    expect(declaration.v2).toEqual({ unit: DEFAULTS.v2Unit(INSTANCE), user: `${INSTANCE}_v2`, group: `${INSTANCE}_v2`, port: 3100, health_url: 'http://127.0.0.1:3100/health' });
    expect(declaration.engine_group).toBe('dedalo');
    expect(declaration.listen).toEqual({ kind: 'unix' });
    expect(declaration.web).toEqual({ server: 'apache', unit: 'apache2' });
    expect('systemd_floor' in declaration).toBe(false);
    for (const field of ['web.server', 'web.unit', 'site.fpm', 'agent_user', 'v1.user', 'v2.user', 'v2.group', 'engine_group', 'php_bin', 'listen']) {
      expect(completion.sources.has(field)).toBe(true);
    }
    expect(completion.vhost?.serverName).toBe(DOMAIN);
    expect(completion.workUnit?.unit).toBe('dedalo-ts');
  });

  test('EL: AppStream 8.0 is below V1_PHP_FLOOR, so Remi 8.4 is the only candidate; the web user is apache', () => {
    const { declaration, layout } = valid(completeDraft(draft(), elHost()));
    expect(declaration.site?.fpm).toEqual({ flavor: 'remi', version: '8.4' });
    expect(layout.site?.v1?.fpm.unit).toBe('php84-php-fpm');
    expect(layout.site?.v1?.fpm.webUser).toBe('apache');
  });

  test('several FPM installs: a decision; the vhost handler wins, then Remi, AppStream, Debian; answers choose', () => {
    const host = { ...elHost(), fpm: [appStreamFpm('8.1'), remiFpm('8.2'), remiFpm('8.4')] };
    const completion = completeDraft(draft(), host);
    const row = decision(completion, 'declaration.fpm');
    expect(row?.options.map(option => option.id)).toEqual(['el-8-1', 'remi-8-2', 'remi-8-4']);
    expect(row?.defaultOption).toBe('remi-8-4');
    const handler = { ...host, web: { ...host.web, vhosts: [vhost({ fpmHandler: 'proxy:unix:/run/php-fpm/www.sock|fcgi://localhost' })] } };
    expect(decision(completeDraft(draft(), handler), 'declaration.fpm')?.defaultOption).toBe('el-8-1');
    expect(completeDraft(draft(), { ...host, fpm: [appStreamFpm('8.1'), debianFpm('8.3')] }).fpm?.flavor).toBe('el');
    expect(completeDraft(draft(), { ...debianHost(), fpm: [debianFpm('8.2'), debianFpm('8.4')], web: { ...debianHost().web, vhosts: [vhost({ fpmHandler: null })] } }).fpm?.version).toBe('8.4');
    const chosen = valid(completeDraft(draft(), host, { answers: answers({ 'declaration.fpm': 'remi-8-2' }) })).declaration;
    expect(chosen.site?.fpm).toEqual({ flavor: 'remi', version: '8.2' });
    expect(fpmOptionId({ flavor: 'debian', version: '8.2' })).toBe('debian-8-2');
  });

  test('no FPM at or above the floor: site.fpm is unfilled and there is no declaration', () => {
    const completion = completeDraft(draft(), { ...elHost(), fpm: [appStreamFpm('8.0')] });
    expect(completion.declaration).toBeNull();
    expect(completion.unfilled.map(row => row.field)).toEqual(['site.fpm']);
  });

  test('a draft naming its FPM keeps it, matched against the installs (or none)', () => {
    const completion = completeDraft(draft({ site: { domain: DOMAIN, fpm: { flavor: 'debian', version: '8.4' } } }), debianHost());
    expect(completion.fpm).toBeNull();
    expect(valid(completion).declaration.site?.fpm?.version).toBe('8.4');
  });

  test('vhosts: several exact ones (80 + 443) propose the TLS one; alias-only, crowded or none are blocking', () => {
    const two = { ...debianHost(), web: { ...debianHost().web, vhosts: [vhost({ port: 80, ssl: false, realpath: '/etc/apache2/sites-available/example.org.conf' }), vhost()] } };
    const completion = completeDraft(draft(), two);
    const row = decision(completion, 'declaration.vhost');
    expect(row?.options).toHaveLength(2);
    expect(row?.defaultOption).toBe(`v-${vhostSha8(vhost())}`);
    expect(completion.vhost?.port).toBe(443);
    const port80 = `v-${vhostSha8(vhost({ port: 80, ssl: false, realpath: '/etc/apache2/sites-available/example.org.conf' }))}`;
    expect(completeDraft(draft(), two, { answers: answers({ 'declaration.vhost': port80 }) }).vhost?.port).toBe(80);
    const alias = completeDraft(draft(), { ...debianHost(), web: { ...debianHost().web, vhosts: [vhost({ matchedBy: 'alias' })] } });
    expect(decision(alias, 'declaration.vhost')?.blocking).toBe(true);
    expect(decision(alias, 'declaration.vhost')?.facts.join(' ')).toMatch(/only by alias/);
    expect(alias.vhost).toBeNull();
    const crowded = completeDraft(draft(), { ...debianHost(), web: { ...debianHost().web, vhosts: [vhost(), vhost({ realpath: '/etc/apache2/sites-available/other.conf' })] } });
    expect(decision(crowded, 'declaration.vhost')?.blocking).toBe(true);
    const none = completeDraft(draft(), { ...debianHost(), web: { ...debianHost().web, vhosts: [] } });
    expect(decision(none, 'declaration.vhost')?.facts.join(' ')).toMatch(/never creates a vhost/);
  });

  /* ── dual stack: one site on IPv4 + IPv6 is never "crowded" ── */
  const withVhosts = (vhosts: ReturnType<typeof vhost>[], patch: Partial<HostFacts['web']> = {}): HostFacts =>
    ({ ...debianHost(), web: { ...debianHost().web, ...patch, vhosts } }) as HostFacts;
  const V6 = '/etc/apache2/sites-available/example.org-v6.conf';

  test('dual stack: ONE row on both families is one site — no decision at all', () => {
    const completion = completeDraft(draft(), withVhosts([vhost({ addresses: ['192.0.2.1', '[2001:db8::1]'] })]));
    expect(decision(completion, 'declaration.vhost')).toBeUndefined();
    expect(completion.vhost?.addresses).toEqual(['192.0.2.1', '[2001:db8::1]']);
    expect(completion.vhostTwins).toEqual([]);
  });

  test('dual stack: two blocks per family (same name, port, TLS) are one site — the IPv4/wildcard one leads, the IPv6 one is its twin', () => {
    const v4 = vhost({ addresses: ['0.0.0.0'] });
    const v6 = vhost({ addresses: ['[::]'], realpath: V6, file: V6 });
    for (const order of [[v4, v6], [v6, v4]]) {
      const completion = completeDraft(draft(), withVhosts(order));
      expect(decision(completion, 'declaration.vhost')).toBeUndefined();
      expect(completion.vhost?.realpath).toBe(v4.realpath);
      expect(completion.vhostTwins.map(row => row.realpath)).toEqual([V6]);
    }
    // Twins in ONE file (two openers) pair the same way.
    const same = completeDraft(draft(), withVhosts([vhost({ addresses: ['*'], line: 2 }), vhost({ addresses: ['[::]'], line: 20 })]));
    expect([same.vhost?.line, same.vhostTwins.map(row => row.line)]).toEqual([2, [20]]);
    // nginx: the twins' own log directories all reach web.log_dirs.
    const nginx = completeDraft(
      draft(),
      withVhosts([vhost({ addresses: ['*'], errorLog: '/var/log/nginx/a/error.log', accessLogs: [] }), vhost({ addresses: ['[::]'], realpath: V6, errorLog: '/var/log/nginx/b/error.log', accessLogs: [] })], {
        candidates: ['nginx'],
        server: 'nginx',
        unit: 'nginx',
        confDInHttp: true,
      }),
    );
    expect(nginx.declaration?.web.log_dirs).toEqual(['/var/log/nginx/a', '/var/log/nginx/b']);
  });

  test('dual stack: a :80 redirect (any family) is never a candidate; with the TLS site it is no decision, alone it is a clear blocker', () => {
    const redirect80 = vhost({ port: 80, ssl: false, addresses: ['*', '[::]'], redirectOnly: true, realpath: '/etc/apache2/sites-available/example.org.conf' });
    const site = completeDraft(draft(), withVhosts([redirect80, vhost({ addresses: ['*', '[::]'] })]));
    expect(decision(site, 'declaration.vhost')).toBeUndefined();
    expect(site.vhost?.port).toBe(443);
    // Per-family redirects + per-family TLS blocks: still one site, no decision.
    const four = completeDraft(
      draft(),
      withVhosts([
        { ...redirect80, addresses: ['0.0.0.0'] },
        { ...redirect80, addresses: ['[::]'], line: 9 },
        vhost({ addresses: ['0.0.0.0'] }),
        vhost({ addresses: ['[::]'], realpath: V6 }),
      ]),
    );
    expect(decision(four, 'declaration.vhost')).toBeUndefined();
    expect([four.vhost?.port, four.vhostTwins.map(row => row.realpath)]).toEqual([443, [V6]]);
    // ONLY redirects claim the name: blocking, manual, the fact names the missing TLS vhost — not a crash.
    const only = completeDraft(draft(), withVhosts([redirect80]));
    const row = decision(only, 'declaration.vhost');
    expect(row).toMatchObject({ blocking: true, defaultOption: 'manual' });
    expect(row?.options.map(option => option.id)).toEqual(['manual']);
    expect(row?.facts[0]).toBe(`${redirect80.realpath}:2 port 80 on *, [::] only redirects every request: it never receives the APIs include`);
    expect(row?.facts[1]).toMatch(/only redirects claim it: the vhost they send to \(the TLS one\) is missing; init never creates a vhost$/);
    expect(only.vhost).toBeNull();
  });

  test('crowded stays crowded for genuine ambiguity: one family claimed twice, or twins that differ in TLS', () => {
    const v6 = vhost({ addresses: ['[::]'], realpath: V6 });
    for (const rows of [
      // Two different blocks on the IPv4/wildcard side.
      [vhost({ addresses: ['*'] }), vhost({ addresses: ['0.0.0.0'], realpath: '/etc/apache2/sites-available/old.conf' })],
      // A dual-stack block and an IPv6 block: the IPv6 family is claimed twice.
      [vhost({ addresses: ['*', '[::]'] }), v6],
      // Per-family blocks that are not the same service (one TLS, one plain).
      [vhost({ addresses: ['*'] }), { ...v6, ssl: false }],
    ]) {
      const crowded = completeDraft(draft(), withVhosts(rows));
      const row = decision(crowded, 'declaration.vhost');
      expect(row).toMatchObject({ blocking: true, defaultOption: 'manual' });
      expect(row?.facts[0]).toBe(`port 443 has 2 different vhosts claiming ServerName ${DOMAIN}:`);
      expect(crowded.vhost).toBeNull();
    }
  });

  test('several sites (a plain :80 that serves, and dual-stack twins on :443): a decision whose options name every block; the answer brings its twins', () => {
    const port80 = vhost({ port: 80, ssl: false, addresses: ['*'], realpath: '/etc/apache2/sites-available/example.org.conf' });
    const v4 = vhost({ addresses: ['*'] });
    const v6 = vhost({ addresses: ['[::]'], realpath: V6 });
    const completion = completeDraft(draft(), withVhosts([port80, v4, v6]));
    const row = decision(completion, 'declaration.vhost');
    expect(row?.blocking).toBe(false);
    expect(row?.defaultOption).toBe(`v-${vhostSha8(v4)}`);
    expect(row?.options.map(option => option.label)).toEqual([describeVhost(port80), `${describeVhost(v4)} + ${describeVhost(v6)}`]);
    expect(completion.vhostTwins.map(twin => twin.realpath)).toEqual([V6]);
    const answered = completeDraft(draft(), withVhosts([port80, v4, v6]), { answers: answers({ 'declaration.vhost': `v-${vhostSha8(port80)}` }) });
    expect([answered.vhost?.port, answered.vhostTwins]).toEqual([80, []]);
  });

  test('describeVhost names every address; addressFamily: brackets/colons are IPv6, the rest the IPv4/wildcard side', () => {
    expect(describeVhost(vhost({ addresses: ['192.0.2.1', '[2001:db8::1]'] }))).toBe('/etc/apache2/sites-available/example.org-le-ssl.conf:2 port 443 on 192.0.2.1, [2001:db8::1] (TLS)');
    expect(describeVhost(vhost({ addresses: [], ssl: false }))).toBe('/etc/apache2/sites-available/example.org-le-ssl.conf:2 port 443');
    expect(['*', '_default_', '0.0.0.0', '192.0.2.1', 'localhost'].map(addressFamily)).toEqual(['ipv4', 'ipv4', 'ipv4', 'ipv4', 'ipv4']);
    expect(['[::]', '[2001:db8::1]', '::1'].map(addressFamily)).toEqual(['ipv6', 'ipv6', 'ipv6']);
  });

  test('two web servers: host.web decides; nginx fills nginx_map from conf.d and the vhost log dirs', () => {
    const both = { ...debianHost(), web: { ...debianHost().web, candidates: ['apache', 'nginx'] as const, server: null, unit: null, confDInHttp: true } };
    const open = completeDraft(draft(), both as unknown as HostFacts);
    expect(decision(open, 'host.web')?.options.map(option => option.id)).toEqual(['apache', 'nginx']);
    const nginx = valid(completeDraft(draft(), both as unknown as HostFacts, { answers: answers({ 'host.web': 'nginx' }) })).declaration;
    expect(nginx.web).toEqual({ server: 'nginx', unit: 'nginx', nginx_map: 'conf_d', log_dirs: [`/var/log/apache2/${DOMAIN}`] });
    const noConfD = { ...debianHost(), web: { ...debianHost().web, candidates: ['nginx'], server: 'nginx', unit: 'nginx', confDInHttp: false } } as HostFacts;
    expect(valid(completeDraft(draft(), noConfD)).declaration.web.nginx_map).toBe('none');
    const nothing = completeDraft(draft(), { ...debianHost(), web: { ...debianHost().web, candidates: [] } });
    expect(nothing.unfilled.map(row => row.field)).toContain('web.server');
    // EL apache with no unit observed: the flavour's name.
    expect(valid(completeDraft(draft(), { ...elHost(), web: { ...elHost().web, server: null, unit: null } })).declaration.web.unit).toBe('httpd');
  });

  test('vhostSha8 = the first 8 hex of sha256(realpath NUL port NUL serverName)', () => {
    const expected = new Bun.CryptoHasher('sha256').update([vhost().realpath, '443', DOMAIN].join('\0')).digest('hex').slice(0, 8);
    expect(vhostSha8(vhost())).toBe(expected);
    expect(vhostSha8(vhost({ port: 80 }))).not.toBe(expected);
  });

  test('v1.user: a catch-all account that is not the web user is refused too', () => {
    expect(decision(completeDraft(draft({ v1: { user: 'nobody' } }), debianHost()), 'declaration.v1_user')?.blocking).toBe(true);
  });

  test('v1.user: a web or catch-all account is a blocking decision, act takes <instance>_v1', () => {
    const bad = draft({ v1: { user: 'www-data' } });
    const open = completeDraft(bad, debianHost());
    const row = decision(open, 'declaration.v1_user');
    expect(row?.blocking).toBe(true);
    expect(row?.options.map(option => option.id)).toEqual(['act', 'manual']);
    expect(open.layoutError).toMatch(/v1\.user/);
    expect(valid(completeDraft(bad, debianHost(), { answers: answers({ 'declaration.v1_user': 'act' }) })).declaration.v1?.user).toBe(`${INSTANCE}_v1`);
    // The web server's own run user is refused even when it is not on the fixed list.
    const own = completeDraft(draft({ v1: { user: 'www' } }), { ...debianHost(), web: { ...debianHost().web, runUser: 'www' } });
    expect(decision(own, 'declaration.v1_user')?.blocking).toBe(true);
  });

  test('a long instance cannot derive account names: unfilled, and v1 asks for a name', () => {
    const long = 'a'.repeat(30);
    const completion = completeDraft({ ...draft(), instance: long }, debianHost());
    expect(completion.declaration).toBeNull();
    expect(completion.unfilled.map(row => row.field).sort()).toEqual(['agent_user', 'v1.user', 'v2.user']);
    expect(decision(completion, 'declaration.v1_user')?.options.map(option => option.id)).toEqual(['manual']);
  });

  test('v2 port: busy or typed otherwise proposes the next free untyped port; ours and answers stand', () => {
    const busy = completeDraft(draft(), { ...debianHost(), ports: [3100, 3101] });
    expect(decision(busy, 'declaration.v2_port')?.defaultOption).toBe('port-3102');
    expect(valid(busy).declaration.v2.port).toBe(3102);
    const typed = completeDraft(draft({ v2: { port: 8080 } }), elHost());
    expect(decision(typed, 'declaration.v2_port')?.facts[0]).toMatch(/http_cache_port_t/);
    expect(decision(typed, 'declaration.v2_port')?.defaultOption).toBe('port-8081');
    expect(valid(typed).declaration.v2.port).toBe(8080); // a draft's own port is never silently changed
    const answered = valid(completeDraft(draft({ v2: { port: 8080 } }), elHost(), { answers: answers({ 'declaration.v2_port': 'port-3200' }) })).declaration;
    expect(answered.v2.port).toBe(3200);
    expect(answered.v2.health_url).toBe('http://127.0.0.1:3200/health');
    const existing = valid(completeDraft(draft(), debianHost())).declaration;
    const rerun = completeDraft(existing, { ...debianHost(), ports: [3100] }, { existing });
    expect(decision(rerun, 'declaration.v2_port')).toBeUndefined();
    const sibling = completeDraft(draft(), debianHost(), { declared: { ...declaredFresh(), siblings: [{ source: '/etc/dedalo_publication_host/other.json', layout: valid(completeDraft(draft(), debianHost())).layout }] } });
    expect(decision(sibling, 'declaration.v2_port')?.facts[0]).toMatch(/sibling/);
  });

  test('engine group: from the one work unit; several units ask; none under unix is unfilled and blocking; tls needs none', () => {
    const two = completeDraft(draft(), { ...debianHost(), work: [workUnit(), workUnit({ unit: 'dedalo-ts@museum', group: 'museum' })] });
    expect(decision(two, 'declaration.work_unit')?.options.map(option => option.id)).toEqual(['dedalo-ts', 'dedalo-ts_museum']);
    expect(valid(completeDraft(draft(), { ...debianHost(), work: [workUnit(), workUnit({ unit: 'dedalo-ts@museum', group: 'museum' })] }, { answers: answers({ 'declaration.work_unit': 'dedalo-ts_museum' }) })).declaration.engine_group).toBe('museum');
    const none = completeDraft(draft(), { ...debianHost(), work: [] });
    expect(none.unfilled.map(row => row.field)).toEqual(['engine_group']);
    expect(decision(none, 'declaration.work_unit')?.blocking).toBe(true);
    const tls = completeDraft(draft({ listen: { kind: 'tls', host: '10.8.0.2', port: 7443 } }), { ...debianHost(), work: [] });
    expect(valid(tls).declaration.engine_group).toBeUndefined();
  });

  test('systemd: one profile — the declaration carries no floor whatever the host runs (host.systemd judges it)', () => {
    for (const systemd of [239, 246, 257]) expect('systemd_floor' in valid(completeDraft(draft(), { ...debianHost(), systemd })).declaration).toBe(false);
    expect(() => parseDraft({ ...draft(), systemd_floor: 239 }, 'd')).toThrow(DraftError);
    expect(() => parseDeclaration({ ...unixDeclaration(), systemd_floor: 247 }, 'd')).toThrow();
  });

  test('a value derive() refuses is a layoutError, never a throw', () => {
    const completion = completeDraft(draft({ media: { mode: 'shared' } } as Partial<DraftDeclaration>), debianHost());
    expect(completion.layout).toBeNull();
    expect(completion.layoutError).toMatch(/^media\.root:/);
  });

  test('helpers: versionAtLeast compares numerically', () => {
    expect(versionAtLeast('8.10', '8.9')).toBe(true);
    expect(versionAtLeast('8.1', '8.1')).toBe(true);
    expect(versionAtLeast('1.20.1', '1.14')).toBe(true);
    expect(versionAtLeast('1.12.2', '1.14')).toBe(false);
    expect(versionAtLeast('x', '1')).toBe(false);
  });
});

describe('the APIs a draft serves (draft-only `apis`, else its own v1 block)', () => {
  test('draftServesV1: apis wins; absent, the v1 block decides — a declaration is a valid draft', () => {
    expect(draftServesV1({})).toBe(false);
    expect(draftServesV1({ v1: {} })).toBe(true);
    expect(draftServesV1({ apis: 'v1_and_v2' })).toBe(true);
    expect(draftServesV1({ apis: 'v2_only' })).toBe(false);
  });

  test('a v2-only draft completes with no v1, no php_bin, no site.fpm — and the host family as site.os_family', () => {
    const debian = completeDraft(v2Draft(), debianHost());
    const declaration = debian.declaration as NonNullable<DraftCompletion['declaration']>;
    expect(debian.layoutError).toBeNull();
    expect(debian.servesV1).toBe(false);
    expect(declaration.v1).toBeUndefined();
    expect(declaration.php_bin).toBeUndefined();
    expect(declaration.site).toEqual({ domain: DOMAIN, os_family: 'debian' });
    expect(debian.sources.get('site.os_family')).toContain('debian');
    expect(debian.decisions.map(row => row.id)).not.toContain('declaration.fpm');
    expect(debian.decisions.map(row => row.id)).not.toContain('declaration.v1_user');
    expect(debian.fpm).toBeNull();
    expect(debian.layout?.servedApis).toEqual(['v2']);
    // EL, several FPM installs and none below the floor: still no PHP choice at all.
    const el = completeDraft(v2Draft(), { ...elHost(), fpm: [remiFpm('8.2'), remiFpm('8.4')] });
    expect(el.declaration?.site).toEqual({ domain: DOMAIN, os_family: 'el' });
    expect(el.decisions.map(row => row.id)).not.toContain('declaration.fpm');
    // No FPM installed at all is no unfilled field for a v2-only site.
    expect(completeDraft(v2Draft(), { ...debianHost(), fpm: [] }).unfilled).toEqual([]);
    // The round trip: the completed declaration is itself a v2-only draft.
    expect(canonicalDeclaration(completeDraft(declaration, debianHost()).declaration as never)).toBe(canonicalDeclaration(declaration));
  });

  test("apis 'v1_and_v2' without a v1 block proposes the v1 account; a v1-only key in a v2-only draft is refused by name", () => {
    const v1 = completeDraft(v2Draft({ apis: 'v1_and_v2' }), debianHost());
    expect(v1.declaration?.v1).toEqual({ user: `${INSTANCE}_v1` });
    expect(v1.declaration?.site?.fpm).toEqual({ flavor: 'debian', version: '8.2' });
    const refused = (raw: unknown): string[] => {
      try {
        parseDraft(raw, 'd');
      } catch (error) {
        return (error as DraftError).issues.map(issue => issue.path);
      }
      return [];
    };
    expect(refused({ ...v2Draft({ apis: 'v2_only' }), v1: { user: 'x_v1' } })).toEqual(['v1']);
    expect(refused({ ...v2Draft({ apis: 'v2_only' }), php_bin: '/usr/bin/php' })).toEqual(['php_bin']);
    expect(refused({ ...v2Draft({ apis: 'v2_only' }), site: { domain: DOMAIN, fpm: { flavor: 'debian', version: '8.2' } } })).toEqual(['site.fpm']);
    expect(refused({ ...v2Draft({ apis: 'v2_only' }), site: { domain: DOMAIN, api_paths: { v1: '/a', v2: '/b' } } })).toEqual(['site.api_paths.v1']);
    expect(refused({ ...v2Draft({ apis: 'v1_and_v2' }), php_bin: '/usr/bin/php' })).toEqual([]);
    expect(refused({ ...v2Draft(), apis: 'both' })).toEqual(['apis']);
    // Without `apis`, a stray php_bin is the derive refusal (named), never silently dropped.
    expect(completeDraft(v2Draft({ php_bin: '/usr/bin/php' }), debianHost()).layoutError).toMatch(/^php_bin: /);
  });
});
