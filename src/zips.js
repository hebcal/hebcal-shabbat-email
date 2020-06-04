import sqlite3 from 'sqlite3';
import {open} from 'sqlite';
import fs from 'fs';
import ini from 'ini';
import {flags, HDate, cities, holidays} from '@hebcal/core';
import pino from 'pino';
import {flock} from 'fs-ext';

const logger = pino({
  prettyPrint: {translateTime: true},
});

logger.info('hello world');

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

exitIfYomTov();

sqlite3.verbose();
cities.init();


const config = ini.parse(fs.readFileSync('./config.ini', 'utf-8'));
const a = config['hebcal.mysql.host'];
console.log(a);


// this is a top-level await
(async () => {
  // open the database
  try {
    const lockfile = fs.openSync('/tmp/hebcal-shabbat-weekly.lock', 'w');
    await flock(lockfile, 'ex');

    const zipsDb = await open({
      filename: 'zips.sqlite3',
      driver: sqlite3.cached.Database,
    });
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
  } catch (err) {
    logger.fatal(err);
  }
})();

/*
(async () => {
})();
*/
