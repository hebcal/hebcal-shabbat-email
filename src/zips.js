import sqlite3 from 'sqlite3';
import {open} from 'sqlite';
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

sqlite3.verbose();

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

  // open the database
  const lockfile = fs.openSync('/tmp/hebcal-shabbat-weekly.lock', 'w');
  await flock(lockfile, 'ex');
  logger.info('Opening ZIP code database...');
  const zipsDb = await open({
    filename: 'zips.sqlite3',
    driver: sqlite3.cached.Database,
  });
  logger.info('Opening GeoNames database...');
  const geonamesDb = await open({
    filename: 'geonames.sqlite3',
    driver: sqlite3.cached.Database,
  });
  const result = await zipsDb.get('SELECT CityMixedCase,State,Latitude,Longitude,TimeZone,DayLightSaving FROM ZIPCodes_Primary WHERE ZipCode = ?', '02912');
  console.log(result);
  const result2 = await geonamesDb.get('SELECT * FROM geoname WHERE geonameid = ?', 5224151);
  console.log(result2);

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
            logger.warn(`Unknown city ${cityName} for id=${cfg.id};email=${email}`);
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
