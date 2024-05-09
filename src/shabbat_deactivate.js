/* eslint-disable n/no-process-exit */
import fs from 'fs';
import ini from 'ini';
import pino from 'pino';
import minimist from 'minimist';
import {makeDb, dirIfExistsOrCwd} from './makedb.js';

const PROG = 'shabbat_deactivate.js';
const COUNT_DEFAULT = 7;
const REASONS_DEFAULT = 'amzn_abuse,user_unknown,user_disabled,domain_error,spam';

const argv = minimist(process.argv.slice(2));
if (argv.help || argv.h) {
  usage();
  process.exit(1);
}
argv.reasons = argv.reasons || REASONS_DEFAULT;
argv.count = argv.count || COUNT_DEFAULT;

const logger = pino({
  level: argv.quiet ? 'warn' : 'info',
/*
  transport: {
    target: 'pino-pretty',
    options: {translateTime: 'SYS:standard', ignore: 'pid,hostname'},
  },
*/
});
const iniPath = argv.ini || '/etc/hebcal-dot-com.ini';
const config = ini.parse(fs.readFileSync(iniPath, 'utf-8'));
let logdir;

main(argv.sleeptime)
    .then(() => {
      logger.info('Success!');
    })
    .catch((err) => {
      logger.fatal(err);
      process.exit(1);
    });

async function main() {
  const db = makeDb(logger, config);
  logdir = await dirIfExistsOrCwd('/var/log/hebcal');
  const addrs = await getCandidates(db);
  logger.info(`Deactivating ${addrs.length} subscriptions`);
  if (!argv.dryrun && addrs.length) {
    await deactivateSubs(db, addrs);
  }
  return db.close();
}

async function deactivateSubs(db, addrs) {
  const emails = addrs.join('\',\'');
  const sql1 = `UPDATE hebcal_shabbat_email
  SET email_status='bounce' WHERE email_address IN('${emails}')`;
  await db.query(sql1);
  const sql2 = `UPDATE hebcal_shabbat_bounce
  SET deactivated=1 WHERE email_address IN('${emails}')`;
  await db.query(sql2);
  return new Promise((resolve, reject) => {
    const subsPath = logdir + '/subscribers.log';
    const t = Math.floor(new Date().getTime() / 1000);
    try {
      const logStream = fs.createWriteStream(subsPath, {flags: 'a'});
      addrs.forEach((addr) => {
        const logMessage = {
          time: t,
          status: 1,
          to: addr,
          code: 'deactivated',
        };
        logStream.write(JSON.stringify(logMessage));
        logStream.write('\n');
      });
      logStream.end();
      return resolve(true);
    } catch (err) {
      return reject(err);
    }
  });
}

async function getCandidates(db) {
  const reasons = argv.reasons.split(',');
  const reasonsSql = reasons.join('\',\'');
  const sql = `
SELECT b.email_address,std_reason,count(1) as count
FROM hebcal_shabbat_email e,
     hebcal_shabbat_bounce b
WHERE e.email_address = b.email_address
AND e.email_status = 'active'
AND b.std_reason IN('${reasonsSql}')
AND b.deactivated = 0
AND DATEDIFF(NOW(), b.timestamp) < 365
GROUP by b.email_address,std_reason`;
  logger.info(sql);
  const results = await db.query(sql);
  const addrs = [];
  for (const row of results) {
    if (row.count > argv.count || row.std_reason == 'amzn_abuse') {
      if (!argv.quiet) {
        logger.info(`${row.email_address} (${row.count} bounces)`);
      }
      addrs.push(row.email_address);
    }
  }
  return Promise.resolve(addrs);
}

function usage() {
  const usage = `Usage:
    ${PROG} [options]

Options:
  --help         Help
  --dryrun       Prints the actions that ${PROG} would take
                  but does not remove anything
  --quiet        Quiet mode (do not print commands)
  --count <n>    Threshold is <n> for bounces (default ${COUNT_DEFAULT})
  --reasons <r>  Use any of comma-separated list of reasons <r> for bounces (default ${REASONS_DEFAULT})
`;
  console.log(usage);
}
