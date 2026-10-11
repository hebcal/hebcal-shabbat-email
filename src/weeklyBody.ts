import {CalOptions, Event, HolidayEvent, Location, reformatTimeStr, TimedEvent} from '@hebcal/core';
import dayjs, {Dayjs} from 'dayjs';
import {Announcement, getSpecialNote, SpecialNoteConfig} from './specialNote.js';
import {urlEncodeAndTrack} from './tracking.js';

const FORMAT_DOW_MONTH_DAY = 'dddd, MMMM D';
export const BLANK = '<div>&nbsp;</div>';
const ITEM_STYLE = 'padding-left:8px;margin-bottom:2px';

export type SubjectAndBody = [
  subject: string,
  body: string,
  htmlBody: string,
  specialNote: string,
  specialNoteTxt: string,
];

/**
 * Gets start and end days for filtering relevant hebcal events: midnight
 * today through six days later, which always includes the coming Saturday.
 */
export function getStartAndEnd(now: Date): [dayjs.Dayjs, dayjs.Dayjs] {
  const midnight = dayjs(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  return [midnight, midnight.add(6, 'day')];
}

/**
 * Sorts east-to-west by longitude, then south-to-north by latitude, then by
 * name, so subscribers sharing a location are adjacent and can reuse a body.
 */
export function compareConfigs(a: {location: Location}, b: {location: Location}): number {
  const locA = a.location;
  const locB = b.location;
  const lonA = locA.getLongitude();
  const lonB = locB.getLongitude();
  if (lonA === lonB) {
    const latA = locA.getLatitude();
    const latB = locB.getLatitude();
    if (latA === latB) {
      const nameA = locA.getName()!;
      const nameB = locB.getName()!;
      return nameA.localeCompare(nameB);
    } else {
      return latA - latB;
    }
  } else {
    return lonB - lonA;
  }
}

/** Subscriber fields recorded in the sent log. */
export type SentLogConfig = {
  email: string;
  zip?: string;
  geonameid?: number;
  legacyCity?: string;
};

/**
 * Formats one sent-log line (`mid:accepted:email:location`) and reports
 * whether the relay accepted the message.
 */
export function formatSentLogLine(
  cfg: SentLogConfig,
  info: {messageId: string; response?: string}
): [line: string, accepted: boolean] {
  const location = cfg.zip || cfg.geonameid || cfg.legacyCity;
  const mid = info.messageId.substring(1, info.messageId.indexOf('@'));
  const accepted = info.response?.startsWith('250') ?? false;
  return [`${mid}:${Number(accepted)}:${cfg.email}:${location}\n`, accepted];
}

/**
 * Parses the contents of a previous run's sent log and returns the
 * addresses that were successfully accepted, so they can be skipped.
 */
export function parseSentLog(contents: string): Set<string> {
  const result = new Set<string>();
  for (const line of contents.split('\n')) {
    const [, status, to] = line.split(':');
    if (+status && to) {
      result.add(to);
    }
  }
  return result;
}

/** Mutable text/HTML accumulator threaded through the per-event renderers. */
type BodyAccumulator = {
  body: string;
  htmlBody: string;
  firstCandles?: string;
  sedra?: string;
  prevStrtime?: string;
};

/** Emits the date sub-heading when we cross into a new calendar day. */
function appendDateHeader(acc: BodyAccumulator, strtime: string): void {
  if (strtime === acc.prevStrtime) {
    return;
  }
  if (acc.htmlBody !== '') {
    acc.htmlBody += `${BLANK}\n`;
    acc.body += '\n';
  }
  acc.htmlBody += `<div style="font-size:14px;color:#941003;font-family:arial,helvetica,sans-serif">${strtime}</div>\n`;
  acc.body += `${strtime}\n`;
  acc.prevStrtime = strtime;
}

/** Per-event values derived once in the loop and shared by the renderers. */
type RenderedEvent = {
  ev: Event;
  dt: dayjs.Dayjs;
  /** Plain-text title. */
  title: string;
  /** HTML title, with typographic apostrophes. */
  title1: string;
  emoji: string | null;
};

function appendTimedEvent(acc: BodyAccumulator, r: RenderedEvent, options: CalOptions): void {
  const ev = r.ev as TimedEvent;
  const desc = ev.getDesc();
  const hourMin = reformatTimeStr(ev.eventTimeStr, 'pm', options);
  if (!acc.firstCandles && desc === 'Candle lighting') {
    acc.firstCandles = hourMin;
  }
  const verb = desc === 'Candle lighting' || desc === 'Havdalah' ? ' is' : '';
  acc.body += `  ${r.title}${verb} at ${hourMin}\n`;
  const emojiSuffix = ev.hasAnyFlag('CHANUKAH_CANDLES', 'KIDDUSH_LEVANA') ? ` ${r.emoji}` : '';
  acc.htmlBody += `<div style="${ITEM_STYLE}">${r.title1}${verb} at <strong>${hourMin}</strong>${emojiSuffix}</div>\n`;
}

function appendParsha(acc: BodyAccumulator, r: RenderedEvent, options: CalOptions): void {
  acc.sedra = r.title.substring(r.title.indexOf(' ') + 1);
  acc.body += `  Torah portion: ${r.title}\n`;
  const url2 = urlEncodeAndTrack(r.ev.url()!, options.il);
  acc.htmlBody += `<div style="${ITEM_STYLE}">Torah portion: <a href="${url2}">${r.title1}</a></div>\n`;
}

function appendHoliday(acc: BodyAccumulator, r: RenderedEvent, options: CalOptions): void {
  const ev = r.ev as HolidayEvent;
  if (r.dt.day() === 6 && !acc.sedra && (ev.hasFlag('CHAG') || ev.cholHaMoedDay)) {
    acc.sedra = ev.basename();
  }
  acc.body += `  ${r.title}\n`;
  const url = ev.url();
  acc.htmlBody += `<div style="${ITEM_STYLE}">`;
  if (url) {
    const url2 = urlEncodeAndTrack(url, options.il);
    acc.htmlBody += `<a href="${url2}">${r.title1}</a>`;
  } else {
    acc.htmlBody += r.title1;
  }
  const emojiSuffix = r.emoji ? ` ${r.emoji}` : '';
  acc.htmlBody += `${emojiSuffix}</div>\n`;
}

/**
 * Renders the week's events into the email subject plus text and HTML
 * bodies, along with the seasonal note / announcement for `today`.
 */
export function makeSubjectAndBody(
  events: Event[],
  options: CalOptions,
  cfg: SpecialNoteConfig,
  today: Dayjs,
  announcement?: Announcement
): SubjectAndBody {
  const acc: BodyAccumulator = {body: '', htmlBody: ''};
  for (const ev of events) {
    const timed = Boolean((ev as TimedEvent).eventTime);
    const title = timed ? ev.renderBrief(options.locale) : ev.render(options.locale);
    const r: RenderedEvent = {
      ev,
      dt: dayjs(ev.getDate().greg()),
      title,
      title1: title.replaceAll("'", '’'),
      emoji: ev.getEmoji(),
    };
    appendDateHeader(acc, r.dt.format(FORMAT_DOW_MONTH_DAY));
    if (timed) {
      appendTimedEvent(acc, r, options);
    } else if (ev.hasFlag('PARSHA_HASHAVUA')) {
      appendParsha(acc, r, options);
    } else {
      appendHoliday(acc, r, options);
    }
  }
  const shortLocation = cfg.location.getShortName();
  let subject = '🕯️';
  if (acc.sedra) subject += ` ${acc.sedra} -`;
  subject += ' ' + shortLocation;
  if (acc.firstCandles) subject += ` candles ${acc.firstCandles}`;

  const [specialNoteTxt, specialNote] = getSpecialNote(cfg, today, announcement);

  return [subject, acc.body, acc.htmlBody, specialNote, specialNoteTxt];
}
