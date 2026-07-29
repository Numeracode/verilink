// control-plane/src/domains/sync/parseLastEventId.ts
/** Decision 15: raw-string Last-Event-ID / last_event_id parsing. */

export type ParseLastEventIdOk = { ok: true; value: bigint };
export type ParseLastEventIdErr = { ok: false; message: string };
export type ParseLastEventIdResult = ParseLastEventIdOk | ParseLastEventIdErr;

export interface LastEventIdInputs {
  /** Raw Last-Event-ID header value; undefined if header absent. */
  header?: string | string[];
  /** Raw ?last_event_id= value; undefined if query key absent. */
  query?: string | string[];
  /** True when the query parameter key is present (even if blank). */
  queryKeyPresent?: boolean;
  /** True when the Last-Event-ID header key is present (even if blank). */
  headerPresent?: boolean;
}

function firstString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function parseNonNegativeInteger(raw: string): ParseLastEventIdResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'last_event_id must not be blank' };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, message: 'last_event_id must be a non-negative integer' };
  }
  try {
    return { ok: true, value: BigInt(trimmed) };
  } catch {
    return { ok: false, message: 'last_event_id is out of range' };
  }
}

/**
 * Header wins when present (including blank). Omitted both → 0.
 * Supplied-but-blank → error.
 */
export function parseLastEventId(input: LastEventIdInputs): ParseLastEventIdResult {
  const headerPresent =
    input.headerPresent ?? input.header !== undefined;
  const queryPresent =
    input.queryKeyPresent ?? input.query !== undefined;

  if (headerPresent) {
    const h = firstString(input.header);
    if (h === undefined || h.trim().length === 0) {
      return { ok: false, message: 'Last-Event-ID must not be blank' };
    }
    return parseNonNegativeInteger(h);
  }

  if (queryPresent) {
    const q = firstString(input.query);
    if (q === undefined || q.trim().length === 0) {
      return { ok: false, message: 'last_event_id must not be blank' };
    }
    return parseNonNegativeInteger(q);
  }

  return { ok: true, value: 0n };
}
