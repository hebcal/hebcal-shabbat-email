import dayjs, {Dayjs} from 'dayjs';
import {HDate, months, getYahrzeitHD, getBirthdayHD} from '@hebcal/hdate';
import {Event, flags, Locale} from '@hebcal/core';
import type {SendMailOptions} from 'nodemailer';
import type {Logger} from 'pino';
import {makeListMessage} from './common.js';
import {IcalEvent} from '@hebcal/icalendar';
import {murmur32HexSync} from '@hebcal/murmurhash3';

const BLANK = '<div>&nbsp;</div>';
const YAHRZEIT_POSTSCRIPT = `${BLANK}
<div>
May your loved one’s soul be bound up in the bond of eternal life and may their memory
serve as a continued source of inspiration and comfort to you.
</div>
`;
const BIRTHDAY_POSTSCRIPT = `${BLANK}\n<div>Mazal Tov! <span lang="he" dir="rtl">מַזָּל טוֹב!</span></div>\n`;
const DATE_STYLE = 'style="color: #941003; white-space: nowrap"';

export type SubBase = {
  num: number;
  dd: string;
  mm: string;
  yy: string;
  sunset: string | number;
  type: string;
  name: string;
  day: dayjs.Dayjs;
  hash: string;
};

export type SubInfo = SubBase & {
  id: string;
  anniversaryId: string;
  hyear: number;
  calendarId: string;
  emailAddress: string;
  reminderDays: number;
  observed?: Dayjs | boolean;
  hd?: HDate;
  diff?: number;
};

export type RawYahrzeitContents = Record<string, string | number>;

/**
 * Returns an array of either 1 or 2 Hebrew years to consider for anniversaries.
 */
export function getThisHebrewYear(today: Dayjs): number[] {
  const htoday = new HDate(today.toDate());
  const hyears = [htoday.getFullYear()];
  if (htoday.getMonth() === months.ELUL) {
    hyears.push(hyears[0] + 1);
  }
  return hyears;
}

/**
 * Fills in `observed`, `diff` and `hd` for the anniversary in `info.hyear`,
 * or sets `observed` to false if there is none that year.
 */
export function computeAnniversary(info: SubInfo, today: Dayjs) {
  const hyear = info.hyear;
  const origDt = info.day.toDate();
  const hd0 =
    info.type === 'Yahrzeit' ? getYahrzeitHD(hyear, origDt) : getBirthdayHD(hyear, origDt);
  if (hd0) {
    const hd = new HDate(hd0);
    const observed = (info.observed = dayjs(hd.greg()));
    info.diff = observed.diff(today, 'd');
    info.hd = hd;
  } else {
    info.observed = false;
  }
}

/**
 * Return candle lighting time description based on day of week
 */
export function lightCandlesWhen(dow: number): string {
  if (dow === 5) {
    return 'before sundown';
  } else if (dow === 6) {
    return 'at nightfall';
  } else {
    return 'at dusk';
  }
}

/** Builds the reminder email (with an .ics attachment for a Yahrzeit). */
export function makeMessage(info: SubInfo): SendMailOptions {
  const type = info.type;
  const isYahrzeit = Boolean(type === 'Yahrzeit');
  const isOther = type === 'Other';
  const UTM_PARAM = `utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=${type.toLowerCase()}-reminder`;
  let typeStr = `Hebrew ${type}`;
  if (isYahrzeit) {
    typeStr = type;
  } else if (isOther) {
    typeStr = 'Hebrew Anniversary';
  }
  const observed = info.observed as Dayjs;
  const subject = makeSubject(typeStr, observed);
  const verb = isYahrzeit ? 'remembering' : 'honoring';
  let postscript = '';
  if (isYahrzeit) {
    postscript = YAHRZEIT_POSTSCRIPT;
  } else if (type === 'Birthday') {
    postscript = BIRTHDAY_POSTSCRIPT;
  }
  const erev = observed.subtract(1, 'day');
  const dow = erev.day();
  const when = lightCandlesWhen(dow);
  const lightCandle = isYahrzeit
    ? ` It is customary to light a memorial candle ${when} on
<time datetime="${erev.format('YYYY-MM-DD')}" ${DATE_STYLE}>${erev.format('dddd, MMMM D')}</time>
as the Yahrzeit begins.`
    : '';
  const hebdate = info.hd!.render('en');
  const origDt = info.day.toDate();
  const nth = calculateAnniversaryNth(origDt, info.hyear);
  const msgid = `${info.anniversaryId}.${Date.now().toString(36)}`;
  const returnPath = `yahrzeit-return+${info.id}.${info.hash}.${info.num}@hebcal.com`;
  const urlBase = 'https://www.hebcal.com/yahrzeit';
  const editUrl = `${urlBase}/edit/${info.calendarId}?${UTM_PARAM}#form`;
  const unsubUrl = `${urlBase}/email?id=${info.id}&hash=${info.hash}&num=${info.num}&unsubscribe=1`;
  const emailAddress = info.emailAddress;

  const imgOpen = `<img src="https://www.hebcal.com/email/open?msgid=${msgid}&amp;loc=${type}&amp;${UTM_PARAM}" alt="" width="1" height="1" border="0" style="height:1px!important;width:1px!important;border-width:0!important;margin-top:0!important;margin-bottom:0!important;margin-right:0!important;margin-left:0!important;padding-top:0!important;padding-bottom:0!important;padding-right:0!important;padding-left:0!important">`;
  const prefix = isOther
    ? info.name
    : `Hebcal joins you in ${verb} ${info.name}, whose ${nth} ${typeStr}`;
  const message = makeListMessage({
    to: emailAddress,
    subject,
    msgid,
    returnPath,
    listId: `<${info.id}.list-id.hebcal.com>`,
    listUnsubscribe: `<${unsubUrl}&commit=1&cfg=json>`,
    html: `<div style="font-size:18px;font-family:georgia,'times new roman',times,serif;">
<div>${prefix} occurs on
<time datetime="${observed.format('YYYY-MM-DD')}" ${DATE_STYLE}>${observed.format('dddd, MMMM D')}</time>,
corresponding to the ${hebdate}.</div>
${BLANK}
<div>${typeStr} begins at sundown on the previous day and continues until
sundown on the day of observance.${lightCandle}</div>
${postscript}
</div>
${BLANK}
<div style="font-size:11px;color:#999;font-family:arial,helvetica,sans-serif">
<div>This email was sent to ${emailAddress} by <a href="https://www.hebcal.com/?${UTM_PARAM}">Hebcal.com</a>.
Hebcal is a free Jewish calendar and holiday web site.</div>
${BLANK}
<div><a href="${editUrl}">Edit ${typeStr}</a> |
<a href="${unsubUrl.replaceAll('&', '&amp;')}&amp;cfg=html&amp;${UTM_PARAM}">Unsubscribe</a> |
<a href="https://www.hebcal.com/home/about/privacy-policy?${UTM_PARAM}">Privacy Policy</a></div>
</div>
${imgOpen}
`,
  });
  if (isYahrzeit) {
    const dt = erev.toDate();
    const dow = erev.day();
    let eventTimeStr = '16:30';
    if (dow === 6) {
      eventTimeStr = '20:00';
    } else if (dow === 5) {
      eventTimeStr = '14:30';
    }
    const ev = new Event(new HDate(dt), `${info.name} ${typeStr} reminder`, flags.USER_EVENT, {
      eventTime: dt,
      eventTimeStr,
      memo:
        `Hebcal joins you in ${verb} ${info.name}, whose ${nth} ${typeStr} occurs on ` +
        `${observed.format('dddd, MMMM D')}, corresponding to the ${hebdate}.\\n\\n` +
        `${typeStr} begins at sundown on ${erev.format('dddd, MMMM D')} and continues until ` +
        'sundown on the day of observance. ' +
        `It is customary to light a memorial candle ${when} as the Yahrzeit begins.\\n\\n` +
        'May your loved one’s soul be bound up in the bond of eternal life and may their memory ' +
        'serve as a continued source of inspiration and comfort to you.',
      alarm: 'P0DT0H0M0S',
      uid: `reminder-${info.anniversaryId}`,
      category: 'Personal',
      duration: 15,
    });
    const ical = new IcalEvent(ev, {});
    const lines =
      [
        'BEGIN:VCALENDAR',
        `PRODID:-//Hebcal//NONSGML Anniversary Email v1${IcalEvent.version()}//EN`,
        'VERSION:2.0',
        'CALSCALE:GREGORIAN',
      ].join('\r\n') +
      '\r\n' +
      ical.toString() +
      '\r\nEND:VCALENDAR\r\n';
    message.attachments = [
      {
        content: lines,
        contentType: 'text/calendar; charset=utf-8',
        filename: 'invite.ics',
      },
    ];
  }
  return message;
}

/**
 * @param {Date} origDt
 * @param {number} hyear
 * @return {string}
 */
export function calculateAnniversaryNth(origDt: Date, hyear: number): string {
  const origHd = new HDate(origDt);
  const origHyear = origHd.getFullYear();
  const numYears = hyear - origHyear;
  const nth = Locale.ordinal(numYears);
  return nth;
}

export function makeSubject(type: string, observed: dayjs.Dayjs): string {
  const erev = observed.subtract(1, 'day');
  const erevMon = erev.format('MMMM');
  const erevDay = erev.format('D');
  const obsMon = observed.format('MMMM');
  const obsDay = observed.format('D');
  const dateRange =
    erevMon === obsMon
      ? `${erevMon} ${erevDay}-${obsDay}`
      : `${erevMon} ${erevDay}-${obsMon} ${obsDay}`;
  return `${type} Observance for ${dateRange}`;
}

function empty(val: unknown): boolean {
  return typeof val !== 'string' || val.length === 0;
}

function isNumKey(k: string): boolean {
  const code = k.codePointAt(1)!;
  return code >= 48 && code <= 57;
}

export function getMaxYahrzeitId(query: RawYahrzeitContents): number {
  let max = 0;
  for (const k of Object.keys(query)) {
    const k0 = k[0];
    if ((k0 === 'y' || k0 === 'x') && isNumKey(k)) {
      let id = +k.substring(1);
      if (empty(query[k])) {
        id = 0;
      } else if (k0 === 'y' && (empty(query['d' + id]) || empty(query['m' + id]))) {
        id = 0;
      }
      if (id > max) {
        max = id;
      }
    }
  }
  return max;
}

export function getAnniversaryType(str: string): string {
  if (typeof str === 'string') {
    const s = str.toLowerCase();
    switch (s[0]) {
      case 'y':
        return 'Yahrzeit';
      case 'b':
        return 'Birthday';
      case 'a':
        return 'Anniversary';
      case 'o':
        return 'Other';
    }
  }
  return 'Yahrzeit';
}

export function getYahrzeitDetailForId(
  query: RawYahrzeitContents,
  num: number,
  logger?: Pick<Logger, 'warn'>
): SubBase | null {
  const {yy, mm, dd} = getDateForId(query, num);
  if (empty(dd) || empty(mm) || empty(yy)) {
    return null;
  }
  const year = Number.parseInt(yy, 10);
  const month = Number.parseInt(mm, 10);
  const mday = Number.parseInt(dd, 10);
  if (!mday || !month || !year) {
    logger?.warn(query, `Invalid date for entry ${num}`);
    return null;
  }
  const type = getAnniversaryType(query['t' + num] as string);
  const sunset: string | number = query[`s${num}`];
  const name = getAnniversaryName(query, num, type);
  let day = dayjs(new Date(year, month - 1, mday));
  if (sunset === 'on' || sunset === '1' || sunset === 1) {
    day = day.add(1, 'day');
  }
  const hash = murmur32HexSync([day.format('YYYY-MM-DD'), type].join('-'));
  return {num, dd, mm, yy, sunset, type, name, day, hash};
}

export function getAnniversaryName(query: RawYahrzeitContents, id: number, type: string): string {
  const str = query[`n${id}`];
  const name0 = typeof str === 'string' ? str.trim() : undefined;
  if (name0) {
    return name0;
  }
  const prefix = type === 'Other' ? 'Untitled' : 'Person';
  return prefix + id;
}

type YearMonthDay = {
  yy: string;
  mm: string;
  dd: string;
};

export function getDateForId(query: RawYahrzeitContents, id: number): YearMonthDay {
  const date = query['x' + id];
  if (typeof date === 'string' && date.length === 10) {
    const yy = date.substring(0, 4);
    const gm = date.substring(5, 7);
    const mm = gm.startsWith('0') ? gm[1] : gm;
    const gd = date.substring(8, 10);
    const dd = gd.startsWith('0') ? gd[1] : gd;
    return {yy, mm, dd};
  }
  const yy = query['y' + id] as string;
  const mm = query['m' + id] as string;
  const dd = query['d' + id] as string;
  return {yy, mm, dd};
}
