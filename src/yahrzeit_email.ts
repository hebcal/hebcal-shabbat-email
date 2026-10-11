import dayjs from 'dayjs';
import pino from 'pino';
import {parseArgs} from 'node:util';
import nodemailer from 'nodemailer';
import type {SendMailOptions, Transporter} from 'nodemailer';
import {makeDb, MysqlDb} from './makedb.js';
import {Metrics} from './metrics.js';
import {
  getLogLevel,
  getChagOnDate,
  makeTransporter,
  htmlToTextOptions,
  msleep,
  readIniConfig,
} from './common.js';
import {
  computeAnniversary,
  getMaxYahrzeitId,
  getThisHebrewYear,
  getYahrzeitDetailForId,
  makeMessage,
  RawYahrzeitContents,
  SubBase,
  SubInfo,
} from './anniversary.js';
import {htmlToText} from 'nodemailer-html-to-text';
import {RowDataPacket} from 'mysql2';

const {values: argv} = parseArgs({
  options: {
    dryrun: {type: 'boolean', short: 'n'},
    quiet: {type: 'boolean', short: 'q'},
    help: {type: 'boolean', short: 'h'},
    force: {type: 'boolean', short: 'f'},
    verbose: {type: 'boolean', short: 'v'},
    localhost: {type: 'boolean'},
    email: {type: 'string'},
    ini: {type: 'string'},
    date: {type: 'string'},
    sleeptime: {type: 'string'},
  },
});
if (argv.help) {
  usage();
  process.exit(1);
}

// allow sleeptime=0 for no sleep
const sleeptime = argv.sleeptime === undefined ? 300 : +argv.sleeptime;

const logger = pino({
  level: getLogLevel(argv),
});

// --dryrun reports a synthetic 250 for every message, so its counts would be
// fiction in the durable totals.
const metrics = new Metrics('yahrzeit_email', {logger, enabled: !argv.dryrun});

let transporter: Transporter;
let db: MysqlDb;

const today = dayjs(argv.date); // undefined => new Date()
logger.debug(`Today is ${today.format('dddd')}`);
const chag = getChagOnDate(today);
if ((chag || today.day() === 6) && !argv.force) {
  // Cron fires Sun-Fri; Yom Tov takes days out of that. Counting the skips
  // keeps "did not mail today" distinguishable from "cron stopped running".
  metrics.finish('skipped');
  process.exit(0);
}

let numSent = 0;

/**
 * Sends the message via nodemailer, or no-op for dryrun
 */
async function sendMail(message: SendMailOptions): Promise<unknown> {
  if (argv.dryrun) {
    return {response: '250 OK', messageId: message.messageId, dryrun: true};
  } else {
    return new Promise((resolve, reject) => {
      transporter.sendMail(message, (err, info) => {
        if (err) {
          return reject(err);
        }
        return resolve(info);
      });
    });
  }
}

type StringDateMap = Record<string, Date>;

/**
 * Main event loop
 */
async function main() {
  logger.debug(`Reading ${argv.ini || 'default config'}...`);
  const config = readIniConfig(argv.ini);

  db = makeDb(logger, config);
  if (!argv.dryrun) {
    transporter = argv.localhost
      ? nodemailer.createTransport({host: 'localhost', port: 25})
      : makeTransporter(config);
    transporter.use('compile', htmlToText(htmlToTextOptions));
  }

  let sql = `SELECT e.id, e.email_addr, e.calendar_id, y.contents
FROM yahrzeit_email e, yahrzeit y
WHERE e.sub_status = 'active'
AND e.calendar_id = y.id`;
  const params: string[] = [];
  if (argv.email) {
    sql += ' AND e.email_addr = ?';
    params.push(argv.email);
  }

  logger.debug(sql);
  const rows = await db.query(sql, params);
  // Set before the bail-out below: a sudden zero is exactly the thing worth
  // seeing on the dashboard, and skipping the gauge would leave the previous
  // run's healthy number standing.
  if (!argv.email) {
    metrics.setGauge('hebcal_email_yahrzeit_subscriptions_loaded', {}, rows?.length ?? 0);
  }
  if (!rows?.length) {
    logger.error('Got zero rows from DB!?');
    await db.close();
    return;
  }
  logger.info(`Loaded ${rows.length} active subscriptions from DB`);

  const optout: StringDateMap = await loadOptOut();
  const toSend = await loadSubsFromDb(rows, optout);

  metrics.setGauge('hebcal_email_yahrzeit_reminders_due', {}, toSend.length);
  logger.debug(`Processing ${toSend.length} messages`);
  for (const info of toSend) {
    const status = await processAnniversary(info);
    logger.debug(status);
  }

  const calendarIds0 = toSend.map(info => info.calendarId);
  const calendarIds = Array.from(new Set(calendarIds0));
  logger.info(`Updating access time for ${calendarIds.length} calendars`);
  for (const calendarId of calendarIds) {
    const sql2 = 'REPLACE INTO yahrzeit_atime (id, ts) VALUES (?, NOW())';
    await db.query(sql2, [calendarId]);
  }

  await db.close();
}

/** Shared lookup tables threaded through the per-row anniversary scan. */
type LoadContext = {
  hyears: number[];
  sent7: StringDateMap;
  sent1: StringDateMap;
  optout: StringDateMap;
};

/**
 * For a single entry and Hebrew year, returns the reminder to send (preferring
 * the 7-day reminder over the 1-day), or undefined if none is due.
 */
function findSubInfoForYear(
  contents: RawYahrzeitContents,
  num: number,
  info0: SubBase,
  hyear: number,
  ctx: LoadContext
): SubInfo | undefined {
  for (const ndays of [7, 1]) {
    const sent = ndays === 7 ? ctx.sent7 : ctx.sent1;
    const info = makeSubInfo(contents, num, info0, hyear, sent, ndays);
    if (info) {
      return info;
    }
  }
  return undefined;
}

/** Collects any due reminders for a single anniversary entry across Hebrew years. */
function collectEntry(
  contents: RawYahrzeitContents,
  num: number,
  info0: SubBase,
  ctx: LoadContext,
  toSend: SubInfo[]
): void {
  for (const hyear of ctx.hyears) {
    const info = findSubInfoForYear(contents, num, info0, hyear, ctx);
    if (info) {
      toSend.push(info);
    }
  }
}

/** Collects any due reminders for all anniversary entries in a single DB row. */
function collectRow(row: RowDataPacket, ctx: LoadContext, toSend: SubInfo[]): void {
  const contents: RawYahrzeitContents = row.contents;
  const id = (contents.id = row.id);
  if (ctx.optout[`${id}.0`]) {
    logger.debug(`Skipping global opt-out ${id}`);
    return;
  }
  contents.calendarId = row.calendar_id;
  contents.emailAddress = row.email_addr;
  const maxId = getMaxYahrzeitId(contents);
  logger.trace(`${id} ${contents.emailAddress} ${maxId}`);
  for (let num = 1; num <= maxId; num++) {
    const info0 = getYahrzeitDetailForId(contents, num, logger);
    if (info0 === null) {
      logger.debug(`Skipping blank ${id}.${num}`);
      continue;
    }
    if (skipOptOut(id, info0, ctx.optout)) {
      continue;
    }
    collectEntry(contents, num, info0, ctx, toSend);
  }
}

async function loadSubsFromDb(rows: RowDataPacket[], optout: StringDateMap): Promise<SubInfo[]> {
  const ctx: LoadContext = {
    hyears: getThisHebrewYear(today),
    sent7: await loadRecentSent('yahrzeit_sent7'),
    sent1: await loadRecentSent('yahrzeit_sent1'),
    optout,
  };
  const toSend: SubInfo[] = [];
  for (const row of rows) {
    collectRow(row, ctx, toSend);
  }
  return toSend;
}

function skipOptOut(subscriptionId: string, info: SubBase, optout: StringDateMap) {
  const num = info.num;
  const idNum = `${subscriptionId}.${num}`;
  for (const key of [idNum, `${idNum}.${info.hash}`]) {
    if (optout[key]) {
      logger.debug(`Skipping opt-out ${key}`);
      return true;
    }
  }
  return false;
}

function makeSubInfo(
  contents: RawYahrzeitContents,
  num: number,
  info0: SubBase,
  hyear: number,
  sent: StringDateMap,
  maxDays: number
): SubInfo | false {
  const id = contents.id;
  const idNum = `${id}.${num}`;
  const prefix = `${idNum}.${hyear}`;
  for (const key of [prefix, `${prefix}.${info0.hash}`]) {
    if (sent[key] !== undefined) {
      logger.debug(`Message for ${key} sent on ${sent[key]}`);
      return false;
    }
  }
  const info: SubInfo = {
    id: id as string,
    anniversaryId: `${id}.${hyear}.${info0.hash}.${num}`,
    hyear: hyear,
    calendarId: contents.calendarId as string,
    emailAddress: contents.emailAddress as string,
    reminderDays: maxDays,
    ...info0,
  };
  computeAnniversary(info, today);
  const diff = info.diff!;
  if (info.observed && diff >= 0 && diff < maxDays) {
    return info;
  } else if (info.observed) {
    logger.debug(`${info.type} ${info.anniversaryId} occurs in ${diff} days`);
  } else {
    logger.debug(`No anniversary for ${info.anniversaryId}`);
  }
  return false;
}

async function loadOptOut(): Promise<StringDateMap> {
  const sql = 'SELECT email_id, name_hash, num, updated FROM yahrzeit_optout WHERE deactivated = 1';
  logger.debug(sql);
  const rows = await db.query(sql);
  logger.info(`Loaded ${rows.length} opt_out from DB`);
  metrics.setGauge('hebcal_email_yahrzeit_optout_rules', {}, rows.length);
  const optout: StringDateMap = {};
  for (const row of rows) {
    const key0 = `${row.email_id}.${row.num}`;
    const key = row.name_hash === null ? key0 : key0 + '.' + row.name_hash;
    optout[key] = row.updated;
  }
  return optout;
}

async function loadRecentSent(tableName: string): Promise<StringDateMap> {
  const sql = `SELECT yahrzeit_id, name_hash, num, hyear, sent_date
FROM ${tableName}
WHERE datediff(NOW(), sent_date) < 365`;
  logger.debug(sql);
  const rows = await db.query(sql);
  logger.info(`Loaded ${rows.length} recently sent from ${tableName}`);
  const sent: StringDateMap = {};
  for (const row of rows) {
    const key0 = `${row.yahrzeit_id}.${row.num}.${row.hyear}`;
    const key = row.name_hash === null ? key0 : key0 + '.' + row.name_hash;
    sent[key] = row.sent_date;
  }
  return sent;
}

async function processAnniversary(info: SubInfo): Promise<unknown> {
  const message = makeMessage(info);
  logger.info(`${info.anniversaryId} - ${info.diff} days - ${message.subject}`);
  // Both series carry the same labels so a failure rate is a straight ratio of
  // one over the sum of the two.
  const labels = {type: info.type, reminder_days: info.reminderDays};
  let status;
  try {
    status = await sendMail(message);
    if (!argv.dryrun) {
      const tableName = `yahrzeit_sent${info.reminderDays}`;
      const sqlSentUpdate = `INSERT INTO ${tableName}
 (yahrzeit_id, name_hash, num, hyear, sent_date)
 VALUES (?, ?, ?, ?, NOW())`;
      logger.debug(sqlSentUpdate);
      await db.query(sqlSentUpdate, [info.id, info.hash, info.num, info.hyear]);
      if (sleeptime) {
        msleep(sleeptime);
      }
    }
    numSent++;
    metrics.inc('hebcal_email_yahrzeit_sent_total', labels);
  } catch (err) {
    logger.error(err);
    metrics.inc('hebcal_email_yahrzeit_send_failures_total', labels);
    status = err;
  }
  return status;
}

function usage() {
  const PROG = 'yahrzeit_email';
  const usage = `Usage:
    ${PROG} [options]

Options:
  --help           Help
  --dryrun         Prints the actions that ${PROG} would take
                     but does not remove anything
  --quiet          Only emit warnings and errors
  --verbose        Extra debugging information
  --force          Run even if it's not Thursday
  --ini <file>     Use non-default hebcal-dot-com.ini
  --email <addr>   Only send to <addr>
`;
  console.log(usage);
}

try {
  await main();
  metrics.finish('success');
  if (numSent > 0) {
    logger.info(`Success! Sent ${numSent} messages.`);
  }
  logger.debug('Done.');
} catch (err) {
  logger.fatal(err);
  metrics.finish('failure');
  process.exit(1);
}
