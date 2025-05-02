import fs from 'fs';
import mysql, {
  Connection,
  ConnectionOptions,
  QueryOptions,
  RowDataPacket,
} from 'mysql2';
import {Logger} from 'pino';

/**
 * Wraps a MySQL connection in promises
 */
export class MysqlDb {
  private connection: Connection;
  constructor(logger: Logger, config: ConnectionOptions) {
    const connURL = `mysql://${config.user}@${config.host}:${config.port}/${config.database}`;
    logger.info(`Connecting to ${connURL}`);
    const connection = mysql.createConnection(config);
    connection.connect(err => {
      if (err) {
        logger.fatal(err, `Cannot connect to ${connURL}`);
        throw err;
      }
      logger.debug('connected as id ' + connection.threadId);
    });
    this.connection = connection;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query(sql: string, values?: any[]): Promise<RowDataPacket[]> {
    return new Promise((resolve, reject) => {
      const qopts: QueryOptions = {sql};
      if (values) {
        qopts.values = values;
      }
      this.connection.query<RowDataPacket[]>(qopts, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }
  async close(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.connection.end(err => {
        if (err) {
          reject(err);
        } else {
          resolve(true);
        }
      });
    });
  }
}

export function makeDb(
  logger: Logger,
  iniConfig: {[s: string]: string},
): MysqlDb {
  const host = iniConfig['hebcal.mysql.host'];
  const port = +iniConfig['hebcal.mysql.port'] || 3306;
  const user = iniConfig['hebcal.mysql.user'];
  const password = iniConfig['hebcal.mysql.password'];
  const database = iniConfig['hebcal.mysql.dbname'];
  const connectionConfig: ConnectionOptions = {
    host,
    port,
    user,
    password,
    database,
  };
  return new MysqlDb(logger, connectionConfig);
}

/**
 * Returns directory name if it exists, else '.' for current working directory
 */
export async function dirIfExistsOrCwd(dir: string): Promise<string> {
  return new Promise(resolve => {
    fs.stat(dir, (err, stats) => {
      if (err) {
        return resolve('.');
      }
      if (!stats?.isDirectory()) {
        return resolve('.');
      }
      return resolve(dir);
    });
  });
}
