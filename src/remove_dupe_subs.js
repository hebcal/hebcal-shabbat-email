/* global process */
import minimist from 'minimist';
import pino from 'pino';
import fs from 'node:fs';
import ini from 'ini';
import {makeDb} from './makedb.js';

const argv = minimist(process.argv.slice(2), {
  boolean: ['dryrun', 'quiet', 'force', 'verbose'],
  alias: {n: 'dryrun', q: 'quiet', f: 'force', v: 'verbose'},
});

const logger = pino({
  level: argv.verbose ? 'debug' : argv.quiet ? 'warn' : 'info',
});

main()
  .then(() => {
    logger.info('Success!');
  })
  .catch(err => {
    logger.fatal(err);
    process.exit(1);
  });

async function main() {
  const iniPath = argv.ini || '/etc/hebcal-dot-com.ini';
  logger.info(`Reading ${iniPath}...`);
  const config = ini.parse(fs.readFileSync(iniPath, 'utf-8'));
  await loadSubs(config);
}

async function loadSubs(iniConfig) {
  const db = makeDb(logger, iniConfig);
  const sql = `select calendar_id from
  (select calendar_id, count(distinct(id)) num_subs, count(distinct(email_addr)) num_emails
   from yahrzeit_email where sub_status = 'active' group by 1 order by 2 desc) a
  where num_emails = 1 and num_subs > 1`;

  logger.info(sql);
  const results = await db.query(sql);
  const calendarIds = results.map(row => row.calendar_id);

  for (const calendarId of calendarIds) {
    const sql2 =
      "select id from yahrzeit_email where calendar_id = ? and sub_status = 'active' order by updated desc";
    logger.info(sql2);
    const results2 = await db.query(sql2, [calendarId]);

    const emailIds = results2.map(row => row.id);
    const emailIdsStr = emailIds.join("','");
    const sql3 = `select * from yahrzeit_optout where email_id in ('${emailIdsStr}')`;
    logger.info(sql3);
    const results3 = await db.query(sql3);

    if (results3.length) {
      logger.warn(`Skipping optout ${calendarId} ('${emailIdsStr}')`);
      continue;
    }

    const toUnsub = emailIds.slice(1).join("','");
    const sql4 = `update yahrzeit_email set sub_status = 'unsub' where id in ('${toUnsub}')`;
    logger.info(sql4);
    await db.query(sql4);
  }
  await db.close();
}
