import fs from 'fs';
import Twitter from 'twitter';
import ini from 'ini';
import {Sedra, HebrewCalendar, HDate, flags, ParshaEvent} from '@hebcal/core';
import pino from 'pino';
import minimist from 'minimist';

const argv = minimist(process.argv.slice(2), {
  boolean: ['dryrun', 'quiet', 'daily', 'shabbat'],
  alias: {n: 'dryrun', q: 'quiet'},
});
const logger = pino({
  level: argv.quiet ? 'warn' : 'info',
  prettyPrint: {translateTime: true, ignore: 'pid,hostname'},
});
const iniPath = argv.ini || '/etc/hebcal-dot-com.ini';
const config = ini.parse(fs.readFileSync(iniPath, 'utf-8'));

main();

// eslint-disable-next-line require-jsdoc
async function main() {
  try {
    if (argv.daily) {
      const twitterStatus = getDailyStatusText();
      if (twitterStatus) {
        logger.info(twitterStatus);
        await randSleep();
        await logInAndPost(twitterStatus);
      }
    } else if (argv.shabbat) {
      const twitterStatus = getShabbatStatusText();
      logger.info(twitterStatus);
      await randSleep();
      await logInAndPost(twitterStatus);
    }
  } catch (err) {
    logger.fatal(err);
    process.exit(1);
  }
}

/** n/a */
async function randSleep() {
  if (argv.randsleep && !argv.dryrun) {
    const seconds = Math.floor(Math.random() * argv.randsleep);
    return new Promise((resolve) => {
      logger.info(`Sleeping for ${seconds} seconds before posting`);
      setTimeout(resolve, 1000 * seconds);
    });
  } else {
    return Promise.resolve(true);
  }
}

/**
 * @param {string} twitterStatus
 */
async function logInAndPost(twitterStatus) {
  if (argv.dryrun) {
    return Promise.resolve(true);
  }
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
    const emoji0 = ev.getEmoji();
    const emoji = emoji0 ? ` ${emoji0}` : '';
    let statusText = `${holiday}${emoji} begins tonight at sundown.`;
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

/**
 * @param {Event} ev
 * @return {string}
 */
function getShortUrl(ev) {
  const url = ev.url();
  return url.replace('https://www.hebcal.com', 'https://hebcal.com')
      .replace('/holidays/', '/h/').replace('/sedrot/', '/s/') +
      '?utm_source=twitter&utm_medium=social';
}

/** @return {string} */
function getDailyStatusText() {
  const hd = new HDate();
  const todayEvents = HebrewCalendar.getHolidaysOnDate(hd);
  if (todayEvents) {
    for (const ev of todayEvents) {
      logger.info(`Today is ${ev.getDesc()}`);
      const statusText = getEventStatusText(ev);
      if (statusText) {
        return statusText + ' ' + getShortUrl(ev);
      }
    }
  }
  const tomorrowEvents = HebrewCalendar.getHolidaysOnDate(hd.next());
  if (tomorrowEvents) {
    let statusText;
    for (const ev of tomorrowEvents) {
      const subj = ev.getDesc();
      const emoji = ev.getEmoji();
      logger.info(`Tomorrow is ${subj}`);
      if (subj.startsWith('Rosh Chodesh') && hd.getDate() != 30) {
        statusText = `${subj} ${emoji} begins tonight at sundown. Chodesh Tov!`;
      } else if (subj == 'Shmini Atzeret') {
        statusText = `${subj} ${emoji} begins tonight at sundown. Chag Sameach!`;
      } else if (ev.getFlags() & flags.MINOR_FAST) {
        statusText = `${subj} begins tomorrow at dawn. Tzom Kal. We wish you an easy fast.`;
      }
      if (statusText) {
        return statusText + ' ' + getShortUrl(ev);
      }
    }
  }
  return undefined;
}

/** @return {string} */
function getShabbatStatusText() {
  const hd = new HDate().onOrAfter(6);
  const sedra = new Sedra(hd.getFullYear(), false);
  const parsha = sedra.getString(hd);
  let twitterStatus = `This week\'s #Torah portion is ${parsha}`;

  const events = HebrewCalendar.getHolidaysOnDate(hd);
  if (events) {
    const specialShabbat = events.find((e) => e.getFlags() & flags.SPECIAL_SHABBAT);
    if (specialShabbat) {
      twitterStatus += ` (${specialShabbat.render()})`;
    }
  }
  let url = '';
  if (sedra.isParsha(hd)) {
    const ev = new ParshaEvent(hd, sedra.get(hd));
    url = ' ' + getShortUrl(ev);
  }
  return twitterStatus + '. Shabbat Shalom!' + url;
}
