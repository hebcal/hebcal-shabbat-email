# hebcal-shabbat-email

Backend jobs that power hebcal.com's email subscriptions: the weekly Shabbat
candle-lighting newsletter and the Yahrzeit (memorial) / anniversary reminder
emails, plus the bounce-handling, unsubscribe, deactivation, and
data-retention plumbing that keeps the subscriber lists healthy.

These are standalone command-line scripts run on a schedule from cron. They're
written in TypeScript, compiled to `dist/`, and share a MySQL database, an SMTP
relay, and (for bounce processing) Amazon SES via SQS.

Requires Node.js 24.x or later.

## Cron scripts

Each script is an independent entry point compiled to `dist/<name>.js`. They
all accept `--quiet` / `--verbose` to control logging, `--ini <file>` to point
at a non-default config file (see [Configuration](#configuration)), and
`--help` for a full flag list.

### `shabbat_weekly.js` — weekly Shabbat times newsletter

The main event. Emails each active subscriber their personalized Shabbat
candle-lighting and havdalah times (computed from the subscriber's location,
elevation preference, and havdalah setting), the week's Torah portion, and any
holidays falling in the coming week — plus a seasonal greeting (Rosh Hashana,
Yom Kippur, Sukkot, Chanukah, Purim, Pesach) when the date calls for one.

Normally it goes out Thursday, but sends a day (or two) early when Thursday —
or Wednesday _and_ Thursday — is a Yom Tov on which mail shouldn't be sent. So
cron fires it Tuesday/Wednesday/Thursday and the script itself decides whether
today is the right day (use `--force` to bypass that check). A per-week "sent"
log deduplicates recipients, so overlapping runs never double-send.

Notable flags:

- `--dryrun` / `-n` — build every message but send nothing.
- `--force` / `-f` — run even when today isn't a scheduled mailing day.
- `--localhost` — send through a local SMTP server on port 25 instead of the configured relay.
- `--positive` / `--negative` — only mail subscribers east (longitude > −20°) or west (≤ −20°, i.e. the Americas) respectively; used to reach earlier time zones first.
- `--sleeptime <ms>` — delay between messages to throttle the relay (default 300).

### `yahrzeit_email.js` — Yahrzeit & anniversary reminders

Sends memorial (Yahrzeit), Hebrew birthday, and Hebrew anniversary reminders 7
days and 1 day before each observance, attaching an `.ics` calendar reminder
for Yahrzeits. Skips Shabbat and Yom Tov. Supports the same `--dryrun`,
`--localhost`, and `--sleeptime` flags, plus `--email <addr>` to send for a
single subscriber only.

### `shabbat_bounce_sqs.js` — SES bounce, complaint & unsubscribe processing

Drains two Amazon SQS queues fed by SES. One carries bounce and complaint
notifications, which are recorded in the `hebcal_shabbat_bounce` table for
later deactivation. The other carries inbound unsubscribe emails, which flip
the subscriber to `unsubscribed` and send a confirmation. Meant to run
frequently (every few minutes) to keep the queues drained.

### `shabbat_deactivate.js` — deactivate chronically-bouncing addresses

Scans recent bounces and deactivates subscriptions whose address has bounced
too many times (or was flagged for abuse). This is what actually stops mail to
dead addresses that `shabbat_bounce_sqs.js` merely recorded. Tunable via
`--count <n>` (bounce threshold, default 7) and `--reasons <list>`
(comma-separated bounce reasons to act on).

### `data_retention.js` — purge old data

Enforces the ≤ 2-year data-retention policy: deletes aged rows from the bounce,
sent-log, and open-tracking tables, and purges long-inactive (pending /
unsubscribed / bounced) subscribers. `--months <n>` overrides the retention
window; `--dryrun` reports row counts without deleting.

## Maintenance scripts (not on cron)

### `remove_dupe_subs.js`

One-off cleanup for Yahrzeit calendars that ended up with several active
subscriptions for the same email address. It unsubscribes all but the most
recently updated one, skipping any calendar that has an opt-out on record.

## Shared modules

`common.ts` (config loading, SMTP transport, logging, holiday helpers) and
`makedb.ts` (a small promise wrapper around MySQL) are libraries used by the
scripts above, not entry points.

## Configuration

Every script reads an INI file — default `/etc/hebcal-dot-com.ini`, overridable
with `--ini`. Keys used:

| Purpose        | Keys                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| MySQL          | `hebcal.mysql.host`, `.port`, `.user`, `.password`, `.dbname`                                                   |
| SMTP relay     | `hebcal.email.shabbat.host`, `.user`, `.password`                                                               |
| Amazon SQS/SES | `hebcal.aws.sqs.access_key`, `.secret_key`, `hebcal.aws.sns.email-bounce.url`, `hebcal.aws.sns.email-unsub.url` |

## Development

```sh
npm install
npm run build     # compile TypeScript to dist/
npm run lint      # oxlint
npm run fix       # oxlint --fix + prettier --write
```

## Deployment (example cron)

The compiled scripts run from cron on the mailer host. The times below are in
the server's local time zone. Only `shabbat_weekly.js` cares about the working
directory — it loads its bundled `zips.sqlite3` / `geonames.sqlite3` databases
by relative path — so it's the one job that needs to `cd $APPDIR` first. The
rest resolve everything by absolute path (the INI file, `/var/log/hebcal-email`,
and Node's own `node_modules`), so they can run from anywhere.

```cron
SHELL=/bin/sh
MAILTO="ops@example.com"
APPDIR=/home/hebcal/hebcal-shabbat-email

# Weekly Shabbat newsletter. Cron fires Tue/Wed/Thu; the script sends only on
# the correct day. Eastern/earlier time zones (--positive) go first at 3:03am,
# then everyone at 8:53am and 2:53pm.
3 3 * * 2,3,4 hebcal cd $APPDIR && node $APPDIR/dist/shabbat_weekly.js --localhost --positive --quiet
53 8,14 * * 2,3,4 hebcal cd $APPDIR && node $APPDIR/dist/shabbat_weekly.js --quiet --localhost

# Deactivate chronically-bouncing addresses: Thu 8:50am and Fri 1:03pm.
50 8 * * 4 hebcal node $APPDIR/dist/shabbat_deactivate.js --quiet --count 3
3 13 * * 5 hebcal node $APPDIR/dist/shabbat_deactivate.js --quiet --count 3

# Drain the SES bounce/complaint/unsubscribe SQS queues every 5 minutes.
*/5 * * * * hebcal node $APPDIR/dist/shabbat_bounce_sqs.js --quiet

# Yahrzeit & anniversary reminders, Sun–Fri at 8:31am.
31 8 * * 0-5 hebcal node $APPDIR/dist/yahrzeit_email.js --quiet --localhost

# Data-retention purge, nightly at 11:47pm.
47 23 * * * hebcal nice node $APPDIR/dist/data_retention.js --quiet
```
