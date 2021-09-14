import dayjs from 'dayjs';
import fs from 'fs';
import ini from 'ini';
import {flags, HDate, HebrewCalendar, months} from '@hebcal/core';
import pino from 'pino';
import {flock} from 'fs-ext';
import mysql from 'mysql2';
import minimist from 'minimist';
import {GeoDb} from '@hebcal/geo-sqlite';
import {dirIfExistsOrCwd} from './makedb';
import {shouldSendEmailToday, makeTransporter} from './common';
import {appendIsraelAndTracking} from '@hebcal/rest-api';

const argv = minimist(process.argv.slice(2), {
  boolean: ['dryrun', 'quiet', 'help', 'force', 'verbose'],
  alias: {h: 'help', n: 'dryrun', q: 'quiet', f: 'force', v: 'verbose'},
});
if (argv.help) {
  usage();
  process.exit(1);
}
// allow sleeptime=0 for no sleep
argv.sleeptime = typeof argv.sleeptime === 'undefined' ? 300 : +argv.sleeptime;

const logger = pino({
  level: argv.verbose ? 'debug' : argv.quiet ? 'warn' : 'info',
  prettyPrint: {translateTime: true, ignore: 'pid,hostname'},
});

const TODAY0 = dayjs(argv.date); // undefined => new Date()
const TODAY = TODAY0.toDate();
logger.debug(`Today is ${TODAY0.format('dddd')}`);
if (!shouldSendEmailToday(TODAY0) && !argv.force) {
  process.exit(0);
}
const [midnight, endOfWeek] = getStartAndEnd(TODAY);

const FORMAT_DOW_MONTH_DAY = 'dddd, MMMM D';

main()
    .then(() => {
      logger.info('Success!');
    })
    .catch((err) => {
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
    logger.info(`Skipping ${alreadySent.size} users from previous run`);
    alreadySent.forEach((x) => subs.delete(x));
  }

  // open the database
  const lockfile = fs.openSync('/tmp/hebcal-shabbat-weekly.lock', 'w');
  await flock(lockfile, 'ex');

  const dbdir = await dirIfExistsOrCwd('/usr/lib/hebcal');
  const zipsFilename = `${dbdir}/zips.sqlite3`;
  const geonamesFilename = `${dbdir}/geonames.sqlite3`;
  const geoDb = new GeoDb(logger, zipsFilename, geonamesFilename);

  parseAllConfigs(subs, geoDb);

  geoDb.close();

  logger.info(`Sorting ${subs.size} users by lat/long`);
  const cfgs = Array.from(subs.values());
  cfgs.sort((a, b) => {
    const alon = a.location.getLongitude();
    const blon = b.location.getLongitude();
    if (alon === blon) {
      const alat = a.location.getLatitude();
      const blat = b.location.getLatitude();
      if (alat === blat) {
        return a.location.getName().localeCompare(b.location.getName());
      } else {
        return alat - blat;
      }
    } else {
      return blon - alon;
    }
  });

  const transporter = makeTransporter(config);
  const logStream = fs.createWriteStream(sentLogFilename, {flags: 'a'});
  const count = cfgs.length;
  logger.info(`About to mail ${count} users`);
  let i = 0;
  for (const cfg of cfgs) {
    if ((i % 200 === 0) || i === count - 1) {
      const cityDescr = cfg.location.getName();
      logger.info(`Sending mail #${i+1}/${count} (${cityDescr})`);
    }
    const info = await mailUser(transporter, cfg);
    if (!argv.dryrun) {
      writeLogLine(logStream, cfg, info);
    }
    if (argv.sleeptime && i != count - 1) {
      msleep(argv.sleeptime);
    }
    i++;
  }
  logger.info(`Sent ${count} messages`);
  logStream.end();

  await flock(lockfile, 'un');
  fs.closeSync(lockfile);
}

/**
 * @param {fs.WriteStream} logStream
 * @param {Object} cfg
 * @param {Object} info
 */
function writeLogLine(logStream, cfg, info) {
  const location = cfg.zip || cfg.geonameid || cfg.legacyCity;
  const mid = info.messageId.substring(1, info.messageId.indexOf('@'));
  const status = Number(info.response.startsWith('250'));
  logStream.write(`${mid}:${status}:${cfg.email}:${location}\n`);
}

/**
 * Gets start and end days for filtering relevant hebcal events
 * @param {Date} now
 * @return {dayjs.Dayjs[]}
 */
function getStartAndEnd(now) {
  const midnight = dayjs(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  const dow = midnight.day();
  const saturday = midnight.add(6 - dow, 'day');
  const sixDaysAhead = midnight.add(6, 'day');
  const endOfWeek = sixDaysAhead.isAfter(saturday) ? sixDaysAhead : saturday;
  return [midnight, endOfWeek];
}

/**
 * sleep for n miliseconds
 * @param {number} n
 */
function msleep(n) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
}

/**
 * mails the user
 * @param {nodemailer.Mail} transporter
 * @param {any} cfg
 * @return {Object}
 */
function mailUser(transporter, cfg) {
  const message = getMessage(cfg);
  if (argv.dryrun) {
    return undefined;
  }
  return transporter.sendMail(message);
}

/**
 * creates a message object
 * @param {any} cfg
 * @return {any}
 */
function getMessage(cfg) {
  const [subj, body0, htmlBody0, specialNote] = getSubjectAndBody(cfg);

  const encoded = encodeURIComponent(Buffer.from(cfg.email).toString('base64'));
  const unsubUrl = `https://www.hebcal.com/email?e=${encoded}`;

  const cityDescr = cfg.location.getName();
  const body = body0 + `
These times are for ${cityDescr}.

Shabbat Shalom,
hebcal.com

To modify your subscription or to unsubscribe completely, visit:
${unsubUrl}
`;

  const urls = {
    home: urlEncodeAndTrack('https://www.hebcal.com/'),
    unsub: urlEncodeAndTrack(`${unsubUrl}&unsubscribe=1`),
    modify: urlEncodeAndTrack(`${unsubUrl}&modify=1`),
    privacy: urlEncodeAndTrack('https://www.hebcal.com/home/about/privacy-policy'),
  };

  const htmlBody = `<!DOCTYPE html><html><head><title>Hebcal Shabbat Times</title></head>
<body>${specialNote}
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
<div>This email was sent to ${cfg.email} by <a href="${urls.home}">Hebcal.com</a></div>
${BLANK}
<div><a href="${urls.unsub}">Unsubscribe</a> |
 <a href="${urls.modify}">Update Settings</a> |
 <a href="${urls.privacy}">Privacy Policy</a></div>
</div>
</body></html>
`;

  const msgid = cfg.id + '.' + new Date().getTime();
  const unsubAddr = `shabbat-unsubscribe+${cfg.id}@hebcal.com`;
  const returnPath = 'shabbat-return+' + cfg.email.replace('@', '=') + '@hebcal.com';
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

let prevCfg;
let prevSubjAndBody;

/**
 * looks up or generates subject and body
 * @param {any} cfg
 * @return {string[]}
 */
function getSubjectAndBody(cfg) {
  const location = cfg.location;
  if (prevCfg &&
      cfg.m === prevCfg.m &&
      cfg.M === prevCfg.M &&
      cfg.b === prevCfg.b &&
      location.geoid === prevCfg.location.geoid) {
    return prevSubjAndBody;
  }
  const options = {
    start: midnight.toDate(),
    end: endOfWeek.toDate(),
    location: location,
    candlelighting: true,
    candleLightingMins: cfg.b,
    il: location.getIsrael(),
    sedrot: true,
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

/**
 * @param {Event[]} events
 * @param {HebrewCalendar.Options} options
 * @param {any} cfg
 * @return {string[]}
 */
function genSubjectAndBody(events, options, cfg) {
  let body = '';
  let htmlBody = '';
  let firstCandles;
  let sedra;
  let prevStrtime;
  for (const ev of events) {
    const timed = Boolean(ev.eventTime);
    const title = timed ? ev.renderBrief() : ev.render();
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
      const hourMin = HebrewCalendar.reformatTimeStr(ev.eventTimeStr, 'pm', options);
      if (!firstCandles && desc === 'Candle lighting') {
        firstCandles = hourMin;
      }
      const verb = (desc === 'Candle lighting' || desc === 'Havdalah') ? ' is' : '';
      body += `  ${title}${verb} at ${hourMin}\n`;
      const emojiSuffix = (mask & flags.CHANUKAH_CANDLES) ? ` ${emoji}` : '';
      htmlBody += `<div style="${ITEM_STYLE}">${title}${verb} at <strong>${hourMin}</strong>${emojiSuffix}</div>\n`;
    } else if (mask === flags.PARSHA_HASHAVUA) {
      sedra = title.substring(title.indexOf(' ') + 1);
      body += `  Torah portion: ${title}\n`;
      const url = ev.url();
      const url2 = urlEncodeAndTrack(url, options.il);
      htmlBody += `<div style="${ITEM_STYLE}">Torah portion: <a href="${url2}">${title}</a></div>\n`;
    } else {
      const dow = dt.day();
      if (dow === 6 && !sedra && (mask & flags.CHAG || ev.cholHaMoedDay)) {
        sedra = ev.basename();
      }
      body += `  ${title}\n`;
      const url = ev.url();
      const url2 = urlEncodeAndTrack(url, options.il);
      const emojiSuffix = emoji ? ` ${emoji}` : '';
      htmlBody += `<div style="${ITEM_STYLE}"><a href="${url2}">${title}</a>${emojiSuffix}</div>\n`;
    }
  }
  const shortLocation = cfg.location.getShortName();
  let subject = '🕯️';
  if (sedra) subject += ` ${sedra} -`;
  subject += ' ' + shortLocation;
  if (firstCandles) subject += ` candles ${firstCandles}`;

  const specialNote = getSpecialNote(cfg, shortLocation);
  return [subject, body, htmlBody, specialNote];
}

const UTM_CAMPAIGN = '&utm_campaign=shabbat-' + dayjs(TODAY).format('YYYY-MM-DD');

/**
 * @param {string} url
 * @param {boolean} il
 * @return {string}
 */
function urlEncodeAndTrack(url, il) {
  const str = appendIsraelAndTracking(url, il, 'newsletter', 'email') + UTM_CAMPAIGN;
  return str.replace(/&/g, '&amp;');
}

/**
 * @param {any} cfg
 * @param {string} shortLocation
 * @return {string}
 */
function getSpecialNote(cfg, shortLocation) {
  const hd = new HDate(TODAY);
  const mm = hd.getMonth();
  const dd = hd.getDate();
  const yy = hd.getFullYear();
  const purimMonth = HDate.isLeapYear(yy) ? months.ADAR_II : months.ADAR_I;
  const gy = TODAY0.year();

  // eslint-disable-next-line require-jsdoc
  function makeUrl(holiday) {
    const il = cfg.location.getIsrael();
    return urlEncodeAndTrack(`https://www.hebcal.com/holidays/${holiday}-${gy}`, il);
  }

  let note;
  if ((mm === months.AV && dd >= 16 && dd <= 26) || (mm === months.ELUL && dd >= 16 && dd <= 26)) {
    // for a week or two in Av and the last week or two of Elul
    const nextYear = yy + 1;
    const fridgeLoc = cfg.zip ? `zip=${cfg.zip}` : `geonameid=${cfg.geonameid}`;
    const erevRH = dayjs(new HDate(1, months.TISHREI, nextYear).prev().greg());
    const strtime = erevRH.format(FORMAT_DOW_MONTH_DAY);
    let url = `https://www.hebcal.com/shabbat/fridge.cgi?${fridgeLoc}&b=${cfg.b}&year=${nextYear}`;
    if (cfg.m) {
      url += `&m=${cfg.m}`;
    } else if (cfg.M) {
      url += `&M=on`;
    }
    url = urlEncodeAndTrack(url);
    note = `Shana Tova! We wish you a happy and healthy New Year.
<br>Rosh Hashana ${nextYear} begins at sundown on ${strtime}.
<br>Print your <a
style="color:#356635" href="${url}">${shortLocation} ${nextYear} candle-lighting times</a>
and post it on your refrigerator.`;
  } else if (yy === 5782 && mm === months.TISHREI && dd <= 9) {
    note = `G’mar Chatima Tova! We wish you a good inscription in the Book of Life.
<br><br>We’re pleased to announce the
<a href="https://www.hebcal.com/home/3744/hebcal-for-apple-watch-beta">Hebcal on the Apple Watch</a>
public beta! If you have an Apple Watch, please sign up and share your feedback.
<br><br>iPhone and Android apps will come eventually. Please stay tuned!`;
  } else if (mm === months.TISHREI && dd <= 9) {
    // between RH & YK
    const erevYK = dayjs(new HDate(9, months.TISHREI, yy).greg());
    const strtime = erevYK.format(FORMAT_DOW_MONTH_DAY);
    note = `G’mar Chatima Tova! We wish you a good inscription in the Book of Life.
<br><a style="color:#356635" href="${makeUrl('yom-kippur')}">Yom Kippur ${yy}</a>
begins at sundown on ${strtime}.`;
  } else if ((mm === months.TISHREI && dd >= 17 && dd <= 21) || (mm === months.NISAN && dd >= 17 && dd <= 20)) {
    const holiday = mm === months.TISHREI ? 'Sukkot' : 'Pesach';
    note = `Moadim L’Simcha! We wish you a very happy ${holiday}.`;
  } else if (mm === purimMonth && dd >= 2 && dd <= 10) {
    // show Purim greeting 1.5 weeks before
    const erevPurim = dayjs(new HDate(13, purimMonth, yy).greg());
    const strtime = erevPurim.format(FORMAT_DOW_MONTH_DAY);
    note = `Chag Purim Sameach!
<a style="color:#356635" href="${makeUrl('purim')}">Purim ${yy}</a>
begins at sundown on ${strtime}.`;
  } else if ((mm === purimMonth && dd >= 17 && dd <= 25) || (mm === months.NISAN && dd >= 2 && dd <= 9)) {
    // show Pesach greeting shortly after Purim and ~2 weeks before
    const erevPesach = dayjs(new HDate(14, months.NISAN, yy).greg());
    const strtime = erevPesach.format(FORMAT_DOW_MONTH_DAY);
    note = `Chag Kasher v’Sameach! We wish you a happy
<a style="color:#356635" href="${makeUrl('pesach')}">Pesach ${yy}</a>.
<br>Passover begins at sundown on ${strtime}.`;
  } else if (mm === months.KISLEV && dd >= 1 && dd <= 13) {
    // for the first 2 weeks of Kislev, show Chanukah greeting
    const erevChanukah = dayjs(new HDate(24, months.KISLEV, yy).greg());
    const dow = erevChanukah.day();
    const strtime = erevChanukah.format(FORMAT_DOW_MONTH_DAY);
    const when = dow === 5 ? 'before sundown' : dow === 6 ? 'at nightfall' : 'at sundown';
    note = `Chag Urim Sameach! Light the first
<a style="color:#356635" href="${makeUrl('chanukah')}">Chanukah candle</a>
${when} on ${strtime}.`;
  }

  if (!note) {
    return '';
  }

  // eslint-disable-next-line max-len
  return '<div style="font-size:14px;font-family:arial,helvetica,sans-serif;padding:8px;color:#468847;background-color:#dff0d8;border-color:#d6e9c6;border-radius:4px">\n' +
    note + `\n</div>\n${BLANK}\n`;
}

/**
 * @param {Map<string,any>} config
 * @param {string[]} addrs
 */
async function loadSubs(config, addrs) {
  const connection = mysql.createConnection({
    host: config['hebcal.mysql.host'],
    user: config['hebcal.mysql.user'],
    password: config['hebcal.mysql.password'],
    database: config['hebcal.mysql.dbname'],
  });
  connection.connect(function(err) {
    if (err) {
      logger.fatal(err);
      throw err;
    }
    logger.debug('connected as id ' + connection.threadId);
  });
  const allSql = addrs && addrs.length ?
    'AND email_address IN (\'' + addrs.join('\',\'') + '\')' :
    '';
  const sql = `SELECT email_address,
       email_id,
       email_candles_zipcode,
       email_candles_city,
       email_candles_geonameid,
       email_candles_havdalah,
       email_havdalah_tzeit,
       email_sundown_candles
FROM hebcal_shabbat_email
WHERE email_status = 'active'
AND email_ip IS NOT NULL
${allSql}`;
  logger.info(sql);
  return new Promise((resolve, reject) => {
    connection.query(sql, function(error, results) {
      if (error) return reject(error);
      const subs = new Map();
      for (const row of results) {
        const email = row.email_address;
        const cfg = {
          id: row.email_id,
          email: email,
          m: row.email_candles_havdalah,
          M: Boolean(row.email_havdalah_tzeit),
          b: row.email_sundown_candles,
        };
        if (row.email_candles_zipcode) {
          cfg.zip = row.email_candles_zipcode;
        } else if (row.email_candles_geonameid) {
          cfg.geonameid = row.email_candles_geonameid;
        } else if (row.email_candles_city) {
          cfg.legacyCity = row.email_candles_city.replace(/\+/g, ' ');
        } else {
          logger.warn(`no geographic key for to=${email}, id=${cfg.id}`);
          continue;
        }
        subs.set(email, cfg);
      }
      connection.end();
      return resolve(subs);
    });
  });
}

/**
 * Reads the previous log and returns any successful email adresses to skip
 * @param {string} sentLogFilename
 * @return {Set<string>}
 */
function loadSentLog(sentLogFilename) {
  const result = new Set();
  let lines;
  try {
    lines = fs.readFileSync(sentLogFilename, 'utf-8').split('\n');
  } catch (error) {
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
 * @param {string} to
 * @param {Object} cfg
 * @param {GeoDb} geoDb
 * @return {boolean}
 */
function parseConfig(to, cfg, geoDb) {
  const location = cfg.zip ? geoDb.lookupZip(cfg.zip) :
    cfg.legacyCity ? geoDb.lookupLegacyCity(cfg.legacyCity) :
    cfg.geonameid ? geoDb.lookupGeoname(cfg.geonameid) :
    null;

  if (!location) {
    logger.warn('Skipping bad config: ' + JSON.stringify(cfg));
    return false;
  } else if (location.getLongitude() === 0 && location.getLongitude === 0) {
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
 * @param {Map<string,any>} subs
 * @param {GeoDb} geoDb
 */
function parseAllConfigs(subs, geoDb) {
  logger.info('Parsing all configs');
  const failures = [];
  for (const [to, cfg] of subs.entries()) {
    if (!parseConfig(to, cfg, geoDb)) {
      failures.push(to);
    }
  }
  if (failures.length) {
    failures.forEach((x) => subs.delete(x));
    logger.warn(`Skipped ${failures.length} subscribers due to config failures`);
  }
}

// eslint-disable-next-line require-jsdoc
function usage() {
  const PROG = 'shabbat_weekly.js';
  const usage = `Usage:
    ${PROG} [options] [email_address...]

Options:
  --help           Help
  --dryrun         Prints the actions that ${PROG} would take
                     but does not remove anything
  --quiet          Only emit warnings and errors
  --sleeptime <n>  Sleep <n> milliseconds between email (default 300)
`;
  console.log(usage);
}
