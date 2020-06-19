import Database from 'better-sqlite3';
import dayjs from 'dayjs';
import fs from 'fs';
import ini from 'ini';
import {flags, HDate, Event, holidays, hebcal, Location} from '@hebcal/core';
import pino from 'pino';
import {flock} from 'fs-ext';
import mysql from 'mysql';
import nodemailer from 'nodemailer';
import minimist from 'minimist';
import {dirIfExistsOrCwd} from './makedb';
const city2geonameid = require('./city2geonameid.json');

const argv = minimist(process.argv.slice(2), {
  boolean: ['dryrun', 'quiet', 'help'],
  alias: {h: 'help', n: 'dryrun', q: 'quiet'},
});
if (argv.help) {
  usage();
  process.exit(1);
}
// allow sleeptime=0 for no sleep
argv.sleeptime = typeof argv.sleeptime == 'undefined' ? 300 : +argv.sleeptime;

const logger = pino({
  level: argv.quiet ? 'warn' : 'info',
  prettyPrint: {translateTime: true, ignore: 'pid,hostname'},
});

logger.info('hello world');

const TODAY0 = dayjs(argv.date); // undefined => new Date()
const TODAY = TODAY0.toDate();
exitIfYomTov(TODAY);
const [midnight, endOfWeek] = getStartAndEnd(TODAY);

const UTM_PARAM = 'utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=shabbat-' +
  dayjs(TODAY).format('YYYY-MM-DD');

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
  const iniPath = argv.ini || '/home/hebcal/local/etc/hebcal-dot-com.ini';
  logger.info(`Reading ${iniPath}...`);
  const config = ini.parse(fs.readFileSync(iniPath, 'utf-8'));
  const subs = await loadSubs(config, argv._);
  logger.info(`Loaded ${subs.size} users`);

  const logdir = await dirIfExistsOrCwd('/home/hebcal/local/var/log');
  const sentLogFilename = logdir + '/shabbat-' + TODAY0.format('YYYYMMDD');

  const alreadySent = loadSentLog(sentLogFilename);
  logger.info(`Skipping ${alreadySent.size} users from previous run`);
  alreadySent.forEach((x) => subs.delete(x));

  // open the database
  const lockfile = fs.openSync('/tmp/hebcal-shabbat-weekly.lock', 'w');
  await flock(lockfile, 'ex');

  const zipsFilename = 'zips.sqlite3';
  logger.info(`Opening ${zipsFilename}...`);
  const zipsDb = new Database(zipsFilename, {fileMustExist: true});

  const geonamesFilename = 'geonames.sqlite3';
  logger.info(`Opening ${geonamesFilename}...`);
  const geonamesDb = new Database(geonamesFilename, {fileMustExist: true});

  parseAllConfigs(subs, zipsDb, geonamesDb);

  zipsDb.close();
  geonamesDb.close();

  logger.info(`Sorting ${subs.size} users by lat/long`);
  const cfgs = Array.from(subs.values());
  cfgs.sort((a, b) => {
    if (a.longitude == b.longitude) {
      if (a.latitude == b.latitude) {
        return a.cityDescr.localeCompare(b.cityDescr);
      } else {
        return a.latitude - b.latitude;
      }
    } else {
      return b.longitude - a.longitude;
    }
  });

  // create reusable transporter object using the default SMTP transport
  const transporter = nodemailer.createTransport({
    host: config['hebcal.email.shabbat.host'],
    port: 465,
    secure: true,
    auth: {
      user: config['hebcal.email.shabbat.user'],
      pass: config['hebcal.email.shabbat.password'],
    },
    tls: {
      // do not fail on invalid certs
      rejectUnauthorized: false,
    },
  });
  const logStream = fs.createWriteStream(sentLogFilename, {flags: 'a'});
  const count = cfgs.length;
  logger.info(`About to mail ${count} users`);
  let i = 0;
  for (const cfg of cfgs) {
    if ((i % 200 == 0) || i == count - 1) {
      logger.info(`Sending mail #${i+1}/${count} (${cfg.cityDescr})`);
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
  const location = cfg.zip || cfg.geonameid;
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
  const fiveDaysAhead = midnight.add(5, 'day');
  const endOfWeek = fiveDaysAhead.isAfter(saturday) ? fiveDaysAhead : saturday;
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
 * Bails out if today is a holiday
 * @param {Date} d
 */
function exitIfYomTov(d) {
  const todayEvents = holidays.getHolidaysOnDate(new HDate(d)) || [];
  const chag = todayEvents.find((ev) => ev.getFlags() & flags.CHAG);
  if (chag) {
    const desc = ev.getDesc();
    logger.info(`Today is ${desc}; exiting due to holiday...`);
    process.exit(0);
  }
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
  const [subj, body0, htmlBody0] = getSubjectAndBody(cfg);

  const encoded = encodeURIComponent(Buffer.from(cfg.email).toString('base64'));
  const unsubUrl = `https://www.hebcal.com/email/?e=${encoded}`;

  const body = body0 + `
These times are for ${cfg.cityDescr}.

Shabbat Shalom,
hebcal.com

To modify your subscription or to unsubscribe completely, visit:
${unsubUrl}
`;

  const htmlBody = `<!DOCTYPE html><html><head><title>Hebcal Shabbat Times</title></head>
<body>
<div style="font-size:18px;font-family:georgia,'times new roman',times,serif;">
${htmlBody0}
<div style="font-size:16px">
<div>These times are for ${cfg.cityDescr}.</div>
${BLANK}
<div>Shabbat Shalom!</div>
${BLANK}
</div>
</div>
<div style="font-size:11px;color:#999;font-family:arial,helvetica,sans-serif">
<div>This email was sent to ${cfg.email} by <a href="https://www.hebcal.com/?${UTM_PARAM}">Hebcal.com</a></div>
${BLANK}
<div><a href="${unsubUrl}&amp;unsubscribe=1&amp;${UTM_PARAM}">Unsubscribe</a> |
 <a href="${unsubUrl}&amp;modify=1&amp;${UTM_PARAM}">Update Settings</a> |
 <a href="https://www.hebcal.com/home/about/privacy-policy?${UTM_PARAM}">Privacy Policy</a></div>
</div>
</body></html>
`;

  const msgid = cfg.id + '.' + new Date().getTime();
  const unsubAddr = `shabbat-unsubscribe+${cfg.id}@hebcal.com`;
  const returnPath = 'shabbat-return+' + cfg.email.replace('@', '=') + '@hebcal.com';
  const message = {
    from: 'Hebcal <shabbat-owner@hebcal.com>',
    replyTo: 'no-reply@hebcal.com',
    to: cfg.email,
    subject: subj,
    messageId: `<${msgid}@hebcal.com>`,
    headers: {
      'Return-Path': returnPath,
      'Errors-To': returnPath,
      'List-Unsubscribe': `<mailto:${unsubAddr}>`,
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
  if (prevCfg && cfg.m == prevCfg.m &&
    ((cfg.geonameid && cfg.geonameid == prevCfg.geonameid) ||
    (cfg.zip && cfg.zip == prevCfg.zip))) {
    return prevSubjAndBody;
  }
  const comma = cfg.cityDescr.indexOf(',');
  const shortLocation = comma == -1 ? cfg.cityDescr : cfg.cityDescr.substring(0, comma);
  const location = new Location(cfg.latitude, cfg.longitude, cfg.il, cfg.tzid,
      cfg.cityName, cfg.cc, cfg.zip || cfg.geonameid);
  const options = {
    start: midnight.toDate(),
    end: endOfWeek.toDate(),
    location: location,
    candlelighting: true,
    havdalahMins: cfg.m,
    il: cfg.il,
    sedrot: true,
  };
  const events = hebcal.hebrewCalendar(options);
  const subjAndBody = genSubjectAndBody(events, options, shortLocation);
  prevSubjAndBody = subjAndBody;
  prevCfg = cfg;
  return subjAndBody;
}

const BLANK = '<div>&nbsp;</div>';

/**
 * @param {Event[]} events
 * @param {hebcal.HebcalOptions} options
 * @param {string} shortLocation
 * @return {string[]}
 */
function genSubjectAndBody(events, options, shortLocation) {
  let body = '';
  let htmlBody = '';
  let firstCandles;
  let sedra;
  const holidaySeen = {};
  for (const ev of events) {
    const desc = ev.render();
    const dt = dayjs(ev.getDate().greg());
    const mask = ev.getFlags();
    const attrs = ev.getAttrs();
    const strtime = dt.format('dddd, MMMM DD');
    if (desc.startsWith('Candle lighting') || desc.startsWith('Havdalah')) {
      const hourMin = hebcal.reformatTimeStr(attrs.eventTimeStr, 'pm', options);
      const shortDesc = desc.substring(0, desc.indexOf(':'));
      if (!firstCandles && shortDesc == 'Candle lighting') {
        firstCandles = hourMin;
      }
      body += `${shortDesc} is at ${hourMin} on ${strtime}\n`;
      htmlBody += `<div>${shortDesc} is at <strong>${hourMin}</strong> on ${strtime}.</div>\n${BLANK}`;
    } else if (mask == flags.PARSHA_HASHAVUA) {
      sedra = desc.substring(desc.indexOf(' ') + 1);
      body += `This week's Torah portion is ${desc}\n`;
      const url = hebcal.getEventUrl(ev);
      body += `  ${url}\n`;
      htmlBody += `<div>This week's Torah portion is <a href="${url}?${UTM_PARAM}">${desc}</a>.</div>\n${BLANK}`;
    } else {
      const dow = dt.day();
      if (dow == 6 && !sedra && (mask & flags.CHAG || attrs.cholHaMoedDay)) {
        sedra = hebcal.getHolidayBasename(desc);
      }
      body += `${desc} occurs on ${strtime}\n`;
      const url = hebcal.getEventUrl(ev);
      if (url && !holidaySeen[url]) {
        body += `  ${url}\n`;
        holidaySeen[url] = true;
      }
      htmlBody += `<div><a href="${url}?${UTM_PARAM}">${desc}</a> occurs on ${strtime}.</div>\n${BLANK}`;
    }
  }
  let subject = '[shabbat]';
  if (sedra) subject += ` ${sedra} -`;
  subject += ' ' + shortLocation;
  if (firstCandles) subject += ` candles ${firstCandles}`;

  return [subject, body, htmlBody];
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
       email_candles_havdalah
FROM hebcal_shabbat_email
WHERE hebcal_shabbat_email.email_status = 'active'
AND hebcal_shabbat_email.email_ip IS NOT NULL
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
        };
        if (row.email_candles_zipcode) {
          cfg.zip = row.email_candles_zipcode;
        } else if (row.email_candles_geonameid) {
          cfg.geonameid = row.email_candles_geonameid;
        } else if (row.email_candles_city) {
          const cityName = row.email_candles_city.replace(/\+/g, ' ');
          const geonameid = city2geonameid[cityName];
          if (geonameid) {
            cfg.geonameid = geonameid;
          } else {
            logger.warn(`unknown city=${cityName} for to=${email}, id=${cfg.id}`);
            continue;
          }
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

// Zip-Codes.com TimeZone IDs
const ZIPCODES_TZ_MAP = {
  '0': 'UTC',
  '4': 'America/Puerto_Rico', // Atlantic (GMT -04:00)
  '5': 'America/New_York', //    Eastern  (GMT -05:00)
  '6': 'America/Chicago', //     Central  (GMT -06:00)
  '7': 'America/Denver', //      Mountain (GMT -07:00)
  '8': 'America/Los_Angeles', // Pacific  (GMT -08:00)
  '9': 'America/Anchorage', //   Alaska   (GMT -09:00)
  '10': 'Pacific/Honolulu', //   Hawaii-Aleutian Islands (GMT -10:00)
  '11': 'Pacific/Pago_Pago', //  American Samoa (GMT -11:00)
  '13': 'Pacific/Funafuti', //   Marshall Islands (GMT +12:00)
  '14': 'Pacific/Guam', //       Guam     (GMT +10:00)
  '15': 'Pacific/Palau', //      Palau    (GMT +9:00)
};

/**
 * @param {string} state
 * @param {number} tz
 * @param {string} dst
 * @return {string}
 */
function getUsaTzid(state, tz, dst) {
  if (tz == 10 && state == 'AK') {
    return 'America/Adak';
  } else if (tz == 7 && state == 'AZ') {
    return dst == 'Y' ? 'America/Denver' : 'America/Phoenix';
  } else {
    return ZIPCODES_TZ_MAP[tz];
  }
}

/**
 * @param {string} name
 * @param {string} admin1
 * @param {string} country
 * @return {string}
 */
function geonameCityDescr(name, admin1, country) {
  if (country == 'United States') country = 'USA';
  if (country == 'United Kingdom') country = 'UK';
  let cityDescr = name;
  if (admin1 && !admin1.startsWith(name) && country != 'Israel') {
    cityDescr += ', ' + admin1;
  }
  if (country) {
    cityDescr += ', ' + country;
  }
  return cityDescr;
}

const GEONAME_SQL = `SELECT
  g.name as name,
  g.asciiname as asciiname,
  g.country as cc,
  c.country as country,
  a.asciiname as admin1,
  g.latitude as latitude,
  g.longitude as longitude,
  g.timezone as timezone
FROM geoname g
LEFT JOIN country c on g.country = c.iso
LEFT JOIN admin1 a on g.country||'.'||g.admin1 = a.key
WHERE g.geonameid = ?
`;

const ZIPCODE_SQL = `SELECT CityMixedCase,State,Latitude,Longitude,TimeZone,DayLightSaving
FROM ZIPCodes_Primary WHERE ZipCode = ?`;

/**
 * Scans subs map and removes invalid entries
 * @param {string} to
 * @param {Object} cfg
 * @param {*} zipStmt
 * @param {*} geonamesStmt
 * @return {boolean}
 */
function parseConfig(to, cfg, zipStmt, geonamesStmt) {
  if (cfg.zip) {
    const result = zipStmt.get(cfg.zip);
    if (!result) {
      logger.warn(`unknown zipcode=${cfg.zip} for to=${to}, id=${cfg.id}`);
      return false;
    } else if (!result.Latitude && !result.Longitude) {
      logger.warn(`zero lat/long zipcode=${cfg.zip} for to=${to}, id=${cfg.id}`);
      return false;
    }
    cfg.latitude = result.Latitude;
    cfg.longitude = result.Longitude;
    cfg.tzid = getUsaTzid(result.State, result.TimeZone, result.DayLightSaving);
    cfg.cc = 'US';
    cfg.il = false;
    cfg.cityDescr = `${result.CityMixedCase}, ${result.State} ${cfg.zip}`;
  } else if (cfg.geonameid) {
    const result = geonamesStmt.get(cfg.geonameid);
    if (!result) {
      logger.warn(`unknown geonameid=${cfg.geonameid} for to=${to}, id=${cfg.id}`);
      return false;
    }
    cfg.latitude = result.latitude;
    cfg.longitude = result.longitude;
    cfg.tzid = result.timezone;
    cfg.cc = result.cc;
    const country = result.country || '';
    const admin1 = result.admin1 || '';
    cfg.cityName = result.name;
    cfg.cityDescr = geonameCityDescr(result.asciiname, admin1, country);
    if (country == 'Israel') {
      cfg.il = true;
      if (admin1.startsWith('Jerusalem') && result.name.startsWith('Jerualem')) {
        cfg.jersualem = true;
      }
    }
  } else {
    logger.warn(`no geographic key in config for to=${to}, id=${cfg.id}`);
    return false;
  }

  if (!cfg.latitude || !cfg.longitude) {
    logger.warn(`Suspicious zero lat/long for to=${to}, id=${cfg.id}`);
    return false;
  } else if (!cfg.tzid) {
    logger.warn(`Unknown tzid for to=${to}, id=${cfg.id}`);
    return false;
  }

  return true;
}

/**
 * Scans subs map and removes invalid entries
 * @param {Map<string,any>} subs
 * @param {*} zipsDb
 * @param {*} geonamesDb
 */
function parseAllConfigs(subs, zipsDb, geonamesDb) {
  logger.info('Parsing all configs');
  const zipStmt = zipsDb.prepare(ZIPCODE_SQL);
  const geonamesStmt = geonamesDb.prepare(GEONAME_SQL);
  const failures = [];
  for (const [to, cfg] of subs.entries()) {
    if (!parseConfig(to, cfg, zipStmt, geonamesStmt)) {
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
