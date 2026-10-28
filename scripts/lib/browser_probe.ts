/**
 * BROWSER PROBE — the page-watching pieces scripts/feature_crawl.ts (test:crawl)
 * and scripts/tool_viewport_check.ts (test:tools:phone) share: the dialog guard,
 * the uncaught-error and console-error listeners, the API `ok:false` listener and
 * the network settle. Each script keeps its own verdict; this is only how a page
 * is observed.
 */

import type { HTTPResponse, Page } from 'puppeteer';

/** A blocking alert/confirm freezes CDP (every later call times out): answer it at once. */
export function guardDialogs(page: Page, accept = false): void {
	page.on('dialog', (dialog) => {
		void (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
	});
}

/** Uncaught page errors — a verdict for both scripts. `stack` keeps the trace. */
export function onPageError(page: Page, sink: (text: string) => void, stack = false): void {
	page.on('pageerror', (err) => {
		const e = err as Error;
		sink(String((stack ? e.stack : e.message) ?? err));
	});
}

/** console.error lines (INFO, not a verdict), with the script location when known. */
export function onConsoleError(page: Page, sink: (text: string, where: string) => void): void {
	page.on('console', (msg) => {
		if (msg.type() !== 'error') return;
		const at = msg.stackTrace()[0];
		const where = at?.url ? ` @ ${at.url.replace(/^.*\/dedalo\//, '')}:${at.lineNumber}` : '';
		sink(msg.text().slice(0, 200), where);
	});
}

/** Every JSON API answer with `ok:false`, named by its action and target. */
export function onApiFailure(
	page: Page,
	origin: string,
	sink: (failure: { url: string; code: string }) => void,
): void {
	page.on('response', (res: HTTPResponse) => {
		if (!res.url().includes('/api/') || !(res.headers()['content-type'] ?? '').includes('json'))
			return;
		void res
			.json()
			.then((body: { ok?: boolean; error?: { code?: string } }) => {
				if (body?.ok !== false) return;
				let what = res.url().replace(origin, '');
				try {
					const rqo = JSON.parse(res.request().postData() ?? '{}');
					what = `${rqo.action ?? '?'} ${rqo.source?.model ?? ''} ${rqo.source?.section_tipo ?? ''}/${rqo.source?.tipo ?? ''}${rqo.source?.section_id ? `/${rqo.source.section_id}` : ''}`;
				} catch {}
				sink({ url: what, code: body.error?.code ?? 'unknown' });
			})
			.catch(() => {});
	});
}

/** Wait until the page's network has been idle for `idleMs` (bounded, never throws). */
export async function settle(page: Page, idleMs = 500, timeoutMs = 20_000): Promise<void> {
	await page.waitForNetworkIdle({ idleTime: idleMs, timeout: timeoutMs }).catch(() => {});
}
