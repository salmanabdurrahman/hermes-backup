# Hermes Backup CLI

[![CI](https://github.com/salmanabdurrahman/hermes-backup/actions/workflows/ci.yml/badge.svg)](https://github.com/salmanabdurrahman/hermes-backup/actions/workflows/ci.yml)

Lightweight, dependency-minimal Node.js command-line utility for automated selective backup of Hermes Agent state and memory to Cloudflare R2 storage with Brevo transactional email failure alerting.

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Architecture & Backup Whitelist](#architecture--backup-whitelist)
  - [Include-First Strategy](#include-first-strategy)
  - [Path Whitelist](#path-whitelist)
  - [Explicit Exclusions](#explicit-exclusions)
  - [SQLite WAL-Safe Staging](#sqlite-wal-safe-staging)
- [Prerequisites](#prerequisites)
- [Installation & Setup](#installation--setup)
- [Environment Configuration](#environment-configuration)
- [Cloudflare R2 Bucket Setup & Privacy Verification](#cloudflare-r2-bucket-setup--privacy-verification)
- [CLI Command Reference](#cli-command-reference)
  - [backup](#backup)
  - [test-notify](#test-notify)
  - [list](#list)
  - [Global Options & Exit Codes](#global-options--exit-codes)
- [Automated Cron Scheduling](#automated-cron-scheduling)
  - [Crontab Configuration](#crontab-configuration)
  - [Log Rotation](#log-rotation)
- [Disaster Recovery & Restoration](#disaster-recovery--restoration)
- [Troubleshooting & Operational FAQ](#troubleshooting--operational-faq)
- [Testing & Verification](#testing--verification)
- [License](#license)

## Overview

Hermes Agent maintains long-term memory, personality definitions, credentials, and custom skills within `~/.hermes/`. A raw snapshot of this directory often exceeds several gigabytes due to disposable models, virtual environments, node runtimes, and transient caches.

Hermes Backup CLI extracts only critical agent state (~80MB uncompressed), stages active SQLite databases with their write-ahead logs, packages them into a `.tar.gz` archive, streams the archive to private Cloudflare R2 storage, prunes expired backups beyond the retention window (default 3 days), and dispatches transactional alert emails via Brevo if any failure occurs.

## Key Features

- **Selective Include-First Extraction**: Captures vital memories, configuration, credentials, custom skills, and cron databases while skipping regenerable models and virtual environments.
- **Generic SQLite WAL-Safe Staging**: Dynamically discovers `.db` databases across whitelisted directories and copies active companion `-wal` and `-shm` files to guarantee snapshot consistency without locking active agent processes.
- **Streaming Tar Gzip Packaging**: Generates timestamped `hermes-backup-YYYY-MM-DD_HHmmss.tar.gz` archives with size validation and zero-byte safety gates.
- **Cloudflare R2 S3 Integration**: Uploads archives directly to S3-compatible Cloudflare R2 buckets with custom object metadata (`hostname`, `timestamp`, `uncompressed-size`).
- **Automated 3-Day Retention Pruning**: Automatically purges remote backups older than `BACKUP_RETENTION_DAYS` (default 3 days) after each successful upload to keep storage usage minimal.
- **Zero Silent Failures**: Dispatches transactional alert emails via Brevo REST API (`POST /v3/smtp/email`) upon any uncaught runtime error or network failure.
- **Dynamic Secret Redaction**: Automatically sanitizes error messages and stack traces, replacing sensitive `.env` credential values (>4 characters) with `[REDACTED]`.
- **Fail-Safe Resource Hygiene**: Guarantees cleanup of temporary staging folders in `/tmp` during both normal completion and error paths (including `SIGINT` and `SIGTERM` signals).

## Architecture & Backup Whitelist

### Include-First Strategy

File extraction operates on an **Include-First** model relative to `HERMES_HOME` (`~/.hermes`). Only paths explicitly listed in the whitelist are scanned and copied. Exclusion rules act as internal safety filters within whitelisted folders (e.g., ignoring transient lock files inside `cron/`).

```
~/.hermes/ (Source Data)
  │
  ├── [Discovered via Whitelist] ──> Staging Directory (/tmp/hermes-backup-timestamp/)
  │                                    │ (Generic SQLite Triad: .db + -wal + -shm)
  │                                    v
  │                                  Tar Gzip Archive (hermes-backup-timestamp.tar.gz)
  │                                    │
  │                                    v
  └── [Excluded Directories]         Cloudflare R2 Bucket (backups/)
      (models, node, venv, cache)     │
                                      └──> Retention Pruner (Deletes archives > 3 days)
```

### Path Whitelist

#### Mandatory Paths

| Path Pattern                  | Description                                                                                     |
| :---------------------------- | :---------------------------------------------------------------------------------------------- |
| `mnemosyne/data/mnemosyne.db` | Primary agent memory database (with `-wal`, `-shm`)                                             |
| `memories/`                   | User profiles and durable notes (`MEMORY.md`, `USER.md`)                                        |
| `config.yaml`                 | Hermes agent core configuration                                                                 |
| `.env`                        | Environment credentials and API tokens                                                          |
| `auth.json`                   | Authentication tokens                                                                           |
| `google_token.json`           | Google OAuth access/refresh tokens                                                              |
| `google_client_secret.json`   | Google OAuth client configuration                                                               |
| `skills/`                     | Custom and workspace skills                                                                     |
| `scripts/`                    | User-defined scripts and automation helpers                                                     |
| `cron/`                       | Scheduled task configurations (`jobs.json`, `executions.db`, `notepad.db`, `usage_audit.jsonl`) |

#### Recommended Paths

| Path Pattern                   | Description                                                                 |
| :----------------------------- | :-------------------------------------------------------------------------- |
| `plugins/`                     | Custom plugin bundles and configurations                                    |
| `gw_accounts/`                 | Gateway accounts and communication configs                                  |
| `hooks/`                       | Event hooks and lifecycle handlers                                          |
| `kanban.db`                    | Kanban board database (with `-wal`, `-shm`)                                 |
| `SOUL.md`                      | Agent persona and system prompt instructions                                |
| `sessions/`                    | Conversational session logs                                                 |
| `backups/mnemosyne/`           | Internal Mnemosyne database snapshots                                       |
| `context_length_cache.yaml`    | Model context window cache                                                  |
| `channel_directory.json`       | Communication channel directory                                             |
| `.skills_prompt_snapshot.json` | Skill prompt compilation snapshots                                          |
| `state.db`                     | Operational state & conversation database (staged via atomic online backup) |

### Explicit Exclusions

The following paths and patterns are excluded from all backup archives:

| Excluded Pattern                          | Rationale                                                                             |
| :---------------------------------------- | :------------------------------------------------------------------------------------ |
| `state.db-wal`, `state.db-shm`            | Companion WAL files (omitted because `state.db` is captured via atomic online backup) |
| `hermes-agent/`                           | Core agent application directory                                                      |
| `backups/*.zip`                           | Root-level pre-update archives                                                        |
| `mnemosyne/models/`                       | Large GGUF/LLM model weights (~3GB+)                                                  |
| `mnemosyne-venv/`                         | Python virtual environments                                                           |
| `node/` & `bin/`                          | Node.js runtimes and CLI binaries                                                     |
| `cache/` & `logs/`                        | Transient runtime caches and raw log files                                            |
| `skills/.hub/`                            | Internal skill registry cache (index-cache, scan-cache, lock)                         |
| `mnemosyne/logs/`                         | Mnemosyne service logs                                                                |
| `*.lock`, `.fire-*`                       | Process locks and ephemeral trigger markers                                           |
| `ticker_heartbeat`, `ticker_last_success` | Transient cron health heartbeats                                                      |

### SQLite WAL-Safe Staging & Atomic Online Backup

Active SQLite databases running in Write-Ahead Logging (WAL) mode hold uncommitted transactions in companion `-wal` files and memory mappings in `-shm` files.

Hermes Backup CLI provides comprehensive WAL protection:

1. **Generic Triad Discovery**: Automatically detects when any `.db` file (e.g. `mnemosyne.db`, `kanban.db`, `executions.db`) has an active `-wal` or `-shm` companion file and copies companion files into the staging directory.
2. **Atomic Online Backup for `state.db`**: For high-write operational databases (`state.db`), Hermes Backup CLI performs an online snapshot via the SQLite `.backup` command with `.bail on`. This flushes active WAL transactions into a single, self-contained, crash-consistent database without risking dirty reads, torn writes, or WAL companion mismatches. If the `sqlite3` CLI binary is not installed on the host, it logs a warning and falls back to direct file staging. If the database is corrupt or encounters lock contention or I/O errors, execution halts with a structured error to prevent false-success backups of damaged state.

## Prerequisites

- **Node.js**: `>= 18.0.0` (LTS recommended)
- **Operating System**: Linux VPS (Ubuntu, Debian, etc.) or macOS
- **Cloudflare R2**: Dedicated bucket with private access configured
- **Brevo Account**: Active API key for transactional email alerting
- **Network**: Outbound HTTPS connectivity to `*.r2.cloudflarestorage.com` (port 443) and `api.brevo.com` (port 443)

## Installation & Setup

1. **Clone the repository** to your VPS:

   ```bash
   git clone https://github.com/salmanabdurrahman/hermes-backup.git /opt/hermes-backup
   cd /opt/hermes-backup
   ```

2. **Install production dependencies**:

   ```bash
   npm install --omit=dev
   ```

3. **Initialize configuration**:

   ```bash
   cp .env.example .env
   chmod 600 .env
   ```

4. **Verify executable permissions**:

   ```bash
   chmod +x cli.js
   ```

## Environment Configuration

Configure your credentials and runtime parameters in `.env`:

```ini
# Hermes Agent Root Directory
HERMES_HOME=/home/salmanabd/.hermes

# Cloudflare R2 Storage Credentials
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_r2_access_key_id
R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
R2_BUCKET_NAME=hermes-backups
# Optional: Auto-derived as https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com when omitted
R2_ENDPOINT=https://your_cloudflare_account_id.r2.cloudflarestorage.com

# Brevo (Sendinblue) Transactional Email Alerting
BREVO_API_KEY=your_brevo_api_key
BREVO_SENDER_NAME="Hermes Backup Bot"
BREVO_SENDER_EMAIL=notifications@yourdomain.com
BREVO_RECIPIENT_EMAIL=admin@yourdomain.com

# Retention and Staging Settings
BACKUP_RETENTION_DAYS=3
BACKUP_TEMP_DIR=/tmp
```

### Configuration Key Reference

| Variable                | Required | Default                                    | Description                                                       |
| :---------------------- | :------: | :----------------------------------------- | :---------------------------------------------------------------- |
| `HERMES_HOME`           |    No    | `/home/salmanabd/.hermes` (or `~/.hermes`) | Absolute path to Hermes data root.                                |
| `R2_ACCOUNT_ID`         |   Yes*   | _None_                                     | Cloudflare account identifier.                                    |
| `R2_ACCESS_KEY_ID`      |   Yes*   | _None_                                     | R2 S3-compatible Access Key ID.                                   |
| `R2_SECRET_ACCESS_KEY`  |   Yes*   | _None_                                     | R2 S3-compatible Secret Access Key.                               |
| `R2_BUCKET_NAME`        |    No    | `hermes-backups`                           | Destination bucket name in Cloudflare R2.                         |
| `R2_ENDPOINT`           |    No    | Auto-derived from `R2_ACCOUNT_ID`          | S3 API endpoint URL for Cloudflare R2.                            |
| `BREVO_API_KEY`         |   Yes*   | _None_                                     | Brevo REST API key for transactional emails.                      |
| `BREVO_SENDER_NAME`     |    No    | `Hermes Backup Bot`                        | Display name for alert emails.                                    |
| `BREVO_SENDER_EMAIL`    |   Yes*   | _None_                                     | Verified sender email address in your Brevo account.              |
| `BREVO_RECIPIENT_EMAIL` |   Yes*   | _None_                                     | Destination email address to receive failure alerts.              |
| `BACKUP_RETENTION_DAYS` |    No    | `3`                                        | Number of days to retain remote backups before automatic pruning. |
| `BACKUP_TEMP_DIR`       |    No    | `/tmp`                                     | Directory used for temporary staging and archive assembly.        |

_\* Required for live operations; optional when running in `--dry-run` mode._

## Cloudflare R2 Bucket Setup & Privacy Verification

Because backup archives contain unencrypted credentials (`.env`, `auth.json`) and session logs, the destination Cloudflare R2 bucket **must remain strictly private**.

### 1. Bucket Creation

Create the bucket via the Cloudflare Dashboard or Cloudflare Wrangler:

```bash
# Using wrangler CLI
wrangler r2 bucket create hermes-backups
```

Ensure that:

- **Public Access** is **Disabled** (Default).
- **R2.dev subdomain** is **Not Enabled**.
- **Custom Domains** are **Not Connected**.

### 2. Privacy Verification (HTTP 403 Test)

Verify that public unauthenticated HTTP requests are rejected:

```bash
# Test public access to R2 bucket endpoint
curl -I "https://pub-${R2_ACCOUNT_ID}.r2.dev/backups/"
```

**Expected Result:**

```http
HTTP/1.1 403 Forbidden
# or DNS resolution failure / connection refused
```

If the endpoint returns `200 OK` or directory listings, immediately open the Cloudflare Dashboard, navigate to **R2 > hermes-backups > Settings > Public Access**, and revoke public access.

## CLI Command Reference

### `backup`

Executes the complete backup lifecycle:

1. Validates configuration and verifies `HERMES_HOME`.
2. Creates an isolated staging directory in `/tmp/hermes-backup-<timestamp>`.
3. Discovers whitelisted files and stages SQLite databases with active WAL companions.
4. Compresses staging data into `hermes-backup-YYYY-MM-DD_HHmmss.tar.gz`.
5. Uploads archive to Cloudflare R2 with metadata.
6. Prunes remote backups older than `BACKUP_RETENTION_DAYS` (default 3 days).
7. Cleans temporary staging files and local archive.
8. On failure: catches error, sanitizes credentials, dispatches Brevo alert email, cleans staging resources, and exits with code `1`.

```bash
# Execute standard backup
node cli.js backup

# Simulate backup without cloud mutations or alert emails
node cli.js backup --dry-run

# Run with detailed verbose output
node cli.js backup --verbose
```

### `test-notify`

Sends a test transactional email via Brevo to verify API credentials, sender authentication, and recipient delivery:

```bash
# Send live test email
node cli.js test-notify

# Simulate email dispatch in dry-run mode
node cli.js test-notify --dry-run
```

### `list`

Queries Cloudflare R2 and displays a formatted table of existing backup archives, their sizes, and upload timestamps:

```bash
# List all backups under default 'backups/' prefix
node cli.js list

# List with custom prefix filter
node cli.js list --prefix "backups/hermes-backup-2026-"
```

### Global Options & Exit Codes

| Flag                | Short | Description                                                    |
| :------------------ | :---: | :------------------------------------------------------------- |
| `--dry-run`         |       | Simulates execution without cloud writes or failure alerts     |
| `--verbose`         | `-v`  | Enables detailed step-by-step progress logging                 |
| `--help`            | `-h`  | Displays usage instructions and available subcommands          |
| `--version`         | `-V`  | Displays CLI version                                           |
| `--prefix <prefix>` |       | Prefix filter for listing remote backups (default: `backups/`) |

#### POSIX Exit Codes

- `0`: Operation completed successfully (or help / version displayed).
- `1`: Operation failed, uncaught error occurred, or invalid CLI argument/subcommand specified.

## Automated Cron Scheduling

### Crontab Configuration

To schedule automatic daily backups at **03:00 UTC**, add an entry to your crontab:

```bash
crontab -e
```

Add the following schedule line (adjust path to match your environment):

```cron
0 3 * * * cd /opt/hermes-backup && /usr/bin/node cli.js backup >> /var/log/hermes-backup.log 2>&1
```

> **Tip on Cron Environments:** Cron runs with a restricted `PATH`. Explicitly provide the full path to your Node.js binary (e.g., `/usr/bin/node` or `/home/salmanabd/.nvm/versions/node/v20.x.x/bin/node`, which you can find by running `which node`).

### Log Rotation

To prevent `/var/log/hermes-backup.log` from growing indefinitely, configure a logrotate rule:

Create `/etc/logrotate.d/hermes-backup`:

```ini
/var/log/hermes-backup.log {
    weekly
    rotate 4
    compress
    missingok
    notifempty
    create 0640 root adm
}
```

## Disaster Recovery & Restoration

If VPS hardware fails or data corruption occurs, restore Hermes Agent state using the following procedure:

### Step 1: Identify and Download the Target Backup

1. List available backups stored in Cloudflare R2:
   ```bash
   node cli.js list
   ```
2. Download the desired `.tar.gz` archive using the AWS CLI or Cloudflare Dashboard:
   ```bash
   aws s3 cp s3://hermes-backups/backups/hermes-backup-YYYY-MM-DD_HHmmss.tar.gz ./ \
     --endpoint-url https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com
   ```

### Step 2: Stop Hermes Agent Service

Stop any running Hermes Agent processes to prevent database writes during restoration:

```bash
# If running via systemd
sudo systemctl stop hermes

# If running via PM2
pm2 stop hermes

# Or stop background process
pkill -f "hermes"
```

### Step 3: Extract Archive to Hermes Home

Extract the archive into your target `~/.hermes/` directory:

```bash
# Create destination directory if restoring on a new host
mkdir -p ~/.hermes

# Extract archive preserving directory hierarchy
tar -xzvf hermes-backup-YYYY-MM-DD_HHmmss.tar.gz -C ~/.hermes/
```

### Step 4: Verify Database Integrity

Verify that restored SQLite databases are intact:

```bash
sqlite3 ~/.hermes/mnemosyne/data/mnemosyne.db "PRAGMA integrity_check;"
```

**Expected Output:**

```txt
ok
```

### Step 5: Restart Hermes Agent Service

```bash
# If running via systemd
sudo systemctl start hermes

# If running via PM2
pm2 start hermes
```

Verify that Hermes Agent successfully starts and loads long-term memories.

## Troubleshooting & Operational FAQ

### 1. `HERMES_HOME directory does not exist`

- **Cause**: The path configured in `HERMES_HOME` does not exist on disk.
- **Fix**: Verify the directory location with `ls -la ~/.hermes` and update `HERMES_HOME` in `.env`.

### 2. `InvalidAccessKeyId` / `SignatureDoesNotMatch` on Cloudflare R2 Upload

- **Cause**: Incorrect R2 API credentials or malformed endpoint URL.
- **Fix**: Re-check `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in `.env`. Confirm that the API token has `Object Read & Write` permissions on the target bucket.

### 3. `Failed to dispatch Brevo alert (HTTP 401 / 403)`

- **Cause**: Invalid or expired `BREVO_API_KEY`, or sender email is not validated in Brevo.
- **Fix**: Run `node cli.js test-notify` to test alerting. Ensure `BREVO_SENDER_EMAIL` matches a verified sender in your Brevo dashboard.

### 4. `PRAGMA integrity_check` reports database errors during testing

- **Cause**: Direct non-atomic copying of SQLite databases while heavy write transactions were active.
- **Fix**: Hermes Backup CLI copies `.db-wal` and `.db-shm` files alongside `.db`. Ensure no background processes delete `-wal` files mid-copy.

### 5. Disk Space Exhaustion in `/tmp`

- **Cause**: Multiple large simultaneous backups or limited temp partition.
- **Fix**: Configure `BACKUP_TEMP_DIR` in `.env` to point to a partition with adequate free storage (e.g., `BACKUP_TEMP_DIR=/var/tmp`).

### 6. `SSL alert number 40` / `ssl/tls alert handshake failure`

- **Cause**: Unresolved `${R2_ACCOUNT_ID}` placeholder in `R2_ENDPOINT` causing requests to target an invalid hostname, or virtual-hosted bucket style addressing.
- **Fix**: Leave `R2_ENDPOINT` blank in `.env` (it will auto-derive from `R2_ACCOUNT_ID`), or ensure `R2_ENDPOINT` contains your explicit Account ID without unexpanded syntax.

## Testing & Verification

Run the comprehensive unit and integration test suite:

```bash
npm test
```

Continuous integration runs automatically via GitHub Actions across Node.js 18.x, 20.x, and 22.x on push and pull requests.

All 120+ tests validate:

- Configuration loading and dynamic secret sanitization.
- Priority path whitelisting and safety-net exclusion filtering.
- Generic SQLite WAL triad atomic staging.
- Gzip archive creation, validation, and temp resource cleanup.
- S3 upload, object listing, and 3-day retention pruning.
- Brevo failure alerting and HTML payload construction.
- CLI argument parsing and exit code contracts.
- End-to-end simulated VPS backup lifecycle.

## License

MIT © [Salman Abdurrahman](https://github.com/salmanabdurrahman)
