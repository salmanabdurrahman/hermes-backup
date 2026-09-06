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
  getAvailableDiskSpace,
  verifyStorageCapacity,
  stageLiveSqliteDatabase,
  verifySqliteIntegrity,
  stageBackup,
} from './stager.js';

export {
  generateArchiveName,
  createArchive,
  createArchiveStream,
  calculateFileSha256,
  validateArchive,
  cleanupArchive,
  cleanupTempResources,
  registerProcessCleanup,
  withStagingCleanup,
  unpackArchive,
  createSafetySnapshot,
} from './archiver.js';

export {
  BACKUP_FILE_REGEX,
  formatBytes,
  createR2Client,
  uploadBackup,
  downloadBackup,
  listBackups,
  getLatestBackup,
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
  DEFAULT_LOCK_FILENAME,
  ProcessLock,
  withProcessLock,
} from './lock.js';

export {
  ALGORITHM,
  SALT_LENGTH,
  IV_LENGTH,
  TAG_LENGTH,
  KEY_LENGTH,
  MIN_ENVELOPE_LENGTH,
  deriveKey,
  encryptArchiveFile,
  decryptArchiveFile,
  isEncryptionEnabled,
} from './crypto.js';

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
  restoreCommand,
  verifyCommand,
  runCli,
} from './cli.js';
