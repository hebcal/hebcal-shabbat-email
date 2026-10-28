import {MysqlDb} from './makedb.js';

/**
 * Candidate selection for shabbat_deactivate.js, shared with
 * metrics_textfile.js so its "eligible" gauge is exactly what the next run
 * would act on.
 *
 * Two rules, because the two kinds of bounce mean different things:
 *
 * - Hard reasons (user_unknown, spam, ...) say the address is bad. A handful of
 *   rows within the window is enough; amzn_abuse is enough on its own.
 *
 * - Soft reasons (over_quota, Transient) say "not right now". A single row
 *   proves nothing, and neither does a pile of rows: one address can collect
 *   hundreds in an hour when something sends to it in a burst. So these are
 *   judged on persistence instead -- distinct ISO weeks with a bounce, spread
 *   over a minimum span, and still bouncing recently. A mailbox that was full
 *   for a month and then cleared out never qualifies; one that has been full
 *   since spring does.
 */

/** Matches the DATEDIFF(...) < 365 window the gauges in metrics_textfile.js use. */
export const BOUNCE_WINDOW_DAYS = 365;

export const HARD_REASONS_DEFAULT = 'amzn_abuse,user_unknown,user_disabled,domain_error,spam';
export const HARD_COUNT_DEFAULT = 7;

export const SOFT_REASONS_DEFAULT = 'over_quota,Transient';
export const SOFT_WEEKS_DEFAULT = 8;
export const SOFT_SPAN_DAYS_DEFAULT = 60;
export const SOFT_RECENT_DAYS_DEFAULT = 30;

export type DeactivateOptions = {
  hardReasons: string[];
  /** A hard reason qualifies at strictly more than this many rows. */
  hardCount: number;
  softReasons: string[];
  /** Minimum distinct ISO weeks with a soft bounce. */
  softWeeks: number;
  /** Minimum days between the first and last soft bounce. */
  softSpanDays: number;
  /** The last soft bounce must be no older than this. */
  softRecentDays: number;
};

export const DEFAULT_OPTIONS: DeactivateOptions = {
  hardReasons: HARD_REASONS_DEFAULT.split(','),
  hardCount: HARD_COUNT_DEFAULT,
  softReasons: SOFT_REASONS_DEFAULT.split(','),
  softWeeks: SOFT_WEEKS_DEFAULT,
  softSpanDays: SOFT_SPAN_DAYS_DEFAULT,
  softRecentDays: SOFT_RECENT_DAYS_DEFAULT,
};

export type HardRow = {email_address: string; std_reason: string; count: number};
export type SoftRow = {
  email_address: string;
  std_reason: string;
  weeks: number;
  span_days: number;
  days_since_last: number;
};

/**
 * Returns the addresses to deactivate, mapped to the bounce reason that tripped
 * the threshold. An address can qualify under several std_reason values;
 * keeping only the first (hard reasons before soft) means summing
 * hebcal_email_deactivated_total over `reason` gives the number of addresses
 * deactivated, not the number of (address, reason) pairs.
 */
export function selectCandidates(
  hardRows: HardRow[],
  softRows: SoftRow[],
  opts: DeactivateOptions
): Map<string, string> {
  const addrs = new Map<string, string>();
  for (const row of hardRows) {
    if (Number(row.count) > opts.hardCount || row.std_reason === 'amzn_abuse') {
      if (!addrs.has(row.email_address)) {
        addrs.set(row.email_address, row.std_reason);
      }
    }
  }
  for (const row of softRows) {
    if (
      Number(row.weeks) >= opts.softWeeks &&
      Number(row.span_days) >= opts.softSpanDays &&
      Number(row.days_since_last) <= opts.softRecentDays
    ) {
      if (!addrs.has(row.email_address)) {
        addrs.set(row.email_address, row.std_reason);
      }
    }
  }
  return addrs;
}

const HARD_SQL = `SELECT email_address, std_reason, COUNT(*) AS count
FROM hebcal_shabbat_bounce
WHERE deactivated = 0
AND std_reason IN (?)
AND DATEDIFF(NOW(), timestamp) < ${BOUNCE_WINDOW_DAYS}
GROUP BY email_address, std_reason`;

const SOFT_SQL = `SELECT email_address, std_reason,
COUNT(DISTINCT YEARWEEK(timestamp, 3)) AS weeks,
DATEDIFF(MAX(timestamp), MIN(timestamp)) AS span_days,
DATEDIFF(NOW(), MAX(timestamp)) AS days_since_last
FROM hebcal_shabbat_bounce
WHERE deactivated = 0
AND std_reason IN (?)
AND DATEDIFF(NOW(), timestamp) < ${BOUNCE_WINDOW_DAYS}
GROUP BY email_address, std_reason`;

/** Runs both scans and applies {@link selectCandidates}. */
export async function getCandidates(
  db: MysqlDb,
  opts: DeactivateOptions
): Promise<Map<string, string>> {
  // `IN (?)` with an empty array is a syntax error, and an empty list means
  // that rule is switched off.
  const hardRows = opts.hardReasons.length
    ? ((await db.query(HARD_SQL, [opts.hardReasons])) as unknown as HardRow[])
    : [];
  const softRows = opts.softReasons.length
    ? ((await db.query(SOFT_SQL, [opts.softReasons])) as unknown as SoftRow[])
    : [];
  return selectCandidates(hardRows, softRows, opts);
}

/** Splits a comma-separated --reasons style argument; '' or 'none' disables. */
export function parseReasons(arg: string | undefined, dflt: string): string[] {
  const s = arg ?? dflt;
  if (s === '' || s === 'none') {
    return [];
  }
  return s
    .split(',')
    .map(r => r.trim())
    .filter(Boolean);
}
