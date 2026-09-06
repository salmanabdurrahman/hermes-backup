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
  - [Canonical Symlink Resolution & Boundary Safety](#canonical-symlink-resolution--boundary-safety)
  - [SQLite WAL-Safe Staging & Atomic Online Backup](#sqlite-wal-safe-staging--atomic-online-backup)
  - [Process Concurrency Locking & Storage Capacity Checks](#process-concurrency-locking--storage-capacity-checks)
- [Client-Side Archive Encryption (AES-256-GCM)](#client-side-archive-encryption-aes-256-gcm)
- [Prerequisites](#prerequisites)
- [Installation & Setup](#installation--setup)
- [Environment Configuration](#environment-configuration)
  - [Configuration Key Reference](#configuration-key-reference)
- [Cloudflare R2 Bucket Setup & Privacy Verification](#cloudflare-r2-bucket-setup--privacy-verification)
- [CLI Command Reference](#cli-command-reference)
  - [backup](#backup)
  - [test-notify](#test-notify)
  - [list](#list)
  - [restore](#restore)
  - [verify](#verify)
  - [Global Options & Exit Codes](#global-options--exit-codes)
- [Automated Cron Scheduling](#automated-cron-scheduling)
  - [Crontab Configuration](#crontab-configuration)
  - [Log Rotation](#log-rotation)
- [Disaster Recovery & Restoration Runbook](#disaster-recovery--restoration-runbook)
  - [Scenario 1: Automated State Restoration to HERMES_HOME](#scenario-1-automated-state-restoration-to-hermes_home)
  - [Scenario 2: Sandbox Restoration to Isolated Directory](#scenario-2-sandbox-restoration-to-isolated-directory)
  - [Scenario 3: Periodic Recovery Drills & Automated Health Checks](#scenario-3-periodic-recovery-drills--automated-health-checks)
  - [Scenario 4: Manual Emergency Fallback](#scenario-4-manual-emergency-fallback)
- [Security Guide](#security-guide)
  - [Boundary Defense & Symlink Escape Prevention](#boundary-defense--symlink-escape-prevention)
  - [Cryptographic Envelope & Key Derivation](#cryptographic-envelope--key-derivation)
  - [Database Integrity Verification](#database-integrity-verification)
  - [Dynamic Credential Sanitization](#dynamic-credential-sanitization)
  - [Host Process Locking](#host-process-locking)
  - [Storage Bucket Privacy & File Permissions](#storage-bucket-privacy--file-permissions)
- [Troubleshooting & Operational FAQ](#troubleshooting--operational-faq)
- [Testing & Verification](#testing--verification)
- [License](#license)

## Overview

Hermes Agent maintains long-term memory, personality definitions, credentials, and custom skills within `~/.hermes/`. A raw snapshot of this directory often exceeds several gigabytes due to disposable models, virtual environments, node runtimes, and transient caches.

Hermes Backup CLI extracts only critical agent state (~80MB uncompressed), stages active SQLite databases with their write-ahead logs, packages them into a `.tar.gz` archive, streams the archive to private Cloudflare R2 storage, prunes expired backups beyond the retention window (default 3 days), and dispatches transactional alert emails via Brevo if any failure occurs.

## Key Features

- **Selective Include-First Extraction**: Captures vital memories, configuration, credentials, custom skills, and cron databases while skipping regenerable models and virtual environments.
- **Canonical Symlink Resolution & Path Guards**: Enforces canonical path verification (`fs.promises.realpath`) to guarantee that no symbolic link within whitelisted directories (such as `skills/` or `plugins/`) can traverse outside `HERMES_HOME` or exfiltrate host credentials.
- **Generic SQLite WAL-Safe Staging**: Dynamically discovers `.db` databases across whitelisted directories and copies active companion `-wal` and `-shm` files to guarantee snapshot consistency without locking active agent processes.
- **Atomic Online SQLite Snapshots & Integrity Checks**: Captures `state.db` using the SQLite `.backup` API with `.bail on` and verifies post-staging database structure with `PRAGMA integrity_check;` before archive compression.
- **Client-Side Symmetric Encryption (AES-256-GCM)**: Optional zero-knowledge archive encryption using AES-256-GCM with scrypt key derivation (NIST SP 800-38D), 16-byte random salt, 12-byte random IV, and 16-byte authentication tag ensuring archives remain confidential in cloud storage.
- **Streaming Tar Gzip Packaging**: Generates timestamped `hermes-backup-YYYY-MM-DD_HHmmss.tar.gz` archives with concurrent SHA-256 stream calculation, size validation, and zero-byte safety gates.
- **Cloudflare R2 S3 Integration**: Uploads archives directly to S3-compatible Cloudflare R2 buckets using in-memory buffer retry resilience with custom cryptographic object metadata (`hostname`, `timestamp`, `uncompressed-size`, `sha256`, `encrypted`).
- **Disaster Recovery Subcommands (`restore` & `verify`)**: Complete recovery lifecycle supporting automated download, SHA-256 verification, automatic decryption, tar structure validation, SQLite integrity checks, pre-restore safety snapshots, and non-destructive sandboxing.
- **Process Concurrency Locking**: Atomic PID file locking (`.hermes-backup.lock`) with active process inspection to prevent race conditions or overlapping cron jobs.
- **Pre-Flight Storage Capacity Verification**: Automatically calculates discovered payload size and verifies available temporary disk space (minimum 2x payload headroom) before staging or compression begins.
- **Automated 3-Day Retention Pruning**: Automatically purges remote backups older than `BACKUP_RETENTION_DAYS` (default 3 days) after each successful upload to keep storage usage minimal.
- **Zero Silent Failures**: Dispatches transactional alert emails via Brevo REST API (`POST /v3/smtp/email`) upon any uncaught runtime error or network failure.
- **Dynamic Secret Redaction**: Automatically sanitizes error messages and stack traces, replacing sensitive `.env` credential values (>4 characters) with `[REDACTED]`.
- **Fail-Safe Resource Hygiene**: Guarantees cleanup of temporary staging and recovery folders in `/tmp` during both normal completion and error paths (including `SIGINT` and `SIGTERM` signals).

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

### Canonical Symlink Resolution & Boundary Safety

File discovery operates under strict canonical boundary validation using `fs.promises.realpath`.

When scanning whitelisted directories (such as `skills/` or `plugins/`), symbolic links may point to internal shared modules or libraries. To prevent directory traversal and arbitrary file exfiltration:

1. **Target Canonicalization**: The staging engine resolves both `HERMES_HOME` and the candidate target path to their canonical absolute representations using `fs.promises.realpath`.
2. **Boundary Validation**: The relative path between the canonical base directory and canonical target path is computed. If the resolved path begins with `..` or is outside `HERMES_HOME`, it is strictly rejected and omitted from backup staging with a diagnostic warning.
3. **Internal Symlink Preservation**: Legitimate symbolic links pointing within `HERMES_HOME` boundaries are resolved and included safely. External references (e.g. pointing to `/etc/passwd`, `/etc/shadow`, `~/.ssh/id_rsa`, or system configuration directories) are strictly blocked.

### SQLite WAL-Safe Staging & Atomic Online Backup

Active SQLite databases running in Write-Ahead Logging (WAL) mode hold uncommitted transactions in companion `-wal` files and memory mappings in `-shm` files.

Hermes Backup CLI provides comprehensive WAL protection:

1. **Generic Triad Discovery**: Automatically detects when any `.db` file (e.g. `mnemosyne.db`, `kanban.db`, `executions.db`) has an active `-wal` or `-shm` companion file and copies companion files into the staging directory.
2. **Atomic Online Backup for `state.db`**: For high-write operational databases (`state.db`), Hermes Backup CLI performs an online snapshot via the SQLite `.backup` command with `.bail on`. This flushes active WAL transactions into a single, self-contained, crash-consistent database without risking dirty reads, torn writes, or WAL companion mismatches. If the `sqlite3` CLI binary is not installed on the host, it logs a warning and falls back to direct file staging. If the database is corrupt or encounters lock contention or I/O errors, execution halts with a structured error to prevent false-success backups of damaged state.
3. **Post-Staging Structural Integrity Verification**: Prior to archive compression, Hermes Backup CLI executes `PRAGMA integrity_check;` across all staged `.db` files. If any database fails integrity check (corruption, malformed pages, or truncated records), staging aborts with a structured fail-closed error and cleans up temporary resources before archive packaging begins. If the `sqlite3` binary is absent on the host, the verification safely passes with a warning.

### Process Concurrency Locking & Storage Capacity Checks

To prevent resource exhaustion and data race hazards during automated executions:

1. **PID-Based Process Locking**: Execution acquires an exclusive lock file (`.hermes-backup.lock`) inside `BACKUP_TEMP_DIR` before running. If a lock exists, the system checks whether the recorded PID is currently alive using `process.kill(pid, 0)`. If the process is dead (a stale lock from an ungraceful reboot or crash), it safely unlinks the stale lock and reacquires it. If the process is active, execution halts immediately with exit code `1` to prevent concurrent I/O collisions.
2. **Pre-Flight Storage Capacity Verification**: Before duplicating files into the staging directory, the stager calculates the total uncompressed byte size of discovered candidate files. It inspects available disk space in `BACKUP_TEMP_DIR` to guarantee at least 2x the discovered payload size (accounting for uncompressed staging plus the compressed archive). If available space is insufficient, execution halts early before any disk I/O occurs, preventing `/tmp` exhaustion.

## Client-Side Archive Encryption (AES-256-GCM)

Hermes Backup CLI provides zero-knowledge, client-side symmetric archive encryption following NIST SP 800-38D recommendations. When enabled, archive files are encrypted locally before transmission, ensuring stored data on Cloudflare R2 remains secure even if storage buckets or transport channels are compromised.

```
Uncompressed Staged Files
         │
         ▼
tar.gz Streaming Archive
         │
         ▼ (scrypt KDF + random 16B Salt + random 12B IV)
AES-256-GCM Encryption Engine
         │
         ▼
Encrypted Binary Archive File
┌──────────────────┬─────────────────┬────────────────────────────┬─────────────────────┐
│ Salt (16 bytes)  │ IV (12 bytes)   │ Ciphertext (N bytes)       │ Auth Tag (16 bytes) │
└──────────────────┴─────────────────┴────────────────────────────┴─────────────────────┘
         │
         ▼
Streamed to Cloudflare R2 with x-amz-meta-encrypted: true
```

### Encryption Features & Security Specifications

- **Authenticated Encryption**: Uses `aes-256-gcm` providing confidentiality, integrity, and authenticity. Any tampered byte or truncated archive immediately triggers an authentication tag mismatch and fails closed during restoration or verification.
- **Key Derivation Function (scrypt)**: Derives a 32-byte (256-bit) encryption key from `BACKUP_ENCRYPTION_KEY` using `scrypt` with a cryptographically secure 16-byte random salt per archive, preventing rainbow table and dictionary attacks.
- **Unique Per-Archive IVs**: Each encryption run generates a fresh 12-byte (96-bit) random Initialization Vector (`crypto.randomBytes(12)`), preventing keystream reuse.
- **Envelope Layout**: The binary archive output contains the 16-byte salt, 12-byte IV, variable-length ciphertext, and 16-byte authentication tag appended at the end.
- **Seamless Recovery**: The `restore` and `verify` commands automatically detect encrypted archives via object metadata (`x-amz-meta-encrypted`) or header heuristics and decrypt them transparently using the configured `BACKUP_ENCRYPTION_KEY`.

### Enabling Client-Side Encryption

1. Generate a strong random symmetric passphrase:

   ```bash
   openssl rand -base64 32
   ```

2. Add the passphrase to your `.env` file:

   ```ini
   BACKUP_ENCRYPTION_KEY="your_generated_passphrase_here"
   ```

3. Set restricted file permissions:

   ```bash
   chmod 600 .env
   ```

> **Important**: Store your `BACKUP_ENCRYPTION_KEY` in a secure password manager or external secrets store. If this key is lost, encrypted backup archives cannot be decrypted or restored under any circumstances.

## Prerequisites

- **Node.js**: `>= 18.0.0` (LTS recommended)
- **Operating System**: Linux VPS (Ubuntu, Debian, etc.) or macOS
- **SQLite CLI (`sqlite3`)**: Recommended for atomic online database snapshots and integrity checks (`PRAGMA integrity_check;`). If absent on host, staging falls back to direct file copy with a warning.
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

# Client-Side Archive Encryption (AES-256-GCM)
# Optional: Set a strong symmetric passphrase to enable authenticated client-side encryption.
# Leave unset or empty to store standard unencrypted .tar.gz archives.
BACKUP_ENCRYPTION_KEY=your_strong_symmetric_passphrase_here
```

### Configuration Key Reference

| Variable                | Required | Default                                    | Description                                                               |
| :---------------------- | :------: | :----------------------------------------- | :------------------------------------------------------------------------ |
| `HERMES_HOME`           |    No    | `/home/salmanabd/.hermes` (or `~/.hermes`) | Absolute path to Hermes data root.                                        |
| `R2_ACCOUNT_ID`         |   Yes*   | _None_                                     | Cloudflare account identifier.                                            |
| `R2_ACCESS_KEY_ID`      |   Yes*   | _None_                                     | R2 S3-compatible Access Key ID.                                           |
| `R2_SECRET_ACCESS_KEY`  |   Yes*   | _None_                                     | R2 S3-compatible Secret Access Key.                                       |
| `R2_BUCKET_NAME`        |    No    | `hermes-backups`                           | Destination bucket name in Cloudflare R2.                                 |
| `R2_ENDPOINT`           |    No    | Auto-derived from `R2_ACCOUNT_ID`          | S3 API endpoint URL for Cloudflare R2.                                    |
| `BREVO_API_KEY`         |   Yes*   | _None_                                     | Brevo REST API key for transactional emails.                              |
| `BREVO_SENDER_NAME`     |    No    | `Hermes Backup Bot`                        | Display name for alert emails.                                            |
| `BREVO_SENDER_EMAIL`    |   Yes*   | _None_                                     | Verified sender email address in your Brevo account.                      |
| `BREVO_RECIPIENT_EMAIL` |   Yes*   | _None_                                     | Destination email address to receive failure alerts.                      |
| `BACKUP_RETENTION_DAYS` |    No    | `3`                                        | Number of days to retain remote backups before automatic pruning.         |
| `BACKUP_TEMP_DIR`       |    No    | `/tmp`                                     | Directory used for temporary staging and archive assembly.                |
| `BACKUP_ENCRYPTION_KEY` |    No    | _None_                                     | Passphrase for client-side AES-256-GCM archive encryption and decryption. |

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
2. Acquires process concurrency lock (`.hermes-backup.lock`).
3. Discovers candidate files using whitelist and verifies canonical path boundaries (symlink escape guard).
4. Calculates total discovered size and verifies available temporary storage in `BACKUP_TEMP_DIR` (minimum 2x headroom).
5. Creates an isolated staging directory in `/tmp/hermes-backup-<timestamp>`.
6. Stages SQLite databases with active WAL companions and online atomic snapshots for `state.db`.
7. Verifies structural integrity of all staged SQLite databases (`PRAGMA integrity_check;`).
8. Compresses staging data into `hermes-backup-YYYY-MM-DD_HHmmss.tar.gz` with concurrent SHA-256 stream calculation.
9. Encrypts archive using AES-256-GCM if `BACKUP_ENCRYPTION_KEY` is configured.
10. Uploads archive to Cloudflare R2 with cryptographic metadata headers.
11. Prunes remote backups older than `BACKUP_RETENTION_DAYS` (default 3 days).
12. Cleans temporary staging files, deletes local archive, and releases process lock.
13. On failure: sanitizes credentials from error details, dispatches Brevo alert email, cleans temporary resources, releases lock, and exits with code `1`.

```bash
# Execute standard live backup
node cli.js backup

# Planning mode: inspect paths and calculate sizes without creating staging files or cloud uploads
node cli.js backup --dry-run

# Local execution simulation: stage files, compress, verify tar, test encryption/decryption without remote mutations
node cli.js backup --local-test

# Run with detailed verbose progress logging
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

Queries Cloudflare R2 and displays a formatted table of existing backup archives, their sizes, upload timestamps, and encryption status:

```bash
# List all backups under default 'backups/' prefix
node cli.js list

# List with custom prefix filter
node cli.js list --prefix "backups/hermes-backup-2026-"
```

### `restore`

Downloads a backup archive from Cloudflare R2, verifies its cryptographic integrity, decrypts it (if encrypted), unpacks to recovery staging, validates SQLite databases, creates a pre-restore safety snapshot of active data, and synchronizes files into the destination directory:

```bash
# Restore the most recent backup archive to HERMES_HOME
node cli.js restore --latest

# Restore a specific backup archive to HERMES_HOME
node cli.js restore hermes-backup-2026-09-01_030000.tar.gz

# Restore to an isolated recovery directory for inspection or sandboxing
node cli.js restore --latest --target-dir /tmp/recovered-hermes

# Planning mode: resolve target archive and display recovery plan without downloading
node cli.js restore --latest --dry-run

# Simulation mode: download, decrypt, unpack, and verify databases without modifying destination files
node cli.js restore --latest --local-test

# Overwrite existing destination files without interactive confirmation
node cli.js restore --latest --force

# Restore with verbose logging
node cli.js restore --latest --verbose
```

#### Restoration Execution Pipeline

1. **Lock Acquisition**: Acquires exclusive process lock (`.hermes-backup.lock`) to prevent concurrent modifications during restore.
2. **Key Resolution**: Identifies target archive in Cloudflare R2 (resolving `--latest` to the newest archive by timestamp).
3. **Download & Checksum Verification**: Streams archive to an isolated temporary recovery directory (`/tmp/hermes-restore-<id>/`) and validates the calculated SHA-256 hash against the `x-amz-meta-sha256` metadata stored during upload.
4. **Decryption**: If the archive is encrypted (or `BACKUP_ENCRYPTION_KEY` is configured), executes authenticated AES-256-GCM decryption. Fails immediately if the passphrase is missing or incorrect.
5. **Archive Validation**: Verifies tar entry structure and header integrity.
6. **Staging Unpack**: Unpacks files into an isolated sandbox staging directory.
7. **Database Integrity Audit**: Executes `PRAGMA integrity_check;` across every unpacked `.db` database file. If any database reports corruption, restore halts and destination files remain untouched.
8. **Pre-Restore Safety Snapshot**: If the destination directory already contains data, creates a timestamped safety snapshot (`/tmp/hermes-safety-snapshot-<timestamp>.tar.gz`) before writing any restored files.
9. **Boundary Security Gate**: Validates that no unpacked file path escapes the destination directory root (`..` path traversal defense).
10. **File Synchronization**: Copies verified files into the destination directory (`HERMES_HOME` or `--target-dir`).
11. **Resource Cleanup**: Purges temporary recovery staging directories and releases the process lock.

### `verify`

Performs an end-to-end audit of remote backup integrity within an isolated temporary sandbox. Downloads the archive, verifies SHA-256 checksums, decrypts ciphertext, validates tar structure, unpacks files, and runs `PRAGMA integrity_check;` across all SQLite databases without modifying `HERMES_HOME` or writing to destination directories:

```bash
# Verify the newest backup in Cloudflare R2
node cli.js verify --latest

# Verify a specific backup archive by name
node cli.js verify hermes-backup-2026-09-01_030000.tar.gz

# Plan verification in dry-run mode (checks remote presence without downloading)
node cli.js verify --latest --dry-run

# Run verification with detailed verbose output
node cli.js verify --latest --verbose
```

### Global Options & Exit Codes

| Flag                  | Short | Description                                                                                    |
| :-------------------- | :---: | :--------------------------------------------------------------------------------------------- |
| `--target-dir <path>` |       | Destination recovery directory for `restore` (default: `HERMES_HOME`)                          |
| `--latest`            |       | Selects the most recent backup archive from Cloudflare R2                                      |
| `--force`             |       | Overwrites destination files during `restore` without confirmation                             |
| `--dry-run`           |       | Planning mode: inspect paths and calculate sizes without disk staging or cloud mutations       |
| `--local-test`        |       | Execution simulation: stage, archive, verify tar, test decryption without remote cloud changes |
| `-v, --verbose`       | `-v`  | Enables detailed step-by-step progress logging                                                 |
| `-h, --help`          | `-h`  | Displays usage instructions and available subcommands                                          |
| `-V, --version`       | `-V`  | Displays CLI version                                                                           |
| `--prefix <prefix>`   |       | Prefix filter for listing remote backups (default: `backups/`)                                 |

#### POSIX Exit Codes

- `0`: Operation completed successfully (or `--help` / `--version` displayed).
- `1`: Operation failed, uncaught runtime error occurred, or invalid CLI argument/subcommand specified.

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

## Disaster Recovery & Restoration Runbook

In the event of hardware failure, database corruption, accidental deletion, or host migration, follow this runbook to restore Hermes Agent state.

### Scenario 1: Automated State Restoration to HERMES_HOME

This is the standard disaster recovery procedure when restoring agent state on an existing or newly provisioned host.

#### Step 1: Query Available Remote Backups

Inspect existing backup archives in Cloudflare R2:

```bash
node cli.js list
```

Identify the target archive key (e.g. `backups/hermes-backup-2026-09-01_030000.tar.gz`) or plan to use the `--latest` flag.

#### Step 2: Stop Hermes Agent Service

To prevent write operations and race conditions during file restoration, stop all active Hermes Agent processes:

```bash
# If running via systemd
sudo systemctl stop hermes

# If running via PM2
pm2 stop hermes

# Or terminate background process
pkill -f "hermes"
```

#### Step 3: Run Dry-Run Restoration Planning

Simulate the restoration to inspect the selected archive and destination path without downloading or modifying local files:

```bash
node cli.js restore --latest --dry-run
```

#### Step 4: Execute Live Restoration

Execute the restore command:

```bash
node cli.js restore --latest
```

During execution, the CLI automatically:

- Acquires an exclusive process lock to block concurrent cron backups.
- Downloads the archive and validates its SHA-256 checksum against Cloudflare R2 metadata.
- Decrypts the archive using `BACKUP_ENCRYPTION_KEY` if client-side encryption is active.
- Validates the tar structure and unpacks files into an isolated sandbox staging directory.
- Runs `PRAGMA integrity_check;` on all restored SQLite databases (`mnemosyne.db`, `executions.db`, `state.db`, etc.).
- Creates a timestamped pre-restore safety snapshot of your current `HERMES_HOME` in `BACKUP_TEMP_DIR` (`/tmp/hermes-safety-snapshot-<timestamp>.tar.gz`) before writing any files.
- Synchronizes verified files into `HERMES_HOME`.
- Cleans up temporary recovery folders and releases the process lock.

#### Step 5: Verify Database Integrity

Optionally verify SQLite database integrity directly:

```bash
sqlite3 ~/.hermes/mnemosyne/data/mnemosyne.db "PRAGMA integrity_check;"
```

**Expected Output:**

```txt
ok
```

#### Step 6: Restart Hermes Agent Service

```bash
# If running via systemd
sudo systemctl start hermes

# If running via PM2
pm2 start hermes
```

Verify that Hermes starts normally and agent memory/conversations are accessible.

#### Emergency Rollback via Safety Snapshot

If an unintended restore occurs or newly restored state causes application issues, rollback immediately using the pre-restore safety snapshot created in `BACKUP_TEMP_DIR`:

```bash
# 1. Stop Hermes Agent service
sudo systemctl stop hermes

# 2. Locate the pre-restore snapshot
ls -lt /tmp/hermes-safety-snapshot-*.tar.gz | head -n 1

# 3. Restore the safety snapshot to HERMES_HOME
tar -xzvf /tmp/hermes-safety-snapshot-<timestamp>.tar.gz -C ~/.hermes/

# 4. Restart Hermes Agent service
sudo systemctl start hermes
```

### Scenario 2: Sandbox Restoration to Isolated Directory

When performing forensic analysis, inspecting historical memories, or recovering specific configuration files without modifying active agent state, restore to an isolated target directory:

```bash
# Restore latest archive into a designated recovery directory
node cli.js restore --latest --target-dir /tmp/recovered-hermes

# Or restore a specific historical archive
node cli.js restore hermes-backup-2026-09-01_030000.tar.gz --target-dir /tmp/recovered-hermes
```

Once unpacked, inspect the restored files safely:

```bash
ls -la /tmp/recovered-hermes
```

### Scenario 3: Periodic Recovery Drills & Automated Health Checks

Untested backups risk recovery failure. Hermes Backup CLI provides the non-destructive `verify` command to audit remote backup integrity end-to-end without touching local agent state.

#### Manual Recovery Drill

Run a periodic recovery audit:

```bash
node cli.js verify --latest
```

This downloads the newest archive into an ephemeral `/tmp` sandbox, validates SHA-256 digests, tests AES-256-GCM decryption, extracts archive entries, and executes `PRAGMA integrity_check;` on all database files before purging the sandbox.

#### Automated Weekly Health Verification Cron

To schedule automated weekly verification audits on Sundays at **04:00 UTC**, add an entry to your crontab:

```cron
0 4 * * 0 cd /opt/hermes-backup && /usr/bin/node cli.js verify --latest >> /var/log/hermes-backup-verify.log 2>&1
```

If archive corruption or decryption errors occur, the command exits with code `1`, allowing monitoring systems to trigger operational alerts.

### Scenario 4: Manual Emergency Fallback

If Node.js or the Hermes Backup CLI runtime is unavailable on the recovery host, backup archives can be downloaded and unpacked using standard system tools.

#### 1. Download Archive from Cloudflare R2

Using AWS CLI with S3 credentials:

```bash
aws s3 cp s3://hermes-backups/backups/hermes-backup-YYYY-MM-DD_HHmmss.tar.gz ./ \
  --endpoint-url https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com
```

#### 2. Decrypt Archive (If Client-Side Encryption is Enabled)

If the archive was encrypted using AES-256-GCM, decrypt it using Node.js standard libraries:

```bash
node -e '
import crypto from "node:crypto";
import fs from "node:fs";
const passphrase = process.env.BACKUP_ENCRYPTION_KEY;
const buf = fs.readFileSync("hermes-backup-YYYY-MM-DD_HHmmss.tar.gz");
const salt = buf.subarray(0, 16);
const iv = buf.subarray(16, 28);
const tag = buf.subarray(buf.length - 16);
const ciphertext = buf.subarray(28, buf.length - 16);
const key = crypto.scryptSync(passphrase, salt, 32);
const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
decipher.setAuthTag(tag);
const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
fs.writeFileSync("decrypted-backup.tar.gz", decrypted);
console.log("Decrypted successfully");
'
```

#### 3. Extract Archive

```bash
mkdir -p ~/.hermes
tar -xzvf decrypted-backup.tar.gz -C ~/.hermes/
```

#### 4. Verify Restored Databases

```bash
sqlite3 ~/.hermes/mnemosyne/data/mnemosyne.db "PRAGMA integrity_check;"
```

## Security Guide

### Boundary Defense & Symlink Escape Prevention

Hermes Backup CLI operates on an include-first model with two-way boundary validation:

- **Staging Discovery Defense**: During file scanning, directory entries are resolved to their canonical paths using `fs.promises.realpath`.
  - **Threat**: A custom skill or plugin could create a symbolic link (e.g. `skills/system-link -> /etc/passwd` or `~/.ssh/id_rsa`). Default traversal would dereference external links, copying private host credentials into the backup archive.
  - **Mitigation**: The staging engine checks every file candidate with `isPathWithinBase(targetPath, baseDir)`. If the canonical target resolves outside `HERMES_HOME`, it is strictly omitted from staging and logged with a diagnostic warning. Legitimate internal symlinks remain fully functional.
- **Restoration Symlink & Traversal Defense**:
  - **Relative Path Guard**: Normalizes all archive paths to prevent relative traversal (`..`) outside the destination root.
  - **Post-Copy Symlink Injection Defense**: After writing each restored file, the restore engine verifies `isPathWithinBase(destPath, targetDir)`. If a pre-existing symbolic link inside the destination directory redirected the write outside `HERMES_HOME`, the file is immediately unlinked and restore aborts before corruption or exfiltration can occur.

### Cryptographic Envelope & Key Derivation

- **Algorithm**: `aes-256-gcm` (NIST SP 800-38D).
- **Key Derivation Function**: `scrypt` with a 16-byte cryptographically secure random salt (`crypto.randomBytes(16)`) deriving a 32-byte key buffer from `BACKUP_ENCRYPTION_KEY`.
- **Initialization Vector**: 12-byte random IV (`crypto.randomBytes(12)`) generated fresh for each archive to prevent keystream reuse.
- **Authentication**: 16-byte authentication tag appended to the binary envelope. Any modification, bit flip, or truncated payload fails decryption immediately.
- **Zero-Knowledge Cloud Storage**: Cloudflare R2 stores only ciphertext; encryption keys are never transmitted to cloud storage.

### Database Integrity Verification

- **Atomic Online Snapshots**: High-write SQLite databases (`state.db`) are captured using the `.backup` shell command with `.bail on`, preventing partial transaction copies. Fallback to raw copy occurs strictly when the `sqlite3` CLI binary is absent (`ENOENT`).
- **Pre-Compression Verification**: Every staged `.db` file is checked via `PRAGMA integrity_check;`. If output is not `ok`, the backup halts immediately with a fail-closed error.
- **Post-Restore Verification**: Before synchronizing restored files into `HERMES_HOME`, the restore engine executes `PRAGMA integrity_check;` on all unpacked databases. Corrupted archives cannot overwrite production state.

### Dynamic Credential Sanitization

- Error messages, stack traces, cause chains, and custom error properties are dynamically filtered through `createSanitizer()`.
- Secret tokens (>4 characters) extracted from configuration and environment variables are replaced with `[REDACTED]`.
- Failure emails dispatched via Brevo REST API never contain raw API tokens, account secrets, or passphrases.

### Host Process Locking

- Concurrency locking uses an atomic file creation flag (`flag: 'wx'`) on `.hermes-backup.lock` in `BACKUP_TEMP_DIR`.
- Active PID verification (`process.kill(pid, 0)`) detects dead/stale locks after server reboots or kernel panics and safely cleans them up.
- Active processes block overlapping runs, protecting against SQLite write collisions and I/O saturation.

### Storage Bucket Privacy & File Permissions

- **Private Bucket**: Verify Cloudflare R2 bucket settings regularly using the HTTP 403 curl test (`curl -I https://pub-${R2_ACCOUNT_ID}.r2.dev/backups/`). Public access must remain disabled.
- **Configuration Permissions**: Protect local secrets by restricting `.env` permissions:
  ```bash
  chmod 600 /opt/hermes-backup/.env
  ```
- **Pre-Restore Safety Snapshots**: Stored in `BACKUP_TEMP_DIR` with restricted permissions before overwriting active destination directories.

## Troubleshooting & Operational FAQ

### 1. `HERMES_HOME directory does not exist`

- **Cause**: The path configured in `HERMES_HOME` does not exist on disk.
- **Fix**: Verify directory location with `ls -la ~/.hermes` and update `HERMES_HOME` in `.env`.

### 2. `InvalidAccessKeyId` / `SignatureDoesNotMatch` on Cloudflare R2 Upload

- **Cause**: Incorrect R2 API credentials or malformed endpoint URL.
- **Fix**: Re-check `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in `.env`. Confirm that the API token has `Object Read & Write` permissions on the target bucket.

### 3. `Failed to dispatch Brevo alert (HTTP 401 / 403)`

- **Cause**: Invalid or expired `BREVO_API_KEY`, or sender email is not validated in Brevo.
- **Fix**: Run `node cli.js test-notify` to test alerting. Ensure `BREVO_SENDER_EMAIL` matches a verified sender in your Brevo dashboard.

### 4. `Archive is encrypted but BACKUP_ENCRYPTION_KEY is not configured`

- **Cause**: Attempting to run `restore` or `verify` on an encrypted archive without providing the symmetric decryption key.
- **Fix**: Set `BACKUP_ENCRYPTION_KEY` in `.env` or pass it in the environment (`BACKUP_ENCRYPTION_KEY="secret" node cli.js restore --latest`).

### 5. `Unsupported state or unable to authenticate data` (Decryption Failure)

- **Cause**: The provided `BACKUP_ENCRYPTION_KEY` does not match the passphrase used when the archive was created, or the ciphertext was modified.
- **Fix**: Verify that you are using the correct passphrase. AES-256-GCM authentication tags fail immediately if any character in the key or byte in the archive differs.

### 6. `Another backup or restore process is running (PID: ...)`

- **Cause**: An active backup or restore process is running, or a previous run crashed leaving a lock file.
- **Fix**: Check if the process is active using `ps -p <PID>`. If active, wait for completion. If the process is dead, the CLI will automatically clean the stale lock on the next run. To remove manually: `rm /tmp/.hermes-backup.lock`.

### 7. `Pre-flight storage check failed: insufficient disk space`

- **Cause**: Available free disk space in `BACKUP_TEMP_DIR` is less than 2x the uncompressed payload size.
- **Fix**: Free disk space in `/tmp` or configure `BACKUP_TEMP_DIR` in `.env` to point to a volume with more storage (e.g., `BACKUP_TEMP_DIR=/var/tmp`).

### 8. `Security violation: restored path resolves outside target directory`

- **Cause**: Archive contains path traversal segments (`..`) attempting to extract files outside the designated destination directory.
- **Fix**: The CLI automatically halts extraction and preserves target directories when malicious or malformed path entries are detected.

### 9. `PRAGMA integrity_check` reports database errors during testing

- **Cause**: SQLite database file had corrupted B-Trees, freelists, or incomplete writes before staging.
- **Fix**: Hermes Backup CLI stages companion `.db-wal` and `.db-shm` files and uses `.backup` on `state.db`. If a database is corrupt, inspect it with `sqlite3 <db> "PRAGMA integrity_check;"` and repair if necessary.

### 10. `SSL alert number 40` / `ssl/tls alert handshake failure`

- **Cause**: Unresolved `${R2_ACCOUNT_ID}` placeholder in `R2_ENDPOINT` causing requests to target an invalid hostname, or virtual-hosted bucket style addressing.
- **Fix**: Leave `R2_ENDPOINT` blank in `.env` (it will auto-derive from `R2_ACCOUNT_ID`), or ensure `R2_ENDPOINT` contains your explicit Account ID without unexpanded syntax.

### 11. `Emergency Rollback: Reverting an unintended restore`

- **Cause**: Restoration was run accidentally, with the wrong archive, or restored files need immediate rollback.
- **Fix**: The restore command automatically creates `/tmp/hermes-safety-snapshot-<timestamp>.tar.gz` prior to modifying destination files. Extract this archive back to `HERMES_HOME` (`tar -xzvf /tmp/hermes-safety-snapshot-*.tar.gz -C ~/.hermes/`) and restart the Hermes service.

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
