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



/** A third-party lookup: the slowest the server makes (Catastro's two calls
* through core's geo services, or the harvest door's robots.txt then the fetch,
* each after its wait for a slot) with room to answer. Not past data_manager's
* LONG_WAIT_TIMEOUT_MS, which would turn the busy cue off. */
export const LOOKUP_TIMEOUT_MS = 60 * 1000

/** A GDAL conversion: up to two binary runs of 60 s each (server/gdal.ts), and
* the wait for a converter slot (core's queue, 120 s by default). */
export const CONVERSION_TIMEOUT_MS = 5 * 60 * 1000

/** A vector upload: up to three binary runs (the file's CRS probe, the typed
* projection's lookup, the conversion itself), each bounded at 60 s. */
export const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000



// @license-end
