/* global process */
import fs from 'fs';
import ini from 'ini';
import {parse} from 'csv-parse';
import {makeDb} from './makedb.js';
import pino from 'pino';
import minimist from 'minimist';
import {translateSmtpStatus} from './common.js';

const argv = minimist(process.argv.slice(2), {
  boolean: ['quiet'],
  alias: {q: 'quiet'},
});

const logger = pino({
  level: argv.quiet ? 'warn' : 'info',
});
const iniPath = argv.ini || '/etc/hebcal-dot-com.ini';
const config = ini.parse(fs.readFileSync(iniPath, 'utf-8'));

main()
  .then(() => {
    logger.info('Success!');
  })
  .catch(err => {
    logger.fatal(err);

    process.exit(1);
  });

const sql = `INSERT INTO hebcal_shabbat_bounce
(email_address,timestamp,std_reason,full_reason,deactivated)
VALUES (?,?,?,?,0)`;

async function main() {
  const filename = argv._[0];
  logger.info(`Reading ${filename}`);
  const records = await processFile(filename);
  const db = makeDb(logger, config);
  for (const r of records) {
    const emailAddress = r[2];
    const fullReason = r[1];
    const timestamp = new Date(1000 * +r[3]);
    const stdReason = translateSmtpStatus(r[0]);
    logger.info(`Bounce: ${emailAddress} ${stdReason}`);
    await db.query(sql, [emailAddress, timestamp, stdReason, fullReason]);
  }
  return db.close();
}

async function processFile(filename) {
  const records = [];
  const rs = fs.createReadStream(filename);
  const parser = rs.pipe(
    parse({
      // CSV options if any
    }),
  );
  for await (const record of parser) {
    // Work with each record
    records.push(record);
  }
  records.shift();
  return records;
}
