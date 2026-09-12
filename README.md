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

### `metrics_textfile.js` — refresh the current-state Prometheus gauges

Not on cron: driven by a systemd timer every 15 minutes (see
[Metrics](#metrics)). Queries MySQL for the numbers that are properties of the
database rather than of any one job — subscriber counts per list and status, the
size of the bounce table, and the un-actioned bounce backlog by `std_reason` —
and rewrites the `.prom` file the other scripts also write.

## Maintenance scripts (not on cron)

### `remove_dupe_subs.js`

One-off cleanup for Yahrzeit calendars that ended up with several active
subscriptions for the same email address. It unsubscribes all but the most
recently updated one, skipping any calendar that has an opt-out on record.

## Shared modules

`common.ts` (config loading, SMTP transport, logging, holiday helpers),
`makedb.ts` (a small promise wrapper around MySQL) and `metrics.ts` (the
Prometheus recorder described below) are libraries used by the scripts above,
not entry points.

## Metrics

Every script reports what it did to Prometheus through node_exporter's
**textfile collector**, writing `/var/lib/hebcal-email/hebcal_email.prom`. On the
mail host a root-owned systemd timer copies that file into
`/var/lib/prometheus/node-exporter/` every two minutes, where node_exporter reads it.

These are short-lived cron processes, so there is nothing for Prometheus to
scrape while they run; the usual answer (a Pushgateway) would mean a new daemon
and a new open port on the mail host. Every hebcal droplet already runs
node_exporter with the textfile collector enabled, so a file dropped in its
directory arrives on the existing `:9100` scrape with the same `instance` label
as the rest of the host metrics — no scrape config, no tag, no new listener.

That copy step is why the jobs write where they do. node_exporter's textfile
directory belongs to the `prometheus-node-exporter` Debian package, which ships
it root-owned and whose ownership dpkg restores on every unpack — so granting an
unprivileged mail user write access there does not survive an `apt upgrade`. A
root timer needs no permission at all. Nothing here needs to know about that
beyond the output path.

A counter has to be monotonic _across_ runs, and each invocation is a fresh
process that knows only its own deltas. So the durable totals live in a small
SQLite database (`/var/lib/hebcal-email/metrics.sqlite3`, via the standard
library's `node:sqlite` — no new dependency), and the `.prom` file is a
rendering of it. Every writer renders the _whole_ database and renames the
result into place, so overlapping jobs — the five-minute SQS drain during an
hour-long weekly send — cannot produce a partial file.

`--dryrun` disables recording entirely: a dry run's counts are not real traffic.

| Metric                                            | Type    | Labels                                    |
| ------------------------------------------------- | ------- | ----------------------------------------- |
| `hebcal_email_job_runs_total`                     | counter | `job`, `result` (success/failure/skipped) |
| `hebcal_email_job_last_run_timestamp_seconds`     | gauge   | `job`                                     |
| `hebcal_email_job_last_success_timestamp_seconds` | gauge   | `job`                                     |
| `hebcal_email_job_duration_seconds`               | gauge   | `job`                                     |
| `hebcal_email_shabbat_sent_total`                 | counter | —                                         |
| `hebcal_email_shabbat_send_failures_total`        | counter | —                                         |
| `hebcal_email_shabbat_subscribers_loaded`         | gauge   | —                                         |
| `hebcal_email_shabbat_recipients`                 | gauge   | —                                         |
| `hebcal_email_shabbat_skipped_already_sent`       | gauge   | —                                         |
| `hebcal_email_shabbat_config_failures_total`      | counter | `reason`                                  |
| `hebcal_email_yahrzeit_sent_total`                | counter | `type`, `reminder_days`                   |
| `hebcal_email_yahrzeit_send_failures_total`       | counter | `type`, `reminder_days`                   |
| `hebcal_email_yahrzeit_subscriptions_loaded`      | gauge   | —                                         |
| `hebcal_email_yahrzeit_reminders_due`             | gauge   | —                                         |
| `hebcal_email_yahrzeit_optout_rules`              | gauge   | —                                         |
| `hebcal_email_sqs_messages_total`                 | counter | `queue` (bounce/unsub)                    |
| `hebcal_email_bounces_total`                      | counter | `reason` (the `std_reason` enum)          |
| `hebcal_email_bounce_notifications_ignored_total` | counter | —                                         |
| `hebcal_email_unsubscribes_total`                 | counter | `result`                                  |
| `hebcal_email_deactivated_total`                  | counter | `reason`                                  |
| `hebcal_email_deactivate_candidates`              | gauge   | —                                         |
| `hebcal_email_retention_rows_deleted_total`       | counter | `table`                                   |
| `hebcal_email_retention_rows_expired`             | gauge   | `table`                                   |
| `hebcal_email_subscribers`                        | gauge   | `list`, `status`                          |
| `hebcal_email_bounce_table_rows`                  | gauge   | —                                         |
| `hebcal_email_bounces_pending_deactivation`       | gauge   | `reason`                                  |

`src/metrics.ts` holds the catalog, and a metric name that is not in it is never
written — that is what keeps a typo from quietly becoming a new time series.

Two environment variables override the paths, for testing or if the
node_exporter package ever moves its directory:
`HEBCAL_METRICS_TEXTFILE_DIR` and `HEBCAL_METRICS_STATE_DIR`.

Both default to the same directory, which must be owned by the user the cron jobs
run as — on the mail host, `install -d -o hebcal -g hebcal /var/lib/hebcal-email`.
That is the only permission these jobs need anywhere. A metrics
failure never fails a mail run — the job logs one warning naming the remedy and
carries on — so `metrics: giving up on this run` in the log is the thing to
grep for when a panel goes flat.

The Grafana dashboard that consumes all of this is `etc/grafana/dashboards/email.json`
in the `hebcal-devops` repo, which is also where the systemd timer and the
cloud-config that deploys it live.

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
the server's local time zone. Scripts that `cd $APPDIR` first do so to resolve
files relative to the app directory (e.g. `shabbat_weekly.js` loads its bundled
geonames/zip SQLite databases from the working directory).

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
31 8 * * 0-5 hebcal cd $APPDIR && node $APPDIR/dist/yahrzeit_email.js --quiet --localhost

# Data-retention purge, nightly at 11:47pm.
47 23 * * * hebcal cd $APPDIR && nice node $APPDIR/dist/data_retention.js --quiet
```

`metrics_textfile.js` is deliberately **not** in here — it runs from the
`hebcal-email-metrics.timer` systemd unit shipped by `hebcal-devops`, because
its job is to keep gauges fresh on a fixed cadence rather than to do work on a
calendar.
