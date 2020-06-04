import Database from 'better-sqlite3';
import fs from 'fs';
import ini from 'ini';
import {flags, HDate, holidays} from '@hebcal/core';
import pino from 'pino';
import {flock} from 'fs-ext';
import mysql from 'mysql';
const city2geonameid = require('./city2geonameid.json');

const logger = pino({
  prettyPrint: {translateTime: true},
});

logger.info('hello world');

exitIfYomTov();

main()
    .then(() => {
      logger.info('Done!');
    })
    .catch((err) => {
      logger.fatal(err);
      process.exit(1);
    });

/** main loop */
async function main() {
  logger.info('Reading config.ini...');
  const config = ini.parse(fs.readFileSync('./config.ini', 'utf-8'));
  const subs = await loadSubs(config, []);
  logger.info(`Loaded ${subs.size} users`);

  const alreadySent = loadSentLog();
  logger.info(`Skipping ${alreadySent.size} users from previous run`);
  alreadySent.forEach((x) => subs.delete(x));

  // open the database
  const lockfile = fs.openSync('/tmp/hebcal-shabbat-weekly.lock', 'w');
  await flock(lockfile, 'ex');

  logger.info('Opening ZIP code database...');
  const zipsDb = new Database('zips.sqlite3', {fileMustExist: true});

  logger.info('Opening GeoNames database...');
  const geonamesDb = new Database('geonames.sqlite3', {fileMustExist: true});

  parseAllConfigs(subs, zipsDb, geonamesDb);

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

  logger.info(`About to mail ${cfgs.length} users`);

  await flock(lockfile, 'un');
  fs.closeSync(lockfile);
}

/** Bails out if today is a holiday */
function exitIfYomTov() {
  const today = holidays.getHolidaysOnDate(new HDate());
  if (today) {
    for (const ev of today) {
      if (ev.getFlags() & flags.CHAG) {
        const desc = ev.getDesc();
        logger.info(`Today is ${desc}; exiting due to holiday...`);
        process.exit(0);
      }
    }
  }
}

/*
  '8299621': 0, // Shetland Islands, Scotland
  '8556393': 0, // unknown
  '6091104': 0, // North York, Ontario
*/
const GEONAMES_MAP = {
  '6693679': 282926, // Modi'in
  '5927689': 5927690, // Coquitlam, British Columbia
  '6049430': 6049429, // Langley, British Columbia
};

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
    if (err) throw err;
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
        if (cfg.geonameid && GEONAMES_MAP[cfg.geonameid]) {
          cfg.geonameid = GEONAMES_MAP[cfg.geonameid];
        }
        subs.set(email, cfg);
      }
      connection.end();
      return resolve(subs);
    });
  });
}

/**
 * @param {Date} d
 * @return {string}
 */
function formatYYYYMMDD(d) {
  return String(d.getFullYear()).padStart(4, '0') +
        String(d.getMonth() + 1).padStart(2, '0') +
        String(d.getDate()).padStart(2, '0');
}

/**
 * Reads the previous log and returns any successful email adresses to skip
 * @return {Set<string>}
 */
function loadSentLog() {
  const d = formatYYYYMMDD(new Date());
  const sentLogFilename = `/home/hebcal/local/var/log/shabbat-${d}`;
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
//
// Code  Description
//  4    Atlantic (GMT -04:00)
//  5    Eastern (GMT -05:00)
//  6    Central (GMT -06:00)
//  7    Mountain (GMT -07:00)
//  8    Pacific (GMT -08:00)
//  9    Alaska (GMT -09:00)
// 10    Hawaii-Aleutian Islands (GMT -10:00)
// 11    American Samoa (GMT -11:00)
// 13    Marshall Islands (GMT +12:00)
// 14    Guam (GMT +10:00)
// 15    Palau (GMT +9:00)
const ZIPCODES_TZ_MAP = {
  '0': 'UTC',
  '4': 'America/Puerto_Rico',
  '5': 'America/New_York',
  '6': 'America/Chicago',
  '7': 'America/Denver',
  '8': 'America/Los_Angeles',
  '9': 'America/Anchorage',
  '10': 'Pacific/Honolulu',
  '11': 'Pacific/Pago_Pago',
  '13': 'Pacific/Funafuti',
  '14': 'Pacific/Guam',
  '15': 'Pacific/Palau',
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
  failures.forEach((x) => subs.delete(x));
  if (failures.length) {
    logger.warn(`Skipped ${failures.length} subscribers due to config failures`);
  }
}
