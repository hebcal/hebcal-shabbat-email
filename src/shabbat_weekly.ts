/* eslint-disable n/no-process-exit */
import {
  CalOptions,
  Event,
  flags,
  HDate,
  HebrewCalendar,
  Location,
  months,
} from '@hebcal/core';
import {GeoDb} from '@hebcal/geo-sqlite';
import {appendIsraelAndTracking} from '@hebcal/rest-api';
import dayjs from 'dayjs';
import fs from 'fs';
import {flock} from 'fs-ext';
import {htmlToText} from 'html-to-text';
import ini from 'ini';
import minimist from 'minimist';
import nodemailer from 'nodemailer';
import pino from 'pino';
import {
  getLogLevel,
  htmlToTextOptions,
  makeTransporter,
  msleep,
  shouldSendEmailToday,
} from './common.js';
import {dirIfExistsOrCwd, makeDb} from './makedb.js';
import {RowDataPacket} from 'mysql2';

const argv = minimist(process.argv.slice(2), {
  boolean: [
    'dryrun',
    'quiet',
    'help',
    'force',
    'verbose',
    'localhost',
    'positive',
    'negative',
  ],
  alias: {h: 'help', n: 'dryrun', q: 'quiet', f: 'force', v: 'verbose'},
});
if (argv.help) {
  usage();
  process.exit(1);
}
// allow sleeptime=0 for no sleep
argv.sleeptime = typeof argv.sleeptime === 'undefined' ? 300 : +argv.sleeptime;

const logger = pino({
  level: getLogLevel(argv),
});

const TODAY0 = dayjs(argv.date); // undefined => new Date()
const TODAY = TODAY0.toDate();
logger.debug(`Today is ${TODAY0.format('dddd')}`);
if (!shouldSendEmailToday(TODAY0) && !argv.force) {
  logger.debug('Exiting...');
  process.exit(0);
}
const [midnight, endOfWeek] = getStartAndEnd(TODAY);
const midnightDt = midnight.toDate();
const endOfWeekDt = endOfWeek.toDate();
logger.debug(
  `start=${midnight.format('YYYY-MM-DD')}, endOfWeek=${endOfWeek.format('YYYY-MM-DD')}`,
);

const FORMAT_DOW_MONTH_DAY = 'dddd, MMMM D';
const geoDb = new GeoDb(logger, 'zips.sqlite3', 'geonames.sqlite3');

main()
  .then(() => {
    geoDb.close();
    logger.info('Success!');
  })
  .catch(err => {
    logger.fatal(err);
    process.exit(1);
  });

/**
 * Main event loop
 */
async function main() {
  const iniPath = argv.ini || '/etc/hebcal-dot-com.ini';
  logger.info(`Reading ${iniPath}...`);
  const config = ini.parse(fs.readFileSync(iniPath, 'utf-8'));
  const subs = await loadSubs(config, argv._);
  logger.info(`Loaded ${subs.size} users`);

  const logdir = await dirIfExistsOrCwd('/var/log/hebcal');
  const dow = TODAY0.day();
  const friday = TODAY0.add(5 - dow, 'day');
  const sentLogFilename = logdir + '/shabbat-' + friday.format('YYYYMMDD');

  if (!argv.force) {
    const alreadySent = loadSentLog(sentLogFilename);
    if (alreadySent.size > 0) {
      logger.info(`Skipping ${alreadySent.size} users from previous run`);
      alreadySent.forEach(x => subs.delete(x));
    }
  }

  return new Promise((resolve, reject) => {
    const lockfile = fs.openSync('/tmp/hebcal-shabbat-weekly.lock', 'w');
    flock(lockfile, 'ex', err => {
      if (err) {
        logger.error(err);
        reject(err);
      }
      mainInner(subs, config, sentLogFilename)
        .then(() => {
          fs.closeSync(lockfile);
          resolve(true);
        })
        .catch((err: Error) => {
          logger.error(err);
          reject(err);
        });
    });
  });
}

function compareConfigs(a: CandleConfig, b: CandleConfig): number {
  const locA = a.location;
  const locB = b.location;
  const lonA = locA.getLongitude();
  const lonB = locB.getLongitude();
  if (lonA === lonB) {
    const latA = locA.getLatitude();
    const latB = locB.getLatitude();
    if (latA === latB) {
      const nameA = locA.getName()!;
      const nameB = locB.getName()!;
      return nameA.localeCompare(nameB);
    } else {
      return latA - latB;
    }
  } else {
    return lonB - lonA;
  }
}

async function mainInner(
  subs: Map<string, CandleConfig>,
  config: {[s: string]: any},
  sentLogFilename: string,
) {
  parseAllConfigs(subs);

  logger.info(`Sorting ${subs.size} users by lat/long`);
  const cfgs = Array.from(subs.values());
  cfgs.sort(compareConfigs);
  const transporter = argv.dryrun
    ? null
    : argv.localhost
      ? nodemailer.createTransport({host: 'localhost', port: 25})
      : makeTransporter(config);
  const logFilename = argv.dryrun ? '/dev/null' : sentLogFilename;
  const logStream = fs.createWriteStream(logFilename, {flags: 'a'});
  const count = cfgs.length;
  logger.info(`About to mail ${count} users`);
  let i = 0;
  for (const cfg of cfgs) {
    if (i % 200 === 0 || i === count - 1) {
      const cityDescr = cfg.location.getName();
      logger.info(`Sending mail #${i + 1}/${count} (${cityDescr})`);
    }
    const info = await mailUser(transporter, cfg);
    if (!argv.dryrun) {
      writeLogLine(logStream, cfg, info);
      if (argv.sleeptime && i !== count - 1) {
        msleep(argv.sleeptime);
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
  M: boolean;
  b: number;
  ue: boolean;
  zip?: string;
  geonameid?: number;
  legacyCity?: string;
  location: Location;
};

const dummyLocation = new Location(0, 0, false, 'UTC');

function writeLogLine(logStream: fs.WriteStream, cfg: CandleConfig, info: any) {
  const location = cfg.zip || cfg.geonameid || cfg.legacyCity;
  const mid = info.messageId.substring(1, info.messageId.indexOf('@'));
  const status = Number(info.response.startsWith('250'));
  logStream.write(`${mid}:${status}:${cfg.email}:${location}\n`);
}

/**
 * Gets start and end days for filtering relevant hebcal events
 */
function getStartAndEnd(now: Date): dayjs.Dayjs[] {
  const midnight = dayjs(
    new Date(now.getFullYear(), now.getMonth(), now.getDate()),
  );
  const dow = midnight.day();
  const saturday = midnight.add(6 - dow, 'day');
  const sixDaysAhead = midnight.add(6, 'day');
  const endOfWeek = sixDaysAhead.isAfter(saturday) ? sixDaysAhead : saturday;
  return [midnight, endOfWeek];
}

/**
 * mails the user
 */
async function mailUser(
  transporter: nodemailer.Transporter | null,
  cfg: CandleConfig,
): Promise<unknown> {
  const message = getMessage(cfg);
  if (!transporter) {
    return undefined;
  }
  return transporter.sendMail(message);
}

/**
 * creates a message object
 */
function getMessage(cfg: CandleConfig): nodemailer.SendMailOptions {
  const [subj, body0, htmlBody0, specialNote, specialNoteTxt] =
    getSubjectAndBody(cfg);

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

  const msgid = cfg.id + '.' + Date.now();
  const openUrl =
    `https://www.hebcal.com/email/open?msgid=${msgid}` +
    '&loc=' +
    encodeURIComponent(cityDescr!) +
    UTM_CAMPAIGN;
  const urls = {
    home: urlEncodeAndTrack('https://www.hebcal.com/'),
    unsub: urlEncodeAndTrack(`${unsubUrl}&unsubscribe=1`),
    modify: urlEncodeAndTrack(`${unsubUrl}&modify=1`),
    open: openUrl.replace(/&/g, '&amp;'),
    privacy: urlEncodeAndTrack(
      'https://www.hebcal.com/home/about/privacy-policy',
    ),
  };
  // eslint-disable-next-line max-len
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
  const returnPath =
    'shabbat-return+' + cfg.email.replace('@', '=') + '@hebcal.com';
  const unsub1click = `https://www.hebcal.com/email?em=${encodeURIComponent(cfg.email)}&unsubscribe=1&v=1&cfg=json`;
  const message = {
    from: 'Hebcal <shabbat-owner@hebcal.com>',
    replyTo: 'no-reply@hebcal.com',
    to: cfg.email,
    subject: subj,
    messageId: `<${msgid}@hebcal.com>`,
    headers: {
      'Return-Path': returnPath,
      'Errors-To': returnPath,
      'List-Unsubscribe': `<${unsub1click}>, <mailto:${unsubAddr}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'List-Id': '<shabbat.hebcal.com>',
    },
    text: body,
    html: htmlBody,
  };
  return message;
}

let prevCfg: CandleConfig;
let prevSubjAndBody: string[];

/**
 * looks up or generates subject and body
 */
function getSubjectAndBody(cfg: CandleConfig): string[] {
  const location = cfg.location;
  if (
    prevCfg &&
    cfg.m === prevCfg.m &&
    cfg.M === prevCfg.M &&
    cfg.b === prevCfg.b &&
    cfg.ue === prevCfg.ue &&
    location.getGeoId() === prevCfg.location.getGeoId()
  ) {
    return prevSubjAndBody;
  }
  const options: CalOptions = {
    start: midnightDt,
    end: endOfWeekDt,
    location: location,
    candlelighting: true,
    candleLightingMins: cfg.b,
    il: location.getIsrael(),
    sedrot: true,
    shabbatMevarchim: true,
    useElevation: cfg.ue,
  };
  if (typeof cfg.m === 'number') {
    options.havdalahMins = cfg.m;
  }
  const events = HebrewCalendar.calendar(options);
  const subjAndBody = genSubjectAndBody(events, options, cfg);
  prevSubjAndBody = subjAndBody;
  prevCfg = cfg;
  return subjAndBody;
}

const BLANK = '<div>&nbsp;</div>';
const ITEM_STYLE = 'padding-left:8px;margin-bottom:2px';

function genSubjectAndBody(
  events: Event[],
  options: CalOptions,
  cfg: CandleConfig,
): string[] {
  let body = '';
  let htmlBody = '';
  let firstCandles;
  let sedra;
  let prevStrtime;
  for (const ev of events) {
    const ev0 = ev as any;
    const timed = Boolean(ev0.eventTime);
    const title = timed ? ev.renderBrief() : ev.render();
    const title1 = title.replace(/'/g, '’');
    const desc = ev.getDesc();
    const hd = ev.getDate();
    const dt = dayjs(hd.greg());
    const mask = ev.getFlags();
    const strtime = dt.format(FORMAT_DOW_MONTH_DAY);
    if (strtime !== prevStrtime) {
      if (htmlBody !== '') {
        htmlBody += `${BLANK}\n`;
        body += '\n';
      }
      htmlBody += `<div style="font-size:14px;color:#941003;font-family:arial,helvetica,sans-serif">${strtime}</div>\n`;
      body += `${strtime}\n`;
      prevStrtime = strtime;
    }
    const emoji = ev.getEmoji();
    if (timed) {
      const eventTimeStr: string = ev0.eventTimeStr;
      const hourMin = HebrewCalendar.reformatTimeStr(
        eventTimeStr,
        'pm',
        options,
      );
      if (!firstCandles && desc === 'Candle lighting') {
        firstCandles = hourMin;
      }
      const verb =
        desc === 'Candle lighting' || desc === 'Havdalah' ? ' is' : '';
      body += `  ${title}${verb} at ${hourMin}\n`;
      const emojiSuffix = mask & flags.CHANUKAH_CANDLES ? ` ${emoji}` : '';
      htmlBody += `<div style="${ITEM_STYLE}">${title1}${verb} at <strong>${hourMin}</strong>${emojiSuffix}</div>\n`;
    } else if (mask === flags.PARSHA_HASHAVUA) {
      sedra = title.substring(title.indexOf(' ') + 1);
      body += `  Torah portion: ${title}\n`;
      const url = ev.url();
      const url2 = urlEncodeAndTrack(url!, options.il);
      htmlBody += `<div style="${ITEM_STYLE}">Torah portion: <a href="${url2}">${title1}</a></div>\n`;
    } else {
      const dow = dt.day();
      if (dow === 6 && !sedra && (mask & flags.CHAG || ev0.cholHaMoedDay)) {
        sedra = ev.basename();
      }
      body += `  ${title}\n`;
      const url = ev.url();
      htmlBody += `<div style="${ITEM_STYLE}">`;
      if (url) {
        const url2 = urlEncodeAndTrack(url, options.il);
        htmlBody += `<a href="${url2}">${title1}</a>`;
      } else {
        htmlBody += title1;
      }
      const emojiSuffix = emoji ? ` ${emoji}` : '';
      htmlBody += `${emojiSuffix}</div>\n`;
    }
  }
  const shortLocation = cfg.location.getShortName();
  let subject = '🕯️';
  if (sedra) subject += ` ${sedra} -`;
  subject += ' ' + shortLocation;
  if (firstCandles) subject += ` candles ${firstCandles}`;

  const specialNote = getSpecialNote(cfg, true);
  const specialNoteTxt = getSpecialNote(cfg, false);

  return [subject, body, htmlBody, specialNote, specialNoteTxt];
}

const UTM_CAMPAIGN = '&utm_campaign=shabbat-weekly';

function urlEncodeAndTrack(url: string, il?: boolean): string {
  il = Boolean(il);
  url = appendIsraelAndTracking(
    url,
    il,
    'newsletter',
    'email',
    'shabbat-weekly',
  );
  return url.replace(/&/g, '&amp;');
}

function nowrap(s: string): string {
  return `<span style="white-space: nowrap">${s}</span>`;
}

function getSpecialNote(cfg: CandleConfig, isHTML: boolean): string {
  const hd = new HDate(TODAY);
  const mm = hd.getMonth();
  const dd = hd.getDate();
  const yy = hd.getFullYear();
  const purimMonth = HDate.isLeapYear(yy) ? months.ADAR_II : months.ADAR_I;
  const gy = TODAY0.year();

  function makeUrl(holiday: string) {
    const il = cfg.location.getIsrael();
    return isHTML
      ? urlEncodeAndTrack(
          `https://www.hebcal.com/holidays/${holiday}-${gy}`,
          il,
        )
      : `https://hebcal.com/h/${holiday}-${gy}${il ? '?i=on' : ''}`;
  }

  const shortLocation = cfg.location.getShortName();
  let note;
  if (
    (mm === months.AV && dd >= 16 && dd <= 26) ||
    (mm === months.ELUL && dd >= 16 && dd <= 26)
  ) {
    // for a week or two in Av and the last week or two of Elul
    const nextYear = yy + 1;
    const fridgeLoc = cfg.zip ? `zip=${cfg.zip}` : `geonameid=${cfg.geonameid}`;
    const erevRH = dayjs(new HDate(1, months.TISHREI, nextYear).prev().greg());
    const strtime = nowrap(erevRH.format(FORMAT_DOW_MONTH_DAY));
    let url = `https://www.hebcal.com/shabbat/fridge.cgi?${fridgeLoc}&b=${cfg.b}&year=${nextYear}`;
    if (cfg.m) {
      url += `&m=${cfg.m}`;
    } else if (cfg.M) {
      url += '&M=on';
    }
    url = urlEncodeAndTrack(url);
    const rhNameSpan = nowrap(`Rosh Hashana ${nextYear}`);
    note = `Shana Tova! We wish you a happy and healthy New Year.
${rhNameSpan} begins at sundown on ${strtime}.
<br><br>Print your <a
style="color:#356635" href="${url}">${shortLocation} ${nextYear} year-at-a-glance</a>
for Shabbat and holiday candle-lighting times on a single page.`;
  } else if (mm === months.TISHREI && dd <= 9) {
    // between RH & YK
    const erevYK = dayjs(new HDate(9, months.TISHREI, yy).greg());
    const strtime = nowrap(erevYK.format(FORMAT_DOW_MONTH_DAY));
    note = `G’mar Chatima Tova! We wish you a good inscription in the Book of Life.
<br><a style="color:#356635" href="${makeUrl('yom-kippur')}">Yom Kippur ${yy}</a>
begins at sundown on ${strtime}.`;
  } else if (
    (mm === months.TISHREI && dd >= 17 && dd <= 21) ||
    (mm === months.NISAN && dd >= 17 && dd <= 20)
  ) {
    const holiday = mm === months.TISHREI ? 'Sukkot' : 'Pesach';
    note = `Moadim L’Simcha! We wish you a very happy ${holiday}.`;
  } else if (mm === purimMonth && dd >= 2 && dd <= 10) {
    // show Purim greeting 1.5 weeks before
    const erevPurim = dayjs(new HDate(13, purimMonth, yy).greg());
    const strtime = nowrap(erevPurim.format(FORMAT_DOW_MONTH_DAY));
    note = `Chag Purim Sameach!
<a style="color:#356635" href="${makeUrl('purim')}">Purim ${yy}</a>
begins at sundown on ${strtime}.`;
  } else if (
    (mm === purimMonth && dd >= 17 && dd <= 25) ||
    (mm === months.NISAN && dd >= 2 && dd <= 9)
  ) {
    // show Pesach greeting shortly after Purim and ~2 weeks before
    const erevPesach = dayjs(new HDate(14, months.NISAN, yy).greg());
    const strtime = nowrap(erevPesach.format(FORMAT_DOW_MONTH_DAY));
    note = `Chag Kasher v’Sameach! We wish you a happy
<a style="color:#356635" href="${makeUrl('pesach')}">Pesach ${yy}</a>.
<br>Passover begins at sundown on ${strtime}.`;
  } else if (mm === months.KISLEV && dd >= 1 && dd <= 13) {
    // for the first 2 weeks of Kislev, show Chanukah greeting
    const erevChanukah = dayjs(new HDate(24, months.KISLEV, yy).greg());
    const dow = erevChanukah.day();
    const strtime = nowrap(erevChanukah.format(FORMAT_DOW_MONTH_DAY));
    const when =
      dow === 5 ? 'before sundown' : dow === 6 ? 'at nightfall' : 'at sundown';
    note = `Chag Urim Sameach! Light the first
<a style="color:#356635" href="${makeUrl('chanukah')}">Chanukah candle</a>
${when} on ${strtime}.`;
  }

  if (!note) {
    return '';
  }

  if (!isHTML) {
    return htmlToText(note, htmlToTextOptions) + '\n\n';
  }

  // eslint-disable-next-line max-len
  return (
    '<div style="font-size:14px;font-family:arial,helvetica,sans-serif;padding:8px;color:#468847;background-color:#dff0d8;border-color:#d6e9c6;border-radius:4px">\n' +
    note +
    `\n</div>\n${BLANK}\n`
  );
}

async function loadSubs(
  config: {[s: string]: string},
  addrs: string[],
): Promise<Map<string, CandleConfig>> {
  const db = makeDb(logger, config);
  const allSql = addrs?.length
    ? "AND email_address IN ('" + addrs.join("','") + "')"
    : '';
  const sql = `SELECT email_address,
       email_id,
       email_candles_zipcode,
       email_candles_city,
       email_candles_geonameid,
       email_use_elevation,
       email_candles_havdalah,
       email_havdalah_tzeit,
       email_sundown_candles
FROM hebcal_shabbat_email
WHERE email_status = 'active'
AND email_ip IS NOT NULL
${allSql}`;
  logger.info(sql);
  const results = await db.query(sql);
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
    M: Boolean(row.email_havdalah_tzeit),
    b: row.email_sundown_candles,
    ue: Boolean(row.email_use_elevation),
    location: dummyLocation,
  };
  if (row.email_candles_zipcode) {
    cfg.zip = row.email_candles_zipcode;
  } else if (row.email_candles_geonameid) {
    cfg.geonameid = row.email_candles_geonameid;
  } else if (row.email_candles_city) {
    cfg.legacyCity = row.email_candles_city.replace(/\+/g, ' ');
  } else {
    logger.warn(`no geographic key for to=${email}, id=${cfg.id}`);
    return null;
  }
  return cfg;
}

/**
 * Reads the previous log and returns any successful email adresses to skip
 */
function loadSentLog(sentLogFilename: string): Set<string> {
  const result = new Set<string>();
  let lines;
  try {
    lines = fs.readFileSync(sentLogFilename, 'utf-8').split('\n');
  } catch (error) {
    logger.info(`No ${sentLogFilename} logfile from prior run: ${error}`);
    return result; // no previous run to scan
  }
  for (const line of lines) {
    const [, status, to] = line.split(':');
    if (+status && to) {
      result.add(to);
    }
  }
  return result;
}

/**
 * Scans subs map and removes invalid entries
 */
function parseConfig(to: string, cfg: CandleConfig): boolean {
  const location = cfg.zip
    ? geoDb.lookupZip(cfg.zip)
    : cfg.legacyCity
      ? geoDb.lookupLegacyCity(cfg.legacyCity)
      : cfg.geonameid
        ? geoDb.lookupGeoname(cfg.geonameid)
        : undefined;

  if (!location) {
    logger.warn('Skipping bad config: ' + JSON.stringify(cfg));
    return false;
  } else if (location.getLongitude() === 0 && location.getLatitude() === 0) {
    logger.warn(`Suspicious zero lat/long for to=${to}, id=${cfg.id}`);
    return false;
  } else if (!location.getTzid()) {
    logger.warn(`Unknown tzid for to=${to}, id=${cfg.id}`);
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
    logger.warn(
      `Skipped ${failures.length} subscribers due to config failures`,
    );
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
`;
  console.log(usage);
}
