import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * Priority 1 (Mandatory) whitelist items relative to HERMES_HOME.
 */
export const MANDATORY_WHITELIST = Object.freeze([
  'mnemosyne/data/mnemosyne.db',
  'memories',
  'config.yaml',
  '.env',
  'auth.json',
  'google_token.json',
  'google_client_secret.json',
  'skills',
  'scripts',
  'cron',
]);

/**
 * Priority 2 (Recommended) whitelist items relative to HERMES_HOME.
 */
export const RECOMMENDED_WHITELIST = Object.freeze([
  'plugins',
  'gw_accounts',
  'hooks',
  'kanban.db',
  'SOUL.md',
  'sessions',
  'backups/mnemosyne',
  'context_length_cache.yaml',
  'channel_directory.json',
  '.skills_prompt_snapshot.json',
]);

/**
 * Combined default whitelist covering all Priority 1 and Priority 2 paths.
 */
export const DEFAULT_WHITELIST = Object.freeze([
  ...MANDATORY_WHITELIST,
  ...RECOMMENDED_WHITELIST,
]);

/**
 * Normalizes relative path separators to standard POSIX forward slashes.
 * @param {string} rawPath
 * @returns {string}
 */
export function normalizePath(rawPath) {
  if (typeof rawPath !== 'string') return '';
  return rawPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Check if a relative path matches the safety-net blacklist.
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isExcluded(relativePath) {
  const normalized = normalizePath(relativePath);
  if (!normalized) return false;

  const basename = path.posix.basename(normalized);
  const segments = normalized.split('/');

  // state.db and its companion files
  if (
    basename === 'state.db' ||
    basename === 'state.db-wal' ||
    basename === 'state.db-shm' ||
    basename === 'state.db-journal'
  ) {
    return true;
  }

  // hermes-agent directory
  if (segments.includes('hermes-agent')) {
    return true;
  }

  // backups/*.zip (preserve backups/mnemosyne, ignore *.zip archives)
  if (normalized.startsWith('backups/') && basename.endsWith('.zip')) {
    return true;
  }

  // mnemosyne/models/
  if (
    normalized.startsWith('mnemosyne/models') ||
    (segments.includes('mnemosyne') && segments.includes('models'))
  ) {
    return true;
  }

  // mnemosyne-venv/
  if (segments.includes('mnemosyne-venv')) {
    return true;
  }

  // node/ directory
  if (segments.includes('node')) {
    return true;
  }

  // bin/ directory
  if (segments.includes('bin')) {
    return true;
  }

  // cache/ directory (root or subdirectories)
  if (segments.includes('cache') || segments.includes('__pycache__')) {
    return true;
  }

  // skills/.hub/ internal registry cache (index-cache, scan-cache, lock, audit)
  if (segments.includes('skills') && segments.includes('.hub')) {
    return true;
  }

  // logs/ directory (root or subdirectories like mnemosyne/logs)
  if (segments.includes('logs')) {
    return true;
  }

  // Version control & OS metadata
  if (segments.includes('.git') || basename === '.DS_Store' || basename === 'Thumbs.db' || basename.endsWith('.pyc')) {
    return true;
  }

  // Transient cron and lock files
  if (basename.endsWith('.lock')) {
    return true;
  }
  if (basename.startsWith('.fire-')) {
    return true;
  }
  if (
    basename === 'ticker_heartbeat' ||
    basename.startsWith('ticker_heartbeat.') ||
    basename === 'ticker_last_success' ||
    basename.startsWith('ticker_last_success.')
  ) {
    return true;
  }

  return false;
}

/**
 * Returns potential SQLite companion file paths (-wal, -shm, -journal) for a .db file.
 * @param {string} relativePath
 * @returns {string[]}
 */
export function getSqliteCompanionPaths(relativePath) {
  const normalized = normalizePath(relativePath);
  if (!normalized.toLowerCase().endsWith('.db')) {
    return [];
  }
  return [
    `${normalized}-wal`,
    `${normalized}-shm`,
    `${normalized}-journal`,
  ];
}

/**
 * Format a Date object into a timestamp string: YYYY-MM-DD_HHmmss.
 * @param {Date} [date=new Date()]
 * @returns {string}
 */
export function formatBackupTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day}_${hours}${minutes}${seconds}`;
}

/**
 * Recursively scans a directory and collects all file paths relative to baseDir.
 * Protects against infinite loops from circular symlinks.
 *
 * @param {string} currentDir - Directory to scan
 * @param {string} baseDir - Root directory for calculating relative paths
 * @param {Set<string>} [visitedDirs=new Set()] - Set of real directory paths already visited
 * @returns {Promise<string[]>} List of relative file paths
 */
async function scanDirectory(currentDir, baseDir, visitedDirs = new Set()) {
  let realCurrent;
  try {
    realCurrent = await fs.promises.realpath(currentDir);
    if (visitedDirs.has(realCurrent)) {
      return [];
    }
    visitedDirs.add(realCurrent);
  } catch {
    // If realpath fails (e.g. broken symlink), skip directory
    return [];
  }

  let entries;
  try {
    entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES') {
      return [];
    }
    throw err;
  }

  const results = [];
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relPath = normalizePath(path.relative(baseDir, fullPath));

    if (isExcluded(relPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      const subFiles = await scanDirectory(fullPath, baseDir, visitedDirs);
      results.push(...subFiles);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      results.push(relPath);
    }
  }

  return results;
}

/**
 * Synchronous directory scanner with cycle protection.
 * @param {string} currentDir
 * @param {string} baseDir
 * @param {Set<string>} [visitedDirs=new Set()]
 * @returns {string[]}
 */
function scanDirectorySync(currentDir, baseDir, visitedDirs = new Set()) {
  let realCurrent;
  try {
    realCurrent = fs.realpathSync(currentDir);
    if (visitedDirs.has(realCurrent)) {
      return [];
    }
    visitedDirs.add(realCurrent);
  } catch {
    return [];
  }

  let entries;
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = [];
  for (const entry of entries) {
    const fullPath = path.join(currentDir, entry.name);
    const relPath = normalizePath(path.relative(baseDir, fullPath));

    if (isExcluded(relPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      const subFiles = scanDirectorySync(fullPath, baseDir, visitedDirs);
      results.push(...subFiles);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      results.push(relPath);
    }
  }

  return results;
}

/**
 * Resolves all backup files from HERMES_HOME using the include-first whitelist and safety-net exclusions.
 * Automatically discovers SQLite -wal and -shm companions.
 *
 * @param {string} hermesHome - Path to HERMES_HOME
 * @param {object} [options]
 * @param {readonly string[]} [options.whitelist=DEFAULT_WHITELIST] - Custom whitelist paths
 * @returns {Array<{ relativePath: string, absolutePath: string, size: number }>}
 */
export function resolveBackupPathsSync(hermesHome, options = {}) {
  const whitelist = options.whitelist || DEFAULT_WHITELIST;

  if (!fs.existsSync(hermesHome)) {
    throw new Error(`HERMES_HOME directory does not exist: ${hermesHome}`);
  }

  const stat = fs.statSync(hermesHome);
  if (!stat.isDirectory()) {
    throw new Error(`HERMES_HOME is not a directory: ${hermesHome}`);
  }

  const resolvedMap = new Map();

  function addFileSync(relPath) {
    const normalized = normalizePath(relPath);
    if (!normalized || isExcluded(normalized)) {
      return;
    }

    const absolutePath = path.join(hermesHome, normalized);
    try {
      if (fs.existsSync(absolutePath)) {
        const fileStat = fs.statSync(absolutePath);
        if (fileStat.isFile()) {
          resolvedMap.set(normalized, {
            relativePath: normalized,
            absolutePath,
            size: fileStat.size,
          });

          // Check generic SQLite companions if this is a .db file
          if (normalized.toLowerCase().endsWith('.db')) {
            const companions = getSqliteCompanionPaths(normalized);
            for (const compRel of companions) {
              if (isExcluded(compRel)) continue;
              const compAbs = path.join(hermesHome, compRel);
              if (fs.existsSync(compAbs)) {
                try {
                  const compStat = fs.statSync(compAbs);
                  if (compStat.isFile()) {
                    resolvedMap.set(compRel, {
                      relativePath: compRel,
                      absolutePath: compAbs,
                      size: compStat.size,
                    });
                  }
                } catch {
                  // Ignore race condition if companion was removed
                }
              }
            }
          }
        }
      }
    } catch {
      // Ignore unreadable files
    }
  }

  for (const item of whitelist) {
    const normalizedItem = normalizePath(item);
    if (isExcluded(normalizedItem)) {
      continue;
    }

    const targetPath = path.join(hermesHome, normalizedItem);
    if (!fs.existsSync(targetPath)) {
      continue;
    }

    try {
      const targetStat = fs.statSync(targetPath);
      if (targetStat.isDirectory()) {
        const dirFiles = scanDirectorySync(targetPath, hermesHome);
        for (const fileRel of dirFiles) {
          addFileSync(fileRel);
        }
      } else if (targetStat.isFile()) {
        addFileSync(normalizedItem);
      }
    } catch {
      // Skip unreadable path
    }
  }

  return Array.from(resolvedMap.values()).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );
}

/**
 * Asynchronously resolves all backup files from HERMES_HOME using the include-first whitelist.
 *
 * @param {string} hermesHome - Path to HERMES_HOME
 * @param {object} [options]
 * @param {readonly string[]} [options.whitelist=DEFAULT_WHITELIST]
 * @returns {Promise<Array<{ relativePath: string, absolutePath: string, size: number }>>}
 */
export async function resolveBackupPaths(hermesHome, options = {}) {
  const whitelist = options.whitelist || DEFAULT_WHITELIST;

  let homeStat;
  try {
    homeStat = await fs.promises.stat(hermesHome);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`HERMES_HOME directory does not exist: ${hermesHome}`);
    }
    throw err;
  }

  if (!homeStat.isDirectory()) {
    throw new Error(`HERMES_HOME is not a directory: ${hermesHome}`);
  }

  const resolvedMap = new Map();

  async function addFile(relPath) {
    const normalized = normalizePath(relPath);
    if (!normalized || isExcluded(normalized)) {
      return;
    }

    const absolutePath = path.join(hermesHome, normalized);
    try {
      const fileStat = await fs.promises.stat(absolutePath);
      if (fileStat.isFile()) {
        resolvedMap.set(normalized, {
          relativePath: normalized,
          absolutePath,
          size: fileStat.size,
        });

        // Check generic SQLite companions if this is a .db file
        if (normalized.toLowerCase().endsWith('.db')) {
          const companions = getSqliteCompanionPaths(normalized);
          for (const compRel of companions) {
            if (isExcluded(compRel)) continue;
            const compAbs = path.join(hermesHome, compRel);
            try {
              const compStat = await fs.promises.stat(compAbs);
              if (compStat.isFile()) {
                resolvedMap.set(compRel, {
                  relativePath: compRel,
                  absolutePath: compAbs,
                  size: compStat.size,
                });
              }
            } catch {
              // Companion does not exist, continue
            }
          }
        }
      }
    } catch {
      // Ignore unreadable files
    }
  }

  for (const item of whitelist) {
    const normalizedItem = normalizePath(item);
    if (isExcluded(normalizedItem)) {
      continue;
    }

    const targetPath = path.join(hermesHome, normalizedItem);
    try {
      const targetStat = await fs.promises.stat(targetPath);
      if (targetStat.isDirectory()) {
        const dirFiles = await scanDirectory(targetPath, hermesHome);
        for (const fileRel of dirFiles) {
          await addFile(fileRel);
        }
      } else if (targetStat.isFile()) {
        await addFile(normalizedItem);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
      // Missing optional whitelist entries are safely ignored
    }
  }

  return Array.from(resolvedMap.values()).sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath)
  );
}

/**
 * Creates an isolated temporary staging directory in tempDir.
 *
 * @param {string} [tempDir='/tmp'] - Base temporary directory
 * @param {string} [prefix='hermes-backup-'] - Prefix for directory name
 * @returns {Promise<string>} Absolute path to the created staging directory
 */
export async function createStagingDirectory(tempDir = '/tmp', prefix = 'hermes-backup-') {
  const timestamp = formatBackupTimestamp();
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const dirName = `${prefix}${timestamp}-${randomSuffix}`;
  const stagingDir = path.resolve(tempDir, dirName);

  await fs.promises.mkdir(stagingDir, { recursive: true });
  return stagingDir;
}

/**
 * Safely removes a staging directory and its contents.
 *
 * @param {string} stagingDir - Absolute path to staging directory
 * @param {string} [tempDir='/tmp'] - Base temp directory for path safety check
 * @returns {Promise<boolean>} True if removed successfully
 */
export async function cleanStagingDirectory(stagingDir, tempDir = '/tmp') {
  if (!stagingDir || typeof stagingDir !== 'string') {
    return false;
  }

  const resolvedStaging = path.resolve(stagingDir);
  const resolvedTemp = path.resolve(tempDir);
  const userHome = os.homedir();

  // Safety check: ensure staging dir is not root, home, or temp root directory
  if (
    resolvedStaging === '/' ||
    resolvedStaging === resolvedTemp ||
    resolvedStaging === userHome ||
    resolvedStaging.length < 5
  ) {
    throw new Error(`Refusing to clean potentially unsafe directory path: ${stagingDir}`);
  }

  try {
    await fs.promises.rm(resolvedStaging, { recursive: true, force: true });
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return true;
    }
    throw err;
  }
}

/**
 * Stages backup files from HERMES_HOME into an isolated staging directory.
 * Preserves relative directory hierarchy and copies SQLite WAL/SHM files.
 *
 * @param {string} hermesHome - Path to HERMES_HOME
 * @param {object} [options]
 * @param {string} [options.stagingDir] - Custom staging directory
 * @param {string} [options.tempDir='/tmp'] - Temp directory if stagingDir is not provided
 * @param {boolean} [options.dryRun=false] - If true, resolves paths without copying
 * @param {readonly string[]} [options.whitelist] - Custom whitelist
 * @returns {Promise<{
 *   stagingDir: string | null,
 *   stagedFiles: Array<{ relativePath: string, sourcePath: string, destPath: string | null, size: number }>,
 *   totalBytes: number,
 *   fileCount: number,
 *   timestamp: string,
 *   dryRun: boolean
 * }>}
 */
export async function stageBackup(hermesHome, options = {}) {
  const {
    stagingDir: customStagingDir,
    tempDir = '/tmp',
    dryRun = false,
    whitelist,
  } = options;

  const timestamp = formatBackupTimestamp();
  const resolvedFiles = await resolveBackupPaths(hermesHome, { whitelist });

  let totalBytes = 0;
  for (const file of resolvedFiles) {
    totalBytes += file.size;
  }

  if (dryRun) {
    return {
      stagingDir: null,
      stagedFiles: resolvedFiles.map((file) => ({
        relativePath: file.relativePath,
        sourcePath: file.absolutePath,
        destPath: null,
        size: file.size,
      })),
      totalBytes,
      fileCount: resolvedFiles.length,
      timestamp,
      dryRun: true,
    };
  }

  const stagingDir = customStagingDir || (await createStagingDirectory(tempDir));
  const stagedFiles = [];

  try {
    for (const file of resolvedFiles) {
      const destPath = path.join(stagingDir, file.relativePath);
      const destDir = path.dirname(destPath);

      await fs.promises.mkdir(destDir, { recursive: true });
      await fs.promises.copyFile(file.absolutePath, destPath);

      const stagedStat = await fs.promises.stat(destPath);

      stagedFiles.push({
        relativePath: file.relativePath,
        sourcePath: file.absolutePath,
        destPath,
        size: stagedStat.size,
      });
    }

    return {
      stagingDir,
      stagedFiles,
      totalBytes,
      fileCount: stagedFiles.length,
      timestamp,
      dryRun: false,
    };
  } catch (err) {
    // If an error occurs during staging, attempt to clean up created directory
    if (!customStagingDir) {
      try {
        await cleanStagingDirectory(stagingDir, tempDir);
      } catch {
        // Suppress cleanup failure to preserve original error
      }
    }
    throw err;
  }
}
