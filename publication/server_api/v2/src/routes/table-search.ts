/**
 * `GET /:db/tables/:table/search?q=` — relevance search over one text column.
 *
 * This is MariaDB FULLTEXT, not a LIKE scan: `MATCH(col) AGAINST(? IN BOOLEAN
 * MODE)`, ordered by descending relevance, with the score exposed to the client
 * as a `relevance` field on each row. Boolean mode means `q` is a query
 * LANGUAGE (`+must`, `-not`, `"phrase"`) rather than a literal string — which
 * is the sharp edge against the fragment routes, where `terms` is matched
 * literally. The two are not interchangeable.
 *
 * The search column is a client parameter (`?column=`, default `transcription`)
 * because which column is worth indexing is a per-publication decision. It must
 * exist AND carry a FULLTEXT index; both failures are the CLIENT's problem and
 * come back as a 400 (the service translates MariaDB errno 1191 rather than
 * letting it escape as a 500).
 *
 * Rows also carry `fragments` — highlighted excerpts — but with a FIXED window
 * (320 chars, 3 occurrences) that no query parameter can tune. Tuning is what
 * the per-record fragments route is for.
 *
 * Envelope and pagination are the same as the record list (data + pagination +
 * an RFC 8288 `Link` header), so a client can page search hits with the same
 * code it pages records.
 */

import { assertKnownDb } from '../db/pool';
import { fulltextSearch } from '../services/search.service';
import { fulltextQuerySchema } from '../validators';
import { buildLinkHeader } from '../utils/links';
import { json } from '../utils/response';

export async function handleTableSearch(_req: Request, params: Record<string, string>, url: URL): Promise<Response> {
  const db = assertKnownDb(params.db);
  const query = fulltextQuerySchema.parse(Object.fromEntries(url.searchParams));

  const { rows, total } = await fulltextSearch(db, params.table, {
    q: query.q,
    column: query.column,
    lang: query.lang,
    limit: query.limit,
    offset: query.offset,
    withTotal: query.count,
    resolve_relations: query.resolve_relations,
    resolve_inverse_relations: query.resolve_inverse_relations,
  });

  // Same pagination contract as the record list — deliberately, so a client
  // pages hits and rows with one implementation.
  const headers: Record<string, string> = {};
  const link = buildLinkHeader(url, query.limit, query.offset, rows.length, total);
  if (link) headers['Link'] = link;

  return json({
    data: rows,
    pagination: {
      limit: query.limit,
      offset: query.offset,
      ...(total !== undefined ? { total } : {}),
    },
  }, 200, headers);
}
