import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerProcessCleanup } from './archiver.js';

/**
 * Default process concurrency lock filename.
 */
export const DEFAULT_LOCK_FILENAME = 'hermes-backup.lock';

/**
 * PID-based mutual exclusion lock for process concurrency management.
 * Creates an atomic lock file with 'wx' flag containing the active process PID.
 * Detects stale locks from terminated processes via signal 0 checks and reclaims them.
 */
export class ProcessLock {
  /**
   * @param {string} [lockFilePath] - Absolute path to the lock file
   */
  constructor(lockFilePath) {
    this.lockFilePath = path.resolve(lockFilePath || path.join(os.tmpdir(), DEFAULT_LOCK_FILENAME));
    this.isLocked = false;
    this._unregisterCleanup = null;
  }

  /**
   * Acquire the process lock atomically.
   * If a lock already exists, tests if the owning PID is alive.
   * If alive, aborts with an error. If dead (stale lock), removes and reacquires.
   *
   * @returns {Promise<boolean>} True when lock is acquired
   * @throws {Error} When another active process holds the lock
   */
  async acquire() {
    const pid = process.pid;

    // Ensure parent directory exists before attempting atomic file creation
    const lockDir = path.dirname(this.lockFilePath);
    try {
      await fs.promises.mkdir(lockDir, { recursive: true });
    } catch {
      // Ignore if directory already exists
    }

    try {
      await fs.promises.writeFile(this.lockFilePath, String(pid), {
        flag: 'wx',
        mode: 0o600,
      });
      this.isLocked = true;

      // Register exit hook for abnormal termination
      try {
        this._unregisterCleanup = registerProcessCleanup(() => {
          this.releaseSync();
        });
      } catch {
        // Suppress cleanup registration errors in environments without process hooks
      }

      return true;
    } catch (err) {
      if (err.code === 'EEXIST') {
        let content;
        try {
          content = await fs.promises.readFile(this.lockFilePath, 'utf8');
        } catch (readErr) {
          if (readErr.code === 'ENOENT') {
            // Lock was released between writeFile and readFile, retry acquisition
            return this.acquire();
          }
          throw new Error(`Unable to read active lock file: ${readErr.message}`);
        }

        const existingPid = parseInt(content.trim(), 10);

        if (!isNaN(existingPid) && existingPid > 0) {
          let isAlive = false;
          try {
            // Signal 0 checks process existence without killing it
            process.kill(existingPid, 0);
            isAlive = true;
          } catch (killErr) {
            if (killErr.code === 'ESRCH') {
              // Process no longer exists (stale lock)
              isAlive = false;
            } else if (killErr.code === 'EPERM') {
              // Process exists but belongs to a different user/privilege
              isAlive = true;
            } else {
              throw killErr;
            }
          }

          if (isAlive) {
            throw new Error(
              `Backup operation already active on PID ${existingPid}. Aborting execution.`
            );
          }

          // Process is confirmed dead; clean stale lock file and reacquire
          try {
            await fs.promises.unlink(this.lockFilePath);
          } catch (unlinkErr) {
            if (unlinkErr.code !== 'ENOENT') {
              throw unlinkErr;
            }
          }

          return this.acquire();
        } else {
          // Lock file content is empty or invalid non-numeric data (stale/corrupted)
          try {
            await fs.promises.unlink(this.lockFilePath);
          } catch (unlinkErr) {
            if (unlinkErr.code !== 'ENOENT') {
              throw unlinkErr;
            }
          }

          return this.acquire();
        }
      }

      throw err;
    }
  }

  /**
   * Release the process lock and delete the lock file.
   * Guards against removing files not owned by the current process.
   *
   * @returns {Promise<void>}
   */
  async release() {
    if (this._unregisterCleanup) {
      try {
        this._unregisterCleanup();
      } catch {
        // Suppress unregister error
      }
      this._unregisterCleanup = null;
    }

    if (this.isLocked) {
      try {
        let shouldUnlink = true;
        try {
          const content = await fs.promises.readFile(this.lockFilePath, 'utf8');
          const recordedPid = parseInt(content.trim(), 10);
          if (!isNaN(recordedPid) && recordedPid !== process.pid) {
            shouldUnlink = false;
          }
        } catch (readErr) {
          if (readErr.code === 'ENOENT') {
            shouldUnlink = false;
          }
        }

        if (shouldUnlink) {
          await fs.promises.unlink(this.lockFilePath);
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw err;
        }
      } finally {
        this.isLocked = false;
      }
    }
  }

  /**
   * Synchronous lock release for process exit and signal handlers.
   */
  releaseSync() {
    if (this._unregisterCleanup) {
      try {
        this._unregisterCleanup();
      } catch {
        // Suppress unregister error
      }
      this._unregisterCleanup = null;
    }

    if (this.isLocked) {
      try {
        if (fs.existsSync(this.lockFilePath)) {
          let shouldUnlink = true;
          try {
            const content = fs.readFileSync(this.lockFilePath, 'utf8');
            const recordedPid = parseInt(content.trim(), 10);
            if (!isNaN(recordedPid) && recordedPid !== process.pid) {
              shouldUnlink = false;
            }
          } catch {
            // Suppress read error in sync handler
          }

          if (shouldUnlink) {
            fs.unlinkSync(this.lockFilePath);
          }
        }
      } catch {
        // Suppress sync release errors during emergency exit
      } finally {
        this.isLocked = false;
      }
    }
  }
}

/**
 * Execute an asynchronous action within a guarded process lock lifecycle.
 * Automatically acquires and releases the lock file.
 *
 * @template T
 * @param {string} lockFilePath - Absolute path to lock file
 * @param {(lock: ProcessLock) => Promise<T>} actionFn - Async function to run while holding lock
 * @returns {Promise<T>} Result of actionFn
 */
export async function withProcessLock(lockFilePath, actionFn) {
  const lock = new ProcessLock(lockFilePath);
  await lock.acquire();
  try {
    return await actionFn(lock);
  } finally {
    await lock.release();
  }
}
