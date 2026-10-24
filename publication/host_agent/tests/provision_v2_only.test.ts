/**
 * A v2-ONLY INSTANCE — a declaration without the `v1` block (the recommended shape for a new site):
 * no PHP anywhere. Every consumer of the v1 / PHP fields handles its absence: derive (the v1-only
 * keys refused by name, php_bin required only with v1), the renderers (no pool, no v1 Alias or PHP
 * handler, no v1 log rotation, no PHP_BIN), the SELinux table, the plan and apply on a FakeHost
 * (no v1 account, no PHP binary pinned, no v1 tree), the access law and the siblings.
 */
import { describe, expect, test } from 'bun:test';
import { apply } from '../src/provision/apply';
import type { AgentLayout, HostDeclaration } from '../src/provision/layout';
import { derive, ownerName } from '../src/provision/layout';
import type { WriteAction } from '../src/provision/plan';
import { accessRefusals, plan, renderAll } from '../src/provision/plan';
import { apacheWebInclude, nginxWebInclude, webIncludeRenderer } from '../src/provision/render/web_include';
import { fpmPoolRenderer } from '../src/provision/render/fpm_pool';
import { logrotateBody, v1LogrotateRenderer } from '../src/provision/render/logrotate';
import { DeclarationError, parseDeclaration } from '../src/provision/schema';
import { selinuxRules } from '../src/provision/selinux';
import { siblingRefusals } from '../src/provision/siblings';
import { factsFor } from './fixtures/provision_facts';
import { unixDeclaration, v2OnlySiteDeclaration } from './fixtures/provision_declaration';
import { FakeInitHost } from './support/provision_fake_host';

const FACTS = factsFor('test', 'v2-only-test-token-not-a-secret-00000000000');

function issues(raw: unknown): string[] {
  try {
    parseDeclaration(raw, 'x');
  } catch (error) {
    if (error instanceof DeclarationError) return error.issues.map(issue => issue.path);
    throw error;
  }
  return [];
}

/** A v1+v2 site, the same instance (the contrast every branch is measured against). */
function v1Site(): HostDeclaration {
  const { os_family: _family, ...site } = v2OnlySiteDeclaration().site ?? { domain: 'example.org' };
  return { ...v2OnlySiteDeclaration(), site: { ...site, fpm: { flavor: 'debian', version: '8.4' } }, v1: { user: 'dedalo-api-v1' }, php_bin: '/usr/bin/php8.4' };
}

describe('derive: v1 is optional, and its keys live and die with it', () => {
  test('a v2-only declaration derives: v1 null, servedApis [v2], no PHP_BIN, no v1 tree, the declared family', () => {
    const l = derive(v2OnlySiteDeclaration());
    expect(l.v1).toBeNull();
    expect(l.servedApis).toEqual(['v2']);
    expect(l.site?.v1).toBeNull();
    expect(l.site?.family).toBe('debian');
    expect(l.site?.v2ApiPath).toBe('/dedalo/publication/server_api/v2');
    expect(l.envVars.PHP_BIN).toBeUndefined();
    expect(l.directories.map(dir => dir.path).filter(path => path.includes('publication_api/v1'))).toEqual([]);
    expect(l.directories.some(dir => dir.modeKey === 'v1Shared')).toBe(false);
    // …and no artifact may name the v1 owner row on it.
    expect(() => ownerName(l, 'v1')).toThrow(/v2-only instance has no v1 user/);
    // A no-site v2-only declaration derives too.
    const { site: _site, ...bare } = v2OnlySiteDeclaration();
    expect(derive(bare).servedApis).toEqual(['v2']);
  });

  test('v1+v2: servedApis [v1, v2], PHP_BIN rendered, the family from the FPM flavour', () => {
    const l = derive(v1Site());
    expect(l.servedApis).toEqual(['v1', 'v2']);
    expect(l.v1).toMatchObject({ user: 'dedalo-api-v1', phpBin: '/usr/bin/php8.4' });
    expect(l.envVars.PHP_BIN).toBe('/usr/bin/php8.4');
    expect(l.site?.family).toBe('debian');
    expect(derive({ ...v1Site(), web: { server: 'apache', unit: 'httpd' }, site: { domain: 'example.org', fpm: { flavor: 'remi', version: '8.4' } }, php_bin: '/opt/remi/php84/root/usr/bin/php' }).site?.family).toBe('el');
  });

  test('every v1-only key without the v1 block is refused, by name', () => {
    const v2 = v2OnlySiteDeclaration();
    expect(issues({ ...v2, php_bin: '/usr/bin/php' })).toEqual(['php_bin']);
    expect(issues({ ...v2, site: { ...v2.site, fpm: { flavor: 'debian', version: '8.4' } } })).toEqual(['site.fpm']);
    expect(issues({ ...v2, site: { ...v2.site, api_paths: { v1: '/a/v1', v2: '/a/v2' } } })).toEqual(['site.api_paths.v1']);
    expect(issues({ ...v2, paths: { fpm_pool_dir: '/scratch/pool.d' } })).toEqual(['paths.fpm_pool_dir']);
    expect(issues({ ...v2, paths: { v1_var_base: '/scratch/var' } })).toEqual(['paths.v1_var_base']);
    // api_paths without v1 is a v2 key only.
    expect(derive({ ...v2, site: { ...(v2.site as NonNullable<HostDeclaration['site']>), api_paths: { v2: '/a/v2' } } }).site?.v2ApiPath).toBe('/a/v2');
  });

  test('with the v1 block: php_bin required (and site.fpm with a site); a v2-only site needs os_family; a disagreeing one is refused', () => {
    const { php_bin: _php, ...noPhp } = v1Site();
    expect(issues(noPhp)).toEqual(['php_bin']);
    const { php_bin: _p2, ...bareNoPhp } = unixDeclaration();
    expect(issues(bareNoPhp)).toEqual(['php_bin']);
    const withoutFpm = { ...v1Site(), site: { domain: 'example.org' } };
    expect(issues(withoutFpm)).toEqual(['site.fpm']);
    expect(issues({ ...v2OnlySiteDeclaration(), site: { domain: 'example.org' } })).toEqual(['site.os_family']);
    expect(issues({ ...v1Site(), site: { ...v1Site().site, os_family: 'el' } })).toEqual(['site.os_family']);
    expect(issues({ ...v1Site(), site: { ...v1Site().site, os_family: 'debian' } })).toEqual([]);
    expect(issues({ ...v2OnlySiteDeclaration(), site: { domain: 'example.org', os_family: 'suse' } })).toEqual(['site.os_family']);
  });

  test('two principals on a v2-only instance: agent_user and v2.user still differ; a name v1 would have used is free', () => {
    expect(issues({ ...v2OnlySiteDeclaration(), agent_user: 'dedalo-api-v2' })).toEqual(['v2.user']);
    expect(issues({ ...v2OnlySiteDeclaration(), agent_user: 'www-data' })).toEqual([]);
  });
});

describe('renderers on a v2-only instance', () => {
  const l = derive(v2OnlySiteDeclaration());

  test('no pool, no v1 rotation; the web include and the web log rotation stay', () => {
    expect(fpmPoolRenderer.appliesTo?.(l)).toBe(false);
    expect(v1LogrotateRenderer.appliesTo?.(l)).toBe(false);
    expect(webIncludeRenderer.appliesTo?.(l)).toBe(true);
    const kinds = renderAll(l, FACTS).map(a => a.kind);
    expect(kinds).not.toContain('fpm_pool');
    expect(kinds).not.toContain('logrotate_v1');
    expect(kinds).toContain('web_include');
    expect(kinds).toContain('logrotate');
    for (const a of renderAll(l, FACTS)) expect(a.body).not.toMatch(/PHP_BIN|php-fpm|publication_api\/v1/);
    // The contrast: the v1 site renders both.
    expect(renderAll(derive(v1Site()), FACTS).map(a => a.kind)).toEqual(expect.arrayContaining(['fpm_pool', 'logrotate_v1']));
  });

  test('the web include carries the v2 proxy only: no v1 Alias/location, no PHP handler (apache and nginx)', () => {
    const apache = apacheWebInclude(l);
    expect(apache).toContain('<Location /dedalo/publication/server_api/v2/>');
    expect(apache).not.toMatch(/^Alias /m);
    expect(apache).not.toMatch(/SetHandler|FilesMatch|php_admin_flag|fcgi|server_api\/v1/);
    const nginx = nginxWebInclude(derive(v2OnlySiteDeclaration({ web: { server: 'nginx', unit: 'nginx' } })));
    expect(nginx).toContain('location /dedalo/publication/server_api/v2/ {');
    expect(nginx).not.toMatch(/fastcgi|\^~|server_api\/v1/);
    // The contrast: the v1 site's include has both.
    expect(apacheWebInclude(derive(v1Site()))).toContain('Alias /dedalo/publication/server_api/v1 ');
  });

  test("the web log group follows the declared family: EL's is root, Debian's adm", () => {
    const el = derive(v2OnlySiteDeclaration({ web: { server: 'apache', unit: 'httpd' }, site: { domain: 'example.org', os_family: 'el' } }));
    expect(el.site?.webLogsDir).toBe('/var/log/httpd/example.org');
    expect(logrotateBody(el)).toContain('\tcreate 0640 root root');
    expect(logrotateBody(l)).toContain('\tcreate 0640 root adm');
  });

  test('SELinux: no v1 tree rule and no v1 pool rows (V/tmp, V/log)', () => {
    const rows = selinuxRules(l).map(rule => rule.row);
    expect(rows).not.toContain('S/publication_api/v1');
    expect(rows).not.toContain('V/tmp');
    expect(rows).not.toContain('V/log');
    expect(selinuxRules(derive(v1Site())).map(rule => rule.row)).toEqual(expect.arrayContaining(['S/publication_api/v1', 'V/tmp', 'V/log']));
  });
});

/** A FakeInitHost with an instant reload poll and the web server running — and NO v1 account. */
class V2Host extends FakeInitHost {
  sleepSync(ms: number): void {
    this.lockIo.sleepSync(ms);
  }
}

function v2Host(decl: HostDeclaration = v2OnlySiteDeclaration()): { l: AgentLayout; host: V2Host } {
  const l = derive(decl);
  const host = new V2Host(l, { os: 'debian', selinux: 'absent' });
  host.users.delete('dedalo-api-v1');
  host.accountGroups.delete('dedalo-api-v1');
  host.seedDir('/var/lib');
  return { l, host };
}

describe('plan and apply on a FakeHost (v2-only)', () => {
  test('no v1 account is required, no PHP binary is pinned, nothing v1 or FPM is planned; it converges', () => {
    const { l, host } = v2Host();
    const actions = plan(l, host.state());
    const paths = actions.flatMap(a => ('path' in a ? [a.path] : []));
    expect(paths.filter(path => path.includes('/v1') || path.includes('php'))).toEqual([]);
    expect(actions.map(a => a.op)).not.toContain('fpm-configtest');
    expect(actions.map(a => a.op)).not.toContain('fpm-reload');
    const web = actions.find(a => a.op === 'write' && a.label === 'web_include') as WriteAction | undefined;
    expect(web?.validate).toBe('web');
    const report = apply(actions, host);
    expect(report.failure).toBeNull();
    expect(plan(l, host.state())).toEqual([]);
    expect(host.calls.some(call => /php|fpm/.test(call))).toBe(false);
  });

  test('the v1+v2 contrast on the same host refuses the missing v1 account and the missing PHP-FPM', () => {
    const { l, host } = v2Host(v1Site());
    let reasons: readonly string[] = [];
    try {
      plan(l, host.state());
    } catch (error) {
      reasons = (error as { reasons: readonly string[] }).reasons;
    }
    expect(reasons.join('\n')).toContain("user 'dedalo-api-v1' (v1.user) does not exist");
    expect(reasons.join('\n')).toContain("site.fpm.bin '/usr/sbin/php-fpm8.4' is not an executable file");
  });

  test('the access law: no php_bin leg and no v1 runner on a v2-only instance', () => {
    const { l, host } = v2Host();
    expect(accessRefusals(l, host.state()).join('\n')).not.toMatch(/php_bin|\(v1\)/);
  });
});

describe('siblings', () => {
  test('a v2-only instance beside a v1+v2 one: no pool comparison, and the v1 principal of the other still counts', () => {
    const own = derive(v2OnlySiteDeclaration());
    const other = derive({
      ...v1Site(),
      instance: 'other',
      agent_user: 'other_agent',
      v1: { user: 'other_v1' },
      v2: { unit: 'other_v2', user: 'other_v2', group: 'other_v2', port: 3200, health_url: 'http://127.0.0.1:3200/health' },
      agent_dir: '/home/other.org/host_agent',
      state_root: '/home/other.org/dedalo',
      bun_bin: '/home/other.org/.bun/bin/bun',
      site: { domain: 'other.org', fpm: { flavor: 'debian', version: '8.4' } },
      media: { mode: 'none' },
    });
    const sibling = [{ source: '/etc/dedalo_publication_host/other.json', layout: other }];
    expect(siblingRefusals(own, sibling).join('\n')).not.toMatch(/v1 pool/);
    // Our agent account named like the other's v1 user: still a clash (the other serves v1).
    const clashing = derive(v2OnlySiteDeclaration({ agent_user: 'other_v1' }));
    expect(siblingRefusals(clashing, sibling).join('\n')).toContain("agent_user 'other_v1' is that instance's v1.user");
  });
});
