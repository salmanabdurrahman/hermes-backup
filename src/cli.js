import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs } from 'node:util';
import { loadConfig, validateConfig } from './config.js';
import { createSanitizer } from './sanitizer.js';
import {
  stageBackup,
  cleanStagingDirectory,
  formatBackupTimestamp,
} from './stager.js';
import {
  createArchive,
  validateArchive,
  cleanupArchive,
  cleanupTempResources,
  generateArchiveName,
} from './archiver.js';
import {
  createR2Client,
  uploadBackup,
  listBackups,
  pruneExpiredBackups,
  formatBackupListTable,
  formatBytes,
} from './storage.js';
import {
  sendFailureAlert,
  sendTestNotification,
} from './notifier.js';

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

Options:
  --dry-run          Simulate operations without making remote network mutations
  -v, --verbose      Enable detailed step-by-step progress logging
  -h, --help         Display help information
  -V, --version      Display version number
  --prefix <prefix>  Prefix filter for listing remote backups (default: 'backups/')

Examples:
  node cli.js backup
  node cli.js backup --dry-run --verbose
  node cli.js test-notify
  node cli.js list
`;

/**
 * Parse CLI arguments into structured command and options.
 *
 * @param {string[]} [rawArgs=process.argv.slice(2)]
 * @returns {{
 *   command: string | null,
 *   options: {
 *     dryRun: boolean,
 *     verbose: boolean,
 *     help: boolean,
 *     version: boolean,
 *     prefix: string
 *   },
 *   positionals: string[]
 * }}
 */
export function parseCliArgs(rawArgs = process.argv.slice(2)) {
  const optionsConfig = {
    'dry-run': { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'V', default: false },
    prefix: { type: 'string', default: 'backups/' },
  };

  const { values, positionals } = parseArgs({
    args: rawArgs,
    options: optionsConfig,
    allowPositionals: true,
    strict: false,
  });

  const command = positionals[0] ? positionals[0].toLowerCase().trim() : null;

  return {
    command,
    options: {
      dryRun: Boolean(values['dry-run']),
      verbose: Boolean(values.verbose),
      help: Boolean(values.help),
      version: Boolean(values.version),
      prefix: typeof values.prefix === 'string' ? values.prefix : 'backups/',
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
  const { dryRun = false, verbose = false } = options;
  const {
    env = process.env,
    config: customConfig,
    io = console,
    fetch: customFetch,
    s3Client,
  } = context;

  const config = customConfig || loadConfig(env);
  const sanitizer = createSanitizer(config);

  const log = (msg) => io.log(msg);
  const logVerbose = (msg) => {
    if (verbose) io.log(msg);
  };
  const logError = (msg) => io.error(msg);

  let stagingDir = null;
  let archivePath = null;

  try {
    // Validate configuration
    validateConfig(config, {
      requireR2: !dryRun,
      requireBrevo: !dryRun,
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
    });

    stagingDir = stageResult.stagingDir;

    log(
      `[INFO] Discovered ${stageResult.fileCount} files (${formatBytes(stageResult.totalBytes)})`
    );
    log('[INFO] Staged SQLite databases with WAL companion files');

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
      };
    } else {
      const uploadStart = Date.now();
      uploadResult = await uploadBackup(archivePath, config, {
        client: s3Client,
        uncompressedSize: stageResult.totalBytes,
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
        };
      }
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

    // Dispatch failure alert via Brevo unless in dry-run mode
    if (!dryRun) {
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
    }

    return {
      success: false,
      exitCode: 1,
      error: sanitizedError,
    };
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
  const { dryRun = false, verbose = false } = options;
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

  try {
    validateConfig(config, {
      requireR2: false,
      requireBrevo: !dryRun,
      throwOnError: true,
    });

    log('[INFO] Sending test notification email via Brevo...');

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
  const { prefix = 'backups/', verbose = false } = options;
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

    default: {
      io.error(`[ERROR] Unknown command: "${command}"`);
      printHelp(io);
      return 1;
    }
  }
}
