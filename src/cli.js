import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadConfig, validateConfig } from './config.js';
import { createSanitizer } from './sanitizer.js';
import {
  stageBackup,
  cleanStagingDirectory,
  formatBackupTimestamp,
  verifySqliteIntegrity,
  isPathWithinBase,
} from './stager.js';
import {
  createArchive,
  validateArchive,
  cleanupArchive,
  cleanupTempResources,
  generateArchiveName,
  unpackArchive,
  createSafetySnapshot,
} from './archiver.js';
import {
  createR2Client,
  uploadBackup,
  downloadBackup,
  listBackups,
  getLatestBackup,
  pruneExpiredBackups,
  formatBackupListTable,
  formatBytes,
} from './storage.js';
import {
  encryptArchiveFile,
  decryptArchiveFile,
  isEncryptionEnabled,
} from './crypto.js';
import {
  sendFailureAlert,
  sendTestNotification,
} from './notifier.js';
import {
  ProcessLock,
  DEFAULT_LOCK_FILENAME,
} from './lock.js';

/**
 * CLI Version string.
 */
export const CLI_VERSION = '1.0.0';

/**
 * Available subcommands.
 */
export const COMMANDS = Object.freeze({
  BACKUP: 'backup',
  TEST_NOTIFY: 'test-notify',
  LIST: 'list',
  RESTORE: 'restore',
  VERIFY: 'verify',
});

/**
 * Help text banner and command usage reference.
 */
export const HELP_TEXT = `Hermes Backup CLI — Automated selective backup of Hermes Agent state to Cloudflare R2

Usage:
  hermes-backup <command> [options]
  node cli.js <command> [options]

Commands:
  backup         Execute selective backup, compression, upload to R2, and prune expired archives
  test-notify    Send a test notification email via Brevo to verify credentials
  list           List existing backups stored in Cloudflare R2
  restore        Download, verify, and restore a backup archive to HERMES_HOME or target directory
  verify         Download and verify archive integrity end-to-end without modifying local state

Options:
  --target-dir <path>  Destination recovery directory (default: HERMES_HOME)
  --latest             Select the most recent backup archive from R2
  --force              Overwrite existing destination files without confirmation
  --dry-run            Planning mode: inspect paths and calculate sizes without disk or network operations
  --local-test         Full execution simulation: stage, archive, verify tar, test decryption without remote mutations
  -v, --verbose        Enable detailed step-by-step progress logging
  -h, --help           Display help information
  -V, --version        Display version number
  --prefix <prefix>    Prefix filter for listing remote backups (default: 'backups/')

Examples:
  node cli.js backup
  node cli.js backup --dry-run
  node cli.js backup --local-test
  node cli.js backup --local-test --verbose
  node cli.js test-notify
  node cli.js list
  node cli.js restore --latest
  node cli.js restore hermes-backup-2025-01-01_120000.tar.gz --target-dir ~/.hermes
  node cli.js verify --latest
`;

/**
 * Parse CLI arguments into structured command and options.
 *
 * @param {string[]} [rawArgs=process.argv.slice(2)]
 * @returns {{
 *   command: string | null,
 *   archiveName: string | null,
 *   options: {
 *     dryRun: boolean,
 *     verbose: boolean,
 *     help: boolean,
 *     version: boolean,
 *     prefix: string,
 *     targetDir: string | undefined,
 *     latest: boolean,
 *     force: boolean,
 *     archiveName: string | null
 *   },
 *   positionals: string[]
 * }}
 */
export function parseCliArgs(rawArgs = process.argv.slice(2)) {
  const optionsConfig = {
    'dry-run': { type: 'boolean', default: false },
    'local-test': { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'V', default: false },
    prefix: { type: 'string', default: 'backups/' },
    'target-dir': { type: 'string' },
    latest: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
  };

  const { values, positionals } = parseArgs({
    args: rawArgs,
    options: optionsConfig,
    allowPositionals: true,
    strict: false,
  });

  const command = positionals[0] ? positionals[0].toLowerCase().trim() : null;
  const rawPositional1 = positionals[1] ? positionals[1].trim() : null;
  const isLatestPositional = rawPositional1 === 'latest' || rawPositional1 === '--latest';
  const archiveName = isLatestPositional ? null : rawPositional1;
  const latest = Boolean(values.latest) || isLatestPositional;

  return {
    command,
    archiveName,
    options: {
      dryRun: Boolean(values['dry-run']),
      localTest: Boolean(values['local-test']),
      verbose: Boolean(values.verbose),
      help: Boolean(values.help),
      version: Boolean(values.version),
      prefix: typeof values.prefix === 'string' ? values.prefix : 'backups/',
      targetDir: typeof values['target-dir'] === 'string' ? values['target-dir'] : undefined,
      latest,
      force: Boolean(values.force),
      archiveName,
    },
    positionals,
  };
}

/**
 * Print help information to standard output.
 * @param {object} [io=console]
 */
export function printHelp(io = console) {
  io.log(HELP_TEXT);
}

/**
 * Print version string to standard output.
 * @param {object} [io=console]
 */
export function printVersion(io = console) {
  io.log(`hermes-backup v${CLI_VERSION}`);
}

/**
 * Executes the full backup lifecycle: stage -> archive -> validate -> upload -> prune -> cleanup.
 * On error, dispatches a failure notification via Brevo transactional email.
 *
 * @param {object} [options={}]
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.verbose=false]
 * @param {object} [context={}]
 * @param {Record<string, string | undefined>} [context.env=process.env]
 * @param {object} [context.config]
 * @param {object} [context.io=console]
 * @param {typeof fetch} [context.fetch]
 * @param {import('@aws-sdk/client-s3').S3Client} [context.s3Client]
 * @returns {Promise<{ success: boolean, exitCode: number, error?: Error, summary?: object }>}
 */
export async function backupCommand(options = {}, context = {}) {
  const { dryRun = false, localTest = false, verbose = false } = options;
  const {
    env = process.env,
    config: customConfig,
    io = console,
    fetch: customFetch,
    s3Client,
    lockFilePath: customLockFilePath,
    processLock: customProcessLock,
    statfsFn,
    getAvailableDiskSpace: customGetAvailableDiskSpace,
    verifyStorageCapacity: customVerifyStorageCapacity,
    skipCapacityCheck,
  } = context;

  const config = customConfig || loadConfig(env);
  const sanitizer = createSanitizer(config);

  const log = (msg) => io.log(msg);
  const logVerbose = (msg) => {
    if (verbose) io.log(msg);
  };
  const logError = (msg) => io.error(msg);

  if (dryRun && localTest) {
    const error = new Error('Cannot specify both --dry-run and --local-test simultaneously.');
    error.code = 'ERR_EXCLUSIVE_OPTIONS';
    logError(`[ERROR] ${error.message}`);
    return {
      success: false,
      exitCode: 1,
      error,
    };
  }

  let stagingDir = null;
  let archivePath = null;
  let lockAcquired = false;

  const lockFilePath = customLockFilePath || path.join(config.tempDir, DEFAULT_LOCK_FILENAME);
  const processLock = customProcessLock || new ProcessLock(lockFilePath);

  try {
    // Acquire concurrency process lock prior to execution
    await processLock.acquire();
    lockAcquired = true;
    logVerbose(`[INFO] Acquired process lock: ${lockFilePath} (PID: ${process.pid})`);

    // Validate configuration
    validateConfig(config, {
      requireR2: !dryRun && !localTest,
      requireBrevo: !dryRun && !localTest,
      throwOnError: true,
    });

    // Check HERMES_HOME source directory existence
    if (!fs.existsSync(config.hermesHome)) {
      throw new Error(`HERMES_HOME directory does not exist: ${config.hermesHome}`);
    }

    const homeStat = await fs.promises.stat(config.hermesHome);
    if (!homeStat.isDirectory()) {
      throw new Error(`HERMES_HOME path is not a directory: ${config.hermesHome}`);
    }

    log('[INFO] Starting Hermes backup...');

    // 1. Staging Step
    const stageResult = await stageBackup(config.hermesHome, {
      tempDir: config.tempDir,
      dryRun,
      onWarning: (msg) => {
        if (typeof io.warn === 'function') {
          io.warn(`[WARN] ${msg}`);
        } else {
          log(`[WARN] ${msg}`);
        }
      },
      statfsFn,
      getAvailableDiskSpace: customGetAvailableDiskSpace,
      verifyStorageCapacity: customVerifyStorageCapacity,
      skipCapacityCheck,
    });

    stagingDir = stageResult.stagingDir;

    log(
      `[INFO] Discovered ${stageResult.fileCount} files (${formatBytes(stageResult.totalBytes)})`
    );
    logVerbose(
      `[INFO] Verified temporary storage capacity on ${config.tempDir} (minimum ${formatBytes(stageResult.totalBytes * 2)} required)`
    );
    if (dryRun) {
      log('[INFO] [DRY-RUN] Planning mode: path discovery and size calculation complete (no staging files created)');
    } else {
      log('[INFO] Staged SQLite databases with WAL companion files');
      logVerbose('[INFO] Verified SQLite structural integrity across staged databases');
    }

    if (verbose) {
      for (const item of stageResult.stagedFiles) {
        logVerbose(`  - ${item.relativePath} (${formatBytes(item.size)})`);
      }
    }

    // 2. Archiving Step
    let archiveResult;
    if (dryRun) {
      const simulatedArchiveName = generateArchiveName(stageResult.timestamp);
      log(
        `[INFO] [DRY-RUN] Archive simulated: ${simulatedArchiveName} (~${formatBytes(stageResult.totalBytes)})`
      );
    } else {
      archiveResult = await createArchive(stagingDir, {
        outputDir: config.tempDir,
        timestamp: stageResult.timestamp,
      });

      archivePath = archiveResult.archivePath;
      log(`[INFO] Compressed archive created: ${formatBytes(archiveResult.size)}`);

      // Verify archive integrity
      await validateArchive(archivePath);
      logVerbose(`[INFO] Archive integrity verified (${archiveResult.entryCount} entries)`);

      // Local decryption testing in simulation mode
      if (localTest) {
        let testKey = config.encryptionKey;
        let usingEphemeralKey = false;
        if (!isEncryptionEnabled(config)) {
          testKey = crypto.randomBytes(32).toString('hex');
          usingEphemeralKey = true;
        }

        const testEncryptedPath = path.join(
          config.tempDir,
          `local-test-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.enc`
        );
        const testDecryptedPath = path.join(
          config.tempDir,
          `local-test-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.tar.gz`
        );

        try {
          log('[INFO] [LOCAL-TEST] Testing client-side encryption and decryption roundtrip...');
          await encryptArchiveFile(archivePath, testEncryptedPath, testKey);
          logVerbose(
            `[INFO] [LOCAL-TEST] Encrypted simulation archive: ${formatBytes((await fs.promises.stat(testEncryptedPath)).size)}`
          );

          await decryptArchiveFile(testEncryptedPath, testDecryptedPath, testKey);
          logVerbose('[INFO] [LOCAL-TEST] Decrypted simulation archive successfully');

          // Verify decrypted archive structure
          const decryptedValidation = await validateArchive(testDecryptedPath);
          log(
            `[INFO] [LOCAL-TEST] Local decryption testing verified successfully (${decryptedValidation.entries.length} entries intact${usingEphemeralKey ? ', ephemeral simulation key' : ', configured encryption key'})`
          );
        } finally {
          await fs.promises.unlink(testEncryptedPath).catch(() => {});
          await fs.promises.unlink(testDecryptedPath).catch(() => {});
        }
      }
    }

    // 3. Remote Upload Step
    let uploadResult;
    if (dryRun) {
      log('[INFO] [DRY-RUN] Upload skipped (dry-run mode)');
      uploadResult = {
        key: `backups/${generateArchiveName(stageResult.timestamp)}`,
        bucket: config.r2.bucketName,
        size: stageResult.totalBytes,
        etag: '"dry-run-etag"',
        dryRun: true,
        localTest: false,
      };
    } else if (localTest) {
      log('[INFO] [LOCAL-TEST] Upload skipped (local-test mode)');
      uploadResult = {
        key: `backups/${path.posix.basename(archivePath)}`,
        bucket: config.r2.bucketName,
        size: archiveResult.size,
        etag: '"local-test-etag"',
        dryRun: false,
        localTest: true,
      };
    } else {
      const uploadStart = Date.now();
      uploadResult = await uploadBackup(archivePath, config, {
        client: s3Client,
        uncompressedSize: stageResult.totalBytes,
        sha256: archiveResult?.sha256,
      });

      const durationSec = ((Date.now() - uploadStart) / 1000).toFixed(1);
      log(
        `[INFO] Uploaded to Cloudflare R2 in ${durationSec}s (Key: ${uploadResult.key}, ETag: ${uploadResult.etag})`
      );
    }

    // 4. Remote Retention Pruning Step
    let pruneResult;
    if (dryRun) {
      if (s3Client) {
        pruneResult = await pruneExpiredBackups(config, {
          client: s3Client,
          retentionDays: config.retentionDays,
          dryRun: true,
        });
      } else {
        log('[INFO] [DRY-RUN] Remote retention check skipped (dry-run mode)');
        pruneResult = {
          pruned: [],
          prunedCount: 0,
          totalFreedBytes: 0,
          dryRun: true,
          localTest: false,
        };
      }
    } else if (localTest) {
      log('[INFO] [LOCAL-TEST] Remote retention pruning skipped (local-test mode)');
      pruneResult = {
        pruned: [],
        prunedCount: 0,
        totalFreedBytes: 0,
        dryRun: false,
        localTest: true,
      };
    } else {
      pruneResult = await pruneExpiredBackups(config, {
        client: s3Client,
        retentionDays: config.retentionDays,
        dryRun: false,
      });
    }

    if (pruneResult.prunedCount > 0) {
      const pluralSuffix = pruneResult.prunedCount === 1 ? '' : 's';
      const dryRunTag = dryRun ? ' [DRY-RUN]' : '';
      log(
        `[INFO]${dryRunTag} Pruned ${pruneResult.prunedCount} expired backup${pluralSuffix} older than ${config.retentionDays} days (${formatBytes(pruneResult.totalFreedBytes)} freed)`
      );
    } else if (!dryRun || s3Client) {
      log('[INFO] Retention check completed: no expired backups to prune');
    }


    // 5. Temporary Resource Cleanup
    if (!dryRun) {
      await cleanupTempResources({
        stagingDir,
        archivePath,
        tempDir: config.tempDir,
      });
      stagingDir = null;
      archivePath = null;
    }

    log('[INFO] Cleaned temporary files. Backup completed successfully.');

    return {
      success: true,
      exitCode: 0,
      summary: {
        fileCount: stageResult.fileCount,
        uncompressedBytes: stageResult.totalBytes,
        archiveSize: archiveResult ? archiveResult.size : stageResult.totalBytes,
        uploadKey: uploadResult.key,
        prunedCount: pruneResult.prunedCount,
        dryRun,
        localTest,
      },
    };
  } catch (rawError) {
    const sanitizedError = sanitizer(rawError);
    logError(`[ERROR] Backup failed: ${sanitizedError.message || sanitizedError}`);

    if (verbose && sanitizedError.stack) {
      logError(sanitizedError.stack);
    }

    // Attempt emergency cleanup of temporary resources
    try {
      await cleanupTempResources({
        stagingDir,
        archivePath,
        tempDir: config.tempDir,
      });
    } catch {
      // Suppress secondary cleanup errors
    }

    // Dispatch failure alert via Brevo unless in dry-run or local-test mode
    if (!dryRun && !localTest) {
      const brevoConfigCheck = validateConfig(config, {
        requireR2: false,
        requireBrevo: true,
      });

      if (brevoConfigCheck.valid) {
        log('[INFO] Dispatching Brevo failure alert email...');
        try {
          const alertResult = await sendFailureAlert(sanitizedError, config, {
            fetch: customFetch,
            throwOnError: false,
          });

          if (alertResult.success) {
            log(
              `[INFO] Brevo notification sent successfully (MessageId: ${alertResult.messageId || 'sent'})`
            );
          } else {
            logError(
              `[ERROR] Failed to dispatch Brevo alert: ${alertResult.error?.message || 'Unknown Brevo error'}`
            );
          }
        } catch (alertErr) {
          const sanitizedAlertErr = sanitizer(alertErr);
          logError(`[ERROR] Failed to dispatch Brevo alert: ${sanitizedAlertErr.message}`);
        }
      } else {
        logVerbose('[INFO] Brevo alerting skipped: credentials not configured or incomplete');
      }
    } else if (localTest) {
      logVerbose('[INFO] [LOCAL-TEST] Brevo alerting skipped (local-test mode)');
    }

    return {
      success: false,
      exitCode: 1,
      error: sanitizedError,
    };
  } finally {
    if (lockAcquired) {
      try {
        await processLock.release();
        logVerbose(`[INFO] Released process lock: ${lockFilePath}`);
      } catch (releaseErr) {
        logVerbose(`[WARN] Failed to release process lock: ${releaseErr.message}`);
      }
    }
  }
}

/**
 * Executes test notification command to verify Brevo delivery setup.
 *
 * @param {object} [options={}]
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.verbose=false]
 * @param {object} [context={}]
 * @param {Record<string, string | undefined>} [context.env=process.env]
 * @param {object} [context.config]
 * @param {object} [context.io=console]
 * @param {typeof fetch} [context.fetch]
 * @returns {Promise<{ success: boolean, exitCode: number, error?: Error }>}
 */
export async function testNotifyCommand(options = {}, context = {}) {
  const { dryRun = false, localTest = false, verbose = false } = options;
  const {
    env = process.env,
    config: customConfig,
    io = console,
    fetch: customFetch,
  } = context;

  const config = customConfig || loadConfig(env);
  const sanitizer = createSanitizer(config);

  const log = (msg) => io.log(msg);
  const logError = (msg) => io.error(msg);

  if (dryRun && localTest) {
    const error = new Error('Cannot specify both --dry-run and --local-test simultaneously.');
    error.code = 'ERR_EXCLUSIVE_OPTIONS';
    logError(`[ERROR] ${error.message}`);
    return {
      success: false,
      exitCode: 1,
      error,
    };
  }

  try {
    validateConfig(config, {
      requireR2: false,
      requireBrevo: !dryRun && !localTest,
      throwOnError: true,
    });

    log('[INFO] Sending test notification email via Brevo...');

    if (localTest) {
      log('[INFO] [LOCAL-TEST] Test notification simulated successfully (remote email dispatch omitted)');
      return {
        success: true,
        exitCode: 0,
      };
    }

    const result = await sendTestNotification(config, {
      fetch: customFetch,
      dryRun,
      throwOnError: true,
    });

    if (dryRun) {
      log('[INFO] [DRY-RUN] Test email simulated successfully');
    } else {
      const msgIdStr = result.messageId ? ` (MessageId: ${result.messageId})` : '';
      log(
        `[INFO] Test notification sent successfully${msgIdStr} to ${config.brevo.recipientEmail}`
      );
    }

    return {
      success: true,
      exitCode: 0,
    };
  } catch (rawError) {
    const sanitizedError = sanitizer(rawError);
    logError(`[ERROR] Test notification failed: ${sanitizedError.message || sanitizedError}`);

    if (verbose && sanitizedError.stack) {
      logError(sanitizedError.stack);
    }

    return {
      success: false,
      exitCode: 1,
      error: sanitizedError,
    };
  }
}

/**
 * Executes list command to display existing backups in Cloudflare R2.
 *
 * @param {object} [options={}]
 * @param {string} [options.prefix='backups/']
 * @param {boolean} [options.verbose=false]
 * @param {object} [context={}]
 * @param {Record<string, string | undefined>} [context.env=process.env]
 * @param {object} [context.config]
 * @param {object} [context.io=console]
 * @param {import('@aws-sdk/client-s3').S3Client} [context.s3Client]
 * @returns {Promise<{ success: boolean, exitCode: number, error?: Error, backups?: any[] }>}
 */
export async function listCommand(options = {}, context = {}) {
  const { prefix = 'backups/', dryRun = false, localTest = false, verbose = false } = options;
  const {
    env = process.env,
    config: customConfig,
    io = console,
    s3Client,
  } = context;

  const config = customConfig || loadConfig(env);
  const sanitizer = createSanitizer(config);

  const log = (msg) => io.log(msg);
  const logError = (msg) => io.error(msg);

  if (dryRun && localTest) {
    const error = new Error('Cannot specify both --dry-run and --local-test simultaneously.');
    error.code = 'ERR_EXCLUSIVE_OPTIONS';
    logError(`[ERROR] ${error.message}`);
    return {
      success: false,
      exitCode: 1,
      error,
    };
  }

  try {
    validateConfig(config, {
      requireR2: true,
      requireBrevo: false,
      throwOnError: true,
    });

    log(`[INFO] Querying backups from Cloudflare R2 bucket: ${config.r2.bucketName}...`);

    const result = await listBackups(config, {
      client: s3Client,
      prefix,
    });

    const tableOutput = formatBackupListTable(result.backups);
    log(tableOutput);

    if (result.backups.length > 0) {
      log(
        `\nTotal: ${result.totalCount} backup archive(s), ${formatBytes(result.totalBytes)}`
      );
    }

    return {
      success: true,
      exitCode: 0,
      backups: result.backups,
    };
  } catch (rawError) {
    const sanitizedError = sanitizer(rawError);
    logError(`[ERROR] Failed to list backups: ${sanitizedError.message || sanitizedError}`);

    if (verbose && sanitizedError.stack) {
      logError(sanitizedError.stack);
    }

    return {
      success: false,
      exitCode: 1,
      error: sanitizedError,
    };
  }
}

/**
 * Inspects the initial two bytes of a file to determine if it is gzip-compressed.
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
async function isGzipFile(filePath) {
  let fileHandle;
  try {
    fileHandle = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(2);
    const { bytesRead } = await fileHandle.read(buffer, 0, 2, 0);
    return bytesRead === 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  } catch {
    return false;
  } finally {
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
    }
  }
}

/**
 * Recursively collects all regular files in a directory tree.
 * @param {string} dirPath
 * @param {string} [baseDir=dirPath]
 * @returns {Promise<Array<{ absolutePath: string, relativePath: string }>>}
 */
async function getAllFiles(dirPath, baseDir = dirPath) {
  const results = [];
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await getAllFiles(fullPath, baseDir);
      results.push(...subFiles);
    } else if (entry.isFile()) {
      results.push({
        absolutePath: fullPath,
        relativePath: path.relative(baseDir, fullPath),
      });
    }
  }
  return results;
}

/**
 * Executes the restore command: downloads archive from R2, verifies SHA-256,
 * decrypts if encrypted, unpacks to recovery staging directory, runs PRAGMA integrity_check
 * on databases, creates a pre-restore safety snapshot, and restores files to destination.
 *
 * @param {object} [options={}]
 * @param {string} [options.archiveName]
 * @param {boolean} [options.latest=false]
 * @param {string} [options.targetDir]
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.force=false]
 * @param {boolean} [options.verbose=false]
 * @param {string} [options.prefix='backups/']
 * @param {object} [context={}]
 * @param {Record<string, string | undefined>} [context.env=process.env]
 * @param {object} [context.config]
 * @param {object} [context.io=console]
 * @param {import('@aws-sdk/client-s3').S3Client} [context.s3Client]
 * @param {string} [context.lockFilePath]
 * @param {ProcessLock} [context.processLock]
 * @param {string} [context.sqliteBinary='sqlite3']
 * @returns {Promise<{ success: boolean, exitCode: number, error?: Error, summary?: object }>}
 */
export async function restoreCommand(options = {}, context = {}) {
  const {
    archiveName: rawArchiveName,
    latest = false,
    targetDir: customTargetDir,
    dryRun = false,
    localTest = false,
    force = false,
    verbose = false,
    prefix = 'backups/',
  } = options;

  const {
    env = process.env,
    config: customConfig,
    io = console,
    s3Client,
    lockFilePath: customLockFilePath,
    processLock: customProcessLock,
    sqliteBinary = 'sqlite3',
  } = context;

  const config = customConfig || loadConfig(env);
  const sanitizer = createSanitizer(config);

  const log = (msg) => io.log(msg);
  const logVerbose = (msg) => {
    if (verbose) io.log(msg);
  };
  const logError = (msg) => io.error(msg);

  if (dryRun && localTest) {
    const error = new Error('Cannot specify both --dry-run and --local-test simultaneously.');
    error.code = 'ERR_EXCLUSIVE_OPTIONS';
    logError(`[ERROR] ${error.message}`);
    return {
      success: false,
      exitCode: 1,
      error,
    };
  }

  const targetDir = customTargetDir
    ? path.resolve(customTargetDir)
    : path.resolve(config.hermesHome);

  let recoveryDir = null;
  let lockAcquired = false;

  const lockFilePath = customLockFilePath || path.join(config.tempDir, DEFAULT_LOCK_FILENAME);
  const processLock = customProcessLock || new ProcessLock(lockFilePath);

  try {
    // Validate configuration
    validateConfig(config, {
      requireR2: !dryRun && !localTest,
      requireBrevo: false,
      throwOnError: true,
    });

    log('[INFO] Starting Hermes restore operation...');

    // Resolve target backup key
    let targetKey = null;
    const isLatest = latest || rawArchiveName === 'latest' || rawArchiveName === '--latest';
    const archiveName = isLatest ? null : rawArchiveName;

    if (isLatest) {
      logVerbose('[INFO] Resolving latest backup from Cloudflare R2...');
      if (dryRun && !s3Client) {
        targetKey = 'backups/latest-simulated.tar.gz';
      } else {
        const latestBackup = await getLatestBackup(config, {
          client: s3Client,
          prefix,
        });
        if (!latestBackup) {
          throw new Error(
            `No backup archives found in Cloudflare R2 bucket: ${config.r2.bucketName}`
          );
        }
        targetKey = latestBackup.key;
      }
    } else if (archiveName && typeof archiveName === 'string' && archiveName.trim().length > 0) {
      targetKey = archiveName.trim();
    } else {
      throw new Error('Archive name or --latest flag must be specified for restore.');
    }

    log(`[INFO] Selected archive for recovery: ${targetKey}`);
    log(`[INFO] Destination directory: ${targetDir}`);

    if (dryRun) {
      log('[INFO] [DRY-RUN] Simulating restore without modifying local state');
      log('[INFO] [DRY-RUN] Restore simulation completed successfully.');
      return {
        success: true,
        exitCode: 0,
        summary: {
          key: targetKey,
          targetDir,
          dryRun: true,
          localTest: false,
        },
      };
    }

    // Acquire process lock for recovery
    await processLock.acquire();
    lockAcquired = true;
    logVerbose(`[INFO] Acquired process lock: ${lockFilePath} (PID: ${process.pid})`);

    // Create isolated recovery temporary directory
    const recoveryId = `hermes-restore-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    recoveryDir = path.join(config.tempDir, recoveryId);
    await fs.promises.mkdir(recoveryDir, { recursive: true });

    // 1. Download Step
    const archiveBasename = path.posix.basename(targetKey);
    const downloadDestPath = path.join(recoveryDir, archiveBasename);
    log(`[INFO] Downloading backup from Cloudflare R2 bucket: ${config.r2.bucketName}...`);

    const downloadResult = await downloadBackup(targetKey, downloadDestPath, config, {
      client: s3Client,
    });
    log(
      `[INFO] Downloaded ${formatBytes(downloadResult.size)} (SHA-256: ${downloadResult.sha256.slice(0, 16)}...)`
    );

    // 2. Decryption Step (if encrypted)
    let archiveToExtract = downloadDestPath;
    const metadata = downloadResult.metadata || {};
    const isExplicitlyEncrypted =
      metadata.encrypted === 'true' || metadata.algorithm === 'aes-256-gcm';
    const isGzip = await isGzipFile(downloadDestPath);
    const requiresDecryption =
      isExplicitlyEncrypted || (isEncryptionEnabled(config) && !isGzip);

    if (requiresDecryption) {
      if (!isEncryptionEnabled(config)) {
        throw new Error('Archive is encrypted but BACKUP_ENCRYPTION_KEY is not configured');
      }

      const decryptedPath = path.join(recoveryDir, 'decrypted-archive.tar.gz');
      log('[INFO] Decrypting archive using configured AES-256-GCM encryption key...');
      await decryptArchiveFile(downloadDestPath, decryptedPath, config.encryptionKey);
      logVerbose('[INFO] Archive decrypted successfully');
      archiveToExtract = decryptedPath;
    }

    // 3. Validation Step (tar integrity check)
    log('[INFO] Verifying archive structure...');
    const validationResult = await validateArchive(archiveToExtract);
    logVerbose(`[INFO] Archive integrity verified (${validationResult.entries.length} entries)`);

    // 4. Staging / Unpack Step
    const unpackStagingDir = path.join(recoveryDir, 'staging');
    await fs.promises.mkdir(unpackStagingDir, { recursive: true });
    await unpackArchive(archiveToExtract, unpackStagingDir);
    log(`[INFO] Unpacked ${validationResult.entries.length} files to recovery staging directory`);

    // 5. SQLite Structural Integrity Verification
    const stagedFiles = await getAllFiles(unpackStagingDir);
    const dbFiles = stagedFiles.filter((f) => f.relativePath.toLowerCase().endsWith('.db'));

    for (const dbFile of dbFiles) {
      const isValid = await verifySqliteIntegrity(dbFile.absolutePath, {
        sqliteBinary,
        onWarning: (msg) => {
          if (typeof io.warn === 'function') {
            io.warn(`[WARN] ${msg}`);
          } else {
            log(`[WARN] ${msg}`);
          }
        },
      });

      if (!isValid) {
        const error = new Error(
          `SQLite integrity check failed for restored database: ${dbFile.relativePath}`
        );
        error.code = 'SQLITE_INTEGRITY_CHECK_FAILED';
        throw error;
      }
    }
    if (dbFiles.length > 0) {
      logVerbose(
        `[INFO] SQLite structural integrity verified across ${dbFiles.length} database(s)`
      );
    }

    // If local execution simulation, skip modifying destination directory
    if (localTest) {
      log(
        `[INFO] [LOCAL-TEST] Recovery simulation: verified archive structure and SQLite database integrity without modifying destination: ${targetDir}`
      );
      await fs.promises.rm(recoveryDir, { recursive: true, force: true });
      recoveryDir = null;

      return {
        success: true,
        exitCode: 0,
        summary: {
          key: targetKey,
          targetDir,
          restoredCount: 0,
          simulatedCount: stagedFiles.length,
          safetySnapshot: null,
          dryRun: false,
          localTest: true,
        },
      };
    }

    // 6. Pre-restore Safety Snapshot
    let safetySnapshot = null;
    if (fs.existsSync(targetDir)) {
      safetySnapshot = await createSafetySnapshot(targetDir, {
        tempDir: config.tempDir,
      });
      if (safetySnapshot) {
        log(
          `[INFO] Created pre-restore safety snapshot: ${safetySnapshot.snapshotPath} (${formatBytes(safetySnapshot.size)})`
        );
      }
    }

    // 7. Synchronize files to target directory
    await fs.promises.mkdir(targetDir, { recursive: true });
    let restoredCount = 0;

    for (const item of stagedFiles) {
      const normalizedRel = path.normalize(item.relativePath);
      if (
        normalizedRel.startsWith('..' + path.sep) ||
        normalizedRel === '..' ||
        path.isAbsolute(normalizedRel)
      ) {
        throw new Error(
          `Security violation: restored path resolves outside target directory: ${item.relativePath}`
        );
      }

      const destPath = path.resolve(targetDir, normalizedRel);
      const relToTarget = path.relative(targetDir, destPath);
      if (
        relToTarget.startsWith('..' + path.sep) ||
        relToTarget === '..' ||
        path.isAbsolute(relToTarget)
      ) {
        throw new Error(
          `Security violation: restored path resolves outside target directory: ${item.relativePath}`
        );
      }

      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.copyFile(item.absolutePath, destPath);

      const isSafe = await isPathWithinBase(destPath, targetDir);
      if (!isSafe) {
        await fs.promises.unlink(destPath).catch(() => {});
        throw new Error(
          `Security violation: restored path resolves outside target directory: ${item.relativePath}`
        );
      }

      restoredCount++;
      logVerbose(`  - Restored: ${item.relativePath}`);
    }

    // 8. Cleanup Temporary Recovery Resources
    await fs.promises.rm(recoveryDir, { recursive: true, force: true });
    recoveryDir = null;

    log(`[INFO] Restored ${restoredCount} files to ${targetDir}. Restore completed successfully.`);

    return {
      success: true,
      exitCode: 0,
      summary: {
        key: targetKey,
        targetDir,
        restoredCount,
        safetySnapshot: safetySnapshot?.snapshotPath || null,
        dryRun: false,
        localTest: false,
      },
    };
  } catch (rawError) {
    const sanitizedError = sanitizer(rawError);
    logError(`[ERROR] Restore failed: ${sanitizedError.message || sanitizedError}`);

    if (verbose && sanitizedError.stack) {
      logError(sanitizedError.stack);
    }

    if (recoveryDir) {
      try {
        await fs.promises.rm(recoveryDir, { recursive: true, force: true });
      } catch {
        // Ignore emergency cleanup errors
      }
    }

    return {
      success: false,
      exitCode: 1,
      error: sanitizedError,
    };
  } finally {
    if (lockAcquired) {
      try {
        await processLock.release();
        logVerbose(`[INFO] Released process lock: ${lockFilePath}`);
      } catch (releaseErr) {
        logVerbose(`[WARN] Failed to release process lock: ${releaseErr.message}`);
      }
    }
  }
}

/**
 * Executes the verify command: downloads archive, verifies SHA-256, decrypts if needed,
 * validates tar, checks SQLite integrity, without modifying local state.
 *
 * @param {object} [options={}]
 * @param {string} [options.archiveName]
 * @param {boolean} [options.latest=false]
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.verbose=false]
 * @param {string} [options.prefix='backups/']
 * @param {object} [context={}]
 * @param {Record<string, string | undefined>} [context.env=process.env]
 * @param {object} [context.config]
 * @param {object} [context.io=console]
 * @param {import('@aws-sdk/client-s3').S3Client} [context.s3Client]
 * @param {string} [context.sqliteBinary='sqlite3']
 * @returns {Promise<{ success: boolean, exitCode: number, error?: Error, summary?: object }>}
 */
export async function verifyCommand(options = {}, context = {}) {
  const {
    archiveName: rawArchiveName,
    latest = false,
    dryRun = false,
    localTest = false,
    verbose = false,
    prefix = 'backups/',
  } = options;

  const {
    env = process.env,
    config: customConfig,
    io = console,
    s3Client,
    sqliteBinary = 'sqlite3',
  } = context;

  const config = customConfig || loadConfig(env);
  const sanitizer = createSanitizer(config);

  const log = (msg) => io.log(msg);
  const logVerbose = (msg) => {
    if (verbose) io.log(msg);
  };
  const logError = (msg) => io.error(msg);

  if (dryRun && localTest) {
    const error = new Error('Cannot specify both --dry-run and --local-test simultaneously.');
    error.code = 'ERR_EXCLUSIVE_OPTIONS';
    logError(`[ERROR] ${error.message}`);
    return {
      success: false,
      exitCode: 1,
      error,
    };
  }

  let recoveryDir = null;

  try {
    // Validate configuration
    validateConfig(config, {
      requireR2: !dryRun && !localTest,
      requireBrevo: false,
      throwOnError: true,
    });

    log('[INFO] Starting Hermes archive verification...');

    // Resolve target backup key
    let targetKey = null;
    const isLatest = latest || rawArchiveName === 'latest' || rawArchiveName === '--latest';
    const archiveName = isLatest ? null : rawArchiveName;

    if (isLatest) {
      logVerbose('[INFO] Resolving latest backup from Cloudflare R2...');
      if (dryRun && !s3Client) {
        targetKey = 'backups/latest-simulated.tar.gz';
      } else {
        const latestBackup = await getLatestBackup(config, {
          client: s3Client,
          prefix,
        });
        if (!latestBackup) {
          throw new Error(
            `No backup archives found in Cloudflare R2 bucket: ${config.r2.bucketName}`
          );
        }
        targetKey = latestBackup.key;
      }
    } else if (archiveName && typeof archiveName === 'string' && archiveName.trim().length > 0) {
      targetKey = archiveName.trim();
    } else {
      throw new Error('Archive name or --latest flag must be specified for verify.');
    }

    log(`[INFO] Selected archive for verification: ${targetKey}`);

    if (dryRun) {
      log('[INFO] [DRY-RUN] Simulating verification without downloading');
      log('[INFO] [DRY-RUN] Archive verification simulated successfully.');
      return {
        success: true,
        exitCode: 0,
        summary: {
          key: targetKey,
          dryRun: true,
          localTest: false,
        },
      };
    }

    // Create isolated verification temporary directory
    const recoveryId = `hermes-verify-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    recoveryDir = path.join(config.tempDir, recoveryId);
    await fs.promises.mkdir(recoveryDir, { recursive: true });

    // 1. Download Step (with SHA-256 validation)
    const archiveBasename = path.posix.basename(targetKey);
    const downloadDestPath = path.join(recoveryDir, archiveBasename);
    log(`[INFO] Downloading backup from Cloudflare R2 bucket: ${config.r2.bucketName}...`);

    const downloadResult = await downloadBackup(targetKey, downloadDestPath, config, {
      client: s3Client,
    });
    log(
      `[INFO] Downloaded ${formatBytes(downloadResult.size)} (SHA-256: ${downloadResult.sha256.slice(0, 16)}...)`
    );

    // 2. Decryption Step (if encrypted)
    let archiveToValidate = downloadDestPath;
    const metadata = downloadResult.metadata || {};
    const isExplicitlyEncrypted =
      metadata.encrypted === 'true' || metadata.algorithm === 'aes-256-gcm';
    const isGzip = await isGzipFile(downloadDestPath);
    const requiresDecryption =
      isExplicitlyEncrypted || (isEncryptionEnabled(config) && !isGzip);

    if (requiresDecryption) {
      if (!isEncryptionEnabled(config)) {
        throw new Error('Archive is encrypted but BACKUP_ENCRYPTION_KEY is not configured');
      }

      const decryptedPath = path.join(recoveryDir, 'decrypted-archive.tar.gz');
      log('[INFO] Decrypting archive using configured AES-256-GCM encryption key...');
      await decryptArchiveFile(downloadDestPath, decryptedPath, config.encryptionKey);
      logVerbose('[INFO] Archive decrypted successfully');
      archiveToValidate = decryptedPath;
    }

    // 3. Validation Step (tar integrity check)
    log('[INFO] Verifying archive structure...');
    const validationResult = await validateArchive(archiveToValidate);
    logVerbose(`[INFO] Archive integrity verified (${validationResult.entries.length} entries)`);

    // 4. Unpack Step into temporary directory
    const unpackStagingDir = path.join(recoveryDir, 'staging');
    await fs.promises.mkdir(unpackStagingDir, { recursive: true });
    await unpackArchive(archiveToValidate, unpackStagingDir);

    // 5. SQLite Structural Integrity Verification
    const stagedFiles = await getAllFiles(unpackStagingDir);
    const dbFiles = stagedFiles.filter((f) => f.relativePath.toLowerCase().endsWith('.db'));

    for (const dbFile of dbFiles) {
      const isValid = await verifySqliteIntegrity(dbFile.absolutePath, {
        sqliteBinary,
        onWarning: (msg) => {
          if (typeof io.warn === 'function') {
            io.warn(`[WARN] ${msg}`);
          } else {
            log(`[WARN] ${msg}`);
          }
        },
      });

      if (!isValid) {
        const error = new Error(
          `SQLite integrity check failed for verified database: ${dbFile.relativePath}`
        );
        error.code = 'SQLITE_INTEGRITY_CHECK_FAILED';
        throw error;
      }
    }
    if (dbFiles.length > 0) {
      logVerbose(
        `[INFO] SQLite structural integrity verified across ${dbFiles.length} database(s)`
      );
    }

    // 6. Cleanup Temporary Resources (HERMES_HOME is untouched)
    await fs.promises.rm(recoveryDir, { recursive: true, force: true });
    recoveryDir = null;

    log(
      `[INFO] Archive verification completed successfully. All checksums, structures, and ${dbFiles.length} SQLite database(s) intact.`
    );

    return {
      success: true,
      exitCode: 0,
      summary: {
        key: targetKey,
        fileCount: validationResult.entries.length,
        dbCount: dbFiles.length,
        valid: true,
        dryRun: false,
        localTest,
      },
    };
  } catch (rawError) {
    const sanitizedError = sanitizer(rawError);
    logError(`[ERROR] Verification failed: ${sanitizedError.message || sanitizedError}`);

    if (verbose && sanitizedError.stack) {
      logError(sanitizedError.stack);
    }

    if (recoveryDir) {
      try {
        await fs.promises.rm(recoveryDir, { recursive: true, force: true });
      } catch {
        // Ignore emergency cleanup errors
      }
    }

    return {
      success: false,
      exitCode: 1,
      error: sanitizedError,
    };
  }
}

/**
 * Main CLI dispatcher. Parses arguments and routes to the appropriate command handler.
 *
 * @param {string[]} [rawArgs=process.argv.slice(2)]
 * @param {object} [context={}]
 * @returns {Promise<number>} POSIX exit code (0 for success, 1 for failure)
 */
export async function runCli(rawArgs = process.argv.slice(2), context = {}) {
  const io = context.io || console;

  let parsed;
  try {
    parsed = parseCliArgs(rawArgs);
  } catch (err) {
    io.error(`[ERROR] Invalid argument: ${err.message}`);
    printHelp(io);
    return 1;
  }

  const { command, options } = parsed;

  if (options.help || (rawArgs.length === 0 && !command)) {
    printHelp(io);
    return 0;
  }

  if (options.version) {
    printVersion(io);
    return 0;
  }

  if (options.dryRun && options.localTest) {
    io.error('[ERROR] Cannot specify both --dry-run and --local-test simultaneously.');
    return 1;
  }

  if (!command) {
    io.error('[ERROR] No command specified.');
    printHelp(io);
    return 1;
  }

  switch (command) {
    case COMMANDS.BACKUP: {
      const result = await backupCommand(options, { ...context, io });
      return result.exitCode;
    }

    case COMMANDS.TEST_NOTIFY: {
      const result = await testNotifyCommand(options, { ...context, io });
      return result.exitCode;
    }

    case COMMANDS.LIST: {
      const result = await listCommand(options, { ...context, io });
      return result.exitCode;
    }

    case COMMANDS.RESTORE: {
      const result = await restoreCommand(options, { ...context, io });
      return result.exitCode;
    }

    case COMMANDS.VERIFY: {
      const result = await verifyCommand(options, { ...context, io });
      return result.exitCode;
    }

    default: {
      io.error(`[ERROR] Unknown command: "${command}"`);
      printHelp(io);
      return 1;
    }
  }
}
