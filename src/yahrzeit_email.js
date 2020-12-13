import dayjs from 'dayjs';
import fs from 'fs';
import ini from 'ini';
import {HDate, HebrewCalendar, Locale} from '@hebcal/core';
import pino from 'pino';
import minimist from 'minimist';
import {makeDb} from './makedb';
import {getChagOnDate, makeTransporter} from './common';

const argv = minimist(process.argv.slice(2), {
  boolean: ['dryrun', 'quiet', 'help', 'force', 'verbose'],
  alias: {h: 'help', n: 'dryrun', q: 'quiet', f: 'force', v: 'verbose'},
});
if (argv.help) {
  usage();
  process.exit(1);
}

const logger = pino({
  level: argv.verbose ? 'debug' : argv.quiet ? 'warn' : 'info',
  prettyPrint: {translateTime: true, ignore: 'pid,hostname'},
});

let transporter = null;
let db = null;

const today = dayjs(argv.date); // undefined => new Date()
logger.debug(`Today is ${today.format('dddd')}`);
const chag = getChagOnDate(today);
if ((chag || today.day() === 6) && !argv.force) {
  process.exit(0);
}

const BLANK = '<div>&nbsp;</div>';
const UTM_PARAM = 'utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=yahrzeit-' +
  today.format('YYYY-MM-DD');
const YAHRZEIT_POSTSCRIPT = `${BLANK}
<div>
May your loved one’s soul be bound up in the bond of eternal life and may their memory
serve as a continued source of inspiration and comfort to you.
</div>
`;
const DATE_STYLE = `style="color: #941003; white-space: nowrap"`;

let numSent = 0;

main()
    .then(() => {
      if (numSent > 0) {
        logger.info(`Success! Sent ${numSent} messages.`);
      }
      logger.debug('Done.');
    })
    .catch((err) => {
      logger.fatal(err);
      process.exit(1);
    });

/**
 * Sends the message via nodemailer, or no-op for dryrun
 * @param {Object} message
 */
async function sendMail(message) {
  if (argv.dryrun) {
    return {response: '250 OK', messageId: 'dryrun'};
  } else {
    return transporter.sendMail(message);
  }
}

/**
 * Main event loop
 */
async function main() {
  const iniPath = argv.ini || '/etc/hebcal-dot-com.ini';
  logger.debug(`Reading ${iniPath}...`);
  const config = ini.parse(fs.readFileSync(iniPath, 'utf-8'));

  db = makeDb(config);
  transporter = makeTransporter(config);

  const sql = `SELECT e.id, e.email_addr, y.contents
FROM yahrzeit_email e, yahrzeit y
WHERE e.sub_status = 'active'
AND e.calendar_id = y.id`;

  logger.debug(sql);
  const rows = await db.query(sql);
  if (!rows || !rows.length) {
    logger.error('Got zero rows from DB!?');
    db.close();
    return;
  }

  const hyear = new HDate(today.toDate()).getFullYear();

  for (const row of rows) {
    const contents = row.contents;
    contents.id = row.id;
    contents.emailAddress = row.email_addr;
    const maxId = getMaxYahrzeitId(contents);
    for (let num = 1; num <= maxId; num++) {
      const status = await processAnniversary(contents, num, hyear);
      logger.debug(status);
    }
  }

  db.close();
}

/**
 * @param {Object<string,string>} contents
 * @param {number} num
 * @param {number} hyear
 */
async function processAnniversary(contents, num, hyear) {
  const info = getYahrzeitDetailForId(contents, num);
  if (info === null) {
    return {msg: `Skipping blank ${id}.${num}`};
  }
  const id = info.id = contents.id;
  const anniversaryId = info.anniversaryId = `${id}.${num}.${hyear}`;
  const type = info.type;
  const origDt = info.day.toDate();
  const hd = info.hd = (type == 'Yahrzeit') ?
    HebrewCalendar.getYahrzeit(hyear, origDt) :
    HebrewCalendar.getBirthdayOrAnniversary(hyear, origDt);
  if (!hd) {
    return {msg: `No anniversary for ${anniversaryId}`};
  }
  const observed = info.observed = dayjs(hd.greg());
  const diff = info.diff = observed.diff(today, 'd');
  if (diff < 0 || diff > 7) {
    return {msg: `Anniversary ${anniversaryId} occurs in ${diff} days`};
  }
  const sqlSent = 'SELECT sent_date FROM yahrzeit_sent WHERE yahrzeit_id = ? AND num = ? AND hyear = ?';
  logger.debug(sqlSent);
  const sent = await db.query(sqlSent, [id, num, hyear]);
  if (sent && sent.length >= 1) {
    return {msg: `Message for ${anniversaryId} sent on ${sent[0].sent_date}`};
  }

  info.num = num;
  info.emailAddress = contents.emailAddress;
  info.hyear = hyear;
  const message = makeMessage(info);
  await sendMail(message);

  if (!argv.dryrun) {
    const sqlUpdate = 'INSERT INTO yahrzeit_sent (yahrzeit_id, num, hyear, sent_date) VALUES (?, ?, ?, NOW())';
    logger.debug(sqlUpdate);
    await db.query(sqlUpdate, [id, num, hyear]);
  }

  numSent++;
}

/**
 * @param {any} info
 * @return {any}
 */
function makeMessage(info) {
  const type = info.type;
  const isYahrzeit = Boolean(type === 'Yahrzeit');
  const typeStr = isYahrzeit ? type : `Hebrew ${type}`;
  const observed = info.observed;
  const subject = makeSubject(typeStr, observed);
  logger.info(`${info.anniversaryId} - ${info.diff} days - ${subject}`);
  const verb = isYahrzeit ? 'remembering' : 'honoring';
  const postscript = isYahrzeit ? YAHRZEIT_POSTSCRIPT : '';
  const erev = observed.subtract(1, 'day');
  const lightCandle = isYahrzeit ? ` It is customary to light a memorial candle just before sundown on
<time datetime="${erev.format('YYYY-MM-DD')}" ${DATE_STYLE}>${erev.format('dddd, MMMM D')}</time>
as the Yahrzeit begins.` : '';
  const hebdate = info.hd.render('en');
  const origDt = info.day.toDate();
  const nth = calculateAnniversaryNth(origDt, info.hyear);
  const msgid = `${info.anniversaryId}.${new Date().getTime()}`;
  const returnPath = `yahrzeit-return+${info.id}.${info.num}@hebcal.com`;
  const unsubUrl = `https://www.hebcal.com/yahrzeit/email?id=${info.id}&num=${info.num}&unsubscribe=1`;
  const emailAddress = info.emailAddress;
  const message = {
    to: emailAddress,
    from: 'Hebcal <shabbat-owner@hebcal.com>',
    replyTo: 'no-reply@hebcal.com',
    subject: subject,
    messageId: `<${msgid}@hebcal.com>`,
    headers: {
      'Return-Path': returnPath,
      'Errors-To': returnPath,
      'List-ID': `<${info.id}.${info.num}.list-id.hebcal.com>`,
      'List-Unsubscribe': `<${unsubUrl}&commit=1&cfg=json>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    html: `<!DOCTYPE html><html><head><title>${subject}</title></head>
<div style="font-size:18px;font-family:georgia,'times new roman',times,serif;">
<div>Hebcal joins you in ${verb} ${info.name}, whose ${nth} ${typeStr} occurs on
<time datetime="${observed.format('YYYY-MM-DD')}" ${DATE_STYLE}>${observed.format('dddd, MMMM D')}</time>,
corresponding to the ${hebdate}.</div>
${BLANK}
<div>${typeStr} begins at sundown on the previous day and continues until sundown on the day
of observance.${lightCandle}</div>
${postscript}
</div>
${BLANK}
<div style="font-size:11px;color:#999;font-family:arial,helvetica,sans-serif">
<div>This email was sent to ${emailAddress} by <a href="https://www.hebcal.com/?${UTM_PARAM}">Hebcal.com</a>.
Hebcal is a free Jewish calendar and holiday web site.</div>
${BLANK}
<div><a href="${unsubUrl}&amp;cfg=html&amp;${UTM_PARAM}">Unsubscribe</a> |
<a href="https://www.hebcal.com/home/about/privacy-policy?${UTM_PARAM}">Privacy Policy</a></div>
</div>
</body></html>
`,
  };
  return message;
}

/**
 * @param {Date} origDt
 * @param {number} hyear
 * @return {string}
 */
function calculateAnniversaryNth(origDt, hyear) {
  const origHd = new HDate(origDt);
  const origHyear = origHd.getFullYear();
  const numYears = hyear - origHyear;
  const nth = Locale.ordinal(numYears);
  return nth;
}

/**
 * @param {string} type
 * @param {dayjs.Dayjs} observed
 * @return {string}
 */
function makeSubject(type, observed) {
  const erev = observed.subtract(1, 'day');
  const erevMon = erev.format('MMMM');
  const erevDay = erev.format('D');
  const obsMon = observed.format('MMMM');
  const obsDay = observed.format('D');
  const dateRange = (erevMon === obsMon) ?
    `${erevMon} ${erevDay}-${obsDay}` : `${erevMon} ${erevDay}-${obsMon} ${obsDay}`;
  return `${type} Observance for ${dateRange}`;
}

/**
 * @param {*} val
 * @return {boolean}
 */
function empty(val) {
  return typeof val !== 'string' || val.length === 0;
}

/**
 * @param {string} k
 * @return {boolean}
 */
function isNumKey(k) {
  const code = k.charCodeAt(1);
  return code >= 48 && code <= 57;
}

/**
 * @param {Object<string,string>} query
 * @return {number}
 */
function getMaxYahrzeitId(query) {
  const ids = Object.keys(query)
      .filter((k) => k[0] == 'y' && isNumKey(k))
      .map((k) => +(k.substring(1)))
      .map((id) => empty(query['y' + id]) ? 0 : id);
  const max = Math.max(...ids);
  const valid = [];
  for (let i = 1; i <= max; i++) {
    if (!empty(query['d' + i]) && !empty(query['m' + i]) && !empty(query['y' + i])) {
      valid.push(i);
    }
  }
  return valid.length === 0 ? 0 : Math.max(...valid);
}

/**
 * @param {Object<string,string>} query
 * @param {number} id
 * @return {*}
 */
function getYahrzeitDetailForId(query, id) {
  const dd = query[`d${id}`];
  const mm = query[`m${id}`];
  const yy = query[`y${id}`];
  if (empty(dd) || empty(mm) || empty(yy)) {
    return null;
  }
  const type = query[`t${id}`] || 'Yahrzeit';
  const sunset = query[`s${id}`];
  const name = query[`n${id}`] ? query[`n${id}`].trim() : `Person${id}`;
  let day = dayjs(new Date(yy, mm - 1, dd));
  if (sunset === 'on') {
    day = day.add(1, 'day');
  }
  return {dd, mm, yy, sunset, type, name, day};
}

// eslint-disable-next-line require-jsdoc
function usage() {
  const PROG = 'yahrzeit_email.js';
  const usage = `Usage:
    ${PROG} [options] [email_address...]

Options:
  --help           Help
  --dryrun         Prints the actions that ${PROG} would take
                     but does not remove anything
  --quiet          Only emit warnings and errors
`;
  console.log(usage);
}
