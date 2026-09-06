import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import {
  runCli,
  backupCommand,
  testNotifyCommand,
  listCommand,
  restoreCommand,
  verifyCommand,
  validateArchive,
  loadConfig,
  formatBytes,
  formatBackupTimestamp,
} from '../src/index.js';

const execFileAsync = promisify(execFile);

/**
 * Creates a structured mock logger to capture logs and errors during test execution.
 */
function createMockIo() {
  const logs = [];
  const errors = [];
  const warns = [];
  return {
    log: (msg) => logs.push(String(msg)),
    error: (msg) => errors.push(String(msg)),
    warn: (msg) => warns.push(String(msg)),
    getLogs: () => logs.join('\n'),
    getErrors: () => errors.join('\n'),
    logsArray: logs,
    errorsArray: errors,
  };
}

describe('End-to-End Integration Test Suite & Mock VPS Validation', () => {
  let tempSuiteDir;
  let mockHermesHome;
  let mockTempDir;

  const sampleSecrets = {
    r2AccountId: 'r2-account-id-test-8899',
    r2AccessKey: 'r2-access-key-test-7788',
    r2SecretKey: 'r2-secret-access-key-test-6677',
    r2Bucket: 'vps-hermes-backups-test',
    brevoKey: 'xkeysib-live-brevo-api-key-test-9900',
    brevoSender: 'bot@example.com',
    brevoRecipient: 'admin@example.com',
  };

  /**
   * Helper to construct a valid test configuration object pointing to isolated mock paths.
   */
  function createTestConfig(overrides = {}) {
    return {
      hermesHome: mockHermesHome,
      r2: {
        accountId: sampleSecrets.r2AccountId,
        accessKeyId: sampleSecrets.r2AccessKey,
        secretAccessKey: sampleSecrets.r2SecretKey,
        bucketName: sampleSecrets.r2Bucket,
        endpoint: `https://${sampleSecrets.r2AccountId}.r2.cloudflarestorage.com`,
      },
      brevo: {
        apiKey: sampleSecrets.brevoKey,
        senderName: 'Hermes VPS Backup Bot',
        senderEmail: sampleSecrets.brevoSender,
        recipientEmail: sampleSecrets.brevoRecipient,
      },
      retentionDays: 3,
      tempDir: mockTempDir,
      ...overrides,
    };
  }

  /**
   * Helper to populate a comprehensive mock Hermes Agent home directory on the mock VPS.
   */
  async function populateMockHermesDirectory(targetHome) {
    await fs.promises.mkdir(targetHome, { recursive: true });

    // --- Mandatory Whitelist Items ---
    // 1. mnemosyne SQLite DB in WAL mode with active records
    const mnemosyneDir = path.join(targetHome, 'mnemosyne', 'data');
    await fs.promises.mkdir(mnemosyneDir, { recursive: true });
    const mnemosyneDbPath = path.join(mnemosyneDir, 'mnemosyne.db');
    execFileSync('sqlite3', [
      mnemosyneDbPath,
      `
      PRAGMA journal_mode = WAL;
      CREATE TABLE long_term_memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        concept TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO long_term_memories (concept, summary) VALUES
        ('user_preferences', 'User prefers concise responses and TypeScript codebase structure.'),
        ('project_architecture', 'Node.js standalone CLI utility backing up state to Cloudflare R2.');
      `,
    ]);
    // Ensure companion files exist
    if (!fs.existsSync(`${mnemosyneDbPath}-wal`)) {
      await fs.promises.writeFile(`${mnemosyneDbPath}-wal`, 'sqlite-wal-index-header-data');
    }
    if (!fs.existsSync(`${mnemosyneDbPath}-shm`)) {
      await fs.promises.writeFile(`${mnemosyneDbPath}-shm`, 'sqlite-shm-shared-memory-data');
    }

    // 2. memories directory
    const memoriesDir = path.join(targetHome, 'memories');
    await fs.promises.mkdir(memoriesDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(memoriesDir, 'MEMORY.md'),
      '# Long Term Memory\n\n- User operates a Debian VPS node.\n- Automated backups run at 03:00 UTC.'
    );
    await fs.promises.writeFile(
      path.join(memoriesDir, 'USER.md'),
      '# User Profile\n\nName: VPS Operator\nRole: Lead Engineer'
    );

    // 3. Root configuration and credentials
    await fs.promises.writeFile(
      path.join(targetHome, 'config.yaml'),
      'agent_name: hermes\nmodel: claude-3-5-sonnet\ntemperature: 0.2\n'
    );
    await fs.promises.writeFile(
      path.join(targetHome, '.env'),
      'HERMES_ENV=production\nOPENAI_API_KEY=sk-test-secret-key-abcdef\n'
    );
    await fs.promises.writeFile(
      path.join(targetHome, 'auth.json'),
      JSON.stringify({ tokens: { primary: 'auth-token-12345' } }, null, 2)
    );
    await fs.promises.writeFile(
      path.join(targetHome, 'google_token.json'),
      JSON.stringify({ access_token: 'ya29.test-google-token' }, null, 2)
    );
    await fs.promises.writeFile(
      path.join(targetHome, 'google_client_secret.json'),
      JSON.stringify({ installed: { client_id: 'google-client-id-123' } }, null, 2)
    );

    // 4. Skills directory with nested skill folders
    const weatherSkillDir = path.join(targetHome, 'skills', 'weather');
    await fs.promises.mkdir(weatherSkillDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(weatherSkillDir, 'SKILL.md'),
      '# Weather Skill\nFetches local weather forecasts via Open-Meteo API.'
    );
    await fs.promises.writeFile(
      path.join(weatherSkillDir, 'handler.js'),
      'export async function getWeather() { return { temp: 22 }; }'
    );

    // 5. Scripts directory
    const scriptsDir = path.join(targetHome, 'scripts');
    await fs.promises.mkdir(scriptsDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(scriptsDir, 'vps_health.sh'),
      '#!/bin/bash\nuptime && free -m\n'
    );

    // 6. Cron directory with SQLite databases in WAL mode and JSON logs
    const cronDir = path.join(targetHome, 'cron');
    await fs.promises.mkdir(cronDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(cronDir, 'jobs.json'),
      JSON.stringify([{ id: 'job-1', name: 'daily-digest', schedule: '0 8 * * *' }], null, 2)
    );
    const cronExecDbPath = path.join(cronDir, 'executions.db');
    execFileSync('sqlite3', [
      cronExecDbPath,
      `
      PRAGMA journal_mode = WAL;
      CREATE TABLE execution_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        status TEXT NOT NULL,
        executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO execution_history (job_id, status) VALUES ('job-1', 'success');
      `,
    ]);
    const cronNotepadDbPath = path.join(cronDir, 'notepad.db');
    execFileSync('sqlite3', [
      cronNotepadDbPath,
      `
      PRAGMA journal_mode = WAL;
      CREATE TABLE notes (id INTEGER PRIMARY KEY, note TEXT);
      INSERT INTO notes (note) VALUES ('Check disk usage on VPS partition.');
      `,
    ]);
    await fs.promises.writeFile(
      path.join(cronDir, 'usage_audit.jsonl'),
      '{"timestamp":"2026-08-29T00:00:00Z","tokens":1500}\n'
    );

    // --- Recommended Whitelist Items ---
    // 7. Plugins directory
    const pluginsDir = path.join(targetHome, 'plugins', 'notifier');
    await fs.promises.mkdir(pluginsDir, { recursive: true });
    await fs.promises.writeFile(path.join(pluginsDir, 'index.js'), 'export function notify() {}');

    // 8. Gateway accounts directory
    const gwAccountsDir = path.join(targetHome, 'gw_accounts');
    await fs.promises.mkdir(gwAccountsDir, { recursive: true });
    await fs.promises.writeFile(path.join(gwAccountsDir, 'accounts.json'), '{"accounts":[]}');

    // 9. Hooks directory
    const hooksDir = path.join(targetHome, 'hooks');
    await fs.promises.mkdir(hooksDir, { recursive: true });
    await fs.promises.writeFile(path.join(hooksDir, 'on_start.js'), 'console.log("Starting");');

    // 10. Root level kanban SQLite database in WAL mode
    const kanbanDbPath = path.join(targetHome, 'kanban.db');
    execFileSync('sqlite3', [
      kanbanDbPath,
      `
      PRAGMA journal_mode = WAL;
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, column_name TEXT);
      INSERT INTO tasks (title, column_name) VALUES ('Setup backup CLI', 'Done');
      INSERT INTO tasks (title, column_name) VALUES ('Verify VPS crontab', 'In Progress');
      `,
    ]);

    // 11. Persona soul document
    await fs.promises.writeFile(
      path.join(targetHome, 'SOUL.md'),
      '# Hermes Agent Soul\n\nYou are Hermes, an autonomous operations agent for cloud infrastructure.'
    );

    // 12. Sessions directory
    const sessionsDir = path.join(targetHome, 'sessions');
    await fs.promises.mkdir(sessionsDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(sessionsDir, 'session_001.json'),
      JSON.stringify({ sessionId: 'session-001', turns: 12 }, null, 2)
    );

    // 13. Backups/mnemosyne directory (MUST BE INCLUDED unlike backups/*.zip)
    const mnemosyneBackupDir = path.join(targetHome, 'backups', 'mnemosyne');
    await fs.promises.mkdir(mnemosyneBackupDir, { recursive: true });
    const snapshotDbPath = path.join(mnemosyneBackupDir, 'snapshot_2026-08-28.db');
    try {
      execFileSync('sqlite3', [
        snapshotDbPath,
        `
        CREATE TABLE snapshot_meta (id INTEGER PRIMARY KEY, note TEXT);
        INSERT INTO snapshot_meta VALUES (1, 'snapshot-data');
        `,
      ]);
    } catch {
      await fs.promises.writeFile(snapshotDbPath, 'sqlite-snapshot-backup-data');
    }

    // 14. Context cache, channel directory, prompt snapshot, state db
    await fs.promises.writeFile(path.join(targetHome, 'context_length_cache.yaml'), 'claude: 200000\n');
    await fs.promises.writeFile(path.join(targetHome, 'channel_directory.json'), '{"channels":[]}');
    await fs.promises.writeFile(path.join(targetHome, '.skills_prompt_snapshot.json'), '{"skills":[]}');

    const stateDbPath = path.join(targetHome, 'state.db');
    execFileSync('sqlite3', [
      stateDbPath,
      `
      PRAGMA journal_mode = WAL;
      CREATE TABLE active_sessions (id INTEGER PRIMARY KEY, session_token TEXT);
      INSERT INTO active_sessions (session_token) VALUES ('sess_xyz_active');
      `,
    ]);

    // --- Safety-Net Excluded Files (Must NOT be included in backup) ---
    // State db companions (excluded; atomic backup handles state.db)
    await fs.promises.writeFile(path.join(targetHome, 'state.db-wal'), 'large-state-wal');
    await fs.promises.writeFile(path.join(targetHome, 'state.db-shm'), 'large-state-shm');

    // Disposable runtimes & heavy dependencies
    const agentDir = path.join(targetHome, 'hermes-agent', 'dist');
    await fs.promises.mkdir(agentDir, { recursive: true });
    await fs.promises.writeFile(path.join(agentDir, 'bundle.js'), 'huge-agent-binary-bundle');

    const modelsDir = path.join(targetHome, 'mnemosyne', 'models');
    await fs.promises.mkdir(modelsDir, { recursive: true });
    await fs.promises.writeFile(path.join(modelsDir, 'llama-3-8b-instruct.gguf'), 'model-weights-4gb');

    const venvDir = path.join(targetHome, 'mnemosyne-venv', 'bin');
    await fs.promises.mkdir(venvDir, { recursive: true });
    await fs.promises.writeFile(path.join(venvDir, 'python3'), 'python-binary');

    const nodeDir = path.join(targetHome, 'node', 'bin');
    await fs.promises.mkdir(nodeDir, { recursive: true });
    await fs.promises.writeFile(path.join(nodeDir, 'node'), 'node-binary');

    const binDir = path.join(targetHome, 'bin');
    await fs.promises.mkdir(binDir, { recursive: true });
    await fs.promises.writeFile(path.join(binDir, 'hermes'), 'cli-binary');

    const cacheDir = path.join(targetHome, 'cache');
    await fs.promises.mkdir(cacheDir, { recursive: true });
    await fs.promises.writeFile(path.join(cacheDir, 'embeddings.cache'), 'cache-embeddings');

    const logsDir = path.join(targetHome, 'logs');
    await fs.promises.mkdir(logsDir, { recursive: true });
    await fs.promises.writeFile(path.join(logsDir, 'runtime.log'), 'log-lines');

    const mnemosyneLogsDir = path.join(targetHome, 'mnemosyne', 'logs');
    await fs.promises.mkdir(mnemosyneLogsDir, { recursive: true });
    await fs.promises.writeFile(path.join(mnemosyneLogsDir, 'vector.log'), 'vector-log-lines');

    // Root-level zip archives
    await fs.promises.writeFile(
      path.join(targetHome, 'backups', 'pre-update-backup-20260801.zip'),
      'zip-data-to-exclude'
    );

    // Transient cron locks and heartbeat flags
    await fs.promises.writeFile(path.join(cronDir, 'task_run.lock'), 'lock');
    await fs.promises.writeFile(path.join(cronDir, '.fire-schedule-101'), 'fire-flag');
    await fs.promises.writeFile(path.join(cronDir, 'ticker_heartbeat'), '1724918400');
    await fs.promises.writeFile(path.join(cronDir, 'ticker_last_success'), '1724918400');
  }

  beforeEach(async () => {
    tempSuiteDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hermes-e2e-suite-'));
    mockHermesHome = path.join(tempSuiteDir, 'home_salmanabd', '.hermes');
    mockTempDir = path.join(tempSuiteDir, 'vps_tmp');
    await fs.promises.mkdir(mockTempDir, { recursive: true });

    await populateMockHermesDirectory(mockHermesHome);
  });

  afterEach(async () => {
    if (tempSuiteDir && fs.existsSync(tempSuiteDir)) {
      try {
        await fs.promises.rm(tempSuiteDir, { recursive: true, force: true });
      } catch {
        // Suppress test suite cleanup errors
      }
    }
  });

  describe('Full Backup Lifecycle: Discovery, Staging, Archiving, S3 Upload, Retention Prune & Unpack Verification', () => {
    it('should complete full end-to-end backup, upload to R2, prune expired backups, clean temp files, and unpack with verified database integrity', async () => {
      const io = createMockIo();
      const config = createTestConfig();

      const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

      const freshKey = `backups/hermes-backup-${formatBackupTimestamp(oneDayAgo)}.tar.gz`;
      const expired5Key = `backups/hermes-backup-${formatBackupTimestamp(fiveDaysAgo)}.tar.gz`;
      const expired10Key = `backups/hermes-backup-${formatBackupTimestamp(tenDaysAgo)}.tar.gz`;

      let uploadedPayloadBuffer = null;
      let putObjectCommandCaptured = null;
      let deleteObjectsCommandCaptured = null;

      // Mock Cloudflare R2 S3 Client
      const mockS3Client = {
        send: async (command) => {
          if (command instanceof PutObjectCommand) {
            putObjectCommandCaptured = command;
            // Read body into memory buffer for archive unpack verification
            const chunks = [];
            const bodyStream = command.input.Body;
            if (typeof bodyStream.on === 'function') {
              for await (const chunk of bodyStream) {
                chunks.push(chunk);
              }
              uploadedPayloadBuffer = Buffer.concat(chunks);
            } else if (Buffer.isBuffer(bodyStream)) {
              uploadedPayloadBuffer = bodyStream;
            }

            return {
              ETag: '"e2e-valid-upload-etag-9988"',
            };
          }

          if (command instanceof ListObjectsV2Command) {
            return {
              Contents: [
                // 1. Fresh backup from yesterday -> Keep
                {
                  Key: freshKey,
                  Size: 15500000,
                  LastModified: oneDayAgo,
                  ETag: '"fresh-backup-etag"',
                },
                // 2. Expired backup from 10 days ago -> Delete
                {
                  Key: expired10Key,
                  Size: 14800000,
                  LastModified: tenDaysAgo,
                  ETag: '"old-backup-etag-1"',
                },
                // 3. Expired backup from 5 days ago -> Delete
                {
                  Key: expired5Key,
                  Size: 15100000,
                  LastModified: fiveDaysAgo,
                  ETag: '"old-backup-etag-2"',
                },
                // 4. Non-standard manual file in backups folder -> Preserve (do not delete)
                {
                  Key: 'backups/custom_readme.txt',
                  Size: 200,
                  LastModified: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
                  ETag: '"manual-file-etag"',
                },
              ],
              IsTruncated: false,
            };
          }

          if (command instanceof DeleteObjectsCommand) {
            deleteObjectsCommandCaptured = command;
            return {
              Deleted: command.input.Delete.Objects.map((obj) => ({ Key: obj.Key })),
              Errors: [],
            };
          }

          throw new Error(`Unexpected S3 command received: ${command.constructor.name}`);
        },
      };

      // Execute backup command
      const result = await backupCommand(
        { dryRun: false, verbose: true },
        { config, io, s3Client: mockS3Client }
      );

      // Verify exit code and execution summary
      assert.equal(result.success, true);
      assert.equal(result.exitCode, 0);
      assert.ok(result.summary);
      assert.ok(result.summary.fileCount >= 20, `Expected >= 20 files, got ${result.summary.fileCount}`);
      assert.ok(result.summary.uncompressedBytes > 0);
      assert.ok(result.summary.archiveSize > 0);
      assert.equal(result.summary.prunedCount, 2);
      assert.equal(result.summary.dryRun, false);

      // Verify S3 PutObjectCommand parameters
      assert.ok(putObjectCommandCaptured instanceof PutObjectCommand);
      assert.equal(putObjectCommandCaptured.input.Bucket, sampleSecrets.r2Bucket);
      assert.ok(
        /^backups\/hermes-backup-\d{4}-\d{2}-\d{2}_\d{6}\.tar\.gz$/.test(
          putObjectCommandCaptured.input.Key
        )
      );
      assert.equal(putObjectCommandCaptured.input.ContentType, 'application/gzip');
      assert.ok(putObjectCommandCaptured.input.Metadata['uncompressed-size']);
      assert.ok(putObjectCommandCaptured.input.Metadata['hostname']);
      assert.ok(putObjectCommandCaptured.input.Metadata['timestamp']);

      // Verify S3 DeleteObjectsCommand retention pruning parameters
      assert.ok(deleteObjectsCommandCaptured instanceof DeleteObjectsCommand);
      assert.equal(deleteObjectsCommandCaptured.input.Bucket, sampleSecrets.r2Bucket);
      const deletedKeys = deleteObjectsCommandCaptured.input.Delete.Objects.map((o) => o.Key);
      assert.deepEqual(deletedKeys.sort(), [expired10Key, expired5Key].sort());

      // Verify temporary directory cleanup: No staging folders or archives remain in mockTempDir
      const remainingTempEntries = await fs.promises.readdir(mockTempDir);
      assert.deepEqual(
        remainingTempEntries.filter((name) => name.startsWith('hermes-backup-')),
        []
      );

      // --- Unpack and Disaster Recovery Restoration Verification ---
      assert.ok(uploadedPayloadBuffer && uploadedPayloadBuffer.length > 0);
      const restoredTestDir = path.join(tempSuiteDir, 'restored_destination');
      await fs.promises.mkdir(restoredTestDir, { recursive: true });

      const tempArchiveFile = path.join(tempSuiteDir, 'downloaded_restore.tar.gz');
      await fs.promises.writeFile(tempArchiveFile, uploadedPayloadBuffer);

      // Extract archive using system tar
      execFileSync('tar', ['-xzvf', tempArchiveFile, '-C', restoredTestDir]);

      // 1. Verify Mandatory Whitelisted Files in Restored Destination
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'mnemosyne/data/mnemosyne.db')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'mnemosyne/data/mnemosyne.db-wal')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'mnemosyne/data/mnemosyne.db-shm')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'memories/MEMORY.md')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'memories/USER.md')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'config.yaml')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, '.env')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'auth.json')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'google_token.json')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'google_client_secret.json')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'skills/weather/SKILL.md')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'skills/weather/handler.js')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'scripts/vps_health.sh')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'cron/jobs.json')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'cron/executions.db')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'cron/notepad.db')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'cron/usage_audit.jsonl')));

      // 2. Verify Recommended Whitelisted Files in Restored Destination
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'plugins/notifier/index.js')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'gw_accounts/accounts.json')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'hooks/on_start.js')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'kanban.db')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'SOUL.md')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'sessions/session_001.json')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'backups/mnemosyne/snapshot_2026-08-28.db')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'context_length_cache.yaml')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'channel_directory.json')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, '.skills_prompt_snapshot.json')));
      assert.ok(fs.existsSync(path.join(restoredTestDir, 'state.db')));

      // 3. Verify Blacklisted Excluded Files are ABSENT in Restored Destination
      assert.equal(fs.existsSync(path.join(restoredTestDir, 'state.db-wal')), false);
      assert.equal(fs.existsSync(path.join(restoredTestDir, 'state.db-shm')), false);
      assert.equal(fs.existsSync(path.join(restoredTestDir, 'hermes-agent')), false);
      assert.equal(fs.existsSync(path.join(restoredTestDir, 'mnemosyne/models')), false);
      assert.equal(fs.existsSync(path.join(restoredTestDir, 'mnemosyne-venv')), false);
      assert.equal(fs.existsSync(path.join(restoredTestDir, 'node')), false);
      assert.equal(fs.existsSync(path.join(restoredTestDir, 'bin')), false);
      assert.equal(fs.existsSync(path.join(restoredTestDir, 'cache')), false);
      assert.equal(fs.existsSync(path.join(restoredTestDir, 'logs')), false);
      assert.equal(fs.existsSync(path.join(restoredTestDir, 'mnemosyne/logs')), false);
      assert.equal(
        fs.existsSync(path.join(restoredTestDir, 'backups/pre-update-backup-20260801.zip')),
        false
      );
      assert.equal(fs.existsSync(path.join(restoredTestDir, 'cron/task_run.lock')), false);
      assert.equal(fs.existsSync(path.join(restoredTestDir, 'cron/.fire-schedule-101')), false);
      assert.equal(fs.existsSync(path.join(restoredTestDir, 'cron/ticker_heartbeat')), false);
      assert.equal(fs.existsSync(path.join(restoredTestDir, 'cron/ticker_last_success')), false);

      // 4. Verify SQLite Database Integrity on Staged & Restored Databases
      const restoredMnemosyneDb = path.join(restoredTestDir, 'mnemosyne/data/mnemosyne.db');
      const mnemosyneIntegrity = execFileSync(
        'sqlite3',
        [restoredMnemosyneDb, 'PRAGMA integrity_check;'],
        { encoding: 'utf8' }
      ).trim();
      assert.equal(mnemosyneIntegrity, 'ok');

      const mnemosyneRecords = execFileSync(
        'sqlite3',
        [restoredMnemosyneDb, 'SELECT concept, summary FROM long_term_memories ORDER BY id;'],
        { encoding: 'utf8' }
      ).trim();
      assert.ok(mnemosyneRecords.includes('user_preferences'));
      assert.ok(mnemosyneRecords.includes('project_architecture'));

      const restoredCronExecDb = path.join(restoredTestDir, 'cron/executions.db');
      const cronExecIntegrity = execFileSync(
        'sqlite3',
        [restoredCronExecDb, 'PRAGMA integrity_check;'],
        { encoding: 'utf8' }
      ).trim();
      assert.equal(cronExecIntegrity, 'ok');

      const restoredKanbanDb = path.join(restoredTestDir, 'kanban.db');
      const kanbanIntegrity = execFileSync(
        'sqlite3',
        [restoredKanbanDb, 'PRAGMA integrity_check;'],
        { encoding: 'utf8' }
      ).trim();
      assert.equal(kanbanIntegrity, 'ok');

      const kanbanTasks = execFileSync(
        'sqlite3',
        [restoredKanbanDb, 'SELECT title, column_name FROM tasks ORDER BY id;'],
        { encoding: 'utf8' }
      ).trim();
      assert.ok(kanbanTasks.includes('Setup backup CLI|Done'));
      assert.ok(kanbanTasks.includes('Verify VPS crontab|In Progress'));
    });
  });

  describe('Error Alerting & Secret Redaction Flow', () => {
    it('should catch upload error, redact loaded secrets in stack trace, dispatch Brevo alert, clean temp staging directory, and return exit code 1', async () => {
      const io = createMockIo();
      const config = createTestConfig();

      // Simulated S3 upload failure containing secrets in the exception message
      const mockS3Client = {
        send: async (command) => {
          if (command instanceof PutObjectCommand) {
            throw new Error(
              `S3 Network timeout contacting ${sampleSecrets.r2AccountId} with secret ${sampleSecrets.r2SecretKey} and key ${sampleSecrets.r2AccessKey}`
            );
          }
          return {};
        },
      };

      let brevoFetchCalled = false;
      let brevoRequestBody = null;
      let brevoHeaders = null;

      const mockFetch = async (url, options) => {
        brevoFetchCalled = true;
        brevoHeaders = options.headers;
        brevoRequestBody = JSON.parse(options.body);

        return {
          ok: true,
          status: 201,
          json: async () => ({ messageId: '<brevo-e2e-alert-message-id-123>' }),
        };
      };

      const result = await backupCommand(
        { dryRun: false, verbose: true },
        {
          config,
          io,
          s3Client: mockS3Client,
          fetch: mockFetch,
        }
      );

      // Verify failure exit code
      assert.equal(result.success, false);
      assert.equal(result.exitCode, 1);
      assert.ok(result.error);

      // Verify log messages and error sanitization
      const errorOutput = io.getErrors();
      assert.ok(errorOutput.includes('[ERROR] Backup failed:'));
      assert.ok(!errorOutput.includes(sampleSecrets.r2SecretKey));
      assert.ok(!errorOutput.includes(sampleSecrets.r2AccessKey));
      assert.ok(errorOutput.includes('[REDACTED]'));

      // Verify Brevo alerting request
      assert.equal(brevoFetchCalled, true);
      assert.equal(brevoHeaders['api-key'], sampleSecrets.brevoKey);
      assert.ok(brevoRequestBody);
      assert.equal(brevoRequestBody.sender.email, sampleSecrets.brevoSender);
      assert.equal(brevoRequestBody.to[0].email, sampleSecrets.brevoRecipient);
      assert.ok(brevoRequestBody.subject.startsWith('[ALERT] Hermes Backup Failed on'));
      assert.ok(!brevoRequestBody.htmlContent.includes(sampleSecrets.r2SecretKey));
      assert.ok(!brevoRequestBody.htmlContent.includes(sampleSecrets.r2AccessKey));
      assert.ok(brevoRequestBody.htmlContent.includes('[REDACTED]'));

      // Verify temp staging directory cleanup occurred after error
      const remainingTempEntries = await fs.promises.readdir(mockTempDir);
      assert.deepEqual(
        remainingTempEntries.filter((name) => name.startsWith('hermes-backup-')),
        []
      );
    });
  });

  describe('Dry-Run Mode End-to-End Simulation', () => {
    it('should simulate path discovery and size calculation without creating staging files or sending network mutations', async () => {
      const io = createMockIo();
      const config = createTestConfig();

      let putObjectCalled = false;
      let deleteObjectsCalled = false;
      const mockS3Client = {
        send: async (command) => {
          if (command instanceof PutObjectCommand) {
            putObjectCalled = true;
            return { ETag: '"dry-run-etag"' };
          }
          if (command instanceof DeleteObjectsCommand) {
            deleteObjectsCalled = true;
            return { Deleted: [] };
          }
          if (command instanceof ListObjectsV2Command) {
            return { Contents: [], IsTruncated: false };
          }
          return {};
        },
      };

      let fetchInvoked = false;
      const mockFetch = async () => {
        fetchInvoked = true;
        return { ok: true };
      };

      const result = await backupCommand(
        { dryRun: true, verbose: true },
        {
          config,
          io,
          s3Client: mockS3Client,
          fetch: mockFetch,
        }
      );

      assert.equal(result.success, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.summary.dryRun, true);
      assert.ok(result.summary.fileCount >= 20);
      assert.equal(putObjectCalled, false);
      assert.equal(deleteObjectsCalled, false);
      assert.equal(fetchInvoked, false);

      const logs = io.getLogs();
      assert.ok(logs.includes('[INFO] Starting Hermes backup...'));
      assert.ok(logs.includes('[DRY-RUN] Archive simulated:'));
      assert.ok(logs.includes('[DRY-RUN] Upload skipped (dry-run mode)'));

      // Confirm no temporary staging directories exist on disk
      const remainingTempEntries = await fs.promises.readdir(mockTempDir);
      assert.deepEqual(
        remainingTempEntries.filter((name) => name.startsWith('hermes-backup-')),
        []
      );
    });
  });

  describe('Local-Test Mode End-to-End Simulation', () => {
    it('should simulate full execution (staging, archiving, tar verification, and local decryption) with zero remote mutations', async () => {
      const io = createMockIo();
      const config = createTestConfig();

      let putObjectCalled = false;
      let deleteObjectsCalled = false;
      const mockS3Client = {
        send: async (command) => {
          if (command instanceof PutObjectCommand) {
            putObjectCalled = true;
          }
          if (command instanceof DeleteObjectsCommand) {
            deleteObjectsCalled = true;
          }
          return {};
        },
      };

      let fetchInvoked = false;
      const mockFetch = async () => {
        fetchInvoked = true;
        return { ok: true };
      };

      const result = await backupCommand(
        { localTest: true, verbose: true },
        {
          config,
          io,
          s3Client: mockS3Client,
          fetch: mockFetch,
        }
      );

      assert.equal(result.success, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.summary.dryRun, false);
      assert.equal(result.summary.localTest, true);
      assert.ok(result.summary.fileCount >= 20);
      assert.equal(putObjectCalled, false);
      assert.equal(deleteObjectsCalled, false);
      assert.equal(fetchInvoked, false);

      const logs = io.getLogs();
      assert.ok(logs.includes('[INFO] Starting Hermes backup...'));
      assert.ok(logs.includes('Staged SQLite databases with WAL companion files'));
      assert.ok(logs.includes('Verified SQLite structural integrity across staged databases'));
      assert.ok(logs.includes('Compressed archive created:'));
      assert.ok(logs.includes('Archive integrity verified'));
      assert.ok(logs.includes('[LOCAL-TEST] Testing client-side encryption and decryption roundtrip...'));
      assert.ok(logs.includes('[LOCAL-TEST] Local decryption testing verified successfully'));
      assert.ok(logs.includes('[LOCAL-TEST] Upload skipped (local-test mode)'));
      assert.ok(logs.includes('[LOCAL-TEST] Remote retention pruning skipped (local-test mode)'));
      assert.ok(logs.includes('Cleaned temporary files. Backup completed successfully.'));

      // Confirm all temporary resources (staging and test archives) were cleaned up
      const remainingTempEntries = await fs.promises.readdir(mockTempDir);
      assert.deepEqual(
        remainingTempEntries.filter((name) => name.startsWith('hermes-backup-') || name.startsWith('local-test-')),
        []
      );
    });
  });

  describe('Subcommands End-to-End: test-notify and list', () => {
    it('should execute test-notify command and dispatch test email via Brevo REST API', async () => {
      const io = createMockIo();
      const config = createTestConfig();

      let brevoCall = null;
      const mockFetch = async (url, options) => {
        brevoCall = { url, options, body: JSON.parse(options.body) };
        return {
          ok: true,
          status: 201,
          json: async () => ({ messageId: '<test-notify-id-7788>' }),
        };
      };

      const result = await testNotifyCommand(
        { dryRun: false, verbose: true },
        { config, io, fetch: mockFetch }
      );

      assert.equal(result.success, true);
      assert.equal(result.exitCode, 0);
      assert.ok(brevoCall);
      assert.ok(brevoCall.body.subject.includes('[TEST] Hermes Backup Notification'));
      assert.ok(brevoCall.body.htmlContent.includes('Hermes Agent Backup Test Notification'));
      assert.ok(io.getLogs().includes('Test notification sent successfully'));
    });

    it('should execute list command and format tabular output of stored backups in R2', async () => {
      const io = createMockIo();
      const config = createTestConfig();

      const mockS3Client = {
        send: async (command) => {
          assert.ok(command instanceof ListObjectsV2Command);
          assert.equal(command.input.Bucket, sampleSecrets.r2Bucket);
          return {
            Contents: [
              {
                Key: 'backups/hermes-backup-2026-08-29_030000.tar.gz',
                Size: 26000000,
                LastModified: new Date('2026-08-29T03:00:00Z'),
                ETag: '"etag-20260829"',
              },
              {
                Key: 'backups/hermes-backup-2026-08-28_030000.tar.gz',
                Size: 25500000,
                LastModified: new Date('2026-08-28T03:00:00Z'),
                ETag: '"etag-20260828"',
              },
            ],
            IsTruncated: false,
          };
        },
      };

      const result = await listCommand(
        { prefix: 'backups/', verbose: true },
        { config, io, s3Client: mockS3Client }
      );

      assert.equal(result.success, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.backups.length, 2);

      const logOutput = io.getLogs();
      assert.ok(logOutput.includes('hermes-backup-2026-08-29_030000.tar.gz'));
      assert.ok(logOutput.includes('hermes-backup-2026-08-28_030000.tar.gz'));
      assert.ok(logOutput.includes('24.79 MB') || logOutput.includes('24.8'));
      assert.ok(logOutput.includes('Total: 2 backup archive(s)'));
    });
  });

  describe('CLI Process Executable Integration (cli.js)', () => {
    it('should execute node cli.js backup --dry-run via child process and exit code 0', async () => {
      const cliPath = path.resolve('./cli.js');
      const customEnv = {
        ...process.env,
        HERMES_HOME: mockHermesHome,
        BACKUP_TEMP_DIR: mockTempDir,
        R2_ACCOUNT_ID: sampleSecrets.r2AccountId,
        R2_ACCESS_KEY_ID: sampleSecrets.r2AccessKey,
        R2_SECRET_ACCESS_KEY: sampleSecrets.r2SecretKey,
        R2_BUCKET_NAME: sampleSecrets.r2Bucket,
        BREVO_API_KEY: sampleSecrets.brevoKey,
        BREVO_SENDER_EMAIL: sampleSecrets.brevoSender,
        BREVO_RECIPIENT_EMAIL: sampleSecrets.brevoRecipient,
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        [cliPath, 'backup', '--dry-run', '--verbose'],
        { env: customEnv }
      );

      assert.ok(stdout.includes('[INFO] Starting Hermes backup...'));
      assert.ok(stdout.includes('[DRY-RUN] Archive simulated:'));
      assert.ok(stdout.includes('[DRY-RUN] Upload skipped (dry-run mode)'));
      assert.ok(stdout.includes('Cleaned temporary files. Backup completed successfully.'));
    });

    it('should execute node cli.js backup --local-test via child process and exit code 0', async () => {
      const cliPath = path.resolve('./cli.js');
      const customEnv = {
        ...process.env,
        HERMES_HOME: mockHermesHome,
        BACKUP_TEMP_DIR: mockTempDir,
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        [cliPath, 'backup', '--local-test', '--verbose'],
        { env: customEnv }
      );

      assert.ok(stdout.includes('[INFO] Starting Hermes backup...'));
      assert.ok(stdout.includes('[LOCAL-TEST] Testing client-side encryption and decryption roundtrip...'));
      assert.ok(stdout.includes('[LOCAL-TEST] Local decryption testing verified successfully'));
      assert.ok(stdout.includes('[LOCAL-TEST] Upload skipped (local-test mode)'));
      assert.ok(stdout.includes('Cleaned temporary files. Backup completed successfully.'));
    });

    it('should execute node cli.js test-notify --dry-run via child process and exit code 0', async () => {
      const cliPath = path.resolve('./cli.js');
      const customEnv = {
        ...process.env,
        HERMES_HOME: mockHermesHome,
        BACKUP_TEMP_DIR: mockTempDir,
        R2_ACCOUNT_ID: sampleSecrets.r2AccountId,
        R2_ACCESS_KEY_ID: sampleSecrets.r2AccessKey,
        R2_SECRET_ACCESS_KEY: sampleSecrets.r2SecretKey,
        R2_BUCKET_NAME: sampleSecrets.r2Bucket,
        BREVO_API_KEY: sampleSecrets.brevoKey,
        BREVO_SENDER_EMAIL: sampleSecrets.brevoSender,
        BREVO_RECIPIENT_EMAIL: sampleSecrets.brevoRecipient,
      };

      const { stdout } = await execFileAsync(
        process.execPath,
        [cliPath, 'test-notify', '--dry-run'],
        { env: customEnv }
      );

      assert.ok(stdout.includes('[INFO] Sending test notification email via Brevo...'));
      assert.ok(stdout.includes('[INFO] [DRY-RUN] Test email simulated successfully'));
    });
  });

  describe('Disaster Recovery Subcommands End-to-End: restore and verify', () => {
    it('should perform complete round-trip backup, verify, and disaster recovery restore with intact databases', async () => {
      const io = createMockIo();
      const config = createTestConfig();

      // In-memory S3 mock storage to simulate R2 bucket
      const r2Store = new Map();

      const mockS3Client = {
        send: async (command) => {
          if (command instanceof PutObjectCommand) {
            const chunks = [];
            const body = command.input.Body;
            let buffer;
            if (Buffer.isBuffer(body)) {
              buffer = body;
            } else if (typeof body.on === 'function') {
              for await (const chunk of body) {
                chunks.push(chunk);
              }
              buffer = Buffer.concat(chunks);
            }
            r2Store.set(command.input.Key, {
              buffer,
              metadata: command.input.Metadata || {},
              lastModified: new Date(),
            });
            return { ETag: '"e2e-r2-upload-etag"' };
          }

          if (command instanceof ListObjectsV2Command) {
            const contents = [];
            for (const [key, obj] of r2Store.entries()) {
              contents.push({
                Key: key,
                Size: obj.buffer.length,
                LastModified: obj.lastModified,
                ETag: '"etag-r2"',
              });
            }
            return { Contents: contents, IsTruncated: false };
          }

          if (command instanceof GetObjectCommand) {
            const obj = r2Store.get(command.input.Key);
            if (!obj) {
              const err = new Error(`NoSuchKey: ${command.input.Key}`);
              err.name = 'NoSuchKey';
              throw err;
            }
            return {
              Body: obj.buffer,
              Metadata: obj.metadata,
              LastModified: obj.lastModified,
              ETag: '"etag-r2"',
            };
          }

          if (command instanceof DeleteObjectsCommand) {
            return { Deleted: [] };
          }

          throw new Error(`Unexpected command: ${command.constructor.name}`);
        },
      };

      // 1. Run full backup
      const backupResult = await backupCommand(
        { dryRun: false, verbose: true },
        { config, io, s3Client: mockS3Client }
      );
      assert.equal(backupResult.success, true);
      assert.equal(backupResult.exitCode, 0);
      assert.ok(r2Store.size >= 1);

      // 2. Run verification without modifying destination
      const verifyResult = await verifyCommand(
        { latest: true, verbose: true },
        { config, io, s3Client: mockS3Client }
      );
      assert.equal(verifyResult.success, true);
      assert.equal(verifyResult.exitCode, 0);
      assert.equal(verifyResult.summary.valid, true);

      // 3. Disaster Recovery: Restore to an empty target directory
      const restoredTargetDir = path.join(tempSuiteDir, 'restored_agent_home');
      const restoreResult = await restoreCommand(
        { latest: true, targetDir: restoredTargetDir, verbose: true },
        { config, io, s3Client: mockS3Client }
      );
      assert.equal(restoreResult.success, true);
      assert.equal(restoreResult.exitCode, 0);
      assert.ok(restoreResult.summary.restoredCount > 0);

      // 4. Validate restored files and database integrity
      assert.ok(fs.existsSync(path.join(restoredTargetDir, 'config.yaml')));
      assert.ok(fs.existsSync(path.join(restoredTargetDir, '.env')));
      assert.ok(fs.existsSync(path.join(restoredTargetDir, 'SOUL.md')));
      assert.ok(fs.existsSync(path.join(restoredTargetDir, 'memories', 'MEMORY.md')));
      assert.ok(fs.existsSync(path.join(restoredTargetDir, 'skills', 'weather', 'SKILL.md')));

      // Validate SQLite database queryability
      const mnemosyneDb = path.join(restoredTargetDir, 'mnemosyne', 'data', 'mnemosyne.db');
      assert.ok(fs.existsSync(mnemosyneDb));
      const memoryRows = execFileSync('sqlite3', [
        mnemosyneDb,
        'SELECT concept, summary FROM long_term_memories ORDER BY id ASC;',
      ]).toString().trim();
      assert.ok(memoryRows.includes('user_preferences'));
      assert.ok(memoryRows.includes('project_architecture'));

      const stateDb = path.join(restoredTargetDir, 'state.db');
      assert.ok(fs.existsSync(stateDb));
      const stateRows = execFileSync('sqlite3', [
        stateDb,
        'SELECT session_token FROM active_sessions;',
      ]).toString().trim();
      assert.equal(stateRows, 'sess_xyz_active');

      // 5. Pre-restore Safety Snapshot on secondary restore over active directory
      await fs.promises.writeFile(
        path.join(restoredTargetDir, 'active_working_state.txt'),
        'in-flight work\n'
      );
      const secondaryRestore = await restoreCommand(
        { latest: true, targetDir: restoredTargetDir },
        { config, io, s3Client: mockS3Client }
      );
      assert.equal(secondaryRestore.success, true);
      assert.ok(secondaryRestore.summary.safetySnapshot !== null);
      assert.ok(fs.existsSync(secondaryRestore.summary.safetySnapshot));

      // Verify the safety snapshot archive contains active_working_state.txt
      const snapshotValidation = await validateArchive(secondaryRestore.summary.safetySnapshot);
      assert.equal(snapshotValidation.valid, true);
      assert.ok(snapshotValidation.entries.some((e) => e.includes('active_working_state.txt')));
    });

    it('should execute cli.js restore --help and verify --help via child process with exit code 0', async () => {
      const cliPath = path.resolve('./cli.js');

      const { stdout: restoreHelp } = await execFileAsync(
        process.execPath,
        [cliPath, 'restore', '--help']
      );
      assert.ok(restoreHelp.includes('Hermes Backup CLI'));
      assert.ok(restoreHelp.includes('restore'));

      const { stdout: verifyHelp } = await execFileAsync(
        process.execPath,
        [cliPath, 'verify', '--help']
      );
      assert.ok(verifyHelp.includes('Hermes Backup CLI'));
      assert.ok(verifyHelp.includes('verify'));
    });
  });
});
