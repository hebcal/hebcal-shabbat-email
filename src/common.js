import {flags, HDate, HebrewCalendar} from '@hebcal/core';
import nodemailer from 'nodemailer';

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
