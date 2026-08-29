import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  MANDATORY_WHITELIST,
  RECOMMENDED_WHITELIST,
  DEFAULT_WHITELIST,
  normalizePath,
  isExcluded,
  getSqliteCompanionPaths,
  formatBackupTimestamp,
  resolveBackupPaths,
  resolveBackupPathsSync,
  createStagingDirectory,
  cleanStagingDirectory,
  stageBackup,
} from '../src/stager.js';

describe('Include-First Path Resolver & SQLite WAL Stager', () => {
  let testTempDir;
  let mockHermesHome;

  beforeEach(async () => {
    testTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hermes-test-stager-'));
    mockHermesHome = path.join(testTempDir, 'mock_hermes_home');
    await fs.promises.mkdir(mockHermesHome, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(testTempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error in test
    }
  });

  describe('Path Normalization & Exclusion Rules', () => {
    it('should normalize Windows and POSIX path separators', () => {
      assert.equal(normalizePath('skills\\my_skill\\file.js'), 'skills/my_skill/file.js');
      assert.equal(normalizePath('/config.yaml/'), 'config.yaml');
      assert.equal(normalizePath('///memories/USER.md'), 'memories/USER.md');
      assert.equal(normalizePath(''), '');
      assert.equal(normalizePath(null), '');
    });

    it('should identify safety-net excluded paths accurately', () => {
      // state.db
      assert.equal(isExcluded('state.db'), true);
      assert.equal(isExcluded('state.db-wal'), true);
      assert.equal(isExcluded('state.db-shm'), true);
      assert.equal(isExcluded('state.db-journal'), true);

      // hermes-agent/
      assert.equal(isExcluded('hermes-agent/index.js'), true);
      assert.equal(isExcluded('hermes-agent/package.json'), true);

      // backups/*.zip vs backups/mnemosyne/
      assert.equal(isExcluded('backups/hermes-old.zip'), true);
      assert.equal(isExcluded('backups/2026-08-01.zip'), true);
      assert.equal(isExcluded('backups/mnemosyne/snapshot.db'), false);
      assert.equal(isExcluded('backups/mnemosyne/manifest.json'), false);

      // mnemosyne/models and mnemosyne-venv
      assert.equal(isExcluded('mnemosyne/models/llama-3.gguf'), true);
      assert.equal(isExcluded('mnemosyne-venv/bin/python'), true);

      // node/ and bin/
      assert.equal(isExcluded('node/bin/node'), true);
      assert.equal(isExcluded('bin/hermes'), true);

      // cache/ and logs/
      assert.equal(isExcluded('cache/temp.bin'), true);
      assert.equal(isExcluded('skills/my_skill/cache/temp.dat'), true);
      assert.equal(isExcluded('skills/my_skill/__pycache__/mod.pyc'), true);
      assert.equal(isExcluded('logs/output.log'), true);
      assert.equal(isExcluded('mnemosyne/logs/agent.log'), true);

      // Git & OS metadata
      assert.equal(isExcluded('skills/my_skill/.git/config'), true);
      assert.equal(isExcluded('skills/my_skill/.DS_Store'), true);
      assert.equal(isExcluded('memories/Thumbs.db'), true);

      // Transient cron and lock files
      assert.equal(isExcluded('cron/run.lock'), true);
      assert.equal(isExcluded('cron/.fire-schedule-1'), true);
      assert.equal(isExcluded('cron/ticker_heartbeat'), true);
      assert.equal(isExcluded('cron/ticker_last_success'), true);

      // Valid whitelisted files that MUST NOT be excluded
      assert.equal(isExcluded('mnemosyne/data/mnemosyne.db'), false);
      assert.equal(isExcluded('mnemosyne/data/mnemosyne.db-wal'), false);
      assert.equal(isExcluded('memories/MEMORY.md'), false);
      assert.equal(isExcluded('config.yaml'), false);
      assert.equal(isExcluded('.env'), false);
      assert.equal(isExcluded('auth.json'), false);
      assert.equal(isExcluded('cron/jobs.json'), false);
      assert.equal(isExcluded('cron/executions.db'), false);
      assert.equal(isExcluded('cron/notepad.db'), false);
      assert.equal(isExcluded('kanban.db'), false);
      assert.equal(isExcluded('SOUL.md'), false);
      assert.equal(isExcluded('.skills_prompt_snapshot.json'), false);
    });

    it('should generate SQLite companion paths for .db files', () => {
      const companions = getSqliteCompanionPaths('mnemosyne/data/mnemosyne.db');
      assert.deepEqual(companions, [
        'mnemosyne/data/mnemosyne.db-wal',
        'mnemosyne/data/mnemosyne.db-shm',
        'mnemosyne/data/mnemosyne.db-journal',
      ]);

      assert.deepEqual(getSqliteCompanionPaths('config.yaml'), []);
      assert.deepEqual(getSqliteCompanionPaths('MEMORIES.md'), []);
    });

    it('should format backup timestamp correctly', () => {
      const fixedDate = new Date(2026, 7, 29, 9, 45, 30); // August 29, 2026 09:45:30
      const formatted = formatBackupTimestamp(fixedDate);
      assert.equal(formatted, '2026-08-29_094530');
    });
  });

  describe('Path Resolution & Whitelist Discovery', () => {
    it('should throw error when HERMES_HOME does not exist or is a file', async () => {
      const nonExistent = path.join(testTempDir, 'does-not-exist');
      await assert.rejects(
        () => resolveBackupPaths(nonExistent),
        (err) => err.message.includes('HERMES_HOME directory does not exist')
      );

      const filePath = path.join(testTempDir, 'some-file.txt');
      await fs.promises.writeFile(filePath, 'hello');
      await assert.rejects(
        () => resolveBackupPaths(filePath),
        (err) => err.message.includes('HERMES_HOME is not a directory')
      );
    });

    it('should discover all whitelisted files and ignore non-whitelisted or blacklisted items', async () => {
      // Create Priority 1 files
      await fs.promises.mkdir(path.join(mockHermesHome, 'mnemosyne/data'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'mnemosyne/data/mnemosyne.db'), 'sqlite-data');
      await fs.promises.writeFile(path.join(mockHermesHome, 'mnemosyne/data/mnemosyne.db-wal'), 'sqlite-wal');

      await fs.promises.mkdir(path.join(mockHermesHome, 'memories'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'memories/MEMORY.md'), '# Memory');
      await fs.promises.writeFile(path.join(mockHermesHome, 'memories/USER.md'), '# User');

      await fs.promises.writeFile(path.join(mockHermesHome, 'config.yaml'), 'model: gpt-4');
      await fs.promises.writeFile(path.join(mockHermesHome, '.env'), 'SECRET_KEY=12345');
      await fs.promises.writeFile(path.join(mockHermesHome, 'auth.json'), '{}');
      await fs.promises.writeFile(path.join(mockHermesHome, 'google_token.json'), '{}');
      await fs.promises.writeFile(path.join(mockHermesHome, 'google_client_secret.json'), '{}');

      await fs.promises.mkdir(path.join(mockHermesHome, 'skills/weather'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'skills/weather/SKILL.md'), 'weather skill');

      await fs.promises.mkdir(path.join(mockHermesHome, 'scripts'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'scripts/health.sh'), '#!/bin/bash');

      await fs.promises.mkdir(path.join(mockHermesHome, 'cron'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'cron/jobs.json'), '[]');
      await fs.promises.writeFile(path.join(mockHermesHome, 'cron/executions.db'), 'exec-db');
      await fs.promises.writeFile(path.join(mockHermesHome, 'cron/executions.db-wal'), 'exec-wal');
      await fs.promises.writeFile(path.join(mockHermesHome, 'cron/executions.db-shm'), 'exec-shm');
      await fs.promises.writeFile(path.join(mockHermesHome, 'cron/notepad.db'), 'notepad-db');
      await fs.promises.writeFile(path.join(mockHermesHome, 'cron/usage_audit.jsonl'), 'log line');

      // Create transient/blacklisted files inside cron
      await fs.promises.writeFile(path.join(mockHermesHome, 'cron/job.lock'), 'lock');
      await fs.promises.writeFile(path.join(mockHermesHome, 'cron/.fire-job-1'), 'fire');
      await fs.promises.writeFile(path.join(mockHermesHome, 'cron/ticker_heartbeat'), '123');
      await fs.promises.writeFile(path.join(mockHermesHome, 'cron/ticker_last_success'), '456');

      // Create Priority 2 files
      await fs.promises.mkdir(path.join(mockHermesHome, 'plugins/notifier'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'plugins/notifier/index.js'), 'plugin');
      await fs.promises.writeFile(path.join(mockHermesHome, 'kanban.db'), 'kanban-db');
      await fs.promises.writeFile(path.join(mockHermesHome, 'SOUL.md'), '# Soul');
      await fs.promises.mkdir(path.join(mockHermesHome, 'sessions'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'sessions/session1.json'), '{}');
      await fs.promises.mkdir(path.join(mockHermesHome, 'backups/mnemosyne'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'backups/mnemosyne/snap1.db'), 'snap');
      await fs.promises.writeFile(path.join(mockHermesHome, 'context_length_cache.yaml'), 'cache');
      await fs.promises.writeFile(path.join(mockHermesHome, 'channel_directory.json'), '{}');
      await fs.promises.writeFile(path.join(mockHermesHome, '.skills_prompt_snapshot.json'), '{}');

      // Create Blacklisted non-whitelisted files (Must be ignored)
      await fs.promises.writeFile(path.join(mockHermesHome, 'state.db'), 'state-data');
      await fs.promises.writeFile(path.join(mockHermesHome, 'state.db-wal'), 'state-wal');
      await fs.promises.mkdir(path.join(mockHermesHome, 'hermes-agent'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'hermes-agent/app.js'), 'heavy agent');
      await fs.promises.writeFile(path.join(mockHermesHome, 'backups/backup-2026.zip'), 'zip archive');
      await fs.promises.mkdir(path.join(mockHermesHome, 'mnemosyne/models'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'mnemosyne/models/llama.gguf'), 'model data');
      await fs.promises.mkdir(path.join(mockHermesHome, 'mnemosyne-venv/bin'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'mnemosyne-venv/bin/python'), 'python');
      await fs.promises.mkdir(path.join(mockHermesHome, 'node/bin'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'node/bin/node'), 'binary');
      await fs.promises.mkdir(path.join(mockHermesHome, 'logs'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'logs/app.log'), 'logs');
      await fs.promises.mkdir(path.join(mockHermesHome, 'cache'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'cache/data.tmp'), 'temp');

      // Resolve paths
      const resolved = await resolveBackupPaths(mockHermesHome);
      const relativePaths = resolved.map((r) => r.relativePath);

      // Verify inclusions
      assert.ok(relativePaths.includes('mnemosyne/data/mnemosyne.db'));
      assert.ok(relativePaths.includes('mnemosyne/data/mnemosyne.db-wal'));
      assert.ok(relativePaths.includes('memories/MEMORY.md'));
      assert.ok(relativePaths.includes('memories/USER.md'));
      assert.ok(relativePaths.includes('config.yaml'));
      assert.ok(relativePaths.includes('.env'));
      assert.ok(relativePaths.includes('auth.json'));
      assert.ok(relativePaths.includes('google_token.json'));
      assert.ok(relativePaths.includes('google_client_secret.json'));
      assert.ok(relativePaths.includes('skills/weather/SKILL.md'));
      assert.ok(relativePaths.includes('scripts/health.sh'));
      assert.ok(relativePaths.includes('cron/jobs.json'));
      assert.ok(relativePaths.includes('cron/executions.db'));
      assert.ok(relativePaths.includes('cron/executions.db-wal'));
      assert.ok(relativePaths.includes('cron/executions.db-shm'));
      assert.ok(relativePaths.includes('cron/notepad.db'));
      assert.ok(relativePaths.includes('cron/usage_audit.jsonl'));
      assert.ok(relativePaths.includes('plugins/notifier/index.js'));
      assert.ok(relativePaths.includes('kanban.db'));
      assert.ok(relativePaths.includes('SOUL.md'));
      assert.ok(relativePaths.includes('sessions/session1.json'));
      assert.ok(relativePaths.includes('backups/mnemosyne/snap1.db'));
      assert.ok(relativePaths.includes('context_length_cache.yaml'));
      assert.ok(relativePaths.includes('channel_directory.json'));
      assert.ok(relativePaths.includes('.skills_prompt_snapshot.json'));

      // Verify exclusions
      assert.ok(!relativePaths.includes('cron/job.lock'));
      assert.ok(!relativePaths.includes('cron/.fire-job-1'));
      assert.ok(!relativePaths.includes('cron/ticker_heartbeat'));
      assert.ok(!relativePaths.includes('cron/ticker_last_success'));
      assert.ok(!relativePaths.includes('state.db'));
      assert.ok(!relativePaths.includes('state.db-wal'));
      assert.ok(!relativePaths.includes('hermes-agent/app.js'));
      assert.ok(!relativePaths.includes('backups/backup-2026.zip'));
      assert.ok(!relativePaths.includes('mnemosyne/models/llama.gguf'));
      assert.ok(!relativePaths.includes('mnemosyne-venv/bin/python'));
      assert.ok(!relativePaths.includes('node/bin/node'));
      assert.ok(!relativePaths.includes('logs/app.log'));
      assert.ok(!relativePaths.includes('cache/data.tmp'));
    });

    it('should handle circular symlinks safely without entering infinite loop', async () => {
      const skillsDir = path.join(mockHermesHome, 'skills/loop_skill');
      await fs.promises.mkdir(skillsDir, { recursive: true });
      await fs.promises.writeFile(path.join(skillsDir, 'SKILL.md'), '# Skill');

      // Create a cyclic symlink pointing back to skillsDir
      try {
        await fs.promises.symlink(skillsDir, path.join(skillsDir, 'circular_link'), 'dir');
      } catch {
        // In environments where symlink creation is restricted, skip symlink creation
      }

      const resolved = await resolveBackupPaths(mockHermesHome);
      const relativePaths = resolved.map((r) => r.relativePath);
      assert.ok(relativePaths.includes('skills/loop_skill/SKILL.md'));
    });

    it('should work synchronously with resolveBackupPathsSync matching async output', async () => {
      await fs.promises.writeFile(path.join(mockHermesHome, 'config.yaml'), 'test');
      await fs.promises.mkdir(path.join(mockHermesHome, 'memories'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'memories/MEMORY.md'), 'test-memory');

      const asyncRes = await resolveBackupPaths(mockHermesHome);
      const syncRes = resolveBackupPathsSync(mockHermesHome);

      assert.deepEqual(asyncRes, syncRes);
    });
  });

  describe('Staging Directory Management & Staging Engine', () => {
    it('should create an isolated staging directory in tempDir and clean it up safely', async () => {
      const stagingDir = await createStagingDirectory(testTempDir);
      assert.ok(fs.existsSync(stagingDir));
      assert.ok(stagingDir.includes('hermes-backup-'));

      const cleaned = await cleanStagingDirectory(stagingDir, testTempDir);
      assert.equal(cleaned, true);
      assert.ok(!fs.existsSync(stagingDir));
    });

    it('should prevent cleaning unsafe or root directories', async () => {
      await assert.rejects(
        () => cleanStagingDirectory('/', testTempDir),
        (err) => err.message.includes('Refusing to clean potentially unsafe')
      );

      await assert.rejects(
        () => cleanStagingDirectory(testTempDir, testTempDir),
        (err) => err.message.includes('Refusing to clean potentially unsafe')
      );

      await assert.rejects(
        () => cleanStagingDirectory(os.homedir(), testTempDir),
        (err) => err.message.includes('Refusing to clean potentially unsafe')
      );
    });

    it('should perform dry-run staging without writing files to disk', async () => {
      await fs.promises.writeFile(path.join(mockHermesHome, 'config.yaml'), 'sample config content');
      await fs.promises.mkdir(path.join(mockHermesHome, 'skills/test_skill'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'skills/test_skill/SKILL.md'), 'skill data');

      const result = await stageBackup(mockHermesHome, {
        tempDir: testTempDir,
        dryRun: true,
      });

      assert.equal(result.dryRun, true);
      assert.equal(result.stagingDir, null);
      assert.equal(result.fileCount, 2);
      assert.ok(result.totalBytes > 0);
      assert.equal(result.stagedFiles.length, 2);
      assert.equal(result.stagedFiles[0].destPath, null);
    });

    it('should stage files preserving relative hierarchy and calculate file statistics', async () => {
      await fs.promises.writeFile(path.join(mockHermesHome, 'config.yaml'), 'config-data-123');
      await fs.promises.mkdir(path.join(mockHermesHome, 'memories'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'memories/MEMORY.md'), '# Memory Profile');

      const result = await stageBackup(mockHermesHome, {
        tempDir: testTempDir,
      });

      assert.equal(result.dryRun, false);
      assert.ok(result.stagingDir);
      assert.ok(fs.existsSync(result.stagingDir));
      assert.equal(result.fileCount, 2);

      // Verify files in staging dir
      const stagedConfig = path.join(result.stagingDir, 'config.yaml');
      const stagedMemory = path.join(result.stagingDir, 'memories/MEMORY.md');

      assert.ok(fs.existsSync(stagedConfig));
      assert.ok(fs.existsSync(stagedMemory));
      assert.equal(await fs.promises.readFile(stagedConfig, 'utf8'), 'config-data-123');
      assert.equal(await fs.promises.readFile(stagedMemory, 'utf8'), '# Memory Profile');

      // Cleanup
      await cleanStagingDirectory(result.stagingDir, testTempDir);
      assert.ok(!fs.existsSync(result.stagingDir));
    });
  });

  describe('Generic SQLite WAL Triad Integrity Test', () => {
    it('should stage SQLite database with WAL and SHM files and maintain integrity', async () => {
      const dbDir = path.join(mockHermesHome, 'mnemosyne/data');
      await fs.promises.mkdir(dbDir, { recursive: true });
      const dbPath = path.join(dbDir, 'mnemosyne.db');

      // Create a real SQLite database in WAL mode using sqlite3 CLI
      execFileSync('sqlite3', [
        dbPath,
        `
        PRAGMA journal_mode = WAL;
        CREATE TABLE agent_memories (id INTEGER PRIMARY KEY, key TEXT, value TEXT);
        INSERT INTO agent_memories (key, value) VALUES ('user_goal', 'Keep state safe');
        INSERT INTO agent_memories (key, value) VALUES ('agent_soul', 'Helpful and precise');
        `,
      ]);

      // Check if .db-wal or .db-shm exist or simulate active WAL
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;

      if (!fs.existsSync(walPath)) {
        await fs.promises.writeFile(walPath, 'simulated-wal-content');
      }
      if (!fs.existsSync(shmPath)) {
        await fs.promises.writeFile(shmPath, 'simulated-shm-content');
      }

      // Also create another SQLite DB in cron/executions.db with its own companion files
      const cronDir = path.join(mockHermesHome, 'cron');
      await fs.promises.mkdir(cronDir, { recursive: true });
      const cronDbPath = path.join(cronDir, 'executions.db');
      execFileSync('sqlite3', [
        cronDbPath,
        `
        PRAGMA journal_mode = WAL;
        CREATE TABLE task_runs (id INTEGER PRIMARY KEY, job_name TEXT, status TEXT);
        INSERT INTO task_runs (job_name, status) VALUES ('daily_sync', 'success');
        `,
      ]);

      // Stage the backup
      const stageResult = await stageBackup(mockHermesHome, { tempDir: testTempDir });
      assert.ok(stageResult.stagingDir);

      const stagedDb = path.join(stageResult.stagingDir, 'mnemosyne/data/mnemosyne.db');
      assert.ok(fs.existsSync(stagedDb));

      const stagedCronDb = path.join(stageResult.stagingDir, 'cron/executions.db');
      assert.ok(fs.existsSync(stagedCronDb));

      // Run SQLite integrity check on staged copies
      const integrityCheck1 = execFileSync('sqlite3', [stagedDb, 'PRAGMA integrity_check;'], {
        encoding: 'utf8',
      }).trim();
      assert.equal(integrityCheck1, 'ok');

      const integrityCheck2 = execFileSync('sqlite3', [stagedCronDb, 'PRAGMA integrity_check;'], {
        encoding: 'utf8',
      }).trim();
      assert.equal(integrityCheck2, 'ok');

      // Verify records are queryable
      const queryResult1 = execFileSync(
        'sqlite3',
        [stagedDb, 'SELECT key, value FROM agent_memories ORDER BY id;'],
        { encoding: 'utf8' }
      ).trim();
      assert.ok(queryResult1.includes('user_goal|Keep state safe'));
      assert.ok(queryResult1.includes('agent_soul|Helpful and precise'));

      const queryResult2 = execFileSync(
        'sqlite3',
        [stagedCronDb, 'SELECT job_name, status FROM task_runs;'],
        { encoding: 'utf8' }
      ).trim();
      assert.ok(queryResult2.includes('daily_sync|success'));

      // Clean staging
      await cleanStagingDirectory(stageResult.stagingDir, testTempDir);
    });
  });
});
