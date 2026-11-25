/**
 * init/report.ts (spec §1.2 TTY + output law, §4.1): the three lists, the sanitizer, the
 * redactor. Every rule is held by a line it must change AND a neighbour it must leave alone; the
 * redacted output must pass cli.ts `guarded` (the placeholder sits below its secret floor).
 */
import { describe, expect, test } from 'bun:test';
import { guarded } from '../src/provision/cli';
import { REDACTED, countLine, redactLine, renderLists, renderNeedsAction, sanitizeLine } from '../src/provision/init/report';
import type { Item } from '../src/provision/init/types';

const SECRET = 'Zq7pX2kN9wLm4vRt';

function item(id: string, list: Item['list'], extra: Partial<Item> = {}): Item {
  return { id, list, area: 'host', title: id, facts: [], commands: [], after: [], blocking: false, optional: false, operatorFile: false, hostWide: false, ...extra };
}

describe('sanitizeLine: nothing an operator file or a child prints can drive the terminal', () => {
  test.each([
    ['CSI colour', 'a\x1b[31mred\x1b[0m b', 'ared b'],
    ['OSC 52 (clipboard) ended by BEL', `x\x1b]52;c;${btoa('rm -rf /')}\x07y`, 'xy'],
    ['OSC ended by ST', 'x\x1b]0;title\x1b\\y', 'xy'],
    ['DCS to the end of the line', 'x\x1bPq#0;2;0;0;0', 'x'],
    ['two-byte escape', 'x\x1bcy', 'xy'],
    ['C1 CSI introducer', 'x\x9b31my', 'x31my'],
    ['carriage return, bell, DEL', 'a\rb\x07c\x7fd', 'abcd'],
    ['a tab becomes one space', '\tServerName\texample.org', ' ServerName example.org'],
  ])('%s', (_name, input, expected) => {
    expect(sanitizeLine(input)).toBe(expected);
  });

  test('a newline is kept (multi-line facts are split by the caller)', () => {
    expect(sanitizeLine('a\nb')).toBe('a\nb');
  });
});

describe('redactLine: the value goes, the directive and its name stay', () => {
  test.each([
    ['SetEnv', `  SetEnv DB_PASSWORD ${SECRET}`, `  SetEnv DB_PASSWORD ${REDACTED}`],
    ['SetEnv, any name', `SetEnv APP_MODE ${SECRET}`, `SetEnv APP_MODE ${REDACTED}`],
    ['PassEnv', 'PassEnv DB_USER DB_PASSWORD', `PassEnv ${REDACTED}`],
    ['SetEnvIf', `SetEnvIf Host example SECRET=${SECRET}`, `SetEnvIf ${REDACTED}`],
    ['FPM env[]', `env[DB_PASS] = ${SECRET}`, `env[DB_PASS] = ${REDACTED}`],
    ['FPM php_admin_value[] credential key', `php_admin_value[mysql.default_password] = ${SECRET}`, `php_admin_value[mysql.default_password] = ${REDACTED}`],
    ['Apache php_value credential key', `php_value session.auth_key ${SECRET}`, `php_value session.auth_key ${REDACTED}`],
    ['fastcgi_param', `fastcgi_param DB_HOST ${SECRET};`, `fastcgi_param DB_HOST ${REDACTED};`],
    ['proxy_set_header Authorization', `proxy_set_header Authorization "Bearer ${SECRET}";`, `proxy_set_header Authorization ${REDACTED}`],
    ['RequestHeader set Cookie', `RequestHeader set Cookie "sid=${SECRET}"`, `RequestHeader set Cookie ${REDACTED}`],
    ['shell assignment', `DB_PASSWORD=${SECRET}`, `DB_PASSWORD=${REDACTED}`],
    ['JSON key', `"api_token": "${SECRET}"`, `"api_token": ${REDACTED}`],
    ['PHP define()', `define('MYSQL_DEDALO_PASSWORD_CONN', '${SECRET}');`, `define('MYSQL_DEDALO_PASSWORD_CONN', ${REDACTED});`],
    ['a unified-diff prefix does not hide it', `+SetEnv DB_PASSWORD ${SECRET}`, `+SetEnv DB_PASSWORD ${REDACTED}`],
  ])('%s', (_name, input, expected) => {
    const out = redactLine(input);
    expect(out).toBe(expected);
    expect(out).not.toContain(SECRET);
  });

  test.each([
    ['php_value with a plain key', 'php_value upload_max_filesize 64M'],
    ['proxy_set_header Host', 'proxy_set_header Host $host;'],
    ['a plain assignment', 'DEPLOYMENT_MODE=apache'],
    ['a vhost line', '<VirtualHost *:443>'],
    ['ServerName', 'ServerName museum.example.org'],
  ])('left alone: %s', (_name, input) => {
    expect(redactLine(input)).toBe(input);
  });

  test('a redacted line passes the cli guard; the raw one does not', () => {
    const printed: string[] = [];
    const sink = guarded(line => printed.push(line));
    const raw = `DB_PASSWORD=${SECRET}`;
    expect(() => sink(raw)).toThrow(/refusing to print/);
    sink(redactLine(raw));
    expect(printed).toEqual([`DB_PASSWORD=${REDACTED}`]);
    expect(REDACTED.length).toBeLessThan(8);
  });
});

describe('renderLists: three lists, whole, in order', () => {
  const items: Item[] = [
    item('host.os', 'right', { title: 'Debian 12', facts: ['debian 12: supported'] }),
    item('accounts.agent', 'change', { title: 'create the agent user', commands: ['useradd --system demo_agent'] }),
    item('web.vhost_reference', 'decision', {
      title: 'reference the include from the vhost',
      operatorFile: true,
      blocking: true,
      diff: { path: '/etc/apache2/sites-enabled/museum.conf', unified: `@@ -1 +1,2 @@\n SetEnv DB_PASSWORD ${SECRET}\n+Include /etc/x.conf\n` },
      options: [
        { id: 'act', label: 'do it', resolves: 'act' },
        { id: 'manual', label: 'by hand', resolves: 'manual' },
      ],
      defaultOption: 'act',
    }),
    item('selinux.home_traverse', 'decision', { hostWide: true, optional: true, options: [{ id: 'boolean', label: 'setsebool', resolves: 'act' }] }),
  ];

  test('the headers carry the counts; each item prints its id, flags, facts, commands, diff and options', () => {
    const lines = renderLists(items, { answers: new Map([['web.vhost_reference', 'manual']]), interactive: true });
    expect(lines.filter(line => /^[123]\. /.test(line))).toEqual(['1. already right (1)', '2. will change (1)', '3. needs your decision (2)']);
    expect(lines).toContain('  [host.os] Debian 12');
    expect(lines).toContain('      - debian 12: supported');
    expect(lines).toContain('      $ useradd --system demo_agent');
    expect(lines).toContain('  [web.vhost_reference] reference the include from the vhost (blocking, edits your file)');
    expect(lines).toContain('      diff /etc/apache2/sites-enabled/museum.conf:');
    expect(lines).toContain(`         SetEnv DB_PASSWORD ${REDACTED}`);
    expect(lines).toContain('        +Include /etc/x.conf');
    expect(lines).toContain('      act: do it (default)');
    expect(lines).toContain('      manual: by hand (answered)');
    expect(lines).toContain('  [selinux.home_traverse] selinux.home_traverse (optional, host-wide)');
    expect(lines.join('\n')).not.toContain(SECRET);
    // Order: list 1 before list 2 before list 3.
    const at = (text: string) => lines.findIndex(line => line.includes(text));
    expect(at('[host.os]')).toBeLessThan(at('2. will change'));
    expect(at('[accounts.agent]')).toBeLessThan(at('3. needs your decision'));
  });

  test('a multi-line fact is indented under its bullet; a title cannot carry an escape', () => {
    const lines = renderLists([item('x.y', 'right', { title: 'evil\x1b]52;c;AAAA\x07title', facts: ['first\nsecond'] })], { interactive: true });
    expect(lines).toContain('  [x.y] eviltitle');
    expect(lines).toContain('      - first');
    expect(lines).toContain('        second');
  });

  test('empty lists still print their headers; countLine counts each list', () => {
    expect(renderLists([], { interactive: true })).toEqual(['1. already right (0)', '2. will change (0)', '3. needs your decision (0)']);
    expect(countLine(items, true)).toBe('1 right, 1 to change, 2 to decide');
  });
});

describe('P2: list 4 "needs your action", the typed hint, the end-of-run summary', () => {
  const manualOnly = item('declaration.vhost', 'decision', {
    title: 'the vhost that serves example.org',
    blocking: true,
    facts: [`SetEnv DB_PASSWORD ${SECRET}`],
    commands: ['create the vhost'],
    options: [{ id: 'manual', label: 'by hand', resolves: 'manual' }],
    defaultOption: 'manual',
  });
  const typed = item('web.vhost.0123abcd', 'decision', {
    operatorFile: true,
    options: [
      { id: 'act', label: 'do it', resolves: 'act', confirm: 'typed' },
      { id: 'manual', label: 'by hand', resolves: 'manual' },
    ],
    defaultOption: 'act',
  });

  test('a manual-only decision is printed under list 4, without options; a typed one says Enter takes nothing', () => {
    const lines = renderLists([manualOnly, typed], { interactive: true });
    expect(lines.filter(line => /^[1234]\. /.test(line))).toEqual([
      '1. already right (0)',
      '2. will change (0)',
      '3. needs your decision (1)',
      '4. needs your action (1) — init cannot do these; they are not asked',
    ]);
    const at = (text: string) => lines.findIndex(line => line.includes(text));
    expect(at('[declaration.vhost]')).toBeGreaterThan(at('4. needs your action'));
    expect(at('[web.vhost.0123abcd]')).toBeLessThan(at('4. needs your action'));
    expect(lines).toContain('      init cannot do this: do it by hand (the commands above), then run init again');
    expect(lines).not.toContain('      manual: by hand (default)');
    expect(lines).toContain('      type the option: this changes your files or the whole host, so Enter takes nothing');
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(countLine([manualOnly, typed], true)).toBe('0 right, 0 to change, 1 to decide, 1 need your action');
  });

  test('without a terminal a manual-only decision stays in list 3 with its options and its --decide: --yes resolves no decision, so "they are not asked" would be false (review lane A)', () => {
    const lines = renderLists([manualOnly, typed], { interactive: false });
    expect(lines.filter(line => /^[1234]\. /.test(line))).toEqual(['1. already right (0)', '2. will change (0)', '3. needs your decision (2)']);
    expect(lines.join('\n')).not.toContain('needs your action');
    expect(lines).toContain('      manual: by hand (default)');
    expect(lines).toContain(
      '      init cannot do this: do it by hand (the commands above), then run init again; without a terminal it stays open until --decide declaration.vhost=manual',
    );
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(countLine([manualOnly, typed], false)).toBe('0 right, 0 to change, 2 to decide');
  });

  test('renderNeedsAction: each item with its (redacted) facts and commands, then the re-run command; nothing for none', () => {
    const lines = renderNeedsAction([manualOnly], 'sh /home/example.org/host_agent/deploy/install.sh test');
    expect(lines).toEqual([
      'needs your action (1) — init cannot do these; do them, then run init again:',
      '  [declaration.vhost] the vhost that serves example.org',
      `      - SetEnv DB_PASSWORD ${REDACTED}`,
      '      $ create the vhost',
      'then re-run: sh /home/example.org/host_agent/deploy/install.sh test',
    ]);
    expect(renderNeedsAction([], 'x')).toEqual([]);
  });
});
