import fs from 'fs';
import Twitter from 'twitter';
import ini from 'ini';
import {Sedra, HDate, common, holidays, flags, hebcal, Event} from '@hebcal/core';
import pino from 'pino';
import minimist from 'minimist';

const argv = minimist(process.argv.slice(2));
const logger = pino({prettyPrint: {translateTime: true, ignore: 'pid,hostname'}});
const iniPath = argv.ini || '/home/hebcal/local/etc/hebcal-dot-com.ini';
const config = ini.parse(fs.readFileSync(iniPath, 'utf-8'));

main();

// eslint-disable-next-line require-jsdoc
async function main() {
  if (argv.randsleep) {
    const seconds = Math.floor(Math.random() * argv.randsleep);
    logger.info(`Sleeping for ${seconds} seconds before posting`);
    if (!argv.dryrun) {
      await new Promise((resolve) => {
        setTimeout(resolve, 1000 * seconds);
      });
    }
  }
  try {
    if (argv.daily) {
      const twitterStatus = getDailyStatusText();
      if (twitterStatus) {
        logger.info(twitterStatus);
        await logInAndPost(twitterStatus);
      }
    } else if (argv.shabbat) {
      const twitterStatus = getShabbatStatusText();
      logger.info(twitterStatus);
      await logInAndPost(twitterStatus);
    }
  } catch (err) {
    logger.fatal(err);
    process.exit(1);
  }
}

/**
 * @param {string} twitterStatus
 */
async function logInAndPost(twitterStatus) {
  const client = new Twitter({
    consumer_key: config['hebcal.twitter.consumer_key'],
    consumer_secret: config['hebcal.twitter.consumer_secret'],
    access_token_key: config['hebcal.twitter.access_token_key'],
    access_token_secret: config['hebcal.twitter.access_token_secret'],
  });
  return new Promise((resolve, reject) => {
    client.post('statuses/update', {status: twitterStatus}, function(error, tweet, response) {
      if (error) return reject(error);
      return resolve(tweet);
    });
  });
}

/**
 * @param {Event} ev
 * @return {string}
 */
function getEventStatusText(ev) {
  const subj = ev.getDesc();
  if (subj.startsWith('Erev ')) {
    const holiday = subj.substring(5);
    let statusText = `${holiday} begins tonight at sundown.`;
    switch (holiday) {
      case 'Tish\'a B\'Av':
        statusText += ' Tzom Kal. We wish you an easy fast.';
        break;
      case 'Rosh Hashana':
        statusText += ' Shana Tovah! We wish you a happy and healthy New Year.';
        break;
      case 'Yom Kippur':
        statusText += ' G\'mar Chatimah Tovah! We wish you a good inscription in the Book of Life.';
        break;
      case 'Pesach':
        statusText += ' Chag Kasher v\'Sameach! We wish you a happy Passover.';
        break;
      default:
        statusText += ' Chag Sameach!';
        break;
    }
    return statusText;
  } else if (subj == 'Chanukah: 1 Candle') {
    return 'Light the first Chanukah candle tonight at sundown. Chag Urim Sameach!';
  }
  return undefined;
}

/** @return {string} */
function getDailyStatusText() {
  const hd = new HDate();
  const todayEvents = holidays.getHolidaysOnDate(hd);
  if (todayEvents) {
    for (const ev of todayEvents) {
      logger.info(`Today is ${ev.getDesc()}`);
      const statusText = getEventStatusText(ev);
      if (statusText) {
        return statusText + ' ' + hebcal.getShortUrl(ev);
      }
    }
  }
  const tomorrowEvents = holidays.getHolidaysOnDate(hd.next());
  if (tomorrowEvents) {
    let statusText;
    for (const ev of tomorrowEvents) {
      const subj = ev.getDesc();
      logger.info(`Tomorrow is ${subj}`);
      if (subj.startsWith('Rosh Chodesh') && hd.getDate() != 30) {
        statusText = `${subj} begins tonight at sundown. Chodesh Tov!`;
      } else if (subj == 'Shmini Atzeret') {
        statusText = `${subj} begins tonight at sundown. Chag Sameach!`;
      } else if (ev.getFlags() & flags.MINOR_FAST) {
        statusText = `${subj} begins tomorrow at dawn. Tzom Kal. We wish you an easy fast.`;
      }
      if (statusText) {
        return statusText + ' ' + hebcal.getShortUrl(ev);
      }
    }
  }
  return undefined;
}

/** @return {string} */
function getShabbatStatusText() {
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
  return twitterStatus + '. Shabbat Shalom! ' + hebcal.getShortUrl(parshaEvent);
}
