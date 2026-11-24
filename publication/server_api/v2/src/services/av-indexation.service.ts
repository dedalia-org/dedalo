/**
 * Resolving an INDEXATION LOCATOR to a playable audiovisual fragment.
 *
 * This is the endpoint a thesaurus-driven front end lives on. In Dédalo, indexing an
 * interview means tagging a stretch of its transcription with a thesaurus term; what the
 * publication stores is a locator — `{section_id, section_tipo, component_tipo, tag_id,
 * tc_in, tc_out}` — that pins one term to one timed passage of one record. A client
 * browsing the thesaurus holds locators and nothing else, and asks this service to turn
 * one into something a user can watch and read.
 *
 * Assembling the answer means reaching across the published schema: the interview row
 * carries the transcription, the media row carries the video file, the speaker row carries
 * who is talking, and the thesaurus tables carry the terms indexed at that same tag. Hence
 * a three-table LEFT JOIN plus a separate terms lookup — LEFT because a fragment is still
 * worth serving when the media or the speaker was not published.
 *
 * Contrast search.service's `avFragments`, which SEARCHES a record's transcription for
 * words. Here nothing is searched: the locator already says which passage, and the work is
 * cutting it out (extractTranscriptionFragment) and dressing it with terms and media URLs.
 */

import { dbExecute } from '../db/pool';
import { avSchema, config } from '../config';
import { NotFoundError, ValidationError, isMissingTableOrColumnError } from '../errors';
import { COLUMNS } from '../constants';
import { parseJsonStrings } from '../utils/parse-json';
import type { Locator, AvIndexationFragment, Speaker } from '../db/types';
import type { DbRow } from '../db/types';

// The AV join shape is configured (AV_* env keys), not hardcoded: a project that
// published under other table/column names points them at its own. Every value is
// boot-validated as a plain SQL identifier (src/config.ts), which is what makes it
// safe to interpolate here — table names cannot be bound as parameters.
export async function getAvIndexationFragment(db: string, locator: Locator): Promise<AvIndexationFragment> {
  const { section_id, section_tipo, component_tipo, tag_id, tc_in = 0, tc_out = 0 } = locator;

  const sql = `
    SELECT
      i.${COLUMNS.SECTION_ID},
      i.${COLUMNS.CODE},
      i.${COLUMNS.TITLE},
      i.${avSchema.transcriptionColumn} as transcription,
      a.${avSchema.videoColumn} as video,
      a.${COLUMNS.IMAGE},
      inf.${COLUMNS.NAME},
      inf.${COLUMNS.SURNAME}
    FROM ${avSchema.table} i
    LEFT JOIN ${avSchema.mediaTable} a ON i.${COLUMNS.SECTION_ID} = a.${COLUMNS.SECTION_ID}
    LEFT JOIN ${avSchema.speakerTable} inf ON i.${COLUMNS.SECTION_ID} = inf.${COLUMNS.SECTION_ID}
    WHERE i.${COLUMNS.SECTION_ID} = ?
  `;

  const rows = await dbExecute<DbRow[]>(db, sql, [section_id]).catch(error => {
    if (isMissingTableOrColumnError(error)) {
      throw new ValidationError(
        `AV indexation is not available on this database: "${avSchema.table}", "${avSchema.mediaTable}" or "${avSchema.speakerTable}" is missing or lacks the AV_* columns (${(error as Error).message})`,
      );
    }
    throw error;
  });

  if (rows.length === 0) {
    throw new NotFoundError(`Record not found for section_id: ${section_id}`);
  }

  const row = parseJsonStrings((rows as Record<string, unknown>[])[0]);
  const transcription = (row.transcription as string) || '';

  const fragmentText = extractTranscriptionFragment(transcription, tc_in, tc_out);

  const videoUrl = row.video
    ? `${config.MEDIA_BASE_URL}/${row.video}?vbegin=${tc_in}&vend=${tc_out}`
    : '';

  const imageUrl = row.image
    ? `${config.MEDIA_BASE_URL}/posterframe/${row.image}`
    : '';

  const speakers: Speaker[] = (row.name || row.surname)
    ? [{ name: `${row.name || ''} ${row.surname || ''}`.trim(), role: 'informant' }]
    : [];

  const terms = await getTermsForLocator(db, section_id, component_tipo, tag_id);

  return {
    locator: { section_id, section_tipo, component_tipo, tag_id, tc_in, tc_out },
    transcription: fragmentText,
    media: { video_url: videoUrl, image_url: imageUrl, tc_in, tc_out },
    speakers,
    terms,
  };
}

/**
 * Cut the words spoken during a timecode window out of a whole transcription.
 *
 * A Dédalo transcription is one long text carrying INLINE MARKERS: `[tc-in-out]` opens a
 * timed segment (so a marker PRECEDES the speech it times), and `[page-n-N]` marks page
 * breaks. Nothing in the database indexes those positions — the timeline exists only as
 * text — so mapping a `tc_in`/`tc_out` window onto characters means walking the markers,
 * which is what the scan below does: find the segment whose range covers `tc_in`, keep
 * scanning until a segment reaches `tc_out`, and slice between the two.
 *
 * The markers are then STRIPPED, along with the whitespace their removal leaves behind:
 * the caller asked for a passage to display next to a video, not for Dédalo's annotation
 * syntax. (The `tc_in`/`tc_out` the caller already holds are echoed back in `media`, so
 * nothing is lost by removing them from the prose.)
 *
 * Degradation is toward "everything" rather than "nothing": an unannotated transcription, or
 * a locator that carries no window at all, yields the whole text — a usable answer either way.
 *
 * THIS WAS BROKEN, and the endpoint looked healthy while it was — worth knowing, because the
 * failure was silent rather than loud. The old scan closed the window only `if (fragmentStart
 * > 0)`, so a window opening at the first marker (index 0 — where a transcription that starts
 * with a timecode puts it, and where the default `tc_in = 0` lands) never closed, and the
 * entire remaining transcription came back. For any later window it was worse: the marker that
 * opened the segment was also the one that closed it, so the slice contained nothing but the
 * marker itself, which the strip then removed — and the caller got an EMPTY STRING.
 */
function extractTranscriptionFragment(transcription: string, tcIn: number, tcOut: number): string {
  if (!transcription) return '';

  // No window asked for (a locator carrying no timecodes): the whole transcription is the answer.
  if (!(tcOut > tcIn)) return stripMarkers(transcription);

  const tcPattern = /\[tc-(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\]/g;
  const segments: Array<{ start: number; tcIn: number; tcOut: number }> = [];

  let match: RegExpExecArray | null;
  while ((match = tcPattern.exec(transcription)) !== null) {
    segments.push({ start: match.index, tcIn: parseFloat(match[1]), tcOut: parseFloat(match[2]) });
  }

  // An unannotated transcription has no timeline to cut against — serve it whole.
  if (segments.length === 0) return stripMarkers(transcription);

  const selected: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    // A segment's words run from its own marker to the next marker (or to the end of the text).
    const end = segments[i + 1]?.start ?? transcription.length;

    // OVERLAP, not containment: a caller asking for 12s–18s of a segment timed 10–20 wants that
    // segment's words, even though the window neither contains it nor aligns with it.
    if (segment.tcIn < tcOut && segment.tcOut > tcIn) {
      selected.push(transcription.slice(segment.start, end));
    }
  }

  return stripMarkers(selected.join(' '));
}

/** Strip Dédalo's inline annotation syntax, and the whitespace its removal leaves behind. */
function stripMarkers(text: string): string {
  return text
    .replace(/\[tc-[^\]]+\]/g, '')
    .replace(/\[page-n-\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getTermsForLocator(
  db: string,
  sectionId: number,
  componentTipo?: string,
  tagId?: number,
): Promise<Array<{ term_id: string; term: string }>> {
  if (!componentTipo || !tagId) return [];

  // `indexation` must be selected by the UNION branches, not just filtered on:
  // a derived table only has the columns it projects. (Before, the filter named
  // t.indexation on a subquery that projected term_id/term only — every call
  // raised "unknown column" and the catch below turned it into an empty list,
  // so terms were ALWAYS empty.)
  const union = avSchema.thesaurusTables
    .map(table => `SELECT term_id, term, indexation FROM ${table}`)
    .join('\n        UNION ALL\n        ');

  if (union === '') return [];

  const sql = `
      SELECT DISTINCT t.term_id, t.term
      FROM (
        ${union}
      ) t
      WHERE t.indexation LIKE ?
      LIMIT 10
    `;

  try {
    // The pattern is a bound LIKE parameter, not SQL interpolation
    const pattern = `%"section_id":"${sectionId}"%"tag_id":"${tagId}"%`;
    const rows = await dbExecute<DbRow[]>(db, sql, [pattern]);

    return (rows as Array<{ term_id: string; term: string }>).map(row => ({
      term_id: row.term_id,
      term: row.term,
    }));
  } catch (error) {
    // Best-effort by contract: a publication need not have thesaurus tables at
    // all, and a fragment is still worth serving without its terms. Report it —
    // a silent empty list is exactly how the bug above survived.
    console.warn(
      `[av-indexation] terms lookup failed for section_id ${sectionId} (serving fragment without terms):`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}
