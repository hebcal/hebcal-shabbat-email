import fs from 'fs';
import Twitter from 'twitter';
import ini from 'ini';
import {Sedra, HDate, common, holidays, flags, hebcal, Event} from '@hebcal/core';
import pino from 'pino';

const logger = pino({prettyPrint: {translateTime: true}});

const hd = new HDate().onOrAfter(common.days.SAT);
const sedra = new Sedra(hd.getFullYear(), false);
const parsha = sedra.getString(hd);
let parshaEvent = new Event(hd, parsha, flags.PARSHA_HASHAVUA);
let twitterStatus = `This week\'s #Torah portion is ${parsha}`;

const events = holidays.getHolidaysOnDate(hd);
if (events) {
  if (!sedra.isParsha(hd)) {
    parshaEvent = events.find((e) => e.getFlags() & flags.SPECIAL_SHABBAT);
  }
  const specialShabbat = events.find((e) => e.getFlags() & flags.SPECIAL_SHABBAT);
  if (specialShabbat) {
    twitterStatus += ` (${specialShabbat.render()})`;
  }
}
const url = hebcal.getShortUrl(parshaEvent);
twitterStatus += `. Shabbat Shalom! ${url}`;

const iniPath = '/home/hebcal/local/bin/hebcal-dot-com.ini';
const config = ini.parse(fs.readFileSync(iniPath, 'utf-8'));

logger.info(twitterStatus);

const client = new Twitter({
  consumer_key: config['hebcal.twitter.consumer_key'],
  consumer_secret: config['hebcal.twitter.consumer_secret'],
  access_token_key: config['hebcal.twitter.token'],
  access_token_secret: config['hebcal.twitter.token_secret'],
});

client.post('statuses/update', {status: twitterStatus}, function(error, tweet, response) {
  if (error) {
    logger.fatal(error);
    process.exit(1);
  }
  logger.info(tweet); // Tweet body.
  logger.info(response); // Raw response object.
});
