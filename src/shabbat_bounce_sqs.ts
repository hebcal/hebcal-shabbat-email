import {DeleteMessageCommand, Message, ReceiveMessageCommand, SQSClient} from '@aws-sdk/client-sqs';
import fs from 'node:fs';
import {parseArgs} from 'node:util';
import pino from 'pino';
import {
  getLogLevel,
  makeTransporter,
  normalizeEmailAddress,
  readIniConfig,
  translateSmtpStatus,
} from './common.js';
import {LOGDIR, dirIfExistsOrCwd, makeDb, MysqlDb} from './makedb.js';
import {Metrics} from './metrics.js';

const {values: argv} = parseArgs({
  options: {
    quiet: {type: 'boolean', short: 'q'},
    verbose: {type: 'boolean', short: 'v'},
    ini: {type: 'string'},
  },
});

const logger = pino({
  level: getLogLevel(argv),
});
const config = readIniConfig(argv.ini);
// This job has no --dryrun: it either drains the queues or it does not run.
const metrics = new Metrics('shabbat_bounce_sqs', {logger});

let logdir: string;

const sqs = new SQSClient({
  region: 'us-east-1',
  credentials: {
    accessKeyId: config['hebcal.aws.sqs.access_key'],
    secretAccessKey: config['hebcal.aws.sqs.secret_key'],
  },
});

const transporter = makeTransporter(config);

type BouncedRecipient = {
  emailAddress: string;
  status?: string;
  diagnosticCode?: string;
};

type SesBounce = {
  bounceType?: string;
  bounceSubType?: string;
  bouncedRecipients: BouncedRecipient[];
};

type SesMail = {
  timestamp?: string;
  source?: string;
  messageId?: string;
  destination?: string[];
  commonHeaders?: {from?: string[]};
};

type SesNotification = {
  notificationType?: string;
  bounce?: SesBounce;
  complaint?: {complainedRecipients: {emailAddress: string}[]};
  mail?: SesMail;
  hebcal?: {timestamp: string; stdReason?: string; ignored?: boolean};
};

type UnsubLogMessage = {
  time: number;
  status: number;
  from: string;
  to: string;
  code: string;
  message: {
    notificationType?: string;
    mail?: {
      timestamp?: string;
      source?: string;
      messageId?: string;
      commonHeaders?: {from?: string[]};
    };
  };
};

function getStdReason(bounce: SesBounce): string {
  if (bounce.bounceSubType && bounce.bounceSubType === 'MailboxFull') {
    return 'over_quota';
  }
  const bouncedRecipient = bounce.bouncedRecipients[0];
  const diagnostic = bouncedRecipient.diagnosticCode;
  if (diagnostic) {
    const matches = diagnostic.match(/\s(5\.\d+\.\d+)\s/);
    if (matches?.length && matches[1]) {
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

/** Flushes and closes a log stream, resolving once the OS write completes. */
function endLogStream(stream: fs.WriteStream): Promise<boolean> {
  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(true));
    stream.on('error', reject);
    stream.end();
  });
}

/** Deletes a batch of processed messages from the queue. */
async function deleteMessages(sqs: SQSClient, queueURL: string, messages: Message[]) {
  await Promise.all(
    messages.map(message => {
      const command = new DeleteMessageCommand({
        QueueUrl: queueURL,
        ReceiptHandle: message.ReceiptHandle,
      });
      return sqs.send(command);
    })
  );
}

/** Records a single bounce/complaint notification in the DB. */
async function recordBounceNotification(innerMsg: any, db: MysqlDb, sql: string) {
  if (innerMsg.notificationType === 'Bounce') {
    const bounceType = innerMsg.bounce.bounceType;
    const recip = innerMsg.bounce.bouncedRecipients[0];
    const emailAddress = normalizeEmailAddress(recip.emailAddress);
    let stdReason = getStdReason(innerMsg.bounce);
    if (stdReason === 'unknown' && bounceType === 'Transient') {
      stdReason = bounceType;
    }
    logger.info(`Bounce: ${emailAddress} ${stdReason}`);
    innerMsg.hebcal.stdReason = stdReason;
    // Labelled by the same std_reason enum the row is stored under, so a
    // dashboard panel and a `SELECT std_reason, COUNT(*)` agree.
    metrics.inc('hebcal_email_bounces_total', {reason: stdReason});
    await db.query(sql, [emailAddress, stdReason, recip.diagnosticCode]);
  } else if (innerMsg.notificationType === 'Complaint') {
    const emailAddress = normalizeEmailAddress(
      innerMsg.complaint.complainedRecipients[0].emailAddress
    );
    const stdReason = 'amzn_abuse';
    logger.info(`Complaint: ${emailAddress} ${stdReason}`);
    innerMsg.hebcal.stdReason = stdReason;
    metrics.inc('hebcal_email_bounces_total', {reason: stdReason});
    await db.query(sql, [emailAddress, stdReason, stdReason]);
  } else {
    logger.warn(`Ignoring unknown bounce message ${innerMsg.notificationType}`);
    metrics.inc('hebcal_email_bounce_notifications_ignored_total');
    innerMsg.hebcal.ignored = true;
    console.log(innerMsg);
  }
}

async function processBounceMessage(
  message: Message,
  db: MysqlDb,
  sql: string,
  bounceLogStream: fs.WriteStream
) {
  if (!message.Body) {
    logger.warn(`Skipping ${message.MessageId} with no body`);
    return;
  }
  const body = JSON.parse(message.Body);
  const innerMsg = JSON.parse(body.Message);
  innerMsg.hebcal = {timestamp: new Date().toISOString()};
  await recordBounceNotification(innerMsg, db, sql);
  bounceLogStream.write(JSON.stringify(innerMsg));
  bounceLogStream.write('\n');
}

async function readBounceQueue(sqs: SQSClient, db: MysqlDb) {
  const bounceLogFilename = logdir + '/bounce-' + new Date().toISOString().substring(0, 7) + '.log';
  const bounceLogStream = fs.createWriteStream(bounceLogFilename, {flags: 'a'});
  const queueURL = config['hebcal.aws.sns.email-bounce.url'];
  logger.info(`Bounces: fetching from ${queueURL}`);
  const params = {
    QueueUrl: queueURL,
    MaxNumberOfMessages: 10,
    WaitTimeSeconds: 5,
  };
  const sql =
    'INSERT INTO hebcal_shabbat_bounce (email_address,std_reason,full_reason,deactivated) VALUES (?,?,?,0)';

  while (true) {
    logger.debug('Bounces: polling for a batch');
    const command = new ReceiveMessageCommand(params);
    const response = await sqs.send(command);
    if (!response.Messages?.length) {
      logger.info('Bounces: done');
      return endLogStream(bounceLogStream);
    }
    logger.debug(`Processing ${response.Messages.length} bounce messages`);
    metrics.inc('hebcal_email_sqs_messages_total', {queue: 'bounce'}, response.Messages.length);
    for (const message of response.Messages) {
      await processBounceMessage(message, db, sql, bounceLogStream);
    }
    logger.debug(`Bounces: deleting ${response.Messages.length} messages`);
    await deleteMessages(sqs, queueURL, response.Messages);
  }
}

/**
 * Determines the unsubscribe source address, preferring the parsed From
 * header over the envelope source when available.
 */
function extractUnsubSource(mail: SesMail): string {
  const from = mail.commonHeaders?.from?.[0];
  if (from) {
    return normalizeEmailAddress(from);
  }
  return mail.source as string;
}

async function processUnsubMessage(message: Message, db: MysqlDb, subsLogStream: fs.WriteStream) {
  if (!message.Body) {
    logger.warn(`Skipping ${message.MessageId} with no body`);
    return;
  }
  const body = JSON.parse(message.Body);
  const innerMsg = JSON.parse(body.Message);
  if (innerMsg.notificationType !== 'Received') {
    return;
  }
  const destination = innerMsg.mail.destination[0];
  const matches0 = destination?.match(/^shabbat-unsubscribe\+(\w+)@hebcal\.com$/);
  const emailId = matches0?.length && matches0[1];
  const source = extractUnsubSource(innerMsg.mail);
  logger.info(`Unsubscribe from=${source} emailId=${emailId}`);
  await unsubscribe(db, destination, source, emailId, innerMsg, subsLogStream);
}

async function readUnsubQueue(sqs: SQSClient, db: MysqlDb) {
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
    logger.debug('Unsubscribes: polling for a batch');
    const command = new ReceiveMessageCommand(params);
    const response = await sqs.send(command);
    if (!response.Messages?.length) {
      logger.info('Unsubscribes: done');
      return endLogStream(subsLogStream);
    }
    logger.debug(`Processing ${response.Messages.length} unsubscribe messages`);
    metrics.inc('hebcal_email_sqs_messages_total', {queue: 'unsub'}, response.Messages.length);
    for (const message of response.Messages) {
      await processUnsubMessage(message, db, subsLogStream);
    }
    logger.info(`Unsubscribes: deleting ${response.Messages.length} messages`);
    await deleteMessages(sqs, queueURL, response.Messages);
  }
}

async function errorMail(emailAddress: string) {
  const message = {
    from: 'Hebcal <shabbat-owner@hebcal.com>',
    to: emailAddress,
    subject: 'Unable to process your message',
    text:
      'Sorry,\n\nWe are unable to process the message from <' +
      emailAddress +
      '>.\n\n' +
      'The email address used to send your message is not subscribed to the Shabbat ' +
      'candle lighting time list.\n\nRegards,\nhebcal.com\n\n',
  };
  return transporter.sendMail(message);
}

async function unsubscribe(
  db: MysqlDb,
  destination: string,
  emailAddress: string,
  emailId: string,
  innerMsg: SesNotification,
  logStream: fs.WriteStream
) {
  const t = Math.floor(Date.now() / 1000);
  const sql =
    'SELECT email_status,email_id,email_address FROM hebcal_shabbat_email ' +
    (emailId ? 'WHERE email_id = ?' : 'WHERE email_address = ?');
  logger.debug(sql);
  const rows = await db.query(sql, [emailId || emailAddress]);
  const logMessage: UnsubLogMessage = {
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
  if (!rows?.length) {
    logMessage.code = 'unsub_notfound';
    metrics.inc('hebcal_email_unsubscribes_total', {result: logMessage.code});
    logStream.write(JSON.stringify(logMessage));
    logStream.write('\n');
    return errorMail(emailAddress);
  }
  const row = rows[0];
  const origEmail = row.email_address;
  logMessage.from = origEmail;
  if (row.email_status === 'unsubscribed') {
    logMessage.code = 'unsub_twice';
    metrics.inc('hebcal_email_unsubscribes_total', {result: logMessage.code});
    logStream.write(JSON.stringify(logMessage));
    logStream.write('\n');
    return errorMail(origEmail);
  }
  logMessage.status = 1;
  logMessage.code = 'unsub';
  metrics.inc('hebcal_email_unsubscribes_total', {result: logMessage.code});
  logStream.write(JSON.stringify(logMessage));
  logStream.write('\n');
  const sql2 = "UPDATE hebcal_shabbat_email SET email_status='unsubscribed' WHERE email_id = ?";
  logger.debug(sql2);
  await db.query(sql2, [row.email_id]);
  const message = {
    from: 'Hebcal <shabbat-owner@hebcal.com>',
    to: origEmail,
    subject: 'You have been unsubscribed from hebcal',
    text:
      'Hello,\n\nPer your request, you have been removed from the weekly ' +
      `Shabbat candle lighting time list.\n\nRegards,\nhebcal.com\n\n[id:${row.email_id}]\n`,
  };
  return transporter.sendMail(message);
}

async function main() {
  const db = makeDb(logger, config);
  logdir = await dirIfExistsOrCwd(LOGDIR);
  await readUnsubQueue(sqs, db);
  await readBounceQueue(sqs, db);
  return db.close();
}

try {
  await main();
  metrics.finish('success');
  logger.info('Success!');
} catch (err) {
  logger.fatal(err);
  metrics.finish('failure');
  process.exit(1);
}
