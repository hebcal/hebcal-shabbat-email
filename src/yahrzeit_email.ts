import dayjs, {Dayjs} from 'dayjs';
import fs from 'fs';
import ini from 'ini';
import {HDate, months, getYahrzeitHD, getBirthdayHD} from '@hebcal/hdate';
import {Event, flags, Locale} from '@hebcal/core';
import pino from 'pino';
import minimist from 'minimist';
import nodemailer from 'nodemailer';
import {makeDb, MysqlDb} from './makedb.js';
import {
  getLogLevel,
  getChagOnDate,
  makeTransporter,
  htmlToTextOptions,
  msleep,
} from './common.js';
import {IcalEvent} from '@hebcal/icalendar';
import {murmur32HexSync} from 'murmurhash3';
import {htmlToText} from 'nodemailer-html-to-text';
import {RowDataPacket} from 'mysql2';

const argv = minimist(process.argv.slice(2), {
  boolean: ['dryrun', 'quiet', 'help', 'force', 'verbose', 'localhost'],
  string: ['email', 'ini'],
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

let transporter: nodemailer.Transporter;
let db: MysqlDb;

const today = dayjs(argv.date); // undefined => new Date()
logger.debug(`Today is ${today.format('dddd')}`);
const chag = getChagOnDate(today);
if ((chag || today.day() === 6) && !argv.force) {
  process.exit(0);
}

const BLANK = '<div>&nbsp;</div>';
const YAHRZEIT_POSTSCRIPT = `${BLANK}
<div>
May your loved one’s soul be bound up in the bond of eternal life and may their memory
serve as a continued source of inspiration and comfort to you.
</div>
`;
const BIRTHDAY_POSTSCRIPT = `${BLANK}\n<div>Mazel Tov! <span lang="he" dir="rtl">מזל טוב!</span></div>\n`;
const DATE_STYLE = 'style="color: #941003; white-space: nowrap"';

let numSent = 0;

main()
  .then(() => {
    if (numSent > 0) {
      logger.info(`Success! Sent ${numSent} messages.`);
    }
    logger.debug('Done.');
  })
  .catch(err => {
    logger.fatal(err);
    process.exit(1);
  });

/**
 * Sends the message via nodemailer, or no-op for dryrun
 */
async function sendMail(message: nodemailer.SendMailOptions): Promise<unknown> {
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

type StringDateMap = {
  [s: string]: Date;
};

/**
 * Main event loop
 */
async function main() {
  const iniPath = argv.ini || '/etc/hebcal-dot-com.ini';
  logger.debug(`Reading ${iniPath}...`);
  const config = ini.parse(fs.readFileSync(iniPath, 'utf-8'));

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
  if (argv.email) {
    sql += ` AND e.email_addr = '${argv.email}'`;
  }

  logger.debug(sql);
  const rows = await db.query(sql);
  if (!rows || !rows.length) {
    logger.error('Got zero rows from DB!?');
    await db.close();
    return;
  }
  logger.info(`Loaded ${rows.length} active subscriptions from DB`);

  const optout: StringDateMap = await loadOptOut();
  const toSend = await loadSubsFromDb(rows, optout);

  logger.debug(`Processing ${toSend.length} messages`);
  for (const info of toSend) {
    const status = await processAnniversary(info);
    logger.debug(status);
  }

  const calendarIds0 = rows.map(row => row.calendar_id as string);
  const calendarIds = Array.from(new Set(calendarIds0));
  logger.info(`Updating access time for ${calendarIds.length} calendars`);
  for (const calendarId of calendarIds) {
    const sql2 = 'REPLACE INTO yahrzeit_atime (id, ts) VALUES (?, NOW())';
    await db.query(sql2, [calendarId]);
  }

  await db.close();
}

type SubBase = {
  num: number;
  dd: string;
  mm: string;
  yy: string;
  sunset: string | number;
  type: string;
  name: string;
  day: dayjs.Dayjs;
  hash: string;
};

type SubInfo = SubBase & {
  id: string;
  anniversaryId: string;
  hyear: number;
  calendarId: string;
  emailAddress: string;
  reminderDays: number;
  observed?: Dayjs | boolean;
  hd?: HDate;
  diff?: number;
};

type RawYahrzeitContents = {
  [s: string]: string | number;
};

async function loadSubsFromDb(
  rows: RowDataPacket[],
  optout: StringDateMap,
): Promise<SubInfo[]> {
  const htoday = new HDate(today.toDate());
  const hyears = [htoday.getFullYear()];
  if (htoday.getMonth() === months.ELUL) {
    hyears.push(hyears[0] + 1);
  }
  const sent7 = await loadRecentSent('yahrzeit_sent7');
  const sent1 = await loadRecentSent('yahrzeit_sent1');

  const toSend: SubInfo[] = [];
  for (const row of rows) {
    const contents: RawYahrzeitContents = row.contents;
    const id = (contents.id = row.id);
    if (optout[`${id}.0`]) {
      logger.debug(`Skipping global opt-out ${id}`);
      continue;
    }
    contents.calendarId = row.calendar_id;
    contents.emailAddress = row.email_addr;
    const maxId = getMaxYahrzeitId(contents);
    logger.trace(`${id} ${contents.emailAddress} ${maxId}`);
    for (let num = 1; num <= maxId; num++) {
      const info0 = getYahrzeitDetailForId(contents, num);
      if (info0 === null) {
        logger.debug(`Skipping blank ${id}.${num}`);
        continue;
      }
      if (skipOptOut(id, info0, optout)) {
        continue;
      }
      for (const hyear of hyears) {
        for (const ndays of [7, 1]) {
          const sent = ndays === 7 ? sent7 : sent1;
          const info = makeSubInfo(contents, num, info0, hyear, sent, ndays);
          if (info) {
            toSend.push(info);
            break;
          }
        }
      }
    }
  }
  return toSend;
}

function skipOptOut(
  subscriptionId: string,
  info: SubBase,
  optout: StringDateMap,
) {
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
  maxDays: number,
): SubInfo | false {
  const id = contents.id;
  const idNum = `${id}.${num}`;
  const prefix = `${idNum}.${hyear}`;
  for (const key of [prefix, `${prefix}.${info0.hash}`]) {
    if (typeof sent[key] !== 'undefined') {
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
  computeAnniversary(info);
  const diff = info.diff!;
  if (info.observed && diff >= 0 && diff < maxDays) {
    return info;
  } else if (!info.observed) {
    logger.debug(`No anniversary for ${info.anniversaryId}`);
  } else {
    logger.debug(`${info.type} ${info.anniversaryId} occurs in ${diff} days`);
  }
  return false;
}

async function loadOptOut(): Promise<StringDateMap> {
  const sql =
    'SELECT email_id, name_hash, num, updated FROM yahrzeit_optout WHERE deactivated = 1';
  logger.debug(sql);
  const rows = await db.query(sql);
  logger.info(`Loaded ${rows.length} opt_out from DB`);
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

function computeAnniversary(info: SubInfo) {
  const hyear = info.hyear;
  const origDt = info.day.toDate();
  const hd0 =
    info.type === 'Yahrzeit'
      ? getYahrzeitHD(hyear, origDt)
      : getBirthdayHD(hyear, origDt);
  if (hd0) {
    const hd = new HDate(hd0);
    const observed = (info.observed = dayjs(hd.greg()));
    info.diff = observed.diff(today, 'd');
    info.hd = hd;
  } else {
    info.observed = false;
  }
}

async function processAnniversary(info: SubInfo): Promise<unknown> {
  const message = makeMessage(info);
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
      if (argv.sleeptime) {
        msleep(argv.sleeptime);
      }
    }
    numSent++;
  } catch (err) {
    logger.error(err);
    status = err;
  }
  return status;
}

function makeMessage(info: SubInfo): nodemailer.SendMailOptions {
  const type = info.type;
  const isYahrzeit = Boolean(type === 'Yahrzeit');
  const isOther = type === 'Other';
  const UTM_PARAM = `utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=${type.toLowerCase()}-reminder`;
  const typeStr = isYahrzeit
    ? type
    : isOther
      ? 'Hebrew Anniversary'
      : `Hebrew ${type}`;
  const observed = info.observed as Dayjs;
  const subject = makeSubject(typeStr, observed);
  logger.info(`${info.anniversaryId} - ${info.diff} days - ${subject}`);
  const verb = isYahrzeit ? 'remembering' : 'honoring';
  const postscript = isYahrzeit
    ? YAHRZEIT_POSTSCRIPT
    : type === 'Birthday'
      ? BIRTHDAY_POSTSCRIPT
      : '';
  const erev = observed.subtract(1, 'day');
  const dow = erev.day();
  const when =
    dow === 5 ? 'before sundown' : dow === 6 ? 'after nightfall' : 'at sundown';
  const lightCandle = isYahrzeit
    ? ` It is customary to light a memorial candle ${when} on
<time datetime="${erev.format('YYYY-MM-DD')}" ${DATE_STYLE}>${erev.format('dddd, MMMM D')}</time>
as the Yahrzeit begins.`
    : '';
  const hebdate = info.hd!.render('en');
  const origDt = info.day.toDate();
  const nth = calculateAnniversaryNth(origDt, info.hyear);
  const msgid = `${info.anniversaryId}.${new Date().getTime()}`;
  const returnPath = `yahrzeit-return+${info.id}.${info.hash}.${info.num}@hebcal.com`;
  const urlBase = 'https://www.hebcal.com/yahrzeit';
  const editUrl = `${urlBase}/edit/${info.calendarId}?${UTM_PARAM}#form`;
  const unsubUrl = `${urlBase}/email?id=${info.id}&hash=${info.hash}&num=${info.num}&unsubscribe=1`;
  const emailAddress = info.emailAddress;

  const imgOpen = `<img src="https://www.hebcal.com/email/open?msgid=${msgid}&amp;loc=${type}&amp;${UTM_PARAM}" alt="" width="1" height="1" border="0" style="height:1px!important;width:1px!important;border-width:0!important;margin-top:0!important;margin-bottom:0!important;margin-right:0!important;margin-left:0!important;padding-top:0!important;padding-bottom:0!important;padding-right:0!important;padding-left:0!important">`;
  const prefix = isOther
    ? info.name
    : `Hebcal joins you in ${verb} ${info.name}, whose ${nth} ${typeStr}`;
  const message: nodemailer.SendMailOptions = {
    to: emailAddress,
    from: 'Hebcal <shabbat-owner@hebcal.com>',
    replyTo: 'no-reply@hebcal.com',
    subject: subject,
    messageId: `<${msgid}@hebcal.com>`,
    headers: {
      'Return-Path': returnPath,
      'Errors-To': returnPath,
      'List-ID': `<${info.id}.list-id.hebcal.com>`,
      'List-Unsubscribe': `<${unsubUrl}&commit=1&cfg=json>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    html: `<div style="font-size:18px;font-family:georgia,'times new roman',times,serif;">
<div>${prefix} occurs on
<time datetime="${observed.format('YYYY-MM-DD')}" ${DATE_STYLE}>${observed.format('dddd, MMMM D')}</time>,
corresponding to the ${hebdate}.</div>
${BLANK}
<div>${typeStr} begins at sundown on the previous day and continues until
sundown on the day of observance.${lightCandle}</div>
${postscript}
</div>
${BLANK}
<div style="font-size:11px;color:#999;font-family:arial,helvetica,sans-serif">
<div>This email was sent to ${emailAddress} by <a href="https://www.hebcal.com/?${UTM_PARAM}">Hebcal.com</a>.
Hebcal is a free Jewish calendar and holiday web site.</div>
${BLANK}
<div><a href="${editUrl}">Edit ${typeStr}</a> |
<a href="${unsubUrl}&amp;cfg=html&amp;${UTM_PARAM}">Unsubscribe</a> |
<a href="https://www.hebcal.com/home/about/privacy-policy?${UTM_PARAM}">Privacy Policy</a></div>
</div>
${imgOpen}
`,
  };
  if (isYahrzeit) {
    const dt = erev.toDate();
    const dow = erev.day();
    const eventTimeStr = dow === 6 ? '20:00' : dow === 5 ? '14:30' : '16:30';
    const ev = new Event(
      new HDate(dt),
      `${info.name} ${typeStr} reminder`,
      flags.USER_EVENT,
      {
        eventTime: dt,
        eventTimeStr,
        memo:
          `Hebcal joins you in ${verb} ${info.name}, whose ${nth} ${typeStr} occurs on ` +
          `${observed.format('dddd, MMMM D')}, corresponding to the ${hebdate}.\\n\\n` +
          `${typeStr} begins at sundown on ${erev.format('dddd, MMMM D')} and continues until ` +
          'sundown on the day of observance. ' +
          `It is customary to light a memorial candle ${when} as the Yahrzeit begins.\\n\\n` +
          'May your loved one’s soul be bound up in the bond of eternal life and may their memory ' +
          'serve as a continued source of inspiration and comfort to you.',
        alarm: 'P0DT0H0M0S',
        uid: `reminder-${info.anniversaryId}`,
        category: 'Personal',
      },
    );
    const ical = new IcalEvent(ev, {});
    const lines =
      [
        'BEGIN:VCALENDAR',
        `PRODID:-//Hebcal//NONSGML Anniversary Email v1${IcalEvent.version()}//EN`,
        'VERSION:2.0',
        'CALSCALE:GREGORIAN',
      ].join('\r\n') +
      '\r\n' +
      ical.toString() +
      '\r\nEND:VCALENDAR\r\n';
    message.attachments = [
      {
        content: lines,
        contentType: 'text/calendar; charset=utf-8',
        filename: 'invite.ics',
      },
    ];
  }
  return message;
}

/**
 * @param {Date} origDt
 * @param {number} hyear
 * @return {string}
 */
function calculateAnniversaryNth(origDt: Date, hyear: number): string {
  const origHd = new HDate(origDt);
  const origHyear = origHd.getFullYear();
  const numYears = hyear - origHyear;
  const nth = Locale.ordinal(numYears);
  return nth;
}

function makeSubject(type: string, observed: dayjs.Dayjs): string {
  const erev = observed.subtract(1, 'day');
  const erevMon = erev.format('MMMM');
  const erevDay = erev.format('D');
  const obsMon = observed.format('MMMM');
  const obsDay = observed.format('D');
  const dateRange =
    erevMon === obsMon
      ? `${erevMon} ${erevDay}-${obsDay}`
      : `${erevMon} ${erevDay}-${obsMon} ${obsDay}`;
  return `${type} Observance for ${dateRange}`;
}

function empty(val: unknown): boolean {
  return typeof val !== 'string' || val.length === 0;
}

function isNumKey(k: string): boolean {
  const code = k.charCodeAt(1);
  return code >= 48 && code <= 57;
}

function getMaxYahrzeitId(query: RawYahrzeitContents): number {
  let max = 0;
  for (const k of Object.keys(query)) {
    const k0 = k[0];
    if ((k0 === 'y' || k0 === 'x') && isNumKey(k)) {
      let id = +k.substring(1);
      if (empty(query[k])) {
        id = 0;
      } else if (
        k0 === 'y' &&
        (empty(query['d' + id]) || empty(query['m' + id]))
      ) {
        id = 0;
      }
      if (id > max) {
        max = id;
      }
    }
  }
  return max;
}

function getAnniversaryType(str: string): string {
  if (typeof str === 'string') {
    const s = str.toLowerCase();
    switch (s[0]) {
      case 'y':
        return 'Yahrzeit';
      case 'b':
        return 'Birthday';
      case 'a':
        return 'Anniversary';
      case 'o':
        return 'Other';
    }
  }
  return 'Yahrzeit';
}

function getYahrzeitDetailForId(
  query: RawYahrzeitContents,
  num: number,
): SubBase | null {
  const {yy, mm, dd} = getDateForId(query, num);
  if (empty(dd) || empty(mm) || empty(yy)) {
    return null;
  }
  const year = parseInt(yy, 10);
  const month = parseInt(mm, 10);
  const mday = parseInt(dd, 10);
  if (!mday || !month || !year) {
    logger.warn(query, `Invalid date for entry ${num}`);
    return null;
  }
  const type = getAnniversaryType(query['t' + num] as string);
  const sunset: string | number = query[`s${num}`];
  const name = getAnniversaryName(query, num, type);
  let day = dayjs(new Date(year, month - 1, mday));
  if (sunset === 'on' || sunset === '1' || sunset === 1) {
    day = day.add(1, 'day');
  }
  const hash = murmur32HexSync([day.format('YYYY-MM-DD'), type].join('-'));
  return {num, dd, mm, yy, sunset, type, name, day, hash};
}

function getAnniversaryName(
  query: RawYahrzeitContents,
  id: number,
  type: string,
): string {
  const str = query[`n${id}`];
  const name0 = typeof str === 'string' ? str.trim() : undefined;
  if (name0) {
    return name0;
  }
  const prefix = type === 'Other' ? 'Untitled' : 'Person';
  return prefix + id;
}

type YearMonthDay = {
  yy: string;
  mm: string;
  dd: string;
};

function getDateForId(query: RawYahrzeitContents, id: number): YearMonthDay {
  const date = query['x' + id];
  if (typeof date === 'string' && date.length === 10) {
    const yy = date.substring(0, 4);
    const gm = date.substring(5, 7);
    const mm = gm.startsWith('0') ? gm[1] : gm;
    const gd = date.substring(8, 10);
    const dd = gd.startsWith('0') ? gd[1] : gd;
    return {yy, mm, dd};
  }
  const yy = query['y' + id] as string;
  const mm = query['m' + id] as string;
  const dd = query['d' + id] as string;
  return {yy, mm, dd};
}

function usage() {
  const PROG = 'yahrzeit_email';
  const usage = `Usage:
    ${PROG} [options] [email_address...]

Options:
  --help           Help
  --dryrun         Prints the actions that ${PROG} would take
                     but does not remove anything
  --quiet          Only emit warnings and errors
  --verbose        Extra debugging information
  --force          Run even if it's not Thursday
  --ini <file>     Use non-default hebcal-dot-com.ini
`;
  console.log(usage);
}
