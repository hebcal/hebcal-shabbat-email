import {calendar, Location} from '@hebcal/core';
import {GeoDb} from '@hebcal/geo-sqlite';
import dayjs from 'dayjs';
import fs from 'node:fs';
import {flock} from 'fs-ext';
import {parseArgs} from 'node:util';
import nodemailer from 'nodemailer';
import type {SendMailOptions, SentMessageInfo, Transporter} from 'nodemailer';
import pino from 'pino';
import {
  getLogLevel,
  makeListMessage,
  makeTransporter,
  msleep,
  readIniConfig,
  shouldSendEmailToday,
} from './common.js';
import {LOGDIR, dirIfExistsOrCwd, makeDb} from './makedb.js';
import {makeCalOptions} from './calOptions.js';
import {Metrics} from './metrics.js';
import {Announcement, DEFAULT_ANNOUNCEMENT_PATH, readAnnouncement} from './specialNote.js';
import {urlEncodeAndTrack} from './tracking.js';
import {
  BLANK,
  compareConfigs,
  formatSentLogLine,
  makeSubjectAndBody,
  getStartAndEnd,
  parseSentLog,
  SubjectAndBody,
} from './weeklyBody.js';
import {RowDataPacket} from 'mysql2';

const {values: argv, positionals} = parseArgs({
  options: {
    dryrun: {type: 'boolean', short: 'n'},
    quiet: {type: 'boolean', short: 'q'},
    help: {type: 'boolean', short: 'h'},
    force: {type: 'boolean', short: 'f'},
    verbose: {type: 'boolean', short: 'v'},
    localhost: {type: 'boolean'},
    positive: {type: 'boolean'},
    negative: {type: 'boolean'},
    date: {type: 'string'},
    ini: {type: 'string'},
    announcement: {type: 'string'},
    sleeptime: {type: 'string'},
  },
  allowPositionals: true,
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

// --dryrun builds every message but sends nothing, so its counts are not real
// traffic and must not land in the durable totals.
const metrics = new Metrics('shabbat_weekly', {logger, enabled: !argv.dryrun});

const TODAY0 = dayjs(argv.date); // undefined => new Date()
const TODAY = TODAY0.toDate();
logger.debug(`Today is ${TODAY0.format('dddd')}`);
if (!shouldSendEmailToday(TODAY0) && !argv.force) {
  logger.debug('Exiting...');
  // Cron fires this Tue/Wed/Thu and it sends on exactly one of them, so most
  // invocations land here. Record them: a run that stops being scheduled at all
  // looks identical to one that skipped, unless the skips are counted.
  metrics.finish('skipped');
  process.exit(0);
}
const [midnight, endOfWeek] = getStartAndEnd(TODAY);
const midnightDt = midnight.toDate();
const endOfWeekDt = endOfWeek.toDate();
logger.debug(`start=${midnight.format('YYYY-MM-DD')}, endOfWeek=${endOfWeek.format('YYYY-MM-DD')}`);

const geoDb = new GeoDb(null, 'zips.sqlite3', 'geonames.sqlite3', {
  geonamesPollInterval: 0,
});
let announcement: Announcement | undefined;

/**
 * Main event loop
 */
async function main() {
  logger.info(`Reading ${argv.ini || 'default config'}...`);
  const config = readIniConfig(argv.ini);
  // A broken announcement file shouldn't cost anyone their candle-lighting
  // times, so log it and send without the announcement.
  const announcementPath = argv.announcement || DEFAULT_ANNOUNCEMENT_PATH;
  try {
    announcement = readAnnouncement(announcementPath, TODAY0);
  } catch (err) {
    logger.error(err, `Ignoring announcement ${announcementPath}`);
  }
  if (announcement) {
    logger.info(`Including announcement from ${announcementPath}`);
  }
  const subs = await loadSubs(config, positionals);
  logger.info(`Loaded ${subs.size} users`);

  const logdir = await dirIfExistsOrCwd(LOGDIR);
  const dow = TODAY0.day();
  const friday = TODAY0.add(5 - dow, 'day');
  const sentLogFilename = logdir + '/shabbat-' + friday.format('YYYYMMDD');

  let skipped = 0;
  if (!argv.force) {
    const alreadySent = loadSentLog(sentLogFilename);
    if (alreadySent.size > 0) {
      skipped = alreadySent.size;
      logger.info(`Skipping ${alreadySent.size} users from previous run`);
      alreadySent.forEach(x => subs.delete(x));
    }
  }
  metrics.setGauge('hebcal_email_shabbat_skipped_already_sent', {}, skipped);

  return new Promise<boolean>((resolve, reject) => {
    const lockfile = fs.openSync('/tmp/hebcal-shabbat-weekly.lock', 'w');
    flock(lockfile, 'ex', err => {
      if (err) {
        // Never acquired the exclusive lock: bail out instead of mailing,
        // otherwise a concurrent run could double-send.
        logger.error(err);
        fs.closeSync(lockfile);
        reject(err);
        return;
      }
      mainInner(subs, config, sentLogFilename)
        .then(() => {
          fs.closeSync(lockfile);
          resolve(true);
        })
        .catch((err: Error) => {
          logger.error(err);
          fs.closeSync(lockfile);
          reject(err);
        });
    });
  });
}

async function mainInner(
  subs: Map<string, CandleConfig>,
  config: Record<string, string>,
  sentLogFilename: string
) {
  parseAllConfigs(subs);

  logger.info(`Sorting ${subs.size} users by lat/long`);
  const cfgs = Array.from(subs.values());
  cfgs.sort(compareConfigs);
  let transporter: Transporter | null;
  if (argv.dryrun) {
    transporter = null;
  } else if (argv.localhost) {
    transporter = nodemailer.createTransport({host: 'localhost', port: 25});
  } else {
    transporter = makeTransporter(config);
  }
  const logFilename = argv.dryrun ? '/dev/null' : sentLogFilename;
  const logStream = fs.createWriteStream(logFilename, {flags: 'a'});
  const count = cfgs.length;
  metrics.setGauge('hebcal_email_shabbat_recipients', {}, count);
  logger.info(`About to mail ${count} users`);
  let i = 0;
  for (const cfg of cfgs) {
    if (i % 200 === 0 || i === count - 1) {
      const cityDescr = cfg.location.getName();
      logger.info(`Sending mail #${i + 1}/${count} (${cityDescr})`);
      // Piggy-backs on the existing progress-log cadence. A full send takes
      // the better part of an hour, and folding the deltas in as we go means
      // the dashboard tracks it live and a crash costs at most 200 messages
      // of counter, instead of the whole run.
      metrics.flush();
    }
    const info = await mailUser(transporter, cfg);
    if (!argv.dryrun) {
      const accepted = writeLogLine(logStream, cfg, info!);
      metrics.inc(
        accepted ? 'hebcal_email_shabbat_sent_total' : 'hebcal_email_shabbat_send_failures_total'
      );
      if (sleeptime && i !== count - 1) {
        msleep(sleeptime);
      }
    }
    i++;
  }
  logger.info(`Sent ${count} messages`);
  logStream.end();
}

type CandleConfig = {
  id: string;
  email: string;
  m: number;
  td: number | null;
  b: number;
  ue: boolean;
  zip?: string;
  geonameid?: number;
  legacyCity?: string;
  location: Location;
};

const dummyLocation = new Location(0, 0, false, 'UTC');

/** Appends the sent-log line and reports whether the relay accepted it. */
function writeLogLine(
  logStream: fs.WriteStream,
  cfg: CandleConfig,
  info: SentMessageInfo
): boolean {
  const [line, accepted] = formatSentLogLine(cfg, info);
  logStream.write(line);
  return accepted;
}

/**
 * mails the user
 */
async function mailUser(
  transporter: Transporter | null,
  cfg: CandleConfig
): Promise<SentMessageInfo | undefined> {
  const message = getMessage(cfg);
  if (!transporter) {
    return undefined;
  }
  return transporter.sendMail(message);
}

/**
 * creates a message object
 */
function getMessage(cfg: CandleConfig): SendMailOptions {
  const [subj, body0, htmlBody0, specialNote, specialNoteTxt] = getSubjectAndBody(cfg);

  const encoded = encodeURIComponent(Buffer.from(cfg.email).toString('base64'));
  const unsubUrl = `https://www.hebcal.com/email?e=${encoded}`;

  const cityDescr = cfg.location.getName();
  const body =
    specialNoteTxt +
    body0 +
    `
These times are for ${cityDescr}.

Shabbat Shalom,
hebcal.com

To modify your subscription or to unsubscribe completely, visit:
${unsubUrl}
`;

  const msgid = cfg.id + '.' + Date.now().toString(36);
  const openUrl =
    `https://www.hebcal.com/email/open?msgid=${msgid}` +
    '&loc=' +
    encodeURIComponent(cityDescr!) +
    UTM_CAMPAIGN;
  const urls = {
    home: urlEncodeAndTrack('https://www.hebcal.com/'),
    unsub: urlEncodeAndTrack(`${unsubUrl}&unsubscribe=1`),
    modify: urlEncodeAndTrack(`${unsubUrl}&modify=1`),
    open: openUrl.replaceAll('&', '&amp;'),
    privacy: urlEncodeAndTrack('https://www.hebcal.com/home/about/privacy-policy'),
  };

  const imgOpen = `<img src="${urls.open}" alt="" width="1" height="1" border="0" style="height:1px!important;width:1px!important;border-width:0!important;margin-top:0!important;margin-bottom:0!important;margin-right:0!important;margin-left:0!important;padding-top:0!important;padding-bottom:0!important;padding-right:0!important;padding-left:0!important">`;
  const htmlBody = `${specialNote}
<div style="font-size:18px;font-family:georgia,'times new roman',times,serif;">
${htmlBody0}
${BLANK}
<div style="font-size:16px">
<div>These times are for ${cityDescr}.</div>
${BLANK}
<div>Shabbat Shalom!</div>
${BLANK}
</div>
</div>
<div style="font-size:11px;color:#999;font-family:arial,helvetica,sans-serif">
<div>This email was sent to ${cfg.email} by <a href="${urls.home}">Hebcal.com</a>.
Hebcal is a free Jewish calendar and holiday web site.</div>
${BLANK}
<div><a href="${urls.unsub}">Unsubscribe</a> |
 <a href="${urls.modify}">Update Settings</a> |
 <a href="${urls.privacy}">Privacy Policy</a></div>
</div>
${imgOpen}
`;

  const unsubAddr = `shabbat-unsubscribe+${cfg.id}@hebcal.com`;
  const returnPath = 'shabbat-return+' + cfg.email.replace('@', '=') + '@hebcal.com';
  const unsub1click = `https://www.hebcal.com/email?em=${encodeURIComponent(cfg.email)}&unsubscribe=1&v=1&cfg=json`;
  return makeListMessage({
    to: cfg.email,
    subject: subj,
    msgid,
    returnPath,
    listId: '<shabbat.hebcal.com>',
    listUnsubscribe: `<${unsub1click}>, <mailto:${unsubAddr}?subject=unsubscribe>`,
    text: body,
    html: htmlBody,
  });
}

let prevCfg: CandleConfig = {
  id: '',
  email: '',
  m: -1,
  td: null,
  b: -1,
  ue: false,
  location: dummyLocation,
};
let prevSubjAndBody: SubjectAndBody;

/**
 * looks up or generates subject and body
 */
function getSubjectAndBody(cfg: CandleConfig): SubjectAndBody {
  const location = cfg.location;
  if (
    cfg.m === prevCfg.m &&
    cfg.td === prevCfg.td &&
    cfg.b === prevCfg.b &&
    cfg.ue === prevCfg.ue &&
    location.getGeoId() === prevCfg.location.getGeoId()
  ) {
    return prevSubjAndBody;
  }
  const options = makeCalOptions(cfg, midnightDt, endOfWeekDt);
  const events = calendar(options);
  const subjAndBody = makeSubjectAndBody(events, options, cfg, TODAY0, announcement);
  prevSubjAndBody = subjAndBody;
  prevCfg = cfg;
  return subjAndBody;
}

const UTM_CAMPAIGN = '&utm_campaign=shabbat-weekly';

async function loadSubs(
  config: Record<string, string>,
  addrs: string[]
): Promise<Map<string, CandleConfig>> {
  const db = makeDb(logger, config);
  const allSql = addrs?.length ? "AND email_address IN ('" + addrs.join("','") + "')" : '';
  const sql = `SELECT email_address,
       email_id,
       email_candles_zipcode,
       email_candles_city,
       email_candles_geonameid,
       email_use_elevation,
       email_candles_havdalah,
       email_havdalah_degrees,
       email_sundown_candles
FROM hebcal_shabbat_email
WHERE email_status = 'active'
AND email_ip IS NOT NULL
${allSql}`;
  logger.info(sql);
  const results = await db.query(sql);
  metrics.setGauge('hebcal_email_shabbat_subscribers_loaded', {}, results.length);
  const subs = new Map<string, CandleConfig>();
  for (const row of results) {
    const cfg = makeCandlesCfg(row);
    if (cfg) {
      subs.set(cfg.email, cfg);
    }
  }
  await db.close();
  return subs;
}

function makeCandlesCfg(row: RowDataPacket): CandleConfig | null {
  const email = row.email_address;
  const cfg: CandleConfig = {
    id: row.email_id,
    email: email,
    m: row.email_candles_havdalah,
    td: row.email_havdalah_degrees === null ? null : Number(row.email_havdalah_degrees),
    b: row.email_sundown_candles,
    ue: Boolean(row.email_use_elevation),
    location: dummyLocation,
  };
  if (row.email_candles_zipcode) {
    cfg.zip = row.email_candles_zipcode;
  } else if (row.email_candles_geonameid) {
    cfg.geonameid = row.email_candles_geonameid;
  } else if (row.email_candles_city) {
    cfg.legacyCity = row.email_candles_city.replaceAll('+', ' ');
  } else {
    logger.warn(`no geographic key: to=${email}, id=${cfg.id}`);
    metrics.inc('hebcal_email_shabbat_config_failures_total', {reason: 'no_geographic_key'});
    return null;
  }
  return cfg;
}

/**
 * Reads the previous log and returns any successful email adresses to skip
 */
function loadSentLog(sentLogFilename: string): Set<string> {
  let contents;
  try {
    contents = fs.readFileSync(sentLogFilename, 'utf-8');
  } catch (error) {
    logger.info(`No ${sentLogFilename} logfile from prior run: ${error}`);
    return new Set<string>(); // no previous run to scan
  }
  return parseSentLog(contents);
}

function getLocation(cfg: CandleConfig): Location | null {
  if (cfg.zip) return geoDb.lookupZip(cfg.zip);
  if (cfg.geonameid) return geoDb.lookupGeoname(cfg.geonameid);
  if (cfg.legacyCity) return geoDb.lookupLegacyCity(cfg.legacyCity);
  return null;
}

/**
 * Scans subs map and removes invalid entries
 */
function parseConfig(to: string, cfg: CandleConfig): boolean {
  const location = getLocation(cfg);
  if (!location) {
    let src = 'legacyCity';
    if (cfg.zip) {
      src = 'zip';
    } else if (cfg.geonameid) {
      src = 'geonameid';
    }
    const val = cfg.zip || cfg.geonameid || cfg.legacyCity;
    logger.warn(`Location not found: ${src}=${val}, to=${to}, id=${cfg.id}`);
    metrics.inc('hebcal_email_shabbat_config_failures_total', {reason: 'location_not_found'});
    return false;
  } else if (location.getLongitude() === 0 && location.getLatitude() === 0) {
    logger.warn(`Suspicious zero lat/long: to=${to}, id=${cfg.id}`);
    metrics.inc('hebcal_email_shabbat_config_failures_total', {reason: 'zero_lat_long'});
    return false;
  } else if (!location.getTzid()) {
    logger.warn(`Unknown tzid: to=${to}, id=${cfg.id}`);
    metrics.inc('hebcal_email_shabbat_config_failures_total', {reason: 'unknown_tzid'});
    return false;
  }

  cfg.location = location;
  return true;
}

/**
 * Scans subs map and removes invalid entries
 */
function parseAllConfigs(subs: Map<string, CandleConfig>) {
  logger.info(`Parsing ${subs.size} configs`);
  const failures = [];
  for (const [to, cfg] of subs.entries()) {
    if (!parseConfig(to, cfg)) {
      failures.push(to);
    }
  }
  if (failures.length) {
    failures.forEach(x => subs.delete(x));
    logger.warn(`Skipped ${failures.length} subscribers due to config failures`);
  }
  if (argv.positive || argv.negative) {
    let filtered = 0;
    for (const [to, cfg] of subs.entries()) {
      const isPositive = cfg.location.getLongitude() > -20;
      if ((argv.positive && !isPositive) || (argv.negative && isPositive)) {
        subs.delete(to);
        filtered++;
      }
    }
    if (filtered > 0) {
      logger.info(`Filtered ${filtered} subscribers based on longitude`);
    }
  }
}

function usage() {
  const PROG = 'shabbat_weekly.js';
  const usage = `Usage:
    ${PROG} [options] [email_address...]

Options:
  --help           Help
  --dryrun         Prints the actions that ${PROG} would take
                     but does not remove anything
  --quiet          Only emit warnings and errors
  --verbose        Extra debugging information
  --sleeptime <n>  Sleep <n> milliseconds between email (default 300)
  --force          Run even if it's not Thursday
  --ini <file>     Use non-default hebcal-dot-com.ini
  --announcement <file>
                   Read optional announcement JSON from <file>
                     (default ${DEFAULT_ANNOUNCEMENT_PATH})
`;
  console.log(usage);
}

try {
  await main();
  geoDb.close();
  metrics.finish('success');
  logger.info('Success!');
} catch (err) {
  logger.fatal(err);
  metrics.finish('failure');
  process.exit(1);
}
