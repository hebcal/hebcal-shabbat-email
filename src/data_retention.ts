import fs from 'node:fs';
import ini from 'ini';
import pino from 'pino';
import minimist from 'minimist';
import {makeDb, MysqlDb} from './makedb.js';
import {getLogLevel} from './common.js';

const PROG = 'data_retention.js';
const RETENTION_MONTHS_DEFAULT = 24;

const TABLES: {name: string; column: string}[] = [
  {name: 'hebcal_shabbat_bounce', column: 'timestamp'},
  {name: 'yahrzeit_sent1', column: 'sent_date'},
  {name: 'yahrzeit_sent7', column: 'sent_date'},
  {name: 'email_open', column: 'ts'},
];

type InactiveTable = {
  name: string;
  dateColumn: string;
  statusColumn: string;
  statuses: string[];
};

const INACTIVE_TABLES: InactiveTable[] = [
  {
    name: 'hebcal_shabbat_email',
    dateColumn: 'email_updated',
    statusColumn: 'email_status',
    statuses: ['pending', 'bounce', 'unsubscribed'],
  },
  {
    name: 'yahrzeit_email',
    dateColumn: 'updated',
    statusColumn: 'sub_status',
    statuses: ['pending', 'unsub', 'bounce'],
  },
];

const argv = minimist(process.argv.slice(2), {
  boolean: ['dryrun', 'quiet', 'help', 'verbose'],
  string: ['ini'],
  alias: {h: 'help', n: 'dryrun', q: 'quiet', v: 'verbose'},
});

if (argv.help) {
  usage();
  process.exit(1);
}

const logger = pino({
  level: getLogLevel(argv),
});
const iniPath = argv.ini || '/etc/hebcal-dot-com.ini';
const config = ini.parse(fs.readFileSync(iniPath, 'utf-8'));
const retentionMonths = argv.months
  ? parseInt(argv.months, 10)
  : RETENTION_MONTHS_DEFAULT;

async function main() {
  const db = makeDb(logger, config);
  for (const table of TABLES) {
    await pruneTable(db, table.name, table.column);
  }
  for (const table of INACTIVE_TABLES) {
    await pruneInactiveSubscribers(db, table);
  }
  return db.close();
}

async function pruneTable(db: MysqlDb, table: string, column: string) {
  const fromWhereSql = `FROM ${table} WHERE ${column} < DATE_SUB(NOW(), INTERVAL ${retentionMonths} MONTH)`;
  const countSql = `SELECT COUNT(*) AS cnt ${fromWhereSql}`;
  const countResult = await db.query(countSql);
  const count = (countResult[0] as any).cnt;
  logger.info(`${table}: ${count} rows older than ${retentionMonths} months`);
  if (count === 0) {
    return;
  }
  if (argv.verbose) {
    const sampleSql = `SELECT * ${fromWhereSql} LIMIT 5`;
    const sampleRows = await db.query(sampleSql);
    logger.info({sampleRows}, `${table}: sample rows to be deleted`);
  }
  if (argv.dryrun) {
    logger.info(`${table}: --dryrun, skipping delete`);
    return;
  }
  const deleteSql = `DELETE ${fromWhereSql} LIMIT 50000`;
  await batchDelete(db, table, deleteSql);
}

async function pruneInactiveSubscribers(db: MysqlDb, tbl: InactiveTable) {
  const table = tbl.name;
  const statuses = tbl.statuses;
  const placeholders = statuses.map(() => '?').join(',');
  const whereClause = `${tbl.dateColumn} < DATE_SUB(NOW(), INTERVAL ${retentionMonths} MONTH) AND ${tbl.statusColumn} IN (${placeholders})`;
  const countSql = `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${whereClause}`;
  const countResult = await db.query(countSql, statuses);
  const count = (countResult[0] as any).cnt;
  logger.info(
    `${table}: ${count} inactive rows older than ${retentionMonths} months`,
  );
  if (count === 0) {
    return;
  }
  if (argv.verbose) {
    const sampleSql = `SELECT * FROM ${table} WHERE ${whereClause} LIMIT 5`;
    const sampleRows = await db.query(sampleSql, statuses);
    logger.info({sampleRows}, `${table}: sample rows to be deleted`);
  }
  if (argv.dryrun) {
    logger.info(`${table}: --dryrun, skipping delete`);
    return;
  }
  const deleteSql = `DELETE FROM ${table} WHERE ${whereClause} LIMIT 50000`;
  await batchDelete(db, table, deleteSql, statuses);
}

async function batchDelete(
  db: MysqlDb,
  table: string,
  deleteSql: string,
  params?: string[],
) {
  let totalDeleted = 0;
  let affected = 0;
  do {
    const result = await db.query(deleteSql, params);
    affected = (result as any).affectedRows;
    totalDeleted += affected;
    if (affected > 0) {
      logger.info(`${table}: deleted batch of ${affected} rows`);
    }
  } while (affected > 0);
  logger.info(`${table}: deleted ${totalDeleted} rows total`);
}

function usage() {
  const usage = `Usage:
    ${PROG} [options]

Options:
  --help           Help
  --dryrun         Prints counts but does not delete anything
  --quiet          Quiet mode
  --verbose        Verbose mode
  --ini <file>     Use <file> for config (default /etc/hebcal-dot-com.ini)
  --months <n>     Retention period in months (default ${RETENTION_MONTHS_DEFAULT})
`;
  console.log(usage);
}

try {
  await main();
  logger.info('Success!');
} catch (err) {
  logger.fatal(err);
  process.exit(1);
}
