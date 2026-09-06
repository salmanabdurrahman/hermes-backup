import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseCliArgs,
  printHelp,
  printVersion,
  backupCommand,
  testNotifyCommand,
  listCommand,
  runCli,
  CLI_VERSION,
  COMMANDS,
  HELP_TEXT,
} from '../src/cli.js';
import {
  ProcessLock,
  DEFAULT_LOCK_FILENAME,
  withProcessLock,
} from '../src/lock.js';
import * as HermesBackup from '../src/index.js';
import { PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const execFileAsync = promisify(execFile);

describe('CLI Dispatcher & Command Routing', () => {
  let tempTestDir;
  let mockHermesHome;

  beforeEach(async () => {
    tempTestDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hermes-cli-test-'));
    mockHermesHome = path.join(tempTestDir, '.hermes');
    await fs.promises.mkdir(mockHermesHome, { recursive: true });

    // Seed mock Hermes data layout
    await fs.promises.writeFile(path.join(mockHermesHome, 'config.yaml'), 'model: mock-llm\n');
    await fs.promises.writeFile(path.join(mockHermesHome, '.env'), 'OPENAI_API_KEY=mock-key-123456\n');
    await fs.promises.writeFile(path.join(mockHermesHome, 'SOUL.md'), '# Hermes Agent Persona\n');

    const memoriesDir = path.join(mockHermesHome, 'memories');
    await fs.promises.mkdir(memoriesDir, { recursive: true });
    await fs.promises.writeFile(path.join(memoriesDir, 'MEMORY.md'), 'User preferences\n');

    const mnemosyneDataDir = path.join(mockHermesHome, 'mnemosyne', 'data');
    await fs.promises.mkdir(mnemosyneDataDir, { recursive: true });
    const mnemosyneDbPath = path.join(mnemosyneDataDir, 'mnemosyne.db');
    try {
      execFileSync('sqlite3', [
        mnemosyneDbPath,
        `
        PRAGMA journal_mode = WAL;
        CREATE TABLE agent_memories (id INTEGER PRIMARY KEY, content TEXT);
        INSERT INTO agent_memories (content) VALUES ('Mock memory content');
        `,
      ]);
    } catch {
      await fs.promises.writeFile(mnemosyneDbPath, 'SQLite dummy db header');
    }
    await fs.promises.writeFile(path.join(mnemosyneDataDir, 'mnemosyne.db-wal'), 'SQLite WAL data');
    await fs.promises.writeFile(path.join(mnemosyneDataDir, 'mnemosyne.db-shm'), 'SQLite SHM index');
  });

  afterEach(async () => {
    if (tempTestDir && fs.existsSync(tempTestDir)) {
      await fs.promises.rm(tempTestDir, { recursive: true, force: true });
    }
  });

  const validTestConfig = {
    hermesHome: '', // Set in test or dynamically
    r2: {
      accountId: 'test-account-id-9988',
      accessKeyId: 'test-access-key-id-7766',
      secretAccessKey: 'test-secret-access-key-5544',
      bucketName: 'test-hermes-backups',
      endpoint: 'https://test-account-id-9988.r2.cloudflarestorage.com',
    },
    brevo: {
      apiKey: 'xkeysib-test-key-001122334455',
      senderName: 'Hermes Alert Bot',
      senderEmail: 'bot@example.com',
      recipientEmail: 'admin@example.com',
    },
    retentionDays: 3,
    tempDir: '',
  };

  /**
   * Helper to capture console.log and console.error output.
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

  describe('parseCliArgs argument parser', () => {
    it('should parse empty arguments with default options', () => {
      const parsed = parseCliArgs([]);
      assert.equal(parsed.command, null);
      assert.equal(parsed.options.dryRun, false);
      assert.equal(parsed.options.verbose, false);
      assert.equal(parsed.options.help, false);
      assert.equal(parsed.options.version, false);
      assert.equal(parsed.options.prefix, 'backups/');
      assert.deepEqual(parsed.positionals, []);
    });

    it('should parse backup subcommand with flags', () => {
      const parsed = parseCliArgs(['backup', '--dry-run', '--verbose']);
      assert.equal(parsed.command, 'backup');
      assert.equal(parsed.options.dryRun, true);
      assert.equal(parsed.options.verbose, true);
      assert.equal(parsed.options.help, false);
    });

    it('should parse short flag aliases (-v, -h, -V)', () => {
      const parsedVerbose = parseCliArgs(['backup', '-v']);
      assert.equal(parsedVerbose.options.verbose, true);

      const parsedHelp = parseCliArgs(['-h']);
      assert.equal(parsedHelp.options.help, true);

      const parsedVersion = parseCliArgs(['-V']);
      assert.equal(parsedVersion.options.version, true);
    });

    it('should parse test-notify and list subcommands with custom prefix', () => {
      const parsedNotify = parseCliArgs(['test-notify', '--dry-run']);
      assert.equal(parsedNotify.command, 'test-notify');
      assert.equal(parsedNotify.options.dryRun, true);

      const parsedList = parseCliArgs(['list', '--prefix', 'custom-backups/']);
      assert.equal(parsedList.command, 'list');
      assert.equal(parsedList.options.prefix, 'custom-backups/');
    });
  });

  describe('printHelp & printVersion', () => {
    it('should output help text matching HELP_TEXT', () => {
      const io = createMockIo();
      printHelp(io);
      assert.ok(io.getLogs().includes('Hermes Backup CLI'));
      assert.ok(io.getLogs().includes('backup'));
      assert.ok(io.getLogs().includes('test-notify'));
      assert.ok(io.getLogs().includes('list'));
    });

    it('should output version string matching CLI_VERSION', () => {
      const io = createMockIo();
      printVersion(io);
      assert.equal(io.getLogs(), `hermes-backup v${CLI_VERSION}`);
    });
  });

  describe('backupCommand execution', () => {
    it('should execute backup in dry-run mode without network upload', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: mockHermesHome,
        tempDir: tempTestDir,
      };

      const result = await backupCommand({ dryRun: true, verbose: true }, { config, io });

      assert.equal(result.success, true);
      assert.equal(result.exitCode, 0);
      assert.ok(result.summary.dryRun);
      assert.ok(result.summary.fileCount >= 6);

      const logOutput = io.getLogs();
      assert.ok(logOutput.includes('[INFO] Starting Hermes backup...'));
      assert.ok(logOutput.includes('Discovered'));
      assert.ok(logOutput.includes('Staged SQLite databases with WAL companion files'));
      assert.ok(logOutput.includes('[DRY-RUN] Archive simulated:'));
      assert.ok(logOutput.includes('[DRY-RUN] Upload skipped (dry-run mode)'));
      assert.ok(logOutput.includes('Cleaned temporary files. Backup completed successfully.'));
    });

    it('should execute full backup workflow with mock S3Client and prune expired backups', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: mockHermesHome,
        tempDir: tempTestDir,
      };

      let putCommandReceived = null;
      let deleteCommandReceived = null;

      const mockS3Client = {
        send: async (command) => {
          if (command instanceof PutObjectCommand) {
            putCommandReceived = command;
            return { ETag: '"mock-upload-etag-1234"' };
          }
          if (command instanceof ListObjectsV2Command) {
            return {
              Contents: [
                {
                  Key: 'backups/hermes-backup-2020-01-01_000000.tar.gz',
                  Size: 5000000,
                  LastModified: new Date('2020-01-01T00:00:00Z'),
                },
              ],
              IsTruncated: false,
            };
          }
          if (command instanceof DeleteObjectsCommand) {
            deleteCommandReceived = command;
            return {
              Deleted: [{ Key: 'backups/hermes-backup-2020-01-01_000000.tar.gz' }],
              Errors: [],
            };
          }
          throw new Error(`Unexpected S3 command: ${command.constructor.name}`);
        },
      };

      const result = await backupCommand(
        { dryRun: false, verbose: true },
        { config, io, s3Client: mockS3Client }
      );

      assert.equal(result.success, true);
      assert.equal(result.exitCode, 0);
      assert.ok(putCommandReceived instanceof PutObjectCommand);
      assert.equal(putCommandReceived.input.Bucket, 'test-hermes-backups');
      assert.ok(deleteCommandReceived instanceof DeleteObjectsCommand);

      const logs = io.getLogs();
      assert.ok(logs.includes('Uploaded to Cloudflare R2'));
      assert.ok(logs.includes('Pruned 1 expired backup older than 3 days'));
      assert.ok(logs.includes('Cleaned temporary files. Backup completed successfully.'));

      // Verify temp resources cleaned up
      const tempEntries = await fs.promises.readdir(tempTestDir);
      const remainingBackups = tempEntries.filter((e) => e.startsWith('hermes-backup-'));
      assert.equal(remainingBackups.length, 0);
    });

    it('should fail and dispatch Brevo failure alert when upload fails', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: mockHermesHome,
        tempDir: tempTestDir,
      };

      const mockS3Client = {
        send: async (command) => {
          if (command instanceof PutObjectCommand) {
            throw new Error(`R2 connection failed with token ${config.r2.secretAccessKey}`);
          }
          return {};
        },
      };

      let capturedBrevoPayload = null;
      const mockFetch = async (url, options) => {
        capturedBrevoPayload = JSON.parse(options.body);
        return {
          ok: true,
          status: 201,
          json: async () => ({ messageId: '<alert-message-id-456>' }),
        };
      };

      const result = await backupCommand(
        { dryRun: false, verbose: false },
        { config, io, s3Client: mockS3Client, fetch: mockFetch }
      );

      assert.equal(result.success, false);
      assert.equal(result.exitCode, 1);
      assert.ok(result.error);

      // Verify error logged and sanitized
      const errors = io.getErrors();
      assert.ok(errors.includes('[ERROR] Backup failed:'));
      assert.ok(!errors.includes(config.r2.secretAccessKey));
      assert.ok(errors.includes('[REDACTED]'));

      // Verify Brevo alert sent
      const logs = io.getLogs();
      assert.ok(logs.includes('Dispatching Brevo failure alert email...'));
      assert.ok(logs.includes('Brevo notification sent successfully (MessageId: <alert-message-id-456>)'));

      assert.ok(capturedBrevoPayload);
      assert.ok(capturedBrevoPayload.subject.includes('[ALERT] Hermes Backup Failed'));
      assert.ok(capturedBrevoPayload.htmlContent.includes('[REDACTED]'));
    });

    it('should handle non-existent HERMES_HOME source directory', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: path.join(tempTestDir, 'non-existent-hermes-home'),
        tempDir: tempTestDir,
      };

      const result = await backupCommand({ dryRun: true }, { config, io });

      assert.equal(result.success, false);
      assert.equal(result.exitCode, 1);
      assert.ok(io.getErrors().includes('HERMES_HOME directory does not exist'));
    });

    it('should skip Brevo alert in dry-run mode on staging/config failure', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: path.join(tempTestDir, 'non-existent-dir'),
        tempDir: tempTestDir,
      };

      let fetchInvoked = false;
      const mockFetch = async () => {
        fetchInvoked = true;
        return { ok: true };
      };

      const result = await backupCommand({ dryRun: true }, { config, io, fetch: mockFetch });

      assert.equal(result.success, false);
      assert.equal(result.exitCode, 1);
      assert.equal(fetchInvoked, false);
    });

    it('should fail backup and dispatch alert when staged SQLite database fails integrity check', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: mockHermesHome,
        tempDir: tempTestDir,
      };

      // Corrupt the database in Hermes home
      const mnemosyneDir = path.join(mockHermesHome, 'mnemosyne', 'data');
      await fs.promises.writeFile(path.join(mnemosyneDir, 'mnemosyne.db'), 'CORRUPTED_DB_BYTES');

      let alertSent = false;
      const mockFetch = async (url, options) => {
        alertSent = true;
        return {
          ok: true,
          status: 201,
          json: async () => ({ messageId: '<integrity-alert-id>' }),
        };
      };

      const result = await backupCommand(
        { dryRun: false, verbose: true },
        { config, io, fetch: mockFetch }
      );

      assert.equal(result.success, false);
      assert.equal(result.exitCode, 1);
      assert.ok(result.error);
      assert.match(result.error.message, /SQLite integrity check failed for staged database/);
      assert.equal(result.error.code, 'SQLITE_INTEGRITY_CHECK_FAILED');
      assert.equal(alertSent, true);

      const errors = io.getErrors();
      assert.ok(errors.includes('[ERROR] Backup failed: SQLite integrity check failed for staged database: mnemosyne/data/mnemosyne.db'));
    });

    it('should acquire process lock during backup and release it upon successful completion', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: mockHermesHome,
        tempDir: tempTestDir,
      };

      const lockFilePath = path.join(tempTestDir, DEFAULT_LOCK_FILENAME);
      assert.equal(fs.existsSync(lockFilePath), false);

      const result = await backupCommand({ dryRun: true, verbose: true }, { config, io });

      assert.equal(result.success, true);
      assert.equal(result.exitCode, 0);

      // Lock file must be cleanly released upon completion
      assert.equal(fs.existsSync(lockFilePath), false);
      const logs = io.getLogs();
      assert.ok(logs.includes('Acquired process lock:'));
      assert.ok(logs.includes('Released process lock:'));
    });

    it('should release process lock upon abnormal termination or failure', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: path.join(tempTestDir, 'non-existent-hermes-dir'),
        tempDir: tempTestDir,
      };

      const lockFilePath = path.join(tempTestDir, DEFAULT_LOCK_FILENAME);

      const result = await backupCommand({ dryRun: true }, { config, io });

      assert.equal(result.success, false);
      assert.equal(result.exitCode, 1);

      // Lock file must be cleanly released despite the failure
      assert.equal(fs.existsSync(lockFilePath), false);
    });

    it('should abort backup and preserve active lock file when another process holds the lock', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: mockHermesHome,
        tempDir: tempTestDir,
      };

      const lockFilePath = path.join(tempTestDir, DEFAULT_LOCK_FILENAME);
      // Simulate an active process holding the lock
      await fs.promises.writeFile(lockFilePath, String(process.pid));

      const result = await backupCommand({ dryRun: true }, { config, io });

      assert.equal(result.success, false);
      assert.equal(result.exitCode, 1);
      assert.ok(result.error);
      assert.match(result.error.message, /Backup operation already active on PID/);

      // Active lock file must NOT be prematurely deleted
      assert.equal(fs.existsSync(lockFilePath), true);
      const remainingContent = await fs.promises.readFile(lockFilePath, 'utf8');
      assert.equal(remainingContent.trim(), String(process.pid));

      // Clean up test lock file
      await fs.promises.unlink(lockFilePath);
    });

    it('should abort backup, release process lock, and dispatch Brevo alert when temporary storage has insufficient capacity', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: mockHermesHome,
        tempDir: tempTestDir,
      };

      const lockFilePath = path.join(tempTestDir, DEFAULT_LOCK_FILENAME);
      let capturedAlertPayload = null;
      const mockFetch = async (url, options) => {
        capturedAlertPayload = JSON.parse(options.body);
        return {
          ok: true,
          status: 201,
          json: async () => ({ messageId: '<capacity-alert-id-123>' }),
        };
      };

      const result = await backupCommand(
        { dryRun: false, verbose: true },
        {
          config,
          io,
          fetch: mockFetch,
          getAvailableDiskSpace: async () => 10, // Mock 10 bytes available (insufficient)
        }
      );

      assert.equal(result.success, false);
      assert.equal(result.exitCode, 1);
      assert.ok(result.error);
      assert.equal(result.error.code, 'INSUFFICIENT_STORAGE_CAPACITY');
      assert.match(result.error.message, /Insufficient temporary storage capacity/i);

      // Verify lock released
      assert.equal(fs.existsSync(lockFilePath), false);

      // Verify error logged
      const errors = io.getErrors();
      assert.ok(errors.includes('[ERROR] Backup failed: Insufficient temporary storage capacity'));

      // Verify Brevo alert sent
      assert.ok(capturedAlertPayload);
      assert.ok(capturedAlertPayload.subject.includes('[ALERT] Hermes Backup Failed'));
      assert.ok(capturedAlertPayload.htmlContent.includes('Insufficient temporary storage capacity'));

      // Verify no lingering staging directory
      const entries = await fs.promises.readdir(tempTestDir);
      const stagingDirs = entries.filter((e) => e.startsWith('hermes-backup-'));
      assert.equal(stagingDirs.length, 0);
    });

    it('should abort dry-run backup when temporary storage capacity is insufficient without dispatching Brevo alert', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: mockHermesHome,
        tempDir: tempTestDir,
      };

      const lockFilePath = path.join(tempTestDir, DEFAULT_LOCK_FILENAME);
      let alertDispatched = false;
      const mockFetch = async () => {
        alertDispatched = true;
        return { ok: true };
      };

      const result = await backupCommand(
        { dryRun: true, verbose: false },
        {
          config,
          io,
          fetch: mockFetch,
          getAvailableDiskSpace: async () => 10,
        }
      );

      assert.equal(result.success, false);
      assert.equal(result.exitCode, 1);
      assert.ok(result.error);
      assert.equal(result.error.code, 'INSUFFICIENT_STORAGE_CAPACITY');
      assert.equal(alertDispatched, false);
      assert.equal(fs.existsSync(lockFilePath), false);
    });

    it('should log verified temporary storage capacity in verbose mode when space is sufficient', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: mockHermesHome,
        tempDir: tempTestDir,
      };

      const result = await backupCommand({ dryRun: true, verbose: true }, { config, io });

      assert.equal(result.success, true);
      assert.equal(result.exitCode, 0);
      const logs = io.getLogs();
      assert.ok(logs.includes('Verified temporary storage capacity on'));
    });
  });

  describe('testNotifyCommand execution', () => {
    it('should execute test-notify in dry-run mode', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: mockHermesHome,
        tempDir: tempTestDir,
      };

      const result = await testNotifyCommand({ dryRun: true }, { config, io });

      assert.equal(result.success, true);
      assert.equal(result.exitCode, 0);
      assert.ok(io.getLogs().includes('[INFO] [DRY-RUN] Test email simulated successfully'));
    });

    it('should send test notification email with valid credentials via mock fetch', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: mockHermesHome,
        tempDir: tempTestDir,
      };

      const mockFetch = async () => {
        return {
          ok: true,
          status: 201,
          json: async () => ({ messageId: '<test-email-msg-999>' }),
        };
      };

      const result = await testNotifyCommand({ dryRun: false }, { config, io, fetch: mockFetch });

      assert.equal(result.success, true);
      assert.equal(result.exitCode, 0);
      assert.ok(io.getLogs().includes('Test notification sent successfully (MessageId: <test-email-msg-999>)'));
    });

    it('should report failure and exit code 1 if Brevo API call fails', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: mockHermesHome,
        tempDir: tempTestDir,
      };

      const mockFetch = async () => {
        return {
          ok: false,
          status: 401,
          json: async () => ({ code: 'unauthorized', message: `Invalid key ${config.brevo.apiKey}` }),
        };
      };

      const result = await testNotifyCommand({ dryRun: false }, { config, io, fetch: mockFetch });

      assert.equal(result.success, false);
      assert.equal(result.exitCode, 1);
      assert.ok(io.getErrors().includes('[ERROR] Test notification failed:'));
      assert.ok(!io.getErrors().includes(config.brevo.apiKey));
      assert.ok(io.getErrors().includes('[REDACTED]'));
    });
  });

  describe('listCommand execution', () => {
    it('should list backups and format table output', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: mockHermesHome,
        tempDir: tempTestDir,
      };

      const mockS3Client = {
        send: async (command) => {
          assert.ok(command instanceof ListObjectsV2Command);
          return {
            Contents: [
              {
                Key: 'backups/hermes-backup-2026-08-29_100000.tar.gz',
                Size: 25000000,
                LastModified: new Date('2026-08-29T10:00:00Z'),
                ETag: '"etag-12345"',
              },
            ],
            IsTruncated: false,
          };
        },
      };

      const result = await listCommand({ prefix: 'backups/' }, { config, io, s3Client: mockS3Client });

      assert.equal(result.success, true);
      assert.equal(result.exitCode, 0);
      assert.equal(result.backups.length, 1);

      const logs = io.getLogs();
      assert.ok(logs.includes('Querying backups from Cloudflare R2 bucket: test-hermes-backups...'));
      assert.ok(logs.includes('hermes-backup-2026-08-29_100000.tar.gz'));
      assert.ok(logs.includes('23.84 MB'));
      assert.ok(logs.includes('Total: 1 backup archive(s)'));
    });

    it('should handle list failure and sanitize error messages', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: mockHermesHome,
        tempDir: tempTestDir,
      };

      const mockS3Client = {
        send: async () => {
          throw new Error(`S3 list failed with secret ${config.r2.secretAccessKey}`);
        },
      };

      const result = await listCommand({}, { config, io, s3Client: mockS3Client });

      assert.equal(result.success, false);
      assert.equal(result.exitCode, 1);
      assert.ok(io.getErrors().includes('[ERROR] Failed to list backups:'));
      assert.ok(!io.getErrors().includes(config.r2.secretAccessKey));
      assert.ok(io.getErrors().includes('[REDACTED]'));
    });
  });

  describe('runCli top-level dispatcher', () => {
    it('should return exit code 0 on --help, -h, and empty arguments', async () => {
      const io = createMockIo();

      const exit1 = await runCli(['--help'], { io });
      assert.equal(exit1, 0);
      assert.ok(io.getLogs().includes('Usage:'));

      const io2 = createMockIo();
      const exit2 = await runCli(['-h'], { io: io2 });
      assert.equal(exit2, 0);

      const io3 = createMockIo();
      const exit3 = await runCli([], { io: io3 });
      assert.equal(exit3, 0);
    });

    it('should return exit code 0 on --version and -V', async () => {
      const io = createMockIo();
      const exit = await runCli(['--version'], { io });
      assert.equal(exit, 0);
      assert.equal(io.getLogs(), `hermes-backup v${CLI_VERSION}`);

      const io2 = createMockIo();
      const exit2 = await runCli(['-V'], { io: io2 });
      assert.equal(exit2, 0);
      assert.equal(io2.getLogs(), `hermes-backup v${CLI_VERSION}`);
    });

    it('should return exit code 1 on unknown subcommand', async () => {
      const io = createMockIo();
      const exit = await runCli(['unknown-command'], { io });
      assert.equal(exit, 1);
      assert.ok(io.getErrors().includes('Unknown command: "unknown-command"'));
    });

    it('should route to backupCommand with options', async () => {
      const io = createMockIo();
      const config = {
        ...validTestConfig,
        hermesHome: mockHermesHome,
        tempDir: tempTestDir,
      };

      const exit = await runCli(['backup', '--dry-run', '--verbose'], { config, io });
      assert.equal(exit, 0);
      assert.ok(io.getLogs().includes('[INFO] Starting Hermes backup...'));
    });
  });

  describe('Index Module Re-exports', () => {
    it('should export all CLI functions and constants from src/index.js', () => {
      assert.equal(typeof HermesBackup.parseCliArgs, 'function');
      assert.equal(typeof HermesBackup.printHelp, 'function');
      assert.equal(typeof HermesBackup.printVersion, 'function');
      assert.equal(typeof HermesBackup.backupCommand, 'function');
      assert.equal(typeof HermesBackup.testNotifyCommand, 'function');
      assert.equal(typeof HermesBackup.listCommand, 'function');
      assert.equal(typeof HermesBackup.getAvailableDiskSpace, 'function');
      assert.equal(typeof HermesBackup.verifyStorageCapacity, 'function');
      assert.equal(typeof HermesBackup.verifySqliteIntegrity, 'function');
      assert.equal(typeof HermesBackup.ProcessLock, 'function');
      assert.equal(typeof HermesBackup.DEFAULT_LOCK_FILENAME, 'string');
      assert.equal(typeof HermesBackup.withProcessLock, 'function');
      assert.equal(typeof HermesBackup.runCli, 'function');
      assert.equal(HermesBackup.CLI_VERSION, '1.0.0');
      assert.equal(typeof HermesBackup.HELP_TEXT, 'string');
      assert.equal(HermesBackup.COMMANDS.BACKUP, 'backup');
      assert.equal(HermesBackup.COMMANDS.TEST_NOTIFY, 'test-notify');
      assert.equal(HermesBackup.COMMANDS.LIST, 'list');
    });
  });

  describe('Process CLI Entrypoint Execution (cli.js)', () => {
    it('should execute node cli.js --help and exit with code 0', async () => {
      const cliPath = path.resolve('./cli.js');
      const { stdout } = await execFileAsync(process.execPath, [cliPath, '--help']);
      assert.ok(stdout.includes('Hermes Backup CLI'));
      assert.ok(stdout.includes('Commands:'));
    });

    it('should execute node cli.js --version and exit with code 0', async () => {
      const cliPath = path.resolve('./cli.js');
      const { stdout } = await execFileAsync(process.execPath, [cliPath, '--version']);
      assert.ok(stdout.includes(`hermes-backup v${CLI_VERSION}`));
    });

    it('should execute node cli.js invalid-subcommand and exit with code 1', async () => {
      const cliPath = path.resolve('./cli.js');
      await assert.rejects(
        async () => {
          await execFileAsync(process.execPath, [cliPath, 'invalid-subcommand']);
        },
        (err) => {
          assert.equal(err.code, 1);
          assert.ok(err.stderr.includes('Unknown command'));
          return true;
        }
      );
    });
  });

  describe('ProcessLock concurrency locking', () => {
    let lockTestDir;
    let lockFilePath;

    beforeEach(async () => {
      lockTestDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hermes-lock-test-'));
      lockFilePath = path.join(lockTestDir, 'test-process.lock');
    });

    afterEach(async () => {
      if (lockTestDir && fs.existsSync(lockTestDir)) {
        await fs.promises.rm(lockTestDir, { recursive: true, force: true });
      }
    });

    it('should atomically acquire lock and write current PID to lock file', async () => {
      const lock = new ProcessLock(lockFilePath);
      assert.equal(lock.isLocked, false);

      const acquired = await lock.acquire();
      assert.equal(acquired, true);
      assert.equal(lock.isLocked, true);
      assert.equal(fs.existsSync(lockFilePath), true);

      const content = await fs.promises.readFile(lockFilePath, 'utf8');
      assert.equal(content.trim(), String(process.pid));

      await lock.release();
      assert.equal(lock.isLocked, false);
      assert.equal(fs.existsSync(lockFilePath), false);
    });

    it('should abort and throw when lock is held by an active PID', async () => {
      // Simulate another active process (using current process PID)
      await fs.promises.writeFile(lockFilePath, String(process.pid));

      const lock = new ProcessLock(lockFilePath);
      await assert.rejects(
        () => lock.acquire(),
        (err) => {
          assert.match(err.message, /Backup operation already active on PID/);
          return true;
        }
      );

      // Active lock file must NOT be deleted
      assert.equal(fs.existsSync(lockFilePath), true);
      const content = await fs.promises.readFile(lockFilePath, 'utf8');
      assert.equal(content.trim(), String(process.pid));
    });

    it('should detect stale lock when PID is dead, unlink it, and successfully reacquire', async () => {
      // Find a dead PID
      let deadPid = 999999;
      while (deadPid > 100000) {
        try {
          process.kill(deadPid, 0);
          deadPid--;
        } catch (err) {
          if (err.code === 'ESRCH') break;
          deadPid--;
        }
      }

      await fs.promises.writeFile(lockFilePath, String(deadPid));

      const lock = new ProcessLock(lockFilePath);
      const acquired = await lock.acquire();
      assert.equal(acquired, true);
      assert.equal(lock.isLocked, true);

      const content = await fs.promises.readFile(lockFilePath, 'utf8');
      assert.equal(content.trim(), String(process.pid));

      await lock.release();
      assert.equal(fs.existsSync(lockFilePath), false);
    });

    it('should detect and clean corrupted or empty lock file and reacquire', async () => {
      // Corrupt content
      await fs.promises.writeFile(lockFilePath, 'INVALID_PID_DATA');

      const lock = new ProcessLock(lockFilePath);
      const acquired = await lock.acquire();
      assert.equal(acquired, true);
      assert.equal(lock.isLocked, true);

      const content = await fs.promises.readFile(lockFilePath, 'utf8');
      assert.equal(content.trim(), String(process.pid));

      await lock.release();
      assert.equal(fs.existsSync(lockFilePath), false);
    });

    it('should guard release against deleting lock file belonging to another process', async () => {
      const lock = new ProcessLock(lockFilePath);
      await lock.acquire();
      assert.equal(lock.isLocked, true);

      // Overwrite lock file with another PID
      await fs.promises.writeFile(lockFilePath, '123456');

      await lock.release();
      assert.equal(lock.isLocked, false);

      // Lock file must still exist because recorded PID didn't match
      assert.equal(fs.existsSync(lockFilePath), true);
      const content = await fs.promises.readFile(lockFilePath, 'utf8');
      assert.equal(content.trim(), '123456');
    });

    it('should execute action safely with withProcessLock helper', async () => {
      let executed = false;
      const result = await withProcessLock(lockFilePath, async (lock) => {
        assert.equal(lock.isLocked, true);
        assert.equal(fs.existsSync(lockFilePath), true);
        executed = true;
        return 'success-value';
      });

      assert.equal(executed, true);
      assert.equal(result, 'success-value');
      assert.equal(fs.existsSync(lockFilePath), false);
    });

    it('should release lock synchronously with releaseSync', async () => {
      const lock = new ProcessLock(lockFilePath);
      await lock.acquire();
      assert.equal(lock.isLocked, true);
      assert.equal(fs.existsSync(lockFilePath), true);

      lock.releaseSync();
      assert.equal(lock.isLocked, false);
      assert.equal(fs.existsSync(lockFilePath), false);
    });
  });
});
