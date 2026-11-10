/**
 * init/api_config.ts against the REAL templates (spec §5.8, §9): publication/server_api/v2/
 * .env.example and publication/server_api/v1/config_api/sample.server_config_api.php.
 *   - v2: one-line replacements, every value single-quoted, every other line byte-identical,
 *     and the round trip through the agent's own env grammar (src/env_file.ts parseEnvFile);
 *   - v1: one-line define()/`$DEFAULT_DDBB` replacements, `$db_name` and
 *     MYSQL_DEDALO_DATABASE_CONN untouched, both transports; the PHP round trip
 *     (`php -n -r 'include …'`) — RED on Linux CI when php is missing, skipped with its reason
 *     on Darwin only;
 *   - the grammars: a refusal names the field and the forbidden class, never the value.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnvFile } from '../src/env_file';
import {
  ApiConfigRefused,
  checkValue,
  renderV1Config,
  V1_API_ROOT_LINE,
  renderV2Env,
  V1_KEYS,
  V2_KEYS,
  type V1Values,
  type V2Values,
  verifyV2RoundTrip,
} from '../src/provision/init/api_config';
import { scratchPath } from './fixtures/instance';

const REPO = resolve(import.meta.dir, '..', '..', '..');
const V2_TEMPLATE = readFileSync(join(REPO, 'publication/server_api/v2/.env.example'), 'utf8');
const V1_TEMPLATE = readFileSync(join(REPO, 'publication/server_api/v1/config_api/sample.server_config_api.php'), 'utf8');
/** Built at runtime: a fixture, never a credential-shaped literal (.gitleaks.toml). */
const PASSWORD = ['Pw', '9', 'x', 'ZqK'].join('-');
const CODE = ['wc', 'Z9', 'k2mN', 'q1'].join('');

const v2: V2Values = {
  host: 'db.internal',
  port: '3307',
  socket: null,
  user: 'web_ro',
  password: PASSWORD,
  dbNames: ['web_one', 'web_two'],
  deploymentMode: 'apache',
};

const v1: V1Values = {
  host: 'localhost',
  user: 'web_ro',
  password: PASSWORD,
  entity: 'my_museum',
  webUserCode: CODE,
  db: 'web_one',
  transport: 'socket',
  socket: '/run/mysqld/mysqld.sock',
  port: null,
};

function changedLines(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  expect(b).toHaveLength(a.length);
  return b.filter((line, index) => line !== a[index]);
}

describe('v2.env', () => {
  test('exactly the seven keys change, each single-quoted; every other line is kept', () => {
    const rendered = renderV2Env(V2_TEMPLATE, v2);
    expect(changedLines(V2_TEMPLATE, rendered).sort()).toEqual(
      [
        "DB_HOST='db.internal'",
        "DB_PORT='3307'",
        "DB_SOCKET=''",
        "DB_USER='web_ro'",
        `DB_PASSWORD='${PASSWORD}'`,
        "DB_NAMES='web_one,web_two'",
        "DEPLOYMENT_MODE='apache'",
      ].sort(),
    );
    expect([...V2_KEYS].sort()).toEqual(['DB_HOST', 'DB_NAMES', 'DB_PASSWORD', 'DB_PORT', 'DB_SOCKET', 'DB_USER', 'DEPLOYMENT_MODE']);
  });

  test('the round trip through parseEnvFile returns exactly the typed values (socket transport too)', () => {
    for (const values of [v2, { ...v2, socket: '/run/mysqld/mysqld.sock', deploymentMode: 'nginx' as const }]) {
      const rendered = renderV2Env(V2_TEMPLATE, values);
      expect(() => verifyV2RoundTrip(rendered, values, parseEnvFile)).not.toThrow();
      const parsed = parseEnvFile(rendered, 'v2.env');
      expect(parsed.DB_PASSWORD).toBe(PASSWORD);
      expect(parsed.DB_SOCKET).toBe(values.socket ?? '');
      expect(parsed.DB_POOL_MAX).toBe('10'); // an untouched template line still reads
    }
  });

  test('MUTATION: an unquoted value or a parser that disagrees is caught by the round trip', () => {
    const rendered = renderV2Env(V2_TEMPLATE, v2);
    const unquoted = rendered.replace(`DB_PASSWORD='${PASSWORD}'`, `DB_PASSWORD=${PASSWORD} # x`);
    expect(() => verifyV2RoundTrip(unquoted, v2, parseEnvFile)).toThrow('DB_PASSWORD: does not read back');
    expect(() => verifyV2RoundTrip(rendered, v2, () => ({}))).toThrow('does not read back');
    expect(() => verifyV2RoundTrip(rendered, v2, () => { throw new Error('bad'); })).toThrow('does not parse');
  });

  test('a template without a key, or with a key twice, is refused naming the key', () => {
    expect(() => renderV2Env(V2_TEMPLATE.replace('DB_PASSWORD=secret\n', ''), v2)).toThrow('DB_PASSWORD: the v2 template');
    expect(() => renderV2Env(`${V2_TEMPLATE}\nDB_USER=again\n`, v2)).toThrow('DB_USER: the v2 template (.env.example) sets it on 2 lines');
    // A commented mention is not a setting line.
    expect(() => renderV2Env(`# DB_HOST=commented\n${V2_TEMPLATE}`, v2)).not.toThrow();
  });

  test('CRLF templates keep their line endings', () => {
    const crlf = V2_TEMPLATE.replace(/\n/g, '\r\n');
    const rendered = renderV2Env(crlf, v2);
    expect(rendered.split('\r\n')).toHaveLength(crlf.split('\r\n').length);
    expect(rendered).toContain(`DB_PASSWORD='${PASSWORD}'\r\n`);
  });

  test('DB_NAMES and DEPLOYMENT_MODE are closed', () => {
    expect(() => renderV2Env(V2_TEMPLATE, { ...v2, dbNames: [] })).toThrow('at least one');
    expect(() => renderV2Env(V2_TEMPLATE, { ...v2, dbNames: ['a', 'a'] })).toThrow('twice');
    expect(() => renderV2Env(V2_TEMPLATE, { ...v2, dbNames: ['a,b'] })).toThrow('DB_NAMES[0]');
    expect(() => renderV2Env(V2_TEMPLATE, { ...v2, deploymentMode: 'iis' as 'apache' })).toThrow('DEPLOYMENT_MODE');
  });
});

describe('server_config_api.php', () => {
  test('socket transport: the six defines and $DEFAULT_DDBB change; $db_name and the DATABASE_CONN define do not', () => {
    const rendered = renderV1Config(V1_TEMPLATE, v1);
    const changed = changedLines(V1_TEMPLATE, rendered).map(line => line.trim());
    expect(changed.sort()).toEqual(
      [
        "define('API_ENTITY', 'my_museum');",
        "$DEFAULT_DDBB = 'web_one';",
        `define('API_WEB_USER_CODE', '${CODE}');`,
        "define('MYSQL_DEDALO_HOSTNAME_CONN', 'localhost');",
        "define('MYSQL_DEDALO_USERNAME_CONN', 'web_ro');",
        `define('MYSQL_DEDALO_PASSWORD_CONN', '${PASSWORD}');`,
        "define('MYSQL_DEDALO_SOCKET_CONN', '/run/mysqld/mysqld.sock');",
        V1_API_ROOT_LINE,
      ].sort(),
    );
    expect(rendered).toContain("define('MYSQL_DEDALO_DB_PORT_CONN'\t, null);");
    expect(rendered).toContain("define('MYSQL_DEDALO_DATABASE_CONN'\t, $db_name);");
    expect(rendered).toContain('$db_name = !empty($db_name)');
    expect(V1_KEYS).toContain('$DEFAULT_DDBB');
  });

  test('API_ROOT is the release that runs, never the shared/ directory the config lives in (D8 links it into every release)', () => {
    // Measured on RHEL 10.2 (two-machine drill, 2026-10-09): the sample's dirname(__FILE__, 2)
    // resolved through the D8 link to <state>/publication_api/v1, every include of common/
    // failed and v1 answered "Class manager not found" with HTTP 200.
    expect(V1_TEMPLATE).toMatch(/^\s*define\('API_ROOT', dirname\(__FILE__, 2\)\);\s*$/m);
    const rendered = renderV1Config(V1_TEMPLATE, v1);
    expect(rendered).not.toContain("define('API_ROOT', dirname(__FILE__, 2));");
    expect(rendered.split('\n').filter(line => line.includes("define('API_ROOT'"))).toEqual([`\t${V1_API_ROOT_LINE}`]);
    expect(() => renderV1Config(V1_TEMPLATE.replace(/^.*define\('API_ROOT'.*$/m, ''), v1)).toThrow('API_ROOT: the v1 sample');
  });

  test('tcp transport sets the port as a number and leaves the socket null', () => {
    const rendered = renderV1Config(V1_TEMPLATE, { ...v1, transport: 'tcp', socket: null, port: '3307' });
    expect(rendered).toContain("define('MYSQL_DEDALO_DB_PORT_CONN', 3307);");
    expect(rendered).toContain("define('MYSQL_DEDALO_SOCKET_CONN'\t, null);");
  });

  test('a sample that lost a define (even one this transport does not set) is refused', () => {
    expect(() => renderV1Config(V1_TEMPLATE.replace(/^.*MYSQL_DEDALO_DB_PORT_CONN.*$/m, ''), v1)).toThrow('MYSQL_DEDALO_DB_PORT_CONN: the v1 sample');
    expect(() => renderV1Config(V1_TEMPLATE.replace(/^.*\$DEFAULT_DDBB\t\t= .*$/m, ''), v1)).toThrow('$DEFAULT_DDBB');
    expect(() => renderV1Config(V1_TEMPLATE, { ...v1, transport: 'udp' as 'tcp' })).toThrow('transport');
    expect(() => renderV1Config(V1_TEMPLATE, { ...v1, socket: null })).toThrow('MYSQL_DEDALO_SOCKET_CONN: must be text');
  });

  const php = Bun.which('php');
  const phpReason = process.platform === 'darwin' ? 'php is not installed on this Mac (RED on Linux CI)' : null;
  const scratch = scratchPath('init_api_php');
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  test.skipIf(php === null && phpReason !== null)(`the PHP round trip reads back the typed values${php === null ? ` — skipped: ${phpReason}` : ''}`, () => {
    expect(php).not.toBeNull(); // RED (not skipped) on Linux when php is missing
    mkdirSync(join(scratch, 'config_api'), { recursive: true });
    const unicode = { ...v1, password: 'Contraseña#ç-ü+€_漢字!🔑', webUserCode: 'Código-ñandú-ç%&🔑' };
    for (const values of [v1, { ...v1, transport: 'tcp' as const, socket: null, port: '3307' }, unicode]) {
      const file = join(scratch, 'config_api', 'server_config_api.php');
      writeFileSync(file, renderV1Config(V1_TEMPLATE, values));
      const code = [
        'error_reporting(0);',
        '$skip_api_web_user_code_verification = true;',
        `include ${JSON.stringify(file)};`,
        'echo json_encode([MYSQL_DEDALO_HOSTNAME_CONN, MYSQL_DEDALO_USERNAME_CONN, MYSQL_DEDALO_PASSWORD_CONN, API_ENTITY, API_WEB_USER_CODE, MYSQL_DEDALO_DATABASE_CONN, MYSQL_DEDALO_SOCKET_CONN, MYSQL_DEDALO_DB_PORT_CONN]);',
      ].join(' ');
      const child = Bun.spawnSync([php as string, '-n', '-r', code], { stdout: 'pipe', stderr: 'pipe' });
      expect(JSON.parse(child.stdout.toString())).toEqual([
        values.host,
        values.user,
        values.password,
        values.entity,
        values.webUserCode,
        values.db,
        values.transport === 'socket' ? values.socket : null,
        values.transport === 'tcp' ? 3307 : null,
      ]);
    }
  });
});

describe('the value grammars', () => {
  test('a refusal names the field and the class, never the value', () => {
    const cases: [Parameters<typeof checkValue>[1], string, string][] = [
      ['secret', `abc'defgh`, 'single quote'],
      ['secret', 'abc\\defgh', 'backslash'],
      ['secret', 'abc$HOMEdefgh', "'$'"],
      ['secret', 'q7Zk2pX', 'shorter than 8'],
      ['secret', 'x'.repeat(257), 'longer than 256'],
      ['secret', 'has spaceinit', 'whitespace'],
      ['secret', 'ñandú\u00a0abc', 'whitespace'],
      ['secret', 'abc\u200bdefgh', 'invisible'],
      ['secret', 'abc\u202edefgh', 'invisible'],
      ['secret', 'abc\ue000defgh', 'private-use'],
      ['secret', 'abc\u3164defgh', 'invisible'],
      ['secret', 'abc\ufe0fdefgh', 'invisible'],
      ['secret', 'abc\u034fdefgh', 'invisible'],
      ['secret', 'abc\ufffddefgh', 'U+FFFD'],
      ['secret', 'abc\u0085defgh', 'control character'],
      ['secret', 'abc\ud83ddefgh', 'lone surrogate'],
      ['secret', 'ñçüé€漢字', 'shorter than 8'],
      ['user', 'web$ro', "'$'"],
      ['db', 'a\nb', 'line break'],
      ['host', 'a\tb', 'control'],
      ['host', '', 'empty'],
      ['socket', '/run/../etc/x', "'..'"],
      ['port', '0', 'between 1 and 65535'],
      ['port', '65536', 'between 1 and 65535'],
      ['entity', 'my museum', 'whitespace'],
      ['host', 'a\0b', 'NUL'],
      ['user', 'x/y', 'outside its grammar'],
    ];
    for (const [cls, value, why] of cases) {
      let caught: unknown;
      try {
        checkValue('FIELD', cls, value);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ApiConfigRefused);
      const message = (caught as Error).message;
      expect(message).toContain('FIELD');
      expect(message).toContain(why);
      if (value.length > 3) expect(message).not.toContain(value);
    }
    expect(() => checkValue('F', 'host', 3)).toThrow('must be text');
  });

  test('MUTATION: the secret grammar never admits a quote — renderers refuse it', () => {
    expect(() => renderV2Env(V2_TEMPLATE, { ...v2, password: `abc'defghij` })).toThrow('DB_PASSWORD');
    expect(() => renderV1Config(V1_TEMPLATE, { ...v1, webUserCode: `abc'defghij` })).toThrow('API_WEB_USER_CODE');
    expect(checkValue('F', 'secret', '!#%&()*+,-./:;<=>?@[]^_`{|}~')).toHaveLength(28);
  });

  test('a secret may use letters of any script: counted in characters, rendered byte-exact', () => {
    const secret = 'Contraseña#ç-ü+€_漢字!🔑';
    expect(checkValue('F', 'secret', secret)).toBe(secret);
    // 8 characters, 9 UTF-16 units (the emoji is two): length is characters, both ways.
    expect(checkValue('F', 'secret', 'ñçüé€漢字🔑')).toHaveLength(9);
    expect(checkValue('F', 'secret', 'ñ'.repeat(256))).toHaveLength(256);
    // 256 characters but 512 UTF-16 units: admitted — a check on .length would refuse it.
    expect([...checkValue('F', 'secret', '🔑'.repeat(256))]).toHaveLength(256);
    expect(() => checkValue('F', 'secret', '🔑'.repeat(257))).toThrow('longer than 256');
    expect(renderV2Env(V2_TEMPLATE, { ...v2, password: secret })).toContain(`DB_PASSWORD='${secret}'`);
    const php = renderV1Config(V1_TEMPLATE, { ...v1, password: secret, webUserCode: `${secret}x` });
    expect(php).toContain(`'${secret}'`);
    expect(php).toContain(`'${secret}x'`);
  });
});
