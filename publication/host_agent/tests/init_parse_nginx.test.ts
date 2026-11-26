/**
 * parse/nginx.ts — `nginx -T` (captured on Debian 12/13, Ubuntu 22.04/24.04, Rocky/Alma 9 and 10;
 * typed: server-name forms, our reference, the guide's lines and hand-placed map), the lexer,
 * includes, http{}, servers, maps, the run user, `-v`.
 */
import { describe, expect, test } from 'bun:test';
import {
  confDIncludedInHttp,
  expandIncludes,
  findHttpBlock,
  findMapDefinitions,
  findServers,
  globToRegExp,
  matchServerNames,
  nginxRunUser,
  parseListen,
  parseNginx,
  parseNginxVersion,
  splitNginxT,
  tokenizeNginx,
} from '../src/provision/init/parse/nginx';
import { OUR_MAP_VARIABLES } from '../src/provision/init/observe';
import { fixture } from './fixtures/init/load';

const REFERENCE = '/etc/dedalo_publication_host/museum_org/web.nginx.con[f]';
const typedFiles = splitNginxT(fixture('typed/nginx/nginx_T_typed.txt'));
const typedTree = expandIncludes(typedFiles);

describe('the dump and the lexer', () => {
  test('splitNginxT: the verdict lines are dropped, each file is cut at its header', () => {
    expect(typedFiles.map(file => file.file)).toEqual([
      '/etc/nginx/nginx.conf',
      '/etc/nginx/mime.types',
      '/etc/nginx/conf.d/dedalo_hand_map.conf',
      '/etc/nginx/conf.d/dedalo_media_map.conf',
      '/etc/nginx/conf.d/museum.org.conf',
    ]);
    expect(typedFiles[0]?.text.startsWith('user nginx nginx;')).toBe(true);
    expect(splitNginxT('nginx: [emerg] unknown directive\n')).toEqual([]);
  });

  test('quotes, escapes, comments and braces/semicolons inside strings', () => {
    const tokens = tokenizeNginx('a "b c" \'d;e\' f\\;g # comment ; {\n{ } ;');
    // `\;` keeps the `;` in the word AND keeps its backslash (ngx_conf_read_token copies it).
    expect(tokens.map(token => token.value)).toEqual(['a', 'b c', 'd;e', 'f\\;g', '{', '}', ';']);
    expect(tokens.at(-1)?.line).toBe(2);
    expect(tokenizeNginx('"a\\"b" "x\\ny" \'it\\\'s\' "back\\\\slash" tab\\tbed r\\r').map(token => token.value)).toEqual([
      'a"b',
      'x\ny',
      "it's",
      'back\\slash',
      'tab\tbed',
      'r\r',
    ]);
    expect(tokenizeNginx('~^www\\d+\\.museum\\.org$ "~^\\d$"').map(token => token.value)).toEqual(['~^www\\d+\\.museum\\.org$', '~^\\d$']);
    expect(() => tokenizeNginx('"open')).toThrow('unterminated');
  });

  test('parseNginx: blocks with end lines; unbalanced or unterminated input throws', () => {
    const tree = parseNginx('http {\n  server {\n    listen 80;\n  }\n}\n', '/x');
    expect(tree[0]).toMatchObject({ name: 'http', line: 1, endLine: 5 });
    expect(tree[0]?.block?.[0]).toMatchObject({ name: 'server', line: 2, endLine: 4 });
    expect(() => parseNginx('}', '/x')).toThrow("unexpected '}'");
    expect(() => parseNginx('http {', '/x')).toThrow('not closed');
    expect(() => parseNginx('listen 80', '/x')).toThrow("has no ';' or '{'");
    expect(() => parseNginx('{', '/x')).toThrow("unexpected '{'");
    expect(() => parseNginx('a }', '/x')).toThrow("unexpected '}' inside 'a'");
  });

  for (const host of ['debian12', 'debian13', 'ubuntu2204', 'ubuntu2404', 'ubuntu2604', 'rocky9', 'alma9', 'rocky10', 'alma10']) {
    test(`captured ${host}: the whole dump parses; http{} exists`, () => {
      const files = splitNginxT(fixture(`captured/${host}/nginx_T.txt`));
      const tree = expandIncludes(files);
      expect(findHttpBlock(tree)).not.toBeNull();
      expect(files[0]?.file).toBe('/etc/nginx/nginx.conf');
    });
  }
});

describe('includes and http{} (§13.6 confDInHttp)', () => {
  test('EL default (captured): conf.d/*.conf is included inside http{}; user nginx', () => {
    for (const host of ['rocky9', 'alma9', 'rocky10', 'alma10']) {
      const tree = expandIncludes(splitNginxT(fixture(`captured/${host}/nginx_T.txt`)));
      expect(confDIncludedInHttp(tree, '/etc/nginx/conf.d', 'dedalo_media_map.conf')).toBe(true);
      expect(nginxRunUser(tree)).toEqual({ user: 'nginx', group: null });
    }
  });

  test('Debian (captured): conf.d is included inside http{} too; user www-data; sites-enabled spliced', () => {
    const files = splitNginxT(fixture('captured/debian12/nginx_T.txt'));
    const tree = expandIncludes(files);
    expect(confDIncludedInHttp(tree, '/etc/nginx/conf.d', 'dedalo_media_map.conf')).toBe(true);
    expect(nginxRunUser(tree)?.user).toBe('www-data');
    // the default site, from sites-enabled/default, is a server inside http{}.
    expect(findServers(tree, files, { referenceInclude: REFERENCE }).some(server => server.file === '/etc/nginx/sites-enabled/default')).toBe(true);
  });

  test('a relative include resolves against the main file; a conf.d outside http is not "in http"; no http → null', () => {
    expect(confDIncludedInHttp(typedTree, '/etc/nginx/conf.d', 'dedalo_media_map.conf')).toBe(true);
    const outside = expandIncludes(splitNginxT('# configuration file /etc/nginx/nginx.conf:\ninclude /etc/nginx/conf.d/*.conf;\nhttp { include sites/*; }\n'));
    expect(confDIncludedInHttp(outside, '/etc/nginx/conf.d', 'dedalo_media_map.conf')).toBe(false);
    expect(confDIncludedInHttp(expandIncludes(splitNginxT(fixture('typed/nginx/nginx_T_no_http.txt'))), '/etc/nginx/conf.d', 'x.conf')).toBeNull();
    expect(expandIncludes([])).toEqual([]);
    expect(nginxRunUser(parseNginx('events {}', '/x'))).toBeNull();
    expect(nginxRunUser(typedTree)).toEqual({ user: 'nginx', group: 'nginx' });
  });

  test('glob(3): *, ?, [..], [!..]; a literal path', () => {
    expect(globToRegExp('/etc/nginx/conf.d/*.conf').test('/etc/nginx/conf.d/a.conf')).toBe(true);
    expect(globToRegExp('/etc/nginx/conf.d/*.conf').test('/etc/nginx/conf.d/sub/a.conf')).toBe(false);
    expect(globToRegExp('/x/web.nginx.con[f]').test('/x/web.nginx.conf')).toBe(true);
    expect(globToRegExp('/x/a?.conf').test('/x/ab.conf')).toBe(true);
    expect(globToRegExp('/x/[!a]b').test('/x/ab')).toBe(false);
    expect(globToRegExp('/x/[ab').test('/x/[ab')).toBe(true);
  });

  test('includes nested past the cap throw', () => {
    const loop = splitNginxT('# configuration file /etc/nginx/nginx.conf:\ninclude /etc/nginx/loop.conf;\n# configuration file /etc/nginx/loop.conf:\ninclude /etc/nginx/loop.conf;\n');
    expect(() => expandIncludes(loop)).toThrow('nest deeper than 16');
  });
});

describe('maps (web.nginx_manual_map)', () => {
  test("the guide's hand-placed map defines all three of our variables; our own map include defines none", () => {
    const maps = findMapDefinitions(typedTree, OUR_MAP_VARIABLES);
    expect(maps).toEqual([
      { file: '/etc/nginx/conf.d/dedalo_hand_map.conf', line: 2, variable: '$dedalo_auth_key' },
      { file: '/etc/nginx/conf.d/dedalo_hand_map.conf', line: 6, variable: '$dedalo_svg_disposition' },
      { file: '/etc/nginx/conf.d/dedalo_hand_map.conf', line: 9, variable: '$dedalo_svg_csp' },
    ]);
    expect(OUR_MAP_VARIABLES).toEqual(['$dedalo_auth_key', '$dedalo_svg_disposition', '$dedalo_svg_csp']);
    expect(findMapDefinitions(expandIncludes(splitNginxT(fixture('captured/rocky9/nginx_T.txt'))), OUR_MAP_VARIABLES)).toEqual([]);
  });
});

describe('servers', () => {
  const servers = findServers(typedTree, typedFiles, { referenceInclude: REFERENCE });

  test('the site server: names, listens (ssl, IPv6), root, logs (access_log off skipped), our reference, the upstream handler', () => {
    const site = servers[0];
    expect(site).toMatchObject({
      file: '/etc/nginx/conf.d/museum.org.conf',
      line: 1,
      endLine: 23,
      names: ['museum.org', 'www.museum.org'],
      listens: [
        { address: '*', port: 443, ssl: true, defaultServer: false },
        { address: '[::]', port: 443, ssl: true, defaultServer: false },
      ],
      root: '/home/museum.org/httpdocs',
      errorLog: '/home/museum.org/logs/error.log',
      accessLogs: ['/home/museum.org/logs/access.log'],
      ourReference: true,
      fpmHandler: '/run/php-fpm/www.sock',
    });
  });

  test("the guide's lines: the media include and both API locations, whole", () => {
    expect(servers[0]?.manualLines.map(entry => entry.line)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(servers[0]?.manualLines[0]?.text.trim()).toBe('include /home/museum.org/dedalo/rules/dedalo_media_publication.nginx.conf;');
  });

  test('default_server and quoted names; a server without listen is *:80; `ssl on;`', () => {
    expect(servers[1]).toMatchObject({ names: ['_', '.museum.org', 'museum.*'], listens: [{ address: '*', port: 80, ssl: false, defaultServer: true }], ourReference: false });
    expect(servers[2]?.listens).toEqual([{ address: '127.0.0.1', port: 8080, ssl: false, defaultServer: false }]);
    expect(servers[3]).toMatchObject({ names: ['other.org'], listens: [{ address: '*', port: 80, ssl: true, defaultServer: false }] });
    expect(servers).toHaveLength(4);
  });

  test('a direct unix fastcgi_pass is read; one inside a guide location is not the site handler', () => {
    const files = splitNginxT('# configuration file /etc/nginx/nginx.conf:\nhttp { server { server_name a.org; location ~ \\.php$ { fastcgi_pass unix:/run/a.sock; } } server { server_name b.org; location /x/server_api/v1/ { fastcgi_pass unix:/run/b.sock; } } }\n');
    const found = findServers(expandIncludes(files), files, { referenceInclude: REFERENCE });
    expect(found.map(server => server.fpmHandler)).toEqual(['/run/a.sock', null]);
    expect(findServers(parseNginx('events {}', '/x'), [], { referenceInclude: REFERENCE })).toEqual([]);
  });

  test('listen forms', () => {
    expect(parseListen(['[::]:443', 'ssl', 'http2'])).toEqual({ address: '[::]', port: 443, ssl: true, defaultServer: false });
    expect(parseListen(['127.0.0.1:8080'])).toEqual({ address: '127.0.0.1', port: 8080, ssl: false, defaultServer: false });
    expect(parseListen(['8443', 'quic', 'default'])).toEqual({ address: '*', port: 8443, ssl: true, defaultServer: true });
    expect(parseListen(['localhost'])).toEqual({ address: 'localhost', port: 80, ssl: false, defaultServer: false });
    expect(parseListen(['[2001:db8::1]:8443', 'ssl'])).toEqual({ address: '[2001:db8::1]', port: 8443, ssl: true, defaultServer: false });
    expect(parseListen(['*:80'])).toEqual({ address: '*', port: 80, ssl: false, defaultServer: false });
    expect(parseListen(['127.0.0.1'])).toEqual({ address: '127.0.0.1', port: 80, ssl: false, defaultServer: false });
    expect(parseListen(['unix:/run/x.sock'])).toBeNull();
    expect(() => parseListen(['[::]'])).toThrow('has no port');
  });
});

describe('dual stack and redirect-only servers', () => {
  const servers = (name: string) => {
    const files = splitNginxT(fixture(`typed/nginx/dualstack/${name}`));
    return findServers(expandIncludes(files), files, { referenceInclude: REFERENCE });
  };

  test('one server per family pair: every listen keeps its address (observe groups them by port into ONE row)', () => {
    const [redirect, tls] = servers('one_block_T.txt');
    expect(redirect?.listens.map(listen => [listen.address, listen.port, listen.ssl])).toEqual([
      ['*', 80, false],
      ['[::]', 80, false],
    ]);
    expect(tls?.listens.map(listen => [listen.address, listen.port, listen.ssl])).toEqual([
      ['*', 443, true],
      ['[::]', 443, true],
    ]);
    expect([redirect?.redirectOnly, tls?.redirectOnly]).toEqual([true, false]);
  });

  test('one server per family: `rewrite ^ https://… permanent` and `return 301 https://…` are redirect-only, the TLS servers are not', () => {
    const found = servers('two_blocks_T.txt');
    expect(found.map(server => [server.line, server.listens[0]?.address, server.listens[0]?.port, server.redirectOnly])).toEqual([
      [2, '*', 80, true],
      [7, '[::]', 80, true],
      [12, '*', 443, false],
      [19, '[::]', 443, false],
    ]);
  });

  test('MUTATION: a redirect inside `if`/`location`, a non-redirect return, a path rewrite or a relative target still serve', () => {
    expect(servers('crowded_T.txt').map(server => server.redirectOnly)).toEqual([false, false]);
    const one = (body: string) => {
      const files = splitNginxT(`# configuration file /etc/nginx/nginx.conf:\nhttp { server { listen 80; server_name museum.org; ${body} } }\n`);
      return findServers(expandIncludes(files), files, { referenceInclude: REFERENCE })[0]?.redirectOnly;
    };
    expect(one('return https://museum.org$request_uri;')).toBe(true);
    expect(one('return 308 $scheme://museum.org$request_uri;')).toBe(true);
    expect(one('rewrite ^(.*)$ https://museum.org$1;')).toBe(true);
    expect(one('location / { return 301 https://museum.org$request_uri; }')).toBe(false);
    expect(one('return 200 "ok";')).toBe(false);
    expect(one('return 444;')).toBe(false);
    expect(one('return 301 /elsewhere;')).toBe(false);
    expect(one('rewrite ^/old https://museum.org/new permanent;')).toBe(false);
    expect(one('root /var/www;')).toBe(false);
  });
});

describe('server_name matching (security)', () => {
  test('exact; .x (also x itself); *.x; x.*; ~regex; an uncompilable regex claims; none', () => {
    expect(matchServerNames(['museum.org', 'www.museum.org'], 'museum.org')).toBe('servername');
    expect(matchServerNames(['_', '.museum.org'], 'museum.org')).toBe('wildcard');
    expect(matchServerNames(['.museum.org'], 'shop.museum.org')).toBe('wildcard');
    expect(matchServerNames(['*.museum.org'], 'shop.museum.org')).toBe('wildcard');
    expect(matchServerNames(['*.museum.org'], 'museum.org')).toBeNull();
    expect(matchServerNames(['museum.*'], 'museum.net')).toBe('wildcard');
    expect(matchServerNames(['~^www\\d+\\.museum\\.org$'], 'www2.museum.org')).toBe('regex');
    expect(matchServerNames(['~^www\\d+\\.museum\\.org$'], 'museum.org')).toBeNull();
    expect(matchServerNames(['~^(unclosed'], 'anything.org')).toBe('regex');
    expect(matchServerNames(['other.org'], 'museum.org')).toBeNull();
  });
});

describe('-v', () => {
  test('captured nginx versions: 1.20.1 (EL 9), 1.26.3 (EL 10), 1.22.1, 1.24.0, 1.26.3, 1.28.3 (Ubuntu 26.04)', () => {
    expect(parseNginxVersion(fixture('captured/rocky9/nginx_v.txt'))).toBe('1.20.1');
    expect(parseNginxVersion(fixture('captured/rocky10/nginx_v.txt'))).toBe('1.26.3');
    expect(parseNginxVersion(fixture('captured/debian12/nginx_v.txt'))).toBe('1.22.1');
    expect(parseNginxVersion(fixture('captured/ubuntu2404/nginx_v.txt'))).toBe('1.24.0');
    expect(parseNginxVersion(fixture('captured/debian13/nginx_v.txt'))).toBe('1.26.3');
    expect(parseNginxVersion(fixture('captured/ubuntu2604/nginx_v.txt'))).toBe('1.28.3');
    expect(parseNginxVersion('')).toBeNull();
  });
});
