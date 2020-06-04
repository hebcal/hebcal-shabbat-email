import sqlite3 from 'sqlite3';
import {open} from 'sqlite';
import fs from 'fs';
import ini from 'ini';

const config = ini.parse(fs.readFileSync('./config.ini', 'utf-8'));
const a = config['hebcal.mysql.host'];
console.log(a);


sqlite3.verbose();

// this is a top-level await
(async () => {
  // open the database
  const db = await open({
    filename: 'zips.sqlite3',
    driver: sqlite3.cached.Database,
  });
  const result = await db.get('SELECT * FROM ZIPCodes_Primary WHERE ZipCode = ?', '02912');
  console.log(result);
})();

/*
(async () => {
})();
*/
