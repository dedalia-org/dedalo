/**
 * CONFIG CATALOG — domain: error_report
 *
 * GENERATED SCAFFOLD (probe_emit_catalog.ts). Hand-edit from here on.
 */

import type { CatalogEntry } from '../catalog_types.ts';

export const ERROR_REPORT_KEYS = {
	DEDALO_ERROR_REPORT_EMAIL: {
		type: 'string',
		scope: 'operator',
		default: undefined,
		heading: 'Error reports: recipient address',
		typeLabel: 'string',
		doc: `The email address this installation's error reports are sent to (normally the
Dédalo maintainers' reporting mailbox). Global administrators get a report button on every
page, from which they can describe a problem and send it — together with the page context,
any JavaScript errors captured since the page loaded and an optional screenshot. Every
report is first **stored on this installation** (the *Error reports* panel of the
maintenance dashboard lists them); when this key is set it is then emailed through the
configured mailer (\`DEDALO_SMTP_*\`). Nothing ever leaves the machine without that
explicit click.

Unset (the default) keeps reports on this installation only. Reports can contain user
ids, page addresses, error stacks and screenshots, and an email may cross third-party mail
servers — set it only if your institution agrees to send them off-site.

\`\`\`bash
DEDALO_ERROR_REPORT_EMAIL="reports@example.org"
\`\`\``,
	},
	DEDALO_ERROR_REPORT_MASTER_URL: {
		type: 'string',
		scope: 'operator',
		// Retired 2026-11-19 (email transport): the HTTP relay is gone. The only reader
		// is the boot warning (warnRetiredErrorReportKeys).
		default: undefined,
		heading: 'Error reports: master installation URL (retired)',
		typeLabel: 'string',
		typeSuffix: '*no longer consulted*',
		doc: `**Not honoured by the engine.** Reports are no longer relayed over HTTP to a master
installation; they are stored locally and emailed to \`DEDALO_ERROR_REPORT_EMAIL\`. The key
is still parsed, but only to log a boot warning. Remove the line and set
\`DEDALO_ERROR_REPORT_EMAIL\` instead.

\`\`\`bash
DEDALO_ERROR_REPORT_MASTER_URL="https://master.example.org/dedalo/core/api/v1/json/"
\`\`\``,
	},
	DEDALO_ERROR_REPORT_RECEIVER: {
		type: 'boolean',
		scope: 'operator',
		// Retired 2026-11-19 (email transport): the pre-auth intake is gone. The only
		// reader is the boot warning (warnRetiredErrorReportKeys).
		default: false,
		heading: 'Error reports: act as the receiver (retired)',
		typeLabel: 'bool',
		typeSuffix: '*no longer consulted*',
		doc: `**Not honoured by the engine.** No installation receives reports from another over
HTTP any more (reports travel by email to \`DEDALO_ERROR_REPORT_EMAIL\`). The key is still
parsed, but only to log a boot warning. Remove the line.

\`\`\`bash
DEDALO_ERROR_REPORT_RECEIVER=true
\`\`\``,
	},
	DEDALO_ERROR_REPORT_RETENTION_DAYS: {
		type: 'number',
		scope: 'operator',
		default: 90,
		heading: 'Error reports: retention',
		typeLabel: 'int',
		doc: `Reports stored on this installation older than this many days are
pruned. Default \`90\`; \`0\` keeps them forever.

Reports are user-written text and can quote record data, so a bounded retention is the
recommended posture — shorten it if your institution's data-protection policy asks for it.

\`\`\`bash
DEDALO_ERROR_REPORT_RETENTION_DAYS=90
\`\`\``,
	},
	DEDALO_ERROR_REPORT_MAX_ROWS: {
		type: 'number',
		scope: 'operator',
		default: 100000,
		heading: 'Error reports: stored row ceiling',
		typeLabel: 'int',
		doc: `The highest number of reports this installation's store may hold.
Each report may carry an inline screenshot of a few hundred kilobytes. When the store is
over this ceiling the OLDEST reports are dropped until it is under it again — eviction,
not refusal, so a new report is never lost to an old one. Default \`100000\`; \`0\` removes the ceiling.

\`\`\`bash
DEDALO_ERROR_REPORT_MAX_ROWS=100000
\`\`\``,
	},
} as const satisfies Record<string, CatalogEntry>;
