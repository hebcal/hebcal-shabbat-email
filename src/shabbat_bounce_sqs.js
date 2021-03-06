/* eslint-disable require-jsdoc */
import fs from 'fs';
import ini from 'ini';
import {makeDb, dirIfExistsOrCwd} from './makedb';
import {makeTransporter} from './common';
import pino from 'pino';
import minimist from 'minimist';
import AWS from 'aws-sdk';

const argv = minimist(process.argv.slice(2), {
  boolean: ['quiet'],
  alias: {q: 'quiet'},
});

const logger = pino({
  level: argv.quiet ? 'warn' : 'info',
  prettyPrint: {translateTime: true, ignore: 'pid,hostname'},
});
const iniPath = argv.ini || '/etc/hebcal-dot-com.ini';
const config = ini.parse(fs.readFileSync(iniPath, 'utf-8'));

let logdir;

AWS.config.update({region: 'us-east-1'});
const sqs = new AWS.SQS({
  apiVersion: '2012-11-05',
  credentials: new AWS.Credentials(
      config['hebcal.aws.access_key'],
      config['hebcal.aws.secret_key']),
});

const transporter = makeTransporter(config);

main()
    .then(() => {
      logger.info('Success!');
    })
    .catch((err) => {
      logger.fatal(err);
      process.exit(1);
    });

/**
 * @param {string} smtpStatus
 * @return {string}
 */
function translateSmtpStatus(smtpStatus) {
  switch (smtpStatus) {
    case '5.1.0':
    case '5.1.1':
      return 'user_unknown';
    case '5.1.2':
    case '5.4.4':
      return 'domain_error';
    case '5.2.1':
      return 'user_disabled';
    case '4.2.2':
    case '5.2.2':
    case '5.2.3':
    case '5.5.2':
      return 'over_quota';
    case '5.3.0':
    case '5.4.1':
    case '5.5.4':
    case '5.7.1':
      return 'spam';
    default:
      return 'unknown';
  }
}

/**
 * @param {Object} bounce
 * @return {string}
 */
function getStdReason(bounce) {
  if (bounce.bounceSubType && bounce.bounceSubType == 'MailboxFull') {
    return 'over_quota';
  }
  const bouncedRecipient = bounce.bouncedRecipients[0];
  const diagnostic = bouncedRecipient.diagnosticCode;
  if (diagnostic) {
    const matches = diagnostic.match(/\s(5\.\d+\.\d+)\s/);
    if (matches && matches.length && matches[1]) {
      return translateSmtpStatus(matches[1]);
    } else if (diagnostic.startsWith('Amazon SES has suppressed sending to this address')) {
      return 'user_disabled';
    }
  }
  if (bouncedRecipient.status) {
    return translateSmtpStatus(bouncedRecipient.status);
  }
  return 'unknown';
}

/**
 * @param {AWS.SQS} sqs
 * @param {*} db
 */
async function readBounceQueue(sqs, db) {
  const bounceLogFilename = logdir + '/bounce-' + new Date().toISOString().substring(0, 7) + '.log';
  const bounceLogStream = fs.createWriteStream(bounceLogFilename, {flags: 'a'});
  const queueURL = config['hebcal.aws.sns.email-bounce.url'];
  logger.info(`Bounces: fetching from ${queueURL}`);
  const params = {
    QueueUrl: queueURL,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 5,
  };
  const sql = 'INSERT INTO hebcal_shabbat_bounce (email_address,std_reason,full_reason,deactivated) VALUES (?,?,?,0)';
  while (true) {
    logger.debug(`Bounces: polling for a batch`);
    const response = await sqs.receiveMessage(params).promise();
    if (!response.Messages || !response.Messages.length) {
      logger.info(`Bounces: done`);
      return new Promise((resolve, reject) => {
        bounceLogStream.end();
        bounceLogStream.on('finish', () => resolve(true));
        bounceLogStream.on('error', reject);
      });
    }
    logger.debug(`Processing ${response.Messages.length} bounce messages`);
    for (const message of response.Messages) {
      const body = JSON.parse(message.Body);
      bounceLogStream.write(body.Message);
      bounceLogStream.write('\n');
      const innerMsg = JSON.parse(body.Message);
      if (innerMsg.notificationType == 'Bounce') {
        const bounceType = innerMsg.bounce.bounceType;
        const recip = innerMsg.bounce.bouncedRecipients[0];
        const emailAddress = recip.emailAddress;
        let stdReason = getStdReason(innerMsg.bounce);
        if (stdReason == 'unknown' && bounceType == 'Transient') {
          stdReason = bounceType;
        }
        logger.info(`Bounce: ${emailAddress} ${stdReason}`);
        await db.query(sql, [emailAddress, stdReason, recip.diagnosticCode]);
      } else if (innerMsg.notificationType == 'Complaint') {
        const emailAddress = innerMsg.complaint.complainedRecipients[0].emailAddress;
        const stdReason = 'amzn_abuse';
        logger.info(`Complaint: ${emailAddress} ${stdReason}`);
        await db.query(sql, [emailAddress, stdReason, stdReason]);
      } else {
        logger.warn(`Ignoring unknown bounce message ${innerMsg.notificationType}`);
        console.log(innerMsg);
      }
    }
    logger.debug(`Bounces: deleting ${response.Messages.length} messages`);
    await Promise.all(response.Messages.map((message) => {
      sqs.deleteMessage({QueueUrl: queueURL, ReceiptHandle: message.ReceiptHandle}).promise();
    }));
  }
}

/**
 * @param {AWS.SQS} sqs
 * @param {*} db
 */
async function readUnsubQueue(sqs, db) {
  const subsLogFilename = logdir + '/subscribers.log';
  const subsLogStream = fs.createWriteStream(subsLogFilename, {flags: 'a'});
  const queueURL = config['hebcal.aws.sns.email-unsub.url'];
  logger.info(`Unsubscribes: fetching from ${queueURL}`);
  const params = {
    QueueUrl: queueURL,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 5,
  };
  while (true) {
    logger.debug(`Unsubscribes: polling for a batch`);
    const response = await sqs.receiveMessage(params).promise();
    if (!response.Messages || !response.Messages.length) {
      logger.info(`Unsubscribes: done`);
      return new Promise((resolve, reject) => {
        subsLogStream.end();
        subsLogStream.on('finish', () => resolve(true));
        subsLogStream.on('error', reject);
      });
    }
    logger.debug(`Processing ${response.Messages.length} unsubscribe messages`);
    for (const message of response.Messages) {
      const body = JSON.parse(message.Body);
      const innerMsg = JSON.parse(body.Message);
      if (innerMsg.notificationType == 'Received') {
        let source = innerMsg.mail.source;
        const destination = innerMsg.mail.destination[0];
        const matches0 = destination.match(/^shabbat-unsubscribe\+(\w+)@hebcal.com$/);
        const emailId = matches0 && matches0.length && matches0[1];
        const commonHeaders = innerMsg.mail.commonHeaders;
        if (commonHeaders && commonHeaders.from && commonHeaders.from[0]) {
          const from = commonHeaders.from[0];
          const matches = from.match(/^[^<]*<([^>]+)>/);
          if (matches && matches.length && matches[1]) {
            source = matches[1].toLowerCase();
          }
        }
        logger.info(`Unsubscribe from=${source} emailId=${emailId}`);
        await unsubscribe(db, destination, source, emailId, subsLogStream);
      }
    }
    logger.info(`Unsubscribes: deleting ${response.Messages.length} messages`);
    await Promise.all(response.Messages.map((message) => {
      sqs.deleteMessage({QueueUrl: queueURL, ReceiptHandle: message.ReceiptHandle}).promise();
    }));
  }
}

async function errorMail(emailAddress) {
  const message = {
    from: 'Hebcal <shabbat-owner@hebcal.com>',
    to: emailAddress,
    subject: 'Unable to process your message',
    text: 'Sorry,\n\nWe are unable to process the message from <' + emailAddress + '>.\n\n' +
    'The email address used to send your message is not subscribed to the Shabbat ' +
    'candle lighting time list.\n\nRegards,\nhebcal.com\n\n',
  };
  return transporter.sendMail(message);
}

async function unsubscribe(db, destination, emailAddress, emailId, subsLogStream) {
  const t = Math.floor(new Date().getTime() / 1000);
  const sql = 'SELECT email_status,email_id,email_address FROM hebcal_shabbat_email ' +
    (emailId ? 'WHERE email_id = ?' : 'WHERE email_address = ?');
  logger.debug(sql);
  const rows = await db.query(sql, [emailId || emailAddress]);
  if (!rows || !rows.length) {
    subsLogStream.write(`status=0 from=${emailAddress} to=${destination} code=unsub_notfound time=${t}\n`);
    return errorMail(emailAddress);
  }
  const row = rows[0];
  const origEmail = row.email_address;
  if (row.email_status == 'unsubscribed') {
    subsLogStream.write(`status=0 from=${origEmail} to=${destination} code=unsub_twice time=${t}\n`);
    return errorMail(origEmail);
  }
  subsLogStream.write(`status=1 from=${origEmail} to=${destination} code=unsub time=${t}\n`);
  const sql2 = 'UPDATE hebcal_shabbat_email SET email_status=\'unsubscribed\' WHERE email_id = ?';
  logger.debug(sql2);
  await db.query(sql2, [row.email_id]);
  const message = {
    from: 'Hebcal <shabbat-owner@hebcal.com>',
    to: origEmail,
    subject: 'You have been unsubscribed from hebcal',
    text: 'Hello,\n\nPer your request, you have been removed from the weekly ' +
    `Shabbat candle lighting time list.\n\nRegards,\nhebcal.com\n\n[id:${row.email_id}]\n`,
  };
  return transporter.sendMail(message);
}

async function main() {
  const db = makeDb(config);
  logdir = await dirIfExistsOrCwd('/var/log/hebcal');
  await readUnsubQueue(sqs, db);
  await readBounceQueue(sqs, db);
  return db.close();
}
