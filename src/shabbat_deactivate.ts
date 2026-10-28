import fs from 'node:fs';
import pino from 'pino';
import {parseArgs} from 'node:util';
import {LOGDIR, makeDb, dirIfExistsOrCwd, MysqlDb} from './makedb.js';
import {Metrics} from './metrics.js';
import {getLogLevel, readIniConfig} from './common.js';
import {
  DeactivateOptions,
  getCandidates,
  parseReasons,
  HARD_COUNT_DEFAULT,
  HARD_REASONS_DEFAULT,
  SOFT_REASONS_DEFAULT,
  SOFT_RECENT_DAYS_DEFAULT,
  SOFT_SPAN_DAYS_DEFAULT,
  SOFT_WEEKS_DEFAULT,
} from './deactivate.js';

const PROG = 'shabbat_deactivate.js';

const {values: argv} = parseArgs({
  options: {
    dryrun: {type: 'boolean', short: 'n'},
    quiet: {type: 'boolean', short: 'q'},
    help: {type: 'boolean', short: 'h'},
    verbose: {type: 'boolean', short: 'v'},
    ini: {type: 'string'},
    reasons: {type: 'string'},
    count: {type: 'string'},
    'soft-reasons': {type: 'string'},
    'soft-weeks': {type: 'string'},
    'soft-span-days': {type: 'string'},
    'soft-recent-days': {type: 'string'},
  },
});
if (argv.help) {
  usage();
  process.exit(1);
}
function intArg(arg: string | undefined, dflt: number): number {
  return arg ? Number.parseInt(arg, 10) : dflt;
}
const opts: DeactivateOptions = {
  hardReasons: parseReasons(argv.reasons, HARD_REASONS_DEFAULT),
  hardCount: intArg(argv.count, HARD_COUNT_DEFAULT),
  softReasons: parseReasons(argv['soft-reasons'], SOFT_REASONS_DEFAULT),
  softWeeks: intArg(argv['soft-weeks'], SOFT_WEEKS_DEFAULT),
  softSpanDays: intArg(argv['soft-span-days'], SOFT_SPAN_DAYS_DEFAULT),
  softRecentDays: intArg(argv['soft-recent-days'], SOFT_RECENT_DAYS_DEFAULT),
};

const logger = pino({
  level: getLogLevel(argv),
});
const config = readIniConfig(argv.ini);
const metrics = new Metrics('shabbat_deactivate', {logger, enabled: !argv.dryrun});
let logdir: string;

async function main() {
  const db = makeDb(logger, config);
  logdir = await dirIfExistsOrCwd(LOGDIR);
  logger.debug(opts);
  const candidates = await getCandidates(db, opts);
  if (!argv.quiet) {
    for (const [addr, reason] of candidates) {
      logger.info(`${addr} (${reason})`);
    }
  }
  const addrs = Array.from(candidates.keys());
  logger.info(`Deactivating ${addrs.length} subscriptions`);
  metrics.setGauge('hebcal_email_deactivate_candidates', {}, addrs.length);
  for (const reason of candidates.values()) {
    metrics.inc('hebcal_email_deactivated_total', {reason});
  }
  if (!argv.dryrun && addrs.length) {
    await deactivateSubs(db, addrs);
  }
  return db.close();
}

async function deactivateSubs(db: MysqlDb, addrs: string[]) {
  await db.query(`UPDATE yahrzeit_email SET sub_status='bounce' WHERE email_addr IN (?)`, [addrs]);
  await db.query(
    `UPDATE hebcal_shabbat_email SET email_status='bounce' WHERE email_address IN (?)`,
    [addrs]
  );
  // hebcal_shabbat_bounce.timestamp is ON UPDATE CURRENT_TIMESTAMP; without
  // the explicit self-assignment this would overwrite when each bounce
  // happened with when it was actioned, which the 365-day window and the
  // data-retention purge both read.
  await db.query(
    `UPDATE hebcal_shabbat_bounce SET deactivated=1, timestamp=timestamp WHERE email_address IN (?)`,
    [addrs]
  );
  return new Promise((resolve, reject) => {
    const currentMonth = new Date().toISOString().substring(0, 7);
    const subsPath = logdir + '/subscribers-' + currentMonth + '.log';
    const t = Math.floor(Date.now() / 1000);
    try {
      const logStream = fs.createWriteStream(subsPath, {flags: 'a'});
      addrs.forEach((addr: string) => {
        const logMessage = {
          time: t,
          status: 1,
          to: addr,
          code: 'deactivated',
        };
        logStream.write(JSON.stringify(logMessage));
        logStream.write('\n');
      });
      logStream.end();
      return resolve(true);
    } catch (err) {
      return reject(err);
    }
  });
}

function usage() {
  const usage = `Usage:
    ${PROG} [options]

Options:
  --help         Help
  --dryrun       Prints the actions that ${PROG} would take
                  but does not remove anything
  --quiet        Quiet mode (do not print commands)
  --count <n>    Hard-bounce threshold: more than <n> bounces (default ${HARD_COUNT_DEFAULT})
  --reasons <r>  Comma-separated hard-bounce reasons, or 'none'
                  (default ${HARD_REASONS_DEFAULT})
  --soft-reasons <r>      Comma-separated soft-bounce reasons, or 'none'
                           (default ${SOFT_REASONS_DEFAULT})
  --soft-weeks <n>        Soft bounces in at least <n> distinct weeks (default ${SOFT_WEEKS_DEFAULT})
  --soft-span-days <n>    ...spanning at least <n> days (default ${SOFT_SPAN_DAYS_DEFAULT})
  --soft-recent-days <n>  ...the latest within <n> days (default ${SOFT_RECENT_DAYS_DEFAULT})
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
