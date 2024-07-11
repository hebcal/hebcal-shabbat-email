import fs from 'fs';
import mysql from 'mysql2/promise';
import {Logger} from 'pino';

/**
 * Wraps a MySQL connection in promises
 */
export async function makeDb(
  logger: Logger,
  iniConfig: {[s: string]: string}
): Promise<mysql.Connection> {
  const host = iniConfig['hebcal.mysql.host'];
  const port = +iniConfig['hebcal.mysql.port'] || 3306;
  const user = iniConfig['hebcal.mysql.user'];
  const password = iniConfig['hebcal.mysql.password'];
  const database = iniConfig['hebcal.mysql.dbname'];
  const connURL = `mysql://${user}@${host}:${port}/${database}`;
  logger.info(`Connecting to ${connURL}`);
  const connection = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
  });
  try {
    await connection.connect();
  } catch (err) {
    logger.fatal(err, `Cannot connect to ${connURL}`);
    throw err;
  }
  logger.debug('connected as id ' + connection.threadId);
  return connection;
}

/**
 * Returns directory name if it exists, else '.' for current working directory
 */
export async function dirIfExistsOrCwd(dir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    fs.stat(dir, (err, stats) => {
      if (err) {
        return resolve('.');
      }
      if (!stats || !stats.isDirectory()) {
        return resolve('.');
      }
      return resolve(dir);
    });
  });
}
