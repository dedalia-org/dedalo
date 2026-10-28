/**
 * The feature crawl's human report (`bun run test:crawl --out <dir>` writes it as
 * crawl_report.html beside crawl_report.json): findings grouped persona → section,
 * each with its verdict (red / known) and its screenshot when one was taken.
 * Self-contained HTML, no script, no external asset.
 */

export interface ReportFinding {
	id: string;
	detail: string;
	known: boolean;
	shot: string | null;
}

const esc = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function renderCrawlReport(
	findings: ReportFinding[],
	summary: {
		personas: number;
		pages: number;
		checks: number;
		red: number;
		posture: Record<string, number>;
	},
): string {
	const byPersona = new Map<string, ReportFinding[]>();
	for (const f of findings) {
		const persona = f.id.split(':')[0] ?? '?';
		byPersona.set(persona, [...(byPersona.get(persona) ?? []), f]);
	}
	const sections = [...byPersona]
		.map(
			([persona, list]) =>
				`<h2>${esc(persona)} <small>${list.length} finding(s)</small></h2><ul>${list
					.sort((a, b) => a.id.localeCompare(b.id))
					.map(
						(f) =>
							`<li class="${f.known ? 'known' : 'red'}"><code>${esc(f.id.slice(persona.length + 1))}</code> <span>${f.known ? 'known' : 'RED'}</span><div>${esc(f.detail)}</div>${f.shot ? `<a href="${esc(f.shot)}"><img src="${esc(f.shot)}" alt="screenshot of ${esc(f.id)}" loading="lazy"></a>` : ''}</li>`,
					)
					.join('')}</ul>`,
		)
		.join('');
	const posture = Object.entries(summary.posture)
		.sort()
		.map(([rule, pages]) => `<tr><td><code>${esc(rule)}</code></td><td>${pages}</td></tr>`)
		.join('');
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Feature crawl report</title><style>
body{font:15px/1.45 system-ui,sans-serif;margin:16px;max-width:1100px;color:#222;background:#fff}
@media (prefers-color-scheme:dark){body{color:#ddd;background:#161616}}
li{margin:.6em 0;padding:.4em .6em;border-left:4px solid #999;list-style:none}li.red{border-color:#c62828}li.known{border-color:#9e9e9e;opacity:.8}
li span{font-weight:600}li.red span{color:#c62828}img{display:block;max-width:100%;max-height:240px;margin-top:.4em;border:1px solid #8884}
ul{padding:0}table{border-collapse:collapse}td{padding:.2em .8em .2em 0}code{overflow-wrap:anywhere}
</style></head><body><h1>Feature crawl</h1><p>${summary.personas} personas · ${summary.pages} pages · ${summary.checks} checks · <strong>${summary.red} red</strong></p>${posture ? `<h2>Page posture (pages per rule)</h2><table>${posture}</table>` : ''}${sections || '<p>No findings.</p>'}</body></html>
`;
}
