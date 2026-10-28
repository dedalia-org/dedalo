/**
 * MEDIA-PROTECTION LOCKSTEP TRIPWIRE (DEC-12).
 *
 * Media access control is enforced by surfaces that must agree, forever:
 *
 *   1. the generated Apache rules   (buildHtaccess)
 *   2. the generated nginx rules    (buildNginxConf)
 *   3. the marker WRITER            (diffusion/targets/mediastore/media_index.ts)
 *   4. the COPY classifier          (diffusion/targets/mediastore/media_copy.ts publicFileKey —
 *                                    what a publication host in `copy` mode receives)
 *
 * Surfaces 1 and 2 decide, from a media FILE NAME, which record marker to stat().
 * Surface 3 decides, from a record, which marker to create. If they ever disagree, the
 * gate stats a marker nobody writes (every published record 404s — visible, annoying) or
 * — the dangerous direction — parses a filename into the WRONG record and serves a file
 * whose record was never published.
 *
 * This gate is behavioral, not textual: it pulls the regexes BACK OUT of the generated
 * web-server text, compiles them in JS, and asserts that all three surfaces classify one
 * table of real filenames identically. Both patterns are plain PCRE using only constructs
 * JS RegExp supports natively ((?:…), [^/]*, {2,12}, \., and named groups), so compiling
 * them here is a faithful test of the PATTERN.
 *
 * HONEST LIMIT: this proves the patterns, not Apache's/nginx's rewrite ENGINES. The
 * engines are proven by the curl matrix in engineering/MEDIA_PROTECTION.md — which is
 * what actually caught the two historical bugs (the `$1_$2`-vs-`%1_%2` backreference and
 * the nginx `^~` precedence trap). Both of those are additionally pinned below.
 *
 * Registered in engineering/TRIPWIRES.md + scripts/verify.ts + scripts/ci/hermetic.sh.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	MEDIA_ACTIVE_DOCUMENT_EXTENSIONS as AGENT_ACTIVE_DOCUMENT_EXTENSIONS,
	MEDIA_FILENAME_GRAMMAR as AGENT_GRAMMAR,
	ALWAYS_MASTER_TIERS as AGENT_MASTER_TIERS,
	MEDIA_SCRIPT_DENY_PATTERN as AGENT_SCRIPT_DENY_PATTERN,
	MEDIA_WORKING_FILE_EXTENSIONS as AGENT_WORKING_FILE_EXTENSIONS,
	classifyMediaPath as classifyAgentMediaPath,
} from '../../publication/host_agent/src/media/grammar.ts';
import { config } from '../../src/config/config.ts';
import {
	buildHtaccess,
	buildNginxConf,
	buildNginxMap,
	filterPublicQualities,
	getPublicQualities,
	MEDIA_AUTH_COOKIE,
	MEDIA_FILENAME_GRAMMAR,
	MEDIA_SCRIPT_DENY_PATTERN,
	MEDIA_WORKING_FILE_EXTENSIONS,
	masterQualities,
	nginxHardeningLocations,
} from '../../src/core/media/protection.ts';
import {
	buildPublicationHostApacheConf,
	buildPublicationHostNginxConf,
} from '../../src/core/media/publication_host_rules.ts';
import {
	MEDIA_ACTIVE_DOCUMENT_EXTENSIONS,
	SVG_ENVELOPE_CSP,
	SVG_QUARANTINE_CSP,
	SVG_QUARANTINE_DISPOSITION,
} from '../../src/core/media/svg_safety.ts';
import { publicFileKey } from '../../src/diffusion/targets/mediastore/media_copy.ts';
import { makeMarkerKey } from '../../src/diffusion/targets/mediastore/media_index.ts';
import { mediaSvgSafetyHeaders } from '../../src/server.ts';

/** The quality folders every generated rule set in this test allows. */
const QUALITIES = [
	'av/404',
	'av/posterframe',
	'av/subtitles',
	'image/1.5MB',
	'image/thumb',
	'image/web',
	'pdf/web',
	'svg/web',
	'3d/web',
];

const HTACCESS = buildHtaccess('publication', QUALITIES, []);
const NGINX = buildNginxConf('publication', QUALITIES);

/** A publication host mounting the published media read-only somewhere ELSE. */
const HOST_ROOT = '/srv/dedalo_media_ro';
const HOST_APACHE = buildPublicationHostApacheConf({ root: HOST_ROOT, qualities: QUALITIES });
const HOST_NGINX = buildPublicationHostNginxConf({ root: HOST_ROOT, qualities: QUALITIES });

/** Pull the rule-B pattern back out of the generated Apache text. */
function apachePattern(text: string = HTACCESS): RegExp {
	const line = text.split('\n').find((l) => l.startsWith('RewriteRule ^(?:'));
	if (line === undefined) throw new Error('rule B not found in the generated .htaccess');
	const match = /^RewriteRule \^(.+?) - \[L\]$/.exec(line);
	if (match?.[1] === undefined) throw new Error(`could not extract the Apache pattern: ${line}`);
	return new RegExp(`^${match[1]}`);
}

/**
 * Pull the rule-B pattern back out of the generated nginx text.
 *
 * The pattern is DOUBLE-QUOTED in the generated conf, and must stay that way: nginx's
 * config lexer treats `{`/`}` as block delimiters, so an unquoted regex carrying the
 * grammar's `{2,12}` quantifier truncates mid-token and nginx refuses to start. That
 * shipped as a real bug (publication mode was unusable on nginx), so the quotes are
 * asserted below, not merely tolerated.
 */
function nginxPattern(text: string = NGINX): RegExp {
	// trimStart: the publication-host include NESTS Rule B inside its outer ^~ prefix.
	const line = text
		.split('\n')
		.map((l) => l.trimStart())
		.find((l) => l.startsWith('location ~ "^/dedalo/'));
	if (line === undefined) {
		throw new Error(
			'rule B not found in the generated nginx conf — it must be `location ~ "<regex>" {`, ' +
				'with the regex DOUBLE-QUOTED (an unquoted `{2,12}` makes nginx refuse to start)',
		);
	}
	const match = /^location ~ "(.+)" \{$/.exec(line);
	if (match?.[1] === undefined) throw new Error(`could not extract the nginx pattern: ${line}`);
	return new RegExp(match[1]);
}

/**
 * ONE table. Every surface must reach the SAME verdict on every row.
 * `key` is the record marker the gate must stat, or null = deny (anonymously).
 */
const CASES: { path: string; key: string | null; why: string }[] = [
	{
		path: 'image/web/pic-1_test3_7.jpg',
		key: 'test3_7',
		why: 'a rich-text image (TODO-066) is keyed to the record its text lives in',
	},
	{
		path: 'image/web/pic.jpg',
		key: null,
		why: 'a legacy unkeyed rich-text image stays login-only BY DESIGN',
	},
	{ path: 'av/404/rsc35_rsc167_2.mp4', key: 'rsc167_2', why: 'av delivery quality' },
	{
		path: 'av/posterframe/rsc35_rsc167_2.jpg',
		key: 'rsc167_2',
		why: 'the posterframe shares its record marker with the video',
	},
	{
		path: 'av/subtitles/rsc35_rsc167_2_lg-spa.vtt',
		key: 'rsc167_2',
		why: 'subtitles ARE media — an unpublished transcription must not leak',
	},
	{ path: 'image/1.5MB/0/rsc29_rsc170_770.jpg', key: 'rsc170_770', why: 'numeric bucket dir' },
	{ path: 'image/thumb/1000/rsc29_rsc170_1770.jpg', key: 'rsc170_1770', why: 'bucket 1000' },
	{
		path: 'image/1.5MB/0/rsc29_rsc170_3_lg-spa.jpg',
		key: 'rsc170_3',
		why: 'translatable image lang suffix',
	},
	{
		path: 'image/1.5MB/dir/deep/rsc29_rsc170_770.jpg',
		key: 'rsc170_770',
		why: 'initial_media_path + additional_path nesting',
	},
	{ path: 'pdf/web/rsc37_rsc176_12.pdf', key: 'rsc176_12', why: 'pdf' },
	{ path: 'svg/web/rsc40_rsc180_5.svg', key: 'rsc180_5', why: 'svg' },
	{ path: '3d/web/rsc50_rsc190_7.glb', key: 'rsc190_7', why: '3d' },
	{
		path: 'image/1.5MB/0/test94_test3_1.jpg',
		key: 'test3_1',
		why: 'THE greedy-prefix case: the component tipo must not be read as the section tipo',
	},

	// ── deny (login-only or refused outright) ──────────────────────────────────────
	{
		path: 'image/original/0/rsc29_rsc170_770.tif',
		key: null,
		why: 'the master tier is not a public quality — even for a published record',
	},
	{
		path: 'image/modified/0/rsc29_rsc170_770.jpg',
		key: null,
		why: 'the retouched tier is not public',
	},
	{
		path: 'image/1.5MB/0/my_custom_name.jpg',
		key: null,
		why: 'a properties.image_id rename does not parse — login-only BY DESIGN, never loosen this',
	},
	{
		path: 'av/404/rsc35_RSC167_2.mp4',
		key: null,
		why: 'the tipo grammar is lowercase',
	},
	{
		path: 'av/subtitles/rsc35_rsc167_2_lg-spa-x-toolongtag.vtt',
		key: null,
		why: 'a lang tag longer than 12 chars does not parse',
	},
	{
		path: '.publication/pub/rsc167_2',
		key: null,
		why: 'the marker store is never served (rule 0)',
	},
];

describe('media protection: the three enforcement surfaces stay in lockstep', () => {
	test('Apache and nginx classify every filename identically, and agree with the writer', () => {
		const apache = apachePattern();
		const nginx = nginxPattern();

		for (const testCase of CASES) {
			// 1. Apache: rule B stats pub/$1_$2 — the captures of THIS pattern.
			const apacheMatch = apache.exec(testCase.path);
			const apacheKey =
				apacheMatch === null ? null : `${apacheMatch[1] ?? ''}_${apacheMatch[2] ?? ''}`;

			// 2. nginx: the location regex runs against the full URL, and stats
			//    pub/${dd_s}_${dd_i} — its NAMED captures.
			const nginxMatch = nginx.exec(`/dedalo/media/${testCase.path}`);
			const nginxKey =
				nginxMatch === null
					? null
					: `${nginxMatch.groups?.dd_s ?? ''}_${nginxMatch.groups?.dd_i ?? ''}`;

			expect(apacheKey, `Apache disagrees on ${testCase.path} (${testCase.why})`).toBe(
				testCase.key,
			);
			expect(nginxKey, `nginx disagrees on ${testCase.path} (${testCase.why})`).toBe(testCase.key);
		}
	});

	test('the WRITER creates exactly the markers the gates stat', () => {
		// Closes the loop: it is not enough that both gates agree on a key — that key must
		// be the one media_index.ts actually writes when the record is published.
		for (const testCase of CASES) {
			if (testCase.key === null) continue;
			const [sectionTipo, sectionId] = testCase.key.split('_');
			expect(makeMarkerKey(sectionTipo as string, sectionId as string)).toBe(testCase.key);
		}
	});

	test('the COPY desired-set classifier (media_copy.ts) agrees with Rule B on every filename', () => {
		// Publication-host `copy` mode ships exactly what Rule B would serve. If the
		// classifier drifted from the generated pattern, a copy host would hold (and serve)
		// files the shared/work gate refuses — or silently miss published ones.
		for (const testCase of CASES) {
			expect(
				publicFileKey(testCase.path, QUALITIES),
				`media_copy disagrees on ${testCase.path} (${testCase.why})`,
			).toBe(testCase.key);
		}
	});

	test('the COPY classifier also refuses everything the hardening 404s, in any letter case', () => {
		const denied = [
			...MEDIA_WORKING_FILE_EXTENSIONS,
			...MEDIA_ACTIVE_DOCUMENT_EXTENSIONS,
			...MEDIA_SCRIPT_DENY_PATTERN.replace('phps?', 'php|phps').split('|'),
		];
		expect(denied.length).toBeGreaterThan(15); // anti-vacuity: all three lists were read
		for (const ext of denied) {
			for (const spelled of [ext, ext.toUpperCase()]) {
				expect(
					publicFileKey(`image/1.5MB/0/rsc29_rsc170_770.${spelled}`, QUALITIES),
					spelled,
				).toBeNull();
			}
		}
	});
});

describe('media protection: the structural traps that historically shipped as bugs', () => {
	test('Apache rule B uses $1_$2, never %1_%2', () => {
		// %1 would reference rule A's last RewriteCond capture instead of this rule's — the
		// gate would stat a marker built from the wrong values and deny everything.
		expect(HTACCESS).toContain('/.publication/pub/$1_$2" -f');
		expect(HTACCESS).not.toContain('%1_%2');
	});

	test('the Apache rule-B RewriteRule immediately follows its RewriteCond', () => {
		const lines = HTACCESS.split('\n');
		const condIndex = lines.findIndex((line) => line.includes('/.publication/pub/$1_$2'));
		expect(condIndex).toBeGreaterThan(-1);
		expect(lines[condIndex + 1]).toStartWith('RewriteRule ^(?:');
	});

	test('the nginx rule-A location is a PLAIN prefix (a ^~ there skips rule B entirely)', () => {
		expect(NGINX).toContain('location /dedalo/media/ {');
		expect(NGINX).not.toContain('location ^~ /dedalo/media/ {');
	});

	test('the nginx rule-B location precedes the rule-A catch-all', () => {
		// nginx matches regex locations in file order.
		expect(NGINX.indexOf('location ~ ^/dedalo/')).toBeLessThan(
			NGINX.indexOf('location /dedalo/media/ {'),
		);
	});

	test('rule B uses NAMED captures — the inner `if` regex resets the numeric ones', () => {
		expect(NGINX).toContain('(?<dd_s>');
		expect(NGINX).toContain('(?<dd_i>');
	});
});

describe('media protection: the fail-closed constants', () => {
	test('every mode denies the marker store, including off', () => {
		for (const mode of ['off', 'private', 'publication'] as const) {
			expect(buildHtaccess(mode, QUALITIES, [])).toContain('\\.publication');
			expect(buildNginxConf(mode, QUALITIES)).toContain('location ^~ /dedalo/media/.publication/');
		}
	});

	test('the SEC-088 script-execution hardening survives in EVERY mode, including off', () => {
		// 'off' must write the hardening-only template, NOT unlink the file: the media root
		// is full of user-uploaded files, and an .htaccess-less media dir is one where an
		// uploaded .php executes.
		for (const mode of ['off', 'private', 'publication'] as const) {
			expect(buildHtaccess(mode, QUALITIES, [])).toContain('Require all denied');
			expect(buildHtaccess(mode, QUALITIES, [])).toContain('Options -Indexes -ExecCGI');
			expect(buildNginxConf(mode, QUALITIES)).toContain('phps?|phtml|phar');
		}
	});

	test('the gated modes deny by default, as 404 and never 403', () => {
		// 403 would disclose that the file exists.
		for (const mode of ['private', 'publication'] as const) {
			expect(buildHtaccess(mode, QUALITIES, [])).toContain('RewriteRule ^ - [R=404,L]');
			expect(buildHtaccess(mode, QUALITIES, [])).not.toContain('R=403');
		}
	});

	test('the cookie pattern is strict sha512 hex in both surfaces', () => {
		// The cookie VALUE becomes a literal filename under auth/. A loosened capture here
		// turns the gate into an arbitrary-file stat oracle.
		expect(HTACCESS).toContain(`${MEDIA_AUTH_COOKIE}=([a-f0-9]{128})`);
		expect(NGINX).toContain('$dedalo_auth_key');
		expect(buildNginxConf('private')).toContain('/.publication/auth/$dedalo_auth_key');
	});

	test('master qualities can never enter the public list', () => {
		expect(filterPublicQualities(['original', 'image/original', 'image/modified'])).toEqual([]);
		for (const quality of getPublicQualities()) {
			expect(quality.split('/')).not.toContain('original');
			expect(quality.split('/')).not.toContain('modified');
		}
	});

	test('a bare/ancestor top-level folder is refused — it would expose its master subdir (MEDIA-05)', () => {
		// A bare `image`/`av`/`pdf` has no forbidden SEGMENT of its own, but rule B's
		// `(?:.+/)?` descends from an allowed quality into any subdir, so a public
		// `image` matched `image/original/0/…rsc.tif` and served the master. Refused.
		expect(filterPublicQualities(['image'])).toEqual([]);
		expect(filterPublicQualities(['av'])).toEqual([]);
		expect(filterPublicQualities(['pdf'])).toEqual([]);
		// A trailing slash trims to the same bare folder (the empty-default trigger:
		// DEDALO_IMAGE_QUALITY_DEFAULT="" → getDefaultPublicQualities emits `image/`).
		expect(filterPublicQualities(['image/'])).toEqual([]);
		// A real, specific quality (≥2 segments, no master segment) SURVIVES — it
		// cannot reach a sibling `original/`.
		expect(filterPublicQualities(['image/1.5MB'])).toEqual(['image/1.5MB']);
		// Mixed: the bare ancestor is dropped, the specific quality kept.
		expect(filterPublicQualities(['image', 'image/1.5MB'])).toEqual(['image/1.5MB']);
		// Every emitted default is a specific ≥2-segment quality (defence in depth).
		for (const quality of getPublicQualities()) {
			expect(quality.split('/').length).toBeGreaterThanOrEqual(2);
		}
	});

	test('the auth cookie NAME is fixed — rotating names would need a web-server reload', () => {
		expect(MEDIA_AUTH_COOKIE).toBe('dedalo_media_auth');
	});
});

// ---------------------------------------------------------------------------
// The FOURTH lockstep axis: the MEDIA-03 response headers (2026-08-24)
// ---------------------------------------------------------------------------

/**
 * SVG is the one image format that is also a DOCUMENT, and the media origin is the
 * application origin. The rule for which SVG population may be served inline is now
 * implemented for THREE consumers — the Bun media route (`mediaSvgSafetyHeaders`), the
 * generated Apache text and the generated nginx map — and a fourth definition of the
 * same rule is exactly the drift this file exists to catch. The rule itself lives in
 * ONE place, src/core/media/svg_safety.ts; these tests pull the patterns back out of
 * the generated web-server text, compile them, and assert that both generators
 * classify a table of REAL paths exactly as the route function does.
 *
 * Why the table is paths and not extensions: the envelope really lives one bucket
 * directory below its `svg/` segment (`image/svg/0/rsc29_rsc170_1.svg`). A pattern
 * anchoring the file directly inside `svg/` compiles, looks right, matches no real
 * envelope, and blanks every `<object type="image/svg+xml">` edit view on every
 * Apache/nginx install. That is the failure this table is shaped to catch.
 *
 * HONEST LIMIT (the same one as above): this proves the PATTERNS agree, not that
 * Apache's `<If>`/`<FilesMatch>` merge order or nginx's map evaluation behave as
 * intended. Those are the four header rows of the curl matrix in
 * engineering/MEDIA_PROTECTION.md §9.
 */
describe('media protection: the MEDIA-03 response headers stay in lockstep', () => {
	const MEDIA_URL = `/dedalo/${config.mediaDir}`;
	const IMAGE_FOLDER = config.media.image.folder.replace(/^\/+/, '').replace(/\/+$/, '');

	/** media-root-relative segments → the URI the web server sees. */
	const uriOf = (relSegments: readonly string[]): string => `${MEDIA_URL}/${relSegments.join('/')}`;

	const CASES: { what: string; rel: string[]; type: string }[] = [
		{
			what: 'a server-generated image envelope (inline, script-free CSP)',
			rel: [IMAGE_FOLDER, 'svg', '0', 'rsc29_rsc170_1.svg'],
			type: 'image/svg+xml',
		},
		{
			what: 'an envelope below a non-empty initial media path',
			rel: [IMAGE_FOLDER, 'sub', 'svg', '12', 'rsc29_rsc170_9.svg'],
			type: 'image/svg+xml',
		},
		{
			what: 'a raw uploaded vector (attachment + sandbox)',
			rel: ['svg', 'web', '0', 'svg29_svg170_1.svg'],
			type: 'image/svg+xml',
		},
		{
			what: 'an SVG in an image quality folder that is NOT the envelope folder',
			rel: [IMAGE_FOLDER, '1.5MB', '0', 'rsc29_rsc170_1.svg'],
			type: 'image/svg+xml',
		},
		{
			what: 'a raster (no SVG headers at all)',
			rel: [IMAGE_FOLDER, '1.5MB', '0', 'rsc29_rsc170_1.jpg'],
			type: 'image/jpeg',
		},
	];

	/** Compile the envelope PCRE out of the generated Apache `<If>` line. */
	function apacheEnvelopePattern(): RegExp {
		const line = HTACCESS.split('\n').find((l) => l.includes('%{REQUEST_URI} =~ m#'));
		if (line === undefined) throw new Error('the MEDIA-03 <If> is missing from the .htaccess');
		const match = /=~ m#(.+?)#">$/.exec(line.trim());
		if (match?.[1] === undefined) throw new Error(`could not extract the Apache <If>: ${line}`);
		return new RegExp(match[1]);
	}

	/** Compile the quarantine extension pattern out of the generated Apache text. */
	function apacheQuarantinePattern(): RegExp {
		const line = HTACCESS.split('\n').find(
			(l) =>
				l.includes('<FilesMatch') &&
				l.includes('Content-Disposition') === false &&
				l.includes('svg|'),
		);
		if (line === undefined) throw new Error('the MEDIA-03 <FilesMatch> is missing');
		const match = /<FilesMatch "\(\?i\)(.+?)">/.exec(line.trim());
		if (match?.[1] === undefined) throw new Error(`could not extract the FilesMatch: ${line}`);
		return new RegExp(match[1], 'i');
	}

	/** Compile one nginx `map` block into an ordered list of [pattern, value]. */
	function nginxMapEntries(variable: string): { pattern: RegExp; value: string }[] {
		const text = buildNginxMap();
		const start = text.indexOf(`map $uri $${variable} {`);
		if (start < 0) throw new Error(`the ${variable} map is missing from the generated map file`);
		const body = text.slice(start, text.indexOf('\n}', start));
		const entries: { pattern: RegExp; value: string }[] = [];
		for (const line of body.split('\n').slice(1)) {
			const match = /^\s*"~(.+?)"\s+"(.*)";$/.exec(line);
			if (match?.[1] !== undefined && match[2] !== undefined) {
				entries.push({ pattern: new RegExp(match[1]), value: match[2] });
			}
		}
		if (entries.length === 0) throw new Error(`the ${variable} map compiled to no entries`);
		return entries;
	}

	/** nginx map semantics: FIRST matching regex wins; no match ⇒ the default. */
	function nginxMapValue(variable: string, uri: string): string {
		for (const { pattern, value } of nginxMapEntries(variable)) {
			if (pattern.test(uri)) return value;
		}
		return '';
	}

	for (const testCase of CASES) {
		test(`${testCase.what}: route, Apache and nginx agree`, () => {
			const uri = uriOf(testCase.rel);
			const routeHeaders = mediaSvgSafetyHeaders(testCase.rel, testCase.type);
			const expectedCsp = routeHeaders['Content-Security-Policy'] ?? '';
			const expectedDisposition = routeHeaders['Content-Disposition'] ?? '';

			// nginx: the two maps ARE the classification, so they must equal the route.
			expect(nginxMapValue('dedalo_svg_csp', uri)).toBe(expectedCsp);
			expect(nginxMapValue('dedalo_svg_disposition', uri)).toBe(expectedDisposition);

			// Apache: the <FilesMatch> sets the quarantine pair, the <If> overrides it
			// for the envelope. Reconstruct that merge and compare the same way.
			const quarantined = apacheQuarantinePattern().test(uri);
			const isEnvelope = apacheEnvelopePattern().test(uri);
			const apacheCsp = isEnvelope ? SVG_ENVELOPE_CSP : quarantined ? SVG_QUARANTINE_CSP : '';
			const apacheDisposition = isEnvelope ? '' : quarantined ? SVG_QUARANTINE_DISPOSITION : '';
			expect(apacheCsp).toBe(expectedCsp);
			expect(apacheDisposition).toBe(expectedDisposition);
		});
	}

	test('ANTI-VACUITY: the case table really exercises both verdicts', () => {
		// A table that only ever produced one verdict would pass against a generator
		// that classified everything identically — the exact bug this axis exists for.
		const verdicts = new Set(
			CASES.map((c) => JSON.stringify(mediaSvgSafetyHeaders(c.rel, c.type))),
		);
		expect(verdicts.size).toBe(3); // envelope / quarantine / no headers
	});

	test('the nginx envelope pattern is tested BEFORE the extension pattern', () => {
		// nginx map regexes are evaluated in order and an envelope is also an `.svg`.
		// Reversed, every envelope becomes an attachment and the edit view goes blank.
		for (const variable of ['dedalo_svg_csp', 'dedalo_svg_disposition']) {
			const entries = nginxMapEntries(variable);
			// The envelope entry is the PATH-anchored one; the quarantine entry keys on
			// the extension alone. (Do not match on 'svg/': RegExp.source escapes the
			// slash, so the needle would never be found and the test would be vacuous.)
			const envelopeIndex = entries.findIndex((e) => e.pattern.source.startsWith('^'));
			const extensionIndex = entries.findIndex((e) => e.pattern.source.startsWith('\\.'));
			expect(envelopeIndex).toBeGreaterThanOrEqual(0);
			expect(extensionIndex).toBeGreaterThan(envelopeIndex);
		}
	});

	test('EVERY byte-serving nginx location carries the full header set, in every mode', () => {
		// add_header does NOT inherit into a location that declares any add_header of
		// its own, so there is no server-level shortcut: a location that serves bytes
		// and omits these serves them bare.
		for (const mode of ['off', 'private', 'publication'] as const) {
			const text = buildNginxConf(mode, mode === 'publication' ? QUALITIES : []);
			const serving = text
				.split('\n')
				.filter((l) => l.startsWith('location') && !l.includes('deny all'));
			expect(serving.length).toBeGreaterThan(0);
			// Split on the LINE START only — the word 'location' also occurs in the
			// generated prose, and splitting on the bare word invents empty blocks.
			const blocks = text.split('\nlocation ').slice(1);
			for (const block of blocks) {
				if (block.includes('deny all')) continue; // a deny location serves no bytes
				expect(block).toContain('add_header X-Content-Type-Options');
				expect(block).toContain('add_header Content-Disposition $dedalo_svg_disposition');
				expect(block).toContain('add_header Content-Security-Policy $dedalo_svg_csp');
			}
		}
	});

	test('the headers cannot FAIL OPEN when mod_headers is absent', () => {
		// Without mod_headers the CSP simply is not emitted. An install in that state
		// must refuse the uploader-supplied population, not serve it inline unprotected.
		expect(HTACCESS).toContain('<IfModule !mod_headers.c>');
		const branch = HTACCESS.slice(
			HTACCESS.indexOf('<IfModule !mod_headers.c>'),
			HTACCESS.indexOf('# Protect working files'),
		);
		expect(branch).toContain('Require all denied');
		expect(branch).toContain('Require all granted'); // the envelope stays reachable
	});

	test('the Apache <If> is merged AFTER the <FilesMatch> it overrides', () => {
		// Apache merges <If> last; if the envelope override were emitted first the
		// FilesMatch would win and every envelope would be an attachment.
		expect(HTACCESS.indexOf('<FilesMatch "(?i)\\.(svg|')).toBeLessThan(
			HTACCESS.indexOf('%{REQUEST_URI} =~ m#'),
		);
	});

	test('active-document extensions are DENIED on both surfaces, in every mode', () => {
		// Nothing legitimate under the media root is named .html/.swf/.hta — no media
		// model's allowedExtensions list contains one. These are refused, not quarantined.
		for (const extension of MEDIA_ACTIVE_DOCUMENT_EXTENSIONS) {
			expect(buildHtaccess('off', [], [])).toContain(extension);
			expect(buildNginxConf('off', [])).toContain(extension);
		}
	});

	test('the nginx map carries its own config hash (it is no longer static)', () => {
		// It used to be written only when ABSENT. Now that the server block references
		// variables the map defines, an install that keeps an old map cannot reload
		// nginx at all — so the map must be rewritten on drift like the other two.
		expect(buildNginxMap()).toContain('# config-hash: ');
	});
	test('the auth marker directory is created 0750, never world-listable', () => {
		// The FILENAMES in that directory are live media credentials: a 0755 marker dir
		// hands every local user a working cookie by `ls`. This used to be pinned
		// indirectly by the MEDIA_DIR_MODE census, which scans for inline mkdir mode
		// LITERALS — the per-session credential gave the directory a second creator, so
		// the mode became one named constant and left that census with nothing to see.
		// Pin the value here instead of leaving the blind spot open.
		const source = readFileSync('src/core/media/protection.ts', 'utf8');
		expect(source).toContain('const AUTH_MARKER_DIR_MODE = 0o750;');
		const inlineModes = source.match(/mkdirSync\([^)]*mode:\s*0o\d+/g) ?? [];
		expect(inlineModes).toEqual([]); // every creator goes through the constant
	});
});

describe('media protection: the PUBLICATION-HOST profile stays in lockstep (PUBLICATION_HOST_SPEC §5.1)', () => {
	test('it classifies every filename exactly like the work profile', () => {
		const apache = apachePattern(HOST_APACHE);
		const nginx = nginxPattern(HOST_NGINX);
		for (const testCase of CASES) {
			const a = apache.exec(testCase.path);
			const apacheKey = a === null ? null : `${a[1] ?? ''}_${a[2] ?? ''}`;
			const n = nginx.exec(`/dedalo/media/${testCase.path}`);
			const nginxKey = n === null ? null : `${n.groups?.dd_s ?? ''}_${n.groups?.dd_i ?? ''}`;
			expect(apacheKey, `host Apache disagrees on ${testCase.path} (${testCase.why})`).toBe(
				testCase.key,
			);
			expect(nginxKey, `host nginx disagrees on ${testCase.path} (${testCase.why})`).toBe(
				testCase.key,
			);
			// nginx aliases the WHOLE matched media path, never a fragment of it.
			if (n !== null) expect(n.groups?.dd_path).toBe(testCase.path);
		}
	});

	test('it stats markers under the HOST root, never the work root', () => {
		expect(HOST_APACHE).toContain(`RewriteCond "${HOST_ROOT}/.publication/pub/$1_$2" -f`);
		expect(HOST_NGINX).toContain(`if (!-f ${HOST_ROOT}/.publication/pub/\${dd_s}_\${dd_i})`);
	});

	test('host and work nginx share ONE hardening builder (SEC-088 / MEDIA-03 / rule 0)', () => {
		const work = nginxHardeningLocations(`/dedalo/${config.mediaDir}`);
		expect(NGINX).toContain(work.join('\n'));
		expect(HOST_NGINX).toContain(work.map((l) => (l === '' ? '' : `\t${l}`)).join('\n'));
		// and the shared script list is the Apache 404 rewrite's too (F3)
		expect(HTACCESS).toContain(`RewriteRule (?i)\\.(${MEDIA_SCRIPT_DENY_PATTERN})$ - [R=404,L]`);
		expect(HOST_APACHE).toContain(`RewriteRule (?i)\\.(${MEDIA_SCRIPT_DENY_PATTERN})$ - [R=404,L]`);
	});

	test('it carries NO Rule A: a work-session cookie is never honoured publicly', () => {
		for (const text of [HOST_APACHE, HOST_NGINX]) {
			expect(text).not.toContain(MEDIA_AUTH_COOKIE);
			expect(text).not.toContain('.publication/auth/');
			expect(text).not.toContain('$dedalo_auth_key');
		}
	});
});

/**
 * F2: the working-file deny (MEDIA_WORKING_FILE_EXTENSIONS) used to be Apache-only, and a
 * case-SENSITIVE 403 there: a published record's grammar-valid `…_test3_1.tmp` passed Rule
 * B and nginx served it, and `.TMP` on an APFS/SMB mount was served by Apache too.
 * Behavioral: the deny rules are pulled back OUT of all four generated texts, compiled, and
 * must refuse every suffix of the constant (any case) as 404, BEFORE Rule B can serve it.
 */
describe('media protection: working files are denied by Apache AND nginx, both profiles (F2)', () => {
	const PROBE_DIR = 'image/1.5MB/0/rsc29_rsc170_1';
	const probes = MEDIA_WORKING_FILE_EXTENSIONS.flatMap((ext) => [ext, ext.toUpperCase()]).map(
		(ext) => `${PROBE_DIR}.${ext}`,
	);

	/** Apache `RewriteRule <pcre> - [R=404,L]` lines, as [line index, regex]. */
	function apacheDenies(text: string): [number, RegExp][] {
		return text.split('\n').flatMap((line, i): [number, RegExp][] => {
			const m = /^RewriteRule (\(\?i\))?(.+) - \[R=404,L\]$/.exec(line);
			return m?.[2] === undefined ? [] : [[i, new RegExp(m[2], m[1] ? 'i' : '')]];
		});
	}

	/** nginx regex locations whose body is `deny all; return 404;`, as [line index, regex]. */
	function nginxDenies(text: string): [number, RegExp][] {
		const lines = text.split('\n').map((l) => l.trimStart());
		return lines.flatMap((line, i): [number, RegExp][] => {
			const m = /^location (~\*?) (\S+) \{$/.exec(line);
			if (m?.[2] === undefined) return [];
			if (lines[i + 1] !== 'deny all;' || lines[i + 2] !== 'return 404;') return [];
			return [[i, new RegExp(m[2], m[1] === '~*' ? 'i' : '')]];
		});
	}

	const ruleBIndex = (text: string, prefix: string): number =>
		text.split('\n').findIndex((l) => l.trimStart().startsWith(prefix));

	const SURFACES: { name: string; text: string; server: 'apache' | 'nginx'; url: string }[] = [
		{ name: 'work Apache (.htaccess)', text: HTACCESS, server: 'apache', url: '' },
		{ name: 'host Apache (vhost include)', text: HOST_APACHE, server: 'apache', url: '' },
		{ name: 'work nginx', text: NGINX, server: 'nginx', url: `/dedalo/${config.mediaDir}/` },
		{ name: 'host nginx', text: HOST_NGINX, server: 'nginx', url: '/dedalo/media/' },
	];

	for (const surface of SURFACES) {
		test(`${surface.name}: every working suffix (any case) is a 404 that precedes Rule B`, () => {
			const denies =
				surface.server === 'apache' ? apacheDenies(surface.text) : nginxDenies(surface.text);
			const ruleB =
				surface.server === 'apache'
					? ruleBIndex(surface.text, 'RewriteRule ^(?:')
					: ruleBIndex(surface.text, 'location ~ "^/dedalo/');
			expect(ruleB).toBeGreaterThan(-1);
			for (const probe of probes) {
				const path = `${surface.url}${probe}`;
				const hit = denies.find(([, re]) => re.test(path));
				expect(hit, `${surface.name} does not deny ${path}`).toBeDefined();
				expect(hit?.[0] ?? Infinity, `${surface.name}: deny of ${path} after Rule B`).toBeLessThan(
					ruleB,
				);
			}
			// and it is the WORKING-file deny, not a catch-all: a plain published .jpg reaches
			// Rule B (the default deny AFTER Rule B is a different rule and does not count).
			const jpg = `${surface.url}${PROBE_DIR}.jpg`;
			expect(denies.some(([i, re]) => i < ruleB && re.test(jpg))).toBe(false);
		});
	}

	test('the Apache .htaccess fails CLOSED without mod_rewrite (FilesMatch fallback)', () => {
		const working = MEDIA_WORKING_FILE_EXTENSIONS.join('|');
		const fallback = `<IfModule !mod_rewrite.c>\n\t<FilesMatch "(?i)\\.(${working})$">\n\t\tRequire all denied`;
		expect(HTACCESS).toContain(fallback);
		expect(HOST_APACHE).toContain(fallback);
	});

	test('mode off keeps the deny on both servers (it is hardening, not the access gate)', () => {
		for (const text of [buildHtaccess('off', [], []), buildNginxConf('off', [])]) {
			expect(text).toContain(`(${MEDIA_WORKING_FILE_EXTENSIONS.join('|')})$`);
		}
	});
});

/**
 * F3: Apache denied the script population (MEDIA_SCRIPT_DENY_PATTERN) with an unconditional
 * `<FilesMatch> Require all denied`. In .htaccess / <Directory> context authz runs BEFORE the
 * per-dir rewrite, so an uploaded `.php` answered 403 — confirming it exists (§2: 404, never
 * 403). Now: `SetHandler none` (never executed) + a `(?i)` `RewriteRule … [R=404,L]`, with the
 * authz deny ONLY inside `<IfModule !mod_rewrite.c>` (a host without mod_rewrite never serves
 * the source either).
 */
describe('media protection: uploaded scripts are a 404 on Apache, never a 403 (F3)', () => {
	const SCRIPT_EXTS = MEDIA_SCRIPT_DENY_PATTERN.replace('phps?', 'php|phps').split('|');
	const APACHE_TEXTS = [
		['work .htaccess (publication)', HTACCESS],
		['work .htaccess (off)', buildHtaccess('off', [], [])],
		['host Apache', HOST_APACHE],
	] as const;

	/** Every `<FilesMatch "(?i)…">` whose body denies, with whether it sits in !mod_rewrite. */
	function authzDenies(text: string): { re: RegExp; fallback: boolean }[] {
		const lines = text.split('\n').map((l) => l.trim());
		const out: { re: RegExp; fallback: boolean }[] = [];
		let inNoRewrite = false;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? '';
			if (line === '<IfModule !mod_rewrite.c>') inNoRewrite = true;
			else if (line === '</IfModule>') inNoRewrite = false;
			const m = /^<FilesMatch "\(\?i\)(.+)">$/.exec(line);
			if (m?.[1] !== undefined && lines[i + 1] === 'Require all denied') {
				out.push({ re: new RegExp(m[1], 'i'), fallback: inNoRewrite });
			}
		}
		return out;
	}

	for (const [name, text] of APACHE_TEXTS) {
		test(`${name}: every script extension (any case) is a 404 rewrite, the authz deny only a fallback`, () => {
			const rewrites = text
				.split('\n')
				.map((l) => /^RewriteRule (\(\?i\))?(.+) - \[R=404,L\]$/.exec(l))
				.flatMap((m) => (m?.[2] === undefined ? [] : [new RegExp(m[2], m[1] ? 'i' : '')]));
			const denies = authzDenies(text);
			for (const ext of SCRIPT_EXTS.flatMap((e) => [e, e.toUpperCase()])) {
				const file = `image/thumb/0/test94_test3_1.${ext}`;
				expect(
					rewrites.some((re) => re.test(file)),
					`${name}: no 404 rewrite for ${file}`,
				).toBe(true);
				// a 403 that wins over the rewrite: an authz deny OUTSIDE the !mod_rewrite fallback
				const eager = denies.filter((d) => !d.fallback && d.re.test(file));
				expect(eager.length, `${name}: ${file} is authz-denied (403) with mod_rewrite loaded`).toBe(
					0,
				);
				// and the no-mod_rewrite host still never serves the source
				expect(
					denies.some((d) => d.fallback && d.re.test(file)),
					`${name}: no fallback for ${file}`,
				).toBe(true);
			}
			// never executed: SetHandler none stays on the PHP family
			expect(text).toContain('<FilesMatch "(?i)\\.(phps?|phtml|phar|pht)$">\n\tSetHandler none');
		});
	}
});

/**
 * AGENT AXIS (PUBLICATION_HOST_SPEC §5.2/§6): a copy-mode publication host is served by the
 * publication_host profile over the agent's copy root, and the agent refuses a media.put
 * the gate could never serve. Its grammar is a COPY (publication/host_agent never imports
 * the engine), so it is held equal here and run over the same CASES table: a drift would
 * copy files the gate never serves, or refuse files it does.
 */
describe('media protection: the publication-host AGENT classifies like the gates (PUBLICATION_HOST_SPEC §5.2)', () => {
	test("its grammar, working-file list and master tiers are the engine's", () => {
		expect(AGENT_GRAMMAR).toBe(MEDIA_FILENAME_GRAMMAR);
		expect([...AGENT_WORKING_FILE_EXTENSIONS]).toEqual([...MEDIA_WORKING_FILE_EXTENSIONS]);
		for (const tier of AGENT_MASTER_TIERS) expect(masterQualities().has(tier)).toBe(true);
		expect([...AGENT_ACTIVE_DOCUMENT_EXTENSIONS]).toEqual([...MEDIA_ACTIVE_DOCUMENT_EXTENSIONS]);
		expect(AGENT_SCRIPT_DENY_PATTERN).toBe(MEDIA_SCRIPT_DENY_PATTERN);
	});

	test('its media.put refuses everything the hardening 404s, in any letter case', () => {
		const denied = [
			...MEDIA_WORKING_FILE_EXTENSIONS,
			...MEDIA_ACTIVE_DOCUMENT_EXTENSIONS,
			...MEDIA_SCRIPT_DENY_PATTERN.replace('phps?', 'php|phps').split('|'),
		];
		expect(denied.length).toBeGreaterThan(15); // anti-vacuity: all three lists were read
		for (const ext of denied) {
			for (const spelled of [ext, ext.toUpperCase()]) {
				const path = `image/thumb/0/x_rsc29_1.${spelled}`;
				expect(classifyAgentMediaPath(path, 'put').ok, path).toBe(false);
			}
		}
	});

	test('its media.put classifier accepts exactly the gate-public rows, with the same key', () => {
		for (const testCase of CASES) {
			const verdict = classifyAgentMediaPath(testCase.path, 'put');
			expect(
				verdict.ok ? verdict.key : null,
				`agent disagrees on ${testCase.path} (${testCase.why})`,
			).toBe(testCase.key);
		}
	});
});
