// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* REQUEST_BUDGETS
* How long one attempt of a readOnly action may take. Such an action is sent
* once (`retries: 1`: never ledgered, a resend would re-run it), so its single
* attempt needs the whole window the five 5 s attempts used to give it.
*
* @module request_budgets
*/



/** A third-party lookup: the server's own fetch deadline (15 s, plus the
* harvest door's robots.txt and pacing) with room to answer. */
export const LOOKUP_TIMEOUT_MS = 30 * 1000

/** A GDAL conversion: up to two binary runs of 60 s each (server/gdal.ts). */
export const CONVERSION_TIMEOUT_MS = 2 * 60 * 1000



// @license-end
