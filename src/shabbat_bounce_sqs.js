/* eslint-disable require-jsdoc */
import fs from 'fs';
import ini from 'ini';
import {makeDb, dirIfExistsOrCwd} from './makedb';
import {makeTransporter, translateSmtpStatus} from './common';
import pino from 'pino';
import minimist from 'minimist';
import {SQSClient, ReceiveMessageCommand, DeleteMessageCommand} from '@aws-sdk/client-sqs';

const argv = minimist(process.argv.slice(2), {
  boolean: ['quiet', 'verbose'],
  alias: {q: 'quiet', v: 'verbose'},
});

const logger = pino({
  level: argv.verbose ? 'debug' : argv.quiet ? 'warn' : 'info',
});
const iniPath = argv.ini || '/etc/hebcal-dot-com.ini';
const config = ini.parse(fs.readFileSync(iniPath, 'utf-8'));

let logdir;

const sqs = new SQSClient({
  region: 'us-east-1',
  credentials: {
    accessKeyId: config['hebcal.aws.sqs.access_key'],
    secretAccessKey: config['hebcal.aws.sqs.secret_key'],
  },
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
 * @param {SQSClient} sqs
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
    const command = new ReceiveMessageCommand(params);
    const response = await sqs.send(command);
    if (!response.Messages || !response.Messages.length) {
      logger.info(`Bounces: done`);
      return new Promise((resolve, reject) => {
        bounceLogStream.on('finish', () => resolve(true));
        bounceLogStream.on('error', reject);
        bounceLogStream.end();
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
      const params = {
        QueueUrl: queueURL,
        ReceiptHandle: message.ReceiptHandle,
      };
      const command = new DeleteMessageCommand(params);
      return sqs.send(command);
    }));
  }
}

/**
 * @param {SQSClient} sqs
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
    const command = new ReceiveMessageCommand(params);
    const response = await sqs.send(command);
    if (!response.Messages || !response.Messages.length) {
      logger.info(`Unsubscribes: done`);
      return new Promise((resolve, reject) => {
        subsLogStream.on('finish', () => resolve(true));
        subsLogStream.on('error', reject);
        subsLogStream.end();
      });
    }
    logger.debug(`Processing ${response.Messages.length} unsubscribe messages`);
    for (const message of response.Messages) {
      const body = JSON.parse(message.Body);
      const innerMsg = JSON.parse(body.Message);
      if (innerMsg.notificationType == 'Received') {
        let source = innerMsg.mail.source;
        const destination = innerMsg.mail.destination[0];
        const matches0 = destination && destination.match(/^shabbat-unsubscribe\+(\w+)@hebcal.com$/);
        const emailId = matches0 && matches0.length && matches0[1];
        const commonHeaders = innerMsg.mail.commonHeaders;
        if (commonHeaders && commonHeaders.from && commonHeaders.from[0]) {
          const from = commonHeaders.from[0];
          const matches = from && from.match(/^[^<]*<([^>]+)>/);
          if (matches && matches.length && matches[1]) {
            source = matches[1].toLowerCase();
          }
        }
        logger.info(`Unsubscribe from=${source} emailId=${emailId}`);
        await unsubscribe(db, destination, source, emailId, innerMsg, subsLogStream);
      }
    }
    logger.info(`Unsubscribes: deleting ${response.Messages.length} messages`);
    await Promise.all(response.Messages.map((message) => {
      const params = {
        QueueUrl: queueURL,
        ReceiptHandle: message.ReceiptHandle,
      };
      const command = new DeleteMessageCommand(params);
      return sqs.send(command);
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

async function unsubscribe(db, destination, emailAddress, emailId, innerMsg, logStream) {
  const t = Math.floor(new Date().getTime() / 1000);
  const sql = 'SELECT email_status,email_id,email_address FROM hebcal_shabbat_email ' +
    (emailId ? 'WHERE email_id = ?' : 'WHERE email_address = ?');
  logger.debug(sql);
  const rows = await db.query(sql, [emailId || emailAddress]);
  const logMessage = {
    time: t,
    status: 0,
    from: emailAddress,
    to: destination,
    code: '',
    message: {
      notificationType: innerMsg.notificationType,
    },
  };
  const mail = innerMsg.mail;
  if (typeof mail === 'object') {
    logMessage.message.mail = {
      timestamp: mail.timestamp,
      source: mail.source,
      messageId: mail.messageId,
      commonHeaders: mail.commonHeaders,
    };
  }
  if (!rows || !rows.length) {
    logMessage.code='unsub_notfound';
    logStream.write(JSON.stringify(logMessage));
    logStream.write('\n');
    return errorMail(emailAddress);
  }
  const row = rows[0];
  const origEmail = row.email_address;
  logMessage.from = origEmail;
  if (row.email_status == 'unsubscribed') {
    logMessage.code='unsub_twice';
    logStream.write(JSON.stringify(logMessage));
    return errorMail(origEmail);
  }
  logMessage.status = 1;
  logMessage.code='unsub';
  logStream.write(JSON.stringify(logMessage));
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
  const db = makeDb(logger, config);
  logdir = await dirIfExistsOrCwd('/var/log/hebcal');
  await readUnsubQueue(sqs, db);
  await readBounceQueue(sqs, db);
  return db.close();
}
