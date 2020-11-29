import util from 'util';
import mysql from 'mysql2';
import fs from 'fs';

/**
 * Wraps a MySQL connection in promises
 * @param {Object<string,string>} iniConfig
 * @return {Object}
 */
export function makeDb(iniConfig) {
  const connection = mysql.createConnection({
    host: iniConfig['hebcal.mysql.host'],
    user: iniConfig['hebcal.mysql.user'],
    password: iniConfig['hebcal.mysql.password'],
    database: iniConfig['hebcal.mysql.dbname'],
  });
  connection.connect(function(err) {
    if (err) {
      throw err;
    }
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
