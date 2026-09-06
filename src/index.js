export {
  loadConfig,
  validateConfig,
  extractSecrets,
  isValidEmail,
} from './config.js';

export {
  createSanitizer,
  sanitize,
  normalizeSecrets,
} from './sanitizer.js';

export {
  MANDATORY_WHITELIST,
  RECOMMENDED_WHITELIST,
  DEFAULT_WHITELIST,
  normalizePath,
  isExcluded,
  getSqliteCompanionPaths,
  formatBackupTimestamp,
  isPathWithinBase,
  isPathWithinBaseSync,
  resolveBackupPaths,
  resolveBackupPathsSync,
  createStagingDirectory,
  cleanStagingDirectory,
  stageLiveSqliteDatabase,
  verifySqliteIntegrity,
  stageBackup,
} from './stager.js';

export {
  generateArchiveName,
  createArchive,
  createArchiveStream,
  validateArchive,
  cleanupArchive,
  cleanupTempResources,
  registerProcessCleanup,
  withStagingCleanup,
} from './archiver.js';

export {
  BACKUP_FILE_REGEX,
  formatBytes,
  createR2Client,
  uploadBackup,
  listBackups,
  pruneExpiredBackups,
  formatBackupListTable,
} from './storage.js';

export {
  DEFAULT_BREVO_API_ENDPOINT,
  DEFAULT_SENDER_NAME,
  DEFAULT_RECIPIENT_NAME,
  escapeHtml,
  formatErrorDetails,
  buildFailureHtml,
  buildTestHtml,
  sendBrevoEmail,
  sendFailureAlert,
  sendTestNotification,
} from './notifier.js';

export {
  CLI_VERSION,
  COMMANDS,
  HELP_TEXT,
  parseCliArgs,
  printHelp,
  printVersion,
  backupCommand,
  testNotifyCommand,
  listCommand,
  runCli,
} from './cli.js';
