/* eslint-disable require-jsdoc */
import fs from 'fs';
import ini from 'ini';
import mysql from 'mysql';
import pino from 'pino';
import minimist from 'minimist';

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

const logger = pino({prettyPrint: {translateTime: true, ignore: 'pid,hostname'}});
const iniPath = argv.ini || '/home/hebcal/local/bin/hebcal-dot-com.ini';
const config = ini.parse(fs.readFileSync(iniPath, 'utf-8'));

main(argv.sleeptime)
    .then(() => {
      logger.info('Success!');
    })
    .catch((err) => {
      logger.fatal(err);
      process.exit(1);
    });

async function main() {
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

  const addrs = await getCandidates(connection);
  logger.info(`Deactivating ${addrs.length} subscriptions`);
  if (!argv.dryrun && addrs.length) {
    await deactivateSubs(connection, addrs);
  }
  connection.end();
}

async function deactivateSubs(connection, addrs) {
  const emails = addrs.join('\',\'');
  const sql1 = `UPDATE hebcal_shabbat_email
  SET email_status='bounce' WHERE email_address IN('${emails}')`;
  const p1 = new Promise((resolve, reject) => {
    connection.query(sql1, function(error, results) {
      if (error) return reject(error);
      return resolve(addrs);
    });
  });
  const sql2 = `UPDATE hebcal_shabbat_bounce
  SET deactivated=1 WHERE email_address IN('${emails}')`;
  const p2 = new Promise((resolve, reject) => {
    connection.query(sql2, function(error, results) {
      if (error) return reject(error);
      return resolve(addrs);
    });
  });
  const p3 = new Promise((resolve, reject) => {
    const subsPath = '/home/hebcal/local/var/log/subscribers.log';
    const t = Math.floor(new Date().getTime() / 1000);
    const logStream = fs.createWriteStream(subsPath, {flags: 'a'});
    addrs.forEach((addr) => logStream.write(`status=1 to=${addr} code=bounce time=${t}\n`));
    logStream.end();
    return resolve(true);
  });
  return Promise.all([p1, p2, p3]);
}

async function getCandidates(connection) {
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
GROUP by b.email_address,std_reason`;
  logger.info(sql);
  return new Promise((resolve, reject) => {
    connection.query(sql, function(error, results) {
      if (error) return reject(error);
      const addrs = [];
      for (const row of results) {
        if (row.count > argv.count || row.std_reason == 'amzn_abuse') {
          if (!argv.quiet) {
            logger.info(`${row.email_address} (${row.count} bounces)`);
          }
          addrs.push(row.email_address);
        }
      }
      return resolve(addrs);
    });
  });
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
