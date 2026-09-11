import pino from 'pino';
import {parseArgs} from 'node:util';
import {makeDb, MysqlDb} from './makedb.js';
import {getLogLevel, readIniConfig} from './common.js';
import {Metrics} from './metrics.js';

/**
 * metrics_textfile.js -- refreshes the current-state gauges that no cron job is
 * in a position to report.
 *
 * The other five scripts each record what *they* did, but the numbers an
 * operator actually looks at first -- how many people are subscribed right now,
 * how big the un-actioned bounce backlog is -- are properties of the database,
 * not of any one run. The weekly newsletter is the only job that reads the
 * subscriber table in bulk, and it runs once a week, so leaving these to it
 * would give a sawtooth updated every seventh day.
 *
 * So this runs from a systemd timer instead (every 15 minutes; see
 * hebcal-devops etc/systemd/system/hebcal-email-metrics.timer). It is also what
 * guarantees hebcal_email.prom exists at all after a rebuild, without waiting
 * for a mailing day.
 *
 * Every gauge is seeded to zero across its full label domain before the query
 * result is applied. A `GROUP BY` returns no row for a status with no rows
 * behind it, and without the seed the gauge would simply keep the last non-zero
 * value it ever had -- the subscriber count for a status that dropped to zero
 * would stay frozen at its old number forever.
 */

const PROG = 'metrics_textfile.js';

/** email_status values in hebcal_shabbat_email. */
const SHABBAT_STATUSES = ['active', 'pending', 'unsubscribed', 'bounce'];

/** sub_status values in yahrzeit_email (note: `unsub`, not `unsubscribed`). */
const YAHRZEIT_STATUSES = ['active', 'pending', 'unsub', 'bounce'];

/** The hebcal_shabbat_bounce.std_reason enum, plus our name for a NULL. */
const BOUNCE_REASONS = [
  'Transient',
  'over_quota',
  'spam',
  'unknown',
  'user_disabled',
  'user_unknown',
  'amzn_abuse',
  'domain_error',
  'unset',
];

/** Matches the DATEDIFF(...) < 365 window shabbat_deactivate.js scans. */
const BOUNCE_WINDOW_DAYS = 365;

const {values: argv} = parseArgs({
  options: {
    quiet: {type: 'boolean', short: 'q'},
    help: {type: 'boolean', short: 'h'},
    verbose: {type: 'boolean', short: 'v'},
    ini: {type: 'string'},
  },
});

if (argv.help) {
  usage();
  process.exit(1);
}

const logger = pino({
  level: getLogLevel(argv),
});
const config = readIniConfig(argv.ini);
const metrics = new Metrics('metrics_textfile', {logger});

async function main() {
  const db = makeDb(logger, config);
  try {
    await subscriberGauges(db, 'shabbat', 'hebcal_shabbat_email', 'email_status', SHABBAT_STATUSES);
    await subscriberGauges(db, 'yahrzeit', 'yahrzeit_email', 'sub_status', YAHRZEIT_STATUSES);
    await bounceGauges(db);
  } finally {
    await db.close();
  }
}

/** One `GROUP BY status` per list, seeded to zero over the known statuses. */
async function subscriberGauges(
  db: MysqlDb,
  list: string,
  table: string,
  column: string,
  statuses: string[]
) {
  for (const status of statuses) {
    metrics.setGauge('hebcal_email_subscribers', {list, status}, 0);
  }
  const sql = `SELECT ${column} AS status, COUNT(*) AS cnt FROM ${table} GROUP BY ${column}`;
  logger.debug(sql);
  const rows = await db.query(sql);
  for (const row of rows) {
    const status = row.status === null ? 'unset' : String(row.status);
    if (!statuses.includes(status)) {
      // A new enum value landed in the schema without this list being updated.
      // Export it anyway -- a status nobody is counting is worse than an
      // unseeded label -- but say so, because it will not zero out cleanly.
      logger.warn(`${table}.${column}: unexpected value ${status}, add it to ${PROG}`);
    }
    metrics.setGauge('hebcal_email_subscribers', {list, status}, Number(row.cnt));
    logger.debug(`${list}/${status}: ${row.cnt}`);
  }
}

/**
 * Table size, plus the un-actioned backlog by reason. The second query is the
 * same scan shabbat_deactivate.js does twice a week, so this gauge is a live
 * preview of what its next run will find.
 */
async function bounceGauges(db: MysqlDb) {
  const totalRows = await db.query('SELECT COUNT(*) AS cnt FROM hebcal_shabbat_bounce');
  metrics.setGauge('hebcal_email_bounce_table_rows', {}, Number(totalRows[0].cnt));

  for (const reason of BOUNCE_REASONS) {
    metrics.setGauge('hebcal_email_bounces_pending_deactivation', {reason}, 0);
  }
  const sql = `SELECT COALESCE(std_reason, 'unset') AS reason, COUNT(*) AS cnt
FROM hebcal_shabbat_bounce
WHERE deactivated = 0
AND DATEDIFF(NOW(), timestamp) < ${BOUNCE_WINDOW_DAYS}
GROUP BY reason`;
  logger.debug(sql);
  const rows = await db.query(sql);
  for (const row of rows) {
    metrics.setGauge(
      'hebcal_email_bounces_pending_deactivation',
      {reason: String(row.reason)},
      Number(row.cnt)
    );
  }
}

function usage() {
  const usage = `Usage:
    ${PROG} [options]

Queries MySQL for the current subscriber and bounce-backlog counts and refreshes
the node_exporter textfile collector's hebcal_email.prom. Run from a systemd
timer, not from cron.

Options:
  --help           Help
  --quiet          Quiet mode
  --verbose        Verbose mode
  --ini <file>     Use <file> for config (default /etc/hebcal-dot-com.ini)
`;
  console.log(usage);
}

try {
  await main();
  metrics.finish('success');
  logger.info('Success!');
} catch (err) {
  logger.fatal(err);
  metrics.finish('failure');
  process.exit(1);
}
