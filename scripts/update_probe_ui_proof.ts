/**
 * ui_proof_update_fix — puppeteer check against the LIVE museum install.
 *
 * Proves, in a real browser against the bytes the real server serves:
 *   1. login works with the temp credential;
 *   2. the SERVED update_code_phases.js (not the repo copy) classifies the
 *      exact terminal frame that misrendered as failure —
 *      {is_running:false, data:{ok:true,data:{version}}} → 'updated';
 *   3. the served render_update_code.js wires resolve_final_frame;
 *   4. screenshots land in ../update_probe/ui_proof_*.png.
 */
import puppeteer from 'puppeteer';
import { readEnv } from '../src/config/env.ts';

const BASE = 'http://127.0.0.1';
const USER = process.argv[2] ?? 'root';
const PASS = process.argv[3] ?? 'probe_cycle_temp_1';

const executablePath = readEnv('PUPPETEER_EXECUTABLE_PATH');
const browser = await puppeteer.launch({
	headless: true,
	args: ['--no-sandbox'],
	...(executablePath ? { executablePath } : { channel: 'chrome' as const }),
});
try {
	const page = await browser.newPage();
	await page.setViewport({ width: 1440, height: 900 });

	await page.goto(`${BASE}/dedalo/`, { waitUntil: 'networkidle2', timeout: 30000 });
	await page.waitForSelector('#username', { timeout: 15000 });
	// The login is TWO-STEP: username → Next reveals the #auth password field.
	await page.type('#username', USER);
	await page.click('.button_enter');
	await page.waitForSelector('#auth', { visible: true, timeout: 15000 });
	await page.type('#auth', PASS);
	await Promise.all([
		page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
		page.keyboard.press('Enter'),
	]);
	await new Promise((r) => setTimeout(r, 2500));

	const whoami = await page.evaluate(() => ({
		url: location.href,
		// The session cookie is HttpOnly — document.cookie never sees it. The
		// logged-in app shell (menu + username chip) is the visible proof.
		// innerText, not textContent: the proof is the RENDERED shell — textContent
		// also reads hidden nodes and inline <script> bodies.
		loggedIn:
			location.pathname.includes('/core/page/') &&
			// biome-ignore lint/performance/useDomNodeTextContent: rendered text IS the proof (see above).
			document.body.innerText.includes('Inventario'),
		// biome-ignore lint/performance/useDomNodeTextContent: rendered text IS the proof (see above).
		body: document.body.innerText.slice(0, 200),
	}));
	console.log('[ui] after login:', JSON.stringify({ url: whoami.url, loggedIn: whoami.loggedIn }));
	if (whoami.loggedIn !== true) {
		await page.screenshot({ path: '../update_probe/ui_proof_login.png' });
		throw new Error(
			`login failed (url ${whoami.url}; page starts: ${JSON.stringify(whoami.body)})`,
		);
	}

	// The load-bearing assertion, IN PAGE, against SERVED bytes:
	const verdict = await page.evaluate(async () => {
		const origin = location.origin;
		const phasesUrl = `${origin}/dedalo/core/area_maintenance/widgets/update_code/js/update_code_phases.js`;
		const renderUrl = `${origin}/dedalo/core/area_maintenance/widgets/update_code/js/render_update_code.js`;
		const mod = await import(phasesUrl);
		const renderSrc = await (await fetch(renderUrl)).text();
		// THE frame the panel misjudged as failure:
		const terminalDoneFrame = {
			pid: null,
			pfile: 'update_code_probe.json',
			is_running: false,
			data: {
				msg: 'OK. Installed Dédalo 7.0.2 (clean). Restarting to load the new code.',
				ok: true,
				request_id: 'ui-proof',
				data: { version: '7.0.2' },
			},
			errors: [],
			total_time: 6104,
		};
		const frozenState = mod.init_phase_state('7.0.2');
		const ending = mod.resolve_final_frame(frozenState, terminalDoneFrame);
		return {
			ending,
			renderWired:
				renderSrc.includes('resolve_final_frame(state, final_frame)') &&
				renderSrc.includes("ending.outcome==='updated'"),
		};
	});
	console.log('[ui] served-module verdict:', JSON.stringify(verdict));
	if (verdict.ending?.outcome !== 'updated') {
		throw new Error(`served module did not classify success: ${JSON.stringify(verdict.ending)}`);
	}
	if (verdict.renderWired !== true) {
		throw new Error('served renderer is not wired to resolve_final_frame');
	}

	await page.screenshot({ path: '../update_probe/ui_proof_home.png' });
	console.log(
		'[ui] PASS — the museum serves the fixed classifier and renderer; screenshots in ../update_probe/',
	);
} finally {
	await browser.close();
}
