import util from 'util';
import mysql from 'mysql2';
import fs from 'fs';

/**
 * Wraps a MySQL connection in promises
 * @param {any} logger
 * @param {Object<string,string>} iniConfig
 * @return {Object}
 */
export function makeDb(logger, iniConfig) {
  const host = iniConfig['hebcal.mysql.host'];
  const user = iniConfig['hebcal.mysql.user'];
  const password = iniConfig['hebcal.mysql.password'];
  const database = iniConfig['hebcal.mysql.dbname'];
  logger.info(`Connecting to mysql://${user}@${host}/${database}`);
  const connection = mysql.createConnection({
    host,
    user,
    password,
    database,
  });
  connection.connect(function(err) {
    if (err) {
      logger.fatal(err);
      throw err;
    }
    logger.debug('connected as id ' + connection.threadId);
  });
  const connQuery = util.promisify(connection.query);
  const connEnd = util.promisify(connection.end);
  return {
    query(sql, args) {
      return connQuery.call(connection, sql, args);
    },
    close() {
      return connEnd.call(connection);
    },
  };
}

/**
 * Returns directory name if it exists, else '.' for current working directory
 * @async
 * @param {string} dir
 * @return {string}
 */
export async function dirIfExistsOrCwd(dir) {
  return new Promise((resolve, reject) => {
    fs.stat(dir, function(err, stats) {
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
