# Hermes Backup CLI

Lightweight, dependency-minimal Node.js command-line utility for automated selective backup of Hermes Agent state and memory to Cloudflare R2 storage with Brevo transactional email failure alerting.

## Features

- **Selective Include-First Extraction**: Targets essential Hermes Agent memory, databases, configuration, and skills (~80MB uncompressed) while excluding regenerable caches, models, and virtual environments (~3.5GB).
- **SQLite WAL-Safe Staging**: Generic stager safely copies active SQLite `.db` databases alongside their `-wal` and `-shm` companion files without corrupting active transactions or locking live services.
- **Tar Gzip Compression**: Packages staging trees into single timestamped `hermes-backup-YYYY-MM-DD_HHmmss.tar.gz` archives.
- **Cloudflare R2 Storage & Pruning**: Streams archives to Cloudflare R2 via S3-compatible API and automatically prunes backups older than the retention threshold (default 3 days).
- **Zero Silent Failures**: Dispatches transactional alert emails via Brevo REST API with dynamic secret redaction on uncaught errors.
- **Safe Resource Cleanup**: Automatically cleans up all temporary staging directories in `/tmp` during both normal and failure runs.

## Prerequisites

- Node.js >= 18.0.0
- Linux VPS / macOS environment with outbound HTTPS access to Cloudflare R2 and Brevo
- Cloudflare R2 bucket with Private Access enabled (Public Access blocked)
- Brevo account and API key

## Installation

```bash
git clone https://github.com/salmanabdurrahman/hermes-backup.git
cd hermes-backup
npm install
```

## Configuration

Copy the template environment file and fill in your credentials:

```bash
cp .env.example .env
```

### Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `HERMES_HOME` | Absolute path to Hermes data directory | `/home/salmanabd/.hermes` |
| `R2_ACCOUNT_ID` | Cloudflare Account ID | Required |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 Access Key ID | Required |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 Secret Access Key | Required |
| `R2_BUCKET_NAME` | Cloudflare R2 Bucket Name | Required |
| `R2_ENDPOINT` | Custom S3 endpoint (or auto-derived from Account ID) | `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` |
| `BREVO_API_KEY` | Brevo API Key | Required |
| `BREVO_SENDER_NAME` | Display name for alert emails | `Hermes Backup Bot` |
| `BREVO_SENDER_EMAIL` | Verified sender email in Brevo | Required |
| `BREVO_RECIPIENT_EMAIL` | Destination email for failure alerts | Required |
| `BACKUP_RETENTION_DAYS`| Remote backup retention period in days | `3` |
| `BACKUP_TEMP_DIR` | Temporary staging folder path | `/tmp` |

## Usage

### Run Backup

Execute the complete backup workflow (stage, archive, upload, prune, cleanup):

```bash
node cli.js backup
```

### Dry Run Mode

Simulate path discovery and size estimation without modifying cloud storage or sending emails:

```bash
node cli.js backup --dry-run --verbose
```

### Test Alert Notification

Verify that Brevo email delivery is configured properly:

```bash
node cli.js test-notify
```

### List Stored Backups

View existing backups stored in Cloudflare R2:

```bash
node cli.js list
```

## Automated Cron Scheduling

To run backups daily at 03:00 UTC, add an entry to your crontab:

```bash
crontab -e
```

```cron
0 3 * * * cd /path/to/hermes-backup && node cli.js backup >> /var/log/hermes-backup.log 2>&1
```

## Disaster Recovery / Restoration

To restore Hermes Agent from an R2 backup archive:

1. Download the target `.tar.gz` archive from Cloudflare R2.
2. Stop the Hermes Agent process.
3. Extract the archive into your Hermes directory:
   ```bash
   tar -xzvf hermes-backup-YYYY-MM-DD_HHmmss.tar.gz -C ~/.hermes/
   ```
4. Restart the Hermes Agent service.

## License

MIT
