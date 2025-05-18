/* eslint-disable n/no-process-exit */
import fs from 'fs';
import ini from 'ini';
import minimist from 'minimist';
import pino from 'pino';
import {getLogLevel} from './common.js';
import {makeDb, MysqlDb} from './makedb.js';
import {pad4, pad2} from '@hebcal/rest-api';

const argv = minimist(process.argv.slice(2), {
  string: ['ini'],
});

const logger = pino({
  level: getLogLevel(argv),
});

let db: MysqlDb;

main()
  .then(() => {
    logger.info('Done.');
  })
  .catch(err => {
    logger.fatal(err);
    process.exit(1);
  });

type RawYahrzeitContents = {
  [s: string]: string | number;
};

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

const MIN_YEARS = 2;
const MAX_YEARS = 50;
export const DEFAULT_YEARS = 20;

/**
 * @param {string|number} str
 * @return {number}
 */
export function getNumYears(str: string | number): number {
  const y = parseInt(str as string, 10);
  if (isNaN(y)) {
    return DEFAULT_YEARS;
  } else if (y < MIN_YEARS) {
    return MIN_YEARS;
  } else if (y > MAX_YEARS) {
    return MAX_YEARS;
  } else {
    return y;
  }
}

const noSaveFields = ['ulid', 'v', 'ref_url', 'ref_text', 'lastModified'];

function compactJsonItem(
  obj: {[x: string]: any; years?: any; em?: any},
  num: string | number,
) {
  const yk = 'y' + num;
  const mk = 'm' + num;
  const dk = 'd' + num;
  const yy = obj[yk];
  const mm = obj[mk];
  const dd = obj[dk];
  if (!empty(dd) && !empty(mm) && !empty(yy)) {
    const yy4 = yy.length === 4 ? yy : pad4(+yy);
    const mm2 = mm.length === 2 ? mm : pad2(+mm);
    const dd2 = dd.length === 2 ? dd : pad2(+dd);
    obj['x' + num] = yy4 + '-' + mm2 + '-' + dd2;
    delete obj[yk];
    delete obj[mk];
    delete obj[dk];
  }
  const typeKey = 't' + num;
  const anniversaryType = obj[typeKey];
  if (anniversaryType) {
    obj[typeKey] = anniversaryType[0].toLowerCase();
  }
  const sunsetKey = 's' + num;
  const sunset = obj[sunsetKey];
  if (typeof sunset !== 'undefined') {
    obj[sunsetKey] = sunset === 'on' || +sunset === 1 ? 1 : 0;
  }
}

export function compactJsonToSave(obj: {
  [x: string]: any;
  years?: any;
  em?: any;
}) {
  const maxId = getMaxYahrzeitId(obj);
  for (let i = 1; i <= maxId; i++) {
    compactJsonItem(obj, i);
  }
  if (typeof obj.years === 'string') {
    obj.years = getNumYears(obj.years);
  }
  noSaveFields.forEach(key => delete obj[key]);
  if (empty(obj.em)) {
    delete obj.em;
  }
}

async function main() {
  const iniPath = argv.ini || '/etc/hebcal-dot-com.ini';
  logger.debug(`Reading ${iniPath}...`);
  const config = ini.parse(fs.readFileSync(iniPath, 'utf-8'));

  db = makeDb(logger, config);

  const sql = `SELECT e.id, e.email_addr, e.calendar_id, y.contents
FROM yahrzeit_email e, yahrzeit y
WHERE e.sub_status = 'active'
AND e.calendar_id = y.id`;

  logger.debug(sql);
  const rows = await db.query(sql);
  if (!rows?.length) {
    logger.error('Got zero rows from DB!?');
    await db.close();
    return;
  }
  logger.info(`Loaded ${rows.length} active subscriptions from DB`);

  const done = new Set<string>();
  for (const row of rows) {
    const calendarId = row.calendar_id;
    if (done.has(calendarId)) {
      continue;
    }
    const contents: RawYahrzeitContents = row.contents;
    if (!contents.em) {
      contents.em = row.email_addr;
      compactJsonToSave(contents);
      console.log(calendarId, row.email_addr);
      const contentsStr = JSON.stringify(contents);
      const sql2 =
        'UPDATE yahrzeit SET updated = NOW(), contents = ? WHERE id = ?';
      const rows = await db.query(sql2, [contentsStr, calendarId]);
    }
    done.add(calendarId);
  }

  await db.close();
}
