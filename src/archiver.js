import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { formatBackupTimestamp, cleanStagingDirectory } from './stager.js';

/**
 * Generate standard backup archive filename.
 * @param {string | Date} [timestampOrDate]
 * @returns {string}
 */
export function generateArchiveName(timestampOrDate) {
  let timestamp;
  if (!timestampOrDate) {
    timestamp = formatBackupTimestamp();
  } else if (timestampOrDate instanceof Date) {
    timestamp = formatBackupTimestamp(timestampOrDate);
  } else if (typeof timestampOrDate === 'string' && timestampOrDate.trim().length > 0) {
    timestamp = timestampOrDate.trim();
  } else {
    timestamp = formatBackupTimestamp();
  }
  return `hermes-backup-${timestamp}.tar.gz`;
}

/**
 * Computes the cryptographic SHA-256 checksum of a file via streaming.
 *
 * @param {string} filePath - Path to the file
 * @returns {Promise<string>} Hex-encoded SHA-256 digest
 */
export async function calculateFileSha256(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('File path must be a non-empty string');
  }

  const resolved = path.resolve(filePath);
  const hash = crypto.createHash('sha256');
  const fileStream = fs.createReadStream(resolved);

  await pipeline(fileStream, hash);
  return hash.digest('hex');
}

/**
 * Validates that a directory path exists and is a non-empty directory.
 * @param {string} stagingDir
 * @returns {Promise<string[]>} List of top-level entry names in staging directory
 */
async function validateStagingDirectory(stagingDir) {
  if (!stagingDir || typeof stagingDir !== 'string') {
    throw new Error('Staging directory path must be a non-empty string');
  }

  const resolved = path.resolve(stagingDir);

  let stat;
  try {
    stat = await fs.promises.stat(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Staging directory does not exist: ${resolved}`);
    }
    throw err;
  }

  if (!stat.isDirectory()) {
    throw new Error(`Staging path is not a directory: ${resolved}`);
  }

  const entries = await fs.promises.readdir(resolved);
  if (entries.length === 0) {
    throw new Error(`Cannot create archive from empty staging directory: ${resolved}`);
  }

  return entries;
}

/**
 * Package staged files into a compressed tar.gz archive.
 *
 * @param {string} stagingDir - Absolute path to directory containing staged files
 * @param {object} [options]
 * @param {string} [options.outputDir] - Directory where archive will be written (defaults to parent of stagingDir)
 * @param {string} [options.archiveName] - Custom name for archive file (defaults to hermes-backup-YYYY-MM-DD_HHmmss.tar.gz)
 * @param {string} [options.timestamp] - Specific timestamp for archive name
 * @param {boolean} [options.gzip=true] - Whether to apply gzip compression
 * @returns {Promise<{
 *   archivePath: string,
 *   archiveName: string,
 *   size: number,
 *   sha256: string,
 *   timestamp: string,
 *   entryCount: number
 * }>}
 */
export async function createArchive(stagingDir, options = {}) {
  const resolvedStaging = path.resolve(stagingDir);
  const entries = await validateStagingDirectory(resolvedStaging);

  const timestamp = options.timestamp || formatBackupTimestamp();
  const archiveName = options.archiveName || generateArchiveName(timestamp);
  const outputDir = path.resolve(options.outputDir || path.dirname(resolvedStaging));
  const archivePath = path.join(outputDir, archiveName);

  // Ensure output directory exists
  await fs.promises.mkdir(outputDir, { recursive: true });

  const useGzip = options.gzip !== false;

  const hash = crypto.createHash('sha256');
  const hashStream = new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  const tarStream = tar.c(
    {
      gzip: useGzip,
      cwd: resolvedStaging,
      portable: true,
    },
    entries
  );

  const fileWriteStream = fs.createWriteStream(archivePath);

  try {
    await pipeline(tarStream, hashStream, fileWriteStream);
    const sha256 = hash.digest('hex');

    let stat;
    try {
      stat = await fs.promises.stat(archivePath);
    } catch (err) {
      throw new Error(`Failed to verify generated archive: ${err.message}`);
    }

    if (!stat.isFile() || stat.size === 0) {
      try {
        await fs.promises.rm(archivePath, { force: true });
      } catch {
        // Ignore deletion failure on invalid file
      }
      throw new Error(`Generated archive is empty or invalid (0 bytes): ${archivePath}`);
    }

    return {
      archivePath,
      archiveName,
      size: stat.size,
      sha256,
      timestamp,
      entryCount: entries.length,
    };
  } catch (err) {
    // If archive creation failed and left a broken file, clean it up
    try {
      if (fs.existsSync(archivePath)) {
        await fs.promises.rm(archivePath, { force: true });
      }
    } catch {
      // Ignore cleanup error to preserve primary error
    }
    throw err;
  }
}

/**
 * Creates a readable stream of the tar.gz archive directly from the staging directory.
 * Useful for piping directly to upload streams.
 *
 * @param {string} stagingDir - Absolute path to directory containing staged files
 * @param {object} [options]
 * @param {boolean} [options.gzip=true] - Whether to apply gzip compression
 * @returns {Promise<import('node:stream').Readable>}
 */
export async function createArchiveStream(stagingDir, options = {}) {
  const resolvedStaging = path.resolve(stagingDir);
  const entries = await validateStagingDirectory(resolvedStaging);

  return tar.c(
    {
      gzip: options.gzip !== false,
      cwd: resolvedStaging,
      portable: true,
    },
    entries
  );
}

/**
 * Inspects and validates the integrity of a tar.gz archive.
 *
 * @param {string} archivePath - Absolute path to the archive file
 * @returns {Promise<{ valid: boolean, size: number, entries: string[] }>}
 */
export async function validateArchive(archivePath) {
  if (!archivePath || typeof archivePath !== 'string') {
    throw new Error('Archive path must be a non-empty string');
  }

  const resolved = path.resolve(archivePath);

  let stat;
  try {
    stat = await fs.promises.stat(resolved);
  } catch (err) {
    throw new Error(`Archive file not found: ${resolved}`);
  }

  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Archive is empty or not a regular file: ${resolved} (${stat.size} bytes)`);
  }

  const entries = [];
  try {
    await tar.t({
      file: resolved,
      onentry: (entry) => {
        entries.push(entry.path);
      },
    });
  } catch (err) {
    throw new Error(`Archive validation failed for ${resolved}: ${err.message}`);
  }

  if (entries.length === 0) {
    throw new Error(`Archive validation failed for ${resolved}: archive contains no valid entries`);
  }

  return {
    valid: true,
    size: stat.size,
    entries,
  };
}

/**
 * Safely removes an archive file with path validation guards.
 *
 * @param {string} archivePath - Absolute path to the archive file to delete
 * @param {object} [options]
 * @param {string} [options.tempDir] - Base temp dir restriction if required
 * @returns {Promise<boolean>} True if removed or already absent
 */
export async function cleanupArchive(archivePath, options = {}) {
  if (!archivePath || typeof archivePath !== 'string') {
    return false;
  }

  const resolved = path.resolve(archivePath);
  const userHome = os.homedir();
  const baseTemp = path.resolve(options.tempDir || os.tmpdir());

  // Safety checks
  if (
    resolved === '/' ||
    resolved === userHome ||
    resolved === baseTemp ||
    resolved.length < 5
  ) {
    throw new Error(`Refusing to delete potentially unsafe archive path: ${archivePath}`);
  }

  try {
    await fs.promises.rm(resolved, { force: true });
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return true;
    }
    throw err;
  }
}

/**
 * Safely cleans up temporary backup resources (staging directory and archive file).
 *
 * @param {object} resources
 * @param {string} [resources.stagingDir] - Staging directory to remove
 * @param {string} [resources.archivePath] - Archive file to remove
 * @param {string} [resources.tempDir='/tmp'] - Temp directory for path safety checks
 * @returns {Promise<{ stagingCleaned: boolean, archiveCleaned: boolean }>}
 */
export async function cleanupTempResources(resources = {}) {
  const { stagingDir, archivePath, tempDir = '/tmp' } = resources;
  let stagingCleaned = false;
  let archiveCleaned = false;

  if (stagingDir) {
    try {
      stagingCleaned = await cleanStagingDirectory(stagingDir, tempDir);
    } catch {
      stagingCleaned = false;
    }
  }

  if (archivePath) {
    try {
      archiveCleaned = await cleanupArchive(archivePath, { tempDir });
    } catch {
      archiveCleaned = false;
    }
  }

  return {
    stagingCleaned,
    archiveCleaned,
  };
}

/**
 * Set of active cleanup callbacks for process exit management.
 */
const activeExitCleanups = new Set();
let isExitHandlerAttached = false;

/**
 * Handles process exit signals to purge registered temp resources synchronously.
 */
function handleProcessExit(signal) {
  const callbacks = Array.from(activeExitCleanups);
  activeExitCleanups.clear();
  for (const cleanupFn of callbacks) {
    try {
      cleanupFn(signal);
    } catch {
      // Suppress errors during emergency exit cleanup
    }
  }
}

/**
 * Register a cleanup callback on process exit / termination signals.
 * Returns an unregister function to remove the callback when work finishes normally.
 *
 * @param {(signal?: string) => void} cleanupFn
 * @returns {() => void} Unregister function
 */
export function registerProcessCleanup(cleanupFn) {
  if (typeof cleanupFn !== 'function') {
    throw new TypeError('Cleanup handler must be a function');
  }

  activeExitCleanups.add(cleanupFn);

  if (!isExitHandlerAttached) {
    isExitHandlerAttached = true;
    process.once('exit', () => handleProcessExit('exit'));
    process.once('SIGINT', () => {
      handleProcessExit('SIGINT');
      process.exit(130);
    });
    process.once('SIGTERM', () => {
      handleProcessExit('SIGTERM');
      process.exit(143);
    });
  }

  return () => {
    activeExitCleanups.delete(cleanupFn);
  };
}

/**
 * Execute an asynchronous action within a guarded staging lifecycle.
 * Guarantees staging directory cleanup in a finally block and attaches
 * an emergency process exit handler during execution.
 *
 * @template T
 * @param {string} stagingDir - Absolute path to staging directory
 * @param {(stagingDir: string) => Promise<T>} actionFn - Async function performing work
 * @param {object} [options]
 * @param {string} [options.tempDir='/tmp'] - Temp directory for path safety checks
 * @returns {Promise<T>} Result of actionFn
 */
export async function withStagingCleanup(stagingDir, actionFn, options = {}) {
  const tempDir = options.tempDir || '/tmp';

  // Synchronous fallback cleanup for emergency exit with strict path safety guards
  const emergencyCleanup = () => {
    try {
      if (!stagingDir || typeof stagingDir !== 'string') return;
      const resolvedStaging = path.resolve(stagingDir);
      const resolvedTemp = path.resolve(tempDir);
      const userHome = os.homedir();

      if (
        resolvedStaging === '/' ||
        resolvedStaging === resolvedTemp ||
        resolvedStaging === userHome ||
        resolvedStaging.length < 5
      ) {
        return;
      }

      if (fs.existsSync(resolvedStaging)) {
        fs.rmSync(resolvedStaging, { recursive: true, force: true });
      }
    } catch {
      // Suppress emergency exit cleanup errors
    }
  };

  const unregister = registerProcessCleanup(emergencyCleanup);

  let actionError;
  try {
    return await actionFn(stagingDir);
  } catch (err) {
    actionError = err;
    throw err;
  } finally {
    unregister();
    try {
      await cleanStagingDirectory(stagingDir, tempDir);
    } catch (cleanupErr) {
      if (!actionError) {
        throw cleanupErr;
      }
    }
  }
}

/**
 * Unpacks a compressed tar.gz archive into a target directory.
 *
 * @param {string} archivePath - Absolute or relative path to .tar.gz archive file
 * @param {string} targetDir - Directory where contents will be extracted
 * @param {object} [options]
 * @returns {Promise<{
 *   targetDir: string,
 *   extractedCount: number,
 *   entries: string[]
 * }>}
 */
export async function unpackArchive(archivePath, targetDir, options = {}) {
  if (!archivePath || typeof archivePath !== 'string') {
    throw new Error('Archive path must be a non-empty string');
  }
  if (!targetDir || typeof targetDir !== 'string') {
    throw new Error('Target directory must be a non-empty string');
  }

  const resolvedArchive = path.resolve(archivePath);
  const resolvedTarget = path.resolve(targetDir);

  let stat;
  try {
    stat = await fs.promises.stat(resolvedArchive);
  } catch (err) {
    throw new Error(`Archive file not found: ${resolvedArchive}`);
  }

  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Archive is empty or not a regular file: ${resolvedArchive}`);
  }

  await fs.promises.mkdir(resolvedTarget, { recursive: true });

  const entries = [];
  await tar.x({
    file: resolvedArchive,
    cwd: resolvedTarget,
    onentry: (entry) => {
      entries.push(entry.path);
    },
  });

  return {
    targetDir: resolvedTarget,
    extractedCount: entries.length,
    entries,
  };
}

/**
 * Creates a safety snapshot of an existing target directory before restore operations.
 * Returns null if the target directory does not exist or contains no files.
 *
 * @param {string} targetDir - Absolute or relative path to directory to snapshot
 * @param {object} [options]
 * @param {string} [options.tempDir] - Output directory for snapshot archive
 * @param {string} [options.timestamp] - Specific timestamp string
 * @returns {Promise<{
 *   snapshotPath: string,
 *   snapshotName: string,
 *   size: number,
 *   timestamp: string,
 *   entryCount: number
 * } | null>}
 */
export async function createSafetySnapshot(targetDir, options = {}) {
  if (!targetDir || typeof targetDir !== 'string') {
    throw new Error('Target directory path must be a non-empty string');
  }

  const resolvedTarget = path.resolve(targetDir);

  let stat;
  try {
    stat = await fs.promises.stat(resolvedTarget);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  if (!stat.isDirectory()) {
    throw new Error(`Target path is not a directory: ${resolvedTarget}`);
  }

  const entries = await fs.promises.readdir(resolvedTarget);
  if (entries.length === 0) {
    return null;
  }

  const tempDir = path.resolve(options.tempDir || os.tmpdir());
  await fs.promises.mkdir(tempDir, { recursive: true });

  const timestamp = options.timestamp || formatBackupTimestamp();
  const snapshotName = `pre-restore-snapshot-${timestamp}.tar.gz`;
  const snapshotPath = path.join(tempDir, snapshotName);

  await tar.c(
    {
      gzip: true,
      cwd: resolvedTarget,
      portable: true,
      file: snapshotPath,
    },
    entries
  );

  const snapshotStat = await fs.promises.stat(snapshotPath);
  return {
    snapshotPath,
    snapshotName,
    size: snapshotStat.size,
    timestamp,
    entryCount: entries.length,
  };
}
