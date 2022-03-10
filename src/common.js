import {flags, HDate, HebrewCalendar} from '@hebcal/core';
import nodemailer from 'nodemailer';

export const htmlToTextOptions = {
  wordwrap: 74,
  ignoreImage: true,
  hideLinkHrefIfSameAsText: true,
  selectors: [
    {selector: 'img', format: 'skip'},
    {selector: 'a', options: {hideLinkHrefIfSameAsText: true}},
  ],
};

/**
 * create reusable transporter object using the default SMTP transport
 * @param {Object<string,string>} iniConfig
 * @return {nodemailer.Mail}
 */
export function makeTransporter(iniConfig) {
  return nodemailer.createTransport({
    host: iniConfig['hebcal.email.shabbat.host'],
    port: 465,
    secure: true,
    auth: {
      user: iniConfig['hebcal.email.shabbat.user'],
      pass: iniConfig['hebcal.email.shabbat.password'],
    },
    tls: {
      rejectUnauthorized: false, // do not fail on invalid certs
    },
  });
}

/**
 * @param {dayjs.Dayjs} d
 * @return {Event}
 */
export function getChagOnDate(d) {
  const events = HebrewCalendar.getHolidaysOnDate(new HDate(d.toDate())) || [];
  const chag = events.find((ev) => ev.getFlags() & flags.CHAG);
  return chag;
}

/**
 * Bails out if today is a holiday
 * @param {dayjs.Dayjs} today
 * @return {boolean}
 */
export function shouldSendEmailToday(today) {
  const chag = getChagOnDate(today);
  if (chag) {
    return false;
  }
  switch (today.day()) {
    case 4:
      return true; // Normal case: today is Thursday and it is not yontiff
    case 3:
      // send email today (Wednesday) because Thursday is yontiff
      return Boolean(getChagOnDate(today.add(1, 'day')));
    case 2:
      // send email today (Tuesday) because Wed & Thurs are both yontiff
      return (getChagOnDate(today.add(1, 'day')) && getChagOnDate(today.add(2, 'day')));
    default:
      // no email today - not Tue/Wed/Thu
      return false;
  }
}

/**
 * @param {string} smtpStatus
 * @return {string}
 */
export function translateSmtpStatus(smtpStatus) {
  switch (smtpStatus) {
    case '5.1.0':
    case '5.1.1':
    case '5.1.10':
      return 'user_unknown';
    case '5.1.2':
    case '5.4.4':
    case '5.4.14':
    case '5.4.300':
      return 'domain_error';
    case '5.2.1':
      return 'user_disabled';
    case '4.2.2':
    case '5.2.2':
    case '5.2.3':
    case '5.5.2':
    case '552':
      return 'over_quota';
    case '5.3.0':
    case '5.4.1':
    case '5.5.4':
    case '5.7.1':
    case '550':
    case '451': // 451 relay not permitted!, 451 too many errors detected from your IP
      return 'spam';
    default:
      return 'unknown';
  }
}
