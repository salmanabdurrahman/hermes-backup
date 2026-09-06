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
  isPathWithinBase,
  isPathWithinBaseSync,
  resolveBackupPaths,
  resolveBackupPathsSync,
  createStagingDirectory,
  cleanStagingDirectory,
  stageLiveSqliteDatabase,
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
      assert.equal(isExcluded('state.db'), false);
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

      // skills/.hub/ internal registry cache
      assert.equal(isExcluded('skills/.hub/index-cache/hermes-index.json'), true);
      assert.equal(isExcluded('skills/.hub/scan-cache/scan.json'), true);
      assert.equal(isExcluded('skills/.hub/lock.json'), true);
      assert.equal(isExcluded('skills/.hub/audit.log'), true);

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
      assert.deepEqual(getSqliteCompanionPaths('state.db'), []);
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

      // skills/.hub internal registry cache (must be excluded)
      await fs.promises.mkdir(path.join(mockHermesHome, 'skills/.hub/index-cache'), { recursive: true });
      await fs.promises.writeFile(path.join(mockHermesHome, 'skills/.hub/index-cache/hermes-index.json'), '{}');
      await fs.promises.writeFile(path.join(mockHermesHome, 'skills/.hub/lock.json'), '{}');

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
      assert.ok(relativePaths.includes('state.db'));

      // Verify exclusions
      assert.ok(!relativePaths.includes('cron/job.lock'));
      assert.ok(!relativePaths.includes('cron/.fire-job-1'));
      assert.ok(!relativePaths.includes('cron/ticker_heartbeat'));
      assert.ok(!relativePaths.includes('cron/ticker_last_success'));
      assert.ok(!relativePaths.includes('state.db-wal'));
      assert.ok(!relativePaths.includes('hermes-agent/app.js'));
      assert.ok(!relativePaths.includes('backups/backup-2026.zip'));
      assert.ok(!relativePaths.includes('mnemosyne/models/llama.gguf'));
      assert.ok(!relativePaths.includes('mnemosyne-venv/bin/python'));
      assert.ok(!relativePaths.includes('node/bin/node'));
      assert.ok(!relativePaths.includes('logs/app.log'));
      assert.ok(!relativePaths.includes('cache/data.tmp'));
      assert.ok(!relativePaths.includes('skills/.hub/index-cache/hermes-index.json'));
      assert.ok(!relativePaths.includes('skills/.hub/lock.json'));
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

  describe('Path Boundary Validation & Symlink Traversal Mitigation', () => {
    it('should validate whether paths are strictly within base directory', async () => {
      const internalFile = path.join(mockHermesHome, 'config.yaml');
      await fs.promises.writeFile(internalFile, 'test');

      const internalSubdir = path.join(mockHermesHome, 'skills/demo');
      await fs.promises.mkdir(internalSubdir, { recursive: true });
      const nestedFile = path.join(internalSubdir, 'SKILL.md');
      await fs.promises.writeFile(nestedFile, 'content');

      // Internal paths return true
      assert.equal(await isPathWithinBase(internalFile, mockHermesHome), true);
      assert.equal(await isPathWithinBase(nestedFile, mockHermesHome), true);
      assert.equal(await isPathWithinBase(mockHermesHome, mockHermesHome), true);
      assert.equal(isPathWithinBaseSync(internalFile, mockHermesHome), true);
      assert.equal(isPathWithinBaseSync(nestedFile, mockHermesHome), true);
      assert.equal(isPathWithinBaseSync(mockHermesHome, mockHermesHome), true);

      // External system path returns false
      assert.equal(await isPathWithinBase('/etc/passwd', mockHermesHome), false);
      assert.equal(isPathWithinBaseSync('/etc/passwd', mockHermesHome), false);

      // Parent directory traversal returns false
      const parentDir = path.dirname(mockHermesHome);
      assert.equal(await isPathWithinBase(parentDir, mockHermesHome), false);
      assert.equal(isPathWithinBaseSync(parentDir, mockHermesHome), false);

      // Non-existent target path returns false
      const nonExistent = path.join(mockHermesHome, 'does-not-exist.txt');
      assert.equal(await isPathWithinBase(nonExistent, mockHermesHome), false);
      assert.equal(isPathWithinBaseSync(nonExistent, mockHermesHome), false);
    });

    it('should reject symlinks in whitelist directories pointing to external system files', async () => {
      const skillsDir = path.join(mockHermesHome, 'skills/malicious_skill');
      await fs.promises.mkdir(skillsDir, { recursive: true });
      await fs.promises.writeFile(path.join(skillsDir, 'safe_file.txt'), 'safe');

      // Create symlink pointing to /etc/passwd
      const passwdSymlink = path.join(skillsDir, 'passwd_link');
      try {
        await fs.promises.symlink('/etc/passwd', passwdSymlink);
      } catch {
        // Skip if environment restricts symlinks
      }

      // Create external dummy file outside HERMES_HOME
      const externalSecretFile = path.join(testTempDir, 'external_secret.env');
      await fs.promises.writeFile(externalSecretFile, 'DATABASE_PASSWORD=secret');

      const secretSymlink = path.join(skillsDir, 'stolen_secret.env');
      try {
        await fs.promises.symlink(externalSecretFile, secretSymlink);
      } catch {
        // Skip if environment restricts symlinks
      }

      const resolved = await resolveBackupPaths(mockHermesHome);
      const relativePaths = resolved.map((r) => r.relativePath);

      // Safe file must be included
      assert.ok(relativePaths.includes('skills/malicious_skill/safe_file.txt'));

      // External symlinks must be strictly excluded
      assert.ok(!relativePaths.includes('skills/malicious_skill/passwd_link'));
      assert.ok(!relativePaths.includes('skills/malicious_skill/stolen_secret.env'));

      // Synchronous resolver must match behavior
      const resolvedSync = resolveBackupPathsSync(mockHermesHome);
      const relativePathsSync = resolvedSync.map((r) => r.relativePath);
      assert.ok(relativePathsSync.includes('skills/malicious_skill/safe_file.txt'));
      assert.ok(!relativePathsSync.includes('skills/malicious_skill/passwd_link'));
      assert.ok(!relativePathsSync.includes('skills/malicious_skill/stolen_secret.env'));
    });

    it('should reject symlinks in plugins pointing to external directories', async () => {
      const pluginsDir = path.join(mockHermesHome, 'plugins/custom_plugin');
      await fs.promises.mkdir(pluginsDir, { recursive: true });
      await fs.promises.writeFile(path.join(pluginsDir, 'plugin.json'), '{}');

      // Create external directory with files outside HERMES_HOME
      const externalDir = path.join(testTempDir, 'external_system_dir');
      await fs.promises.mkdir(externalDir, { recursive: true });
      await fs.promises.writeFile(path.join(externalDir, 'sensitive.txt'), 'sensitive data');

      // Create symlink pointing to external directory
      const externalDirSymlink = path.join(pluginsDir, 'linked_external_dir');
      try {
        await fs.promises.symlink(externalDir, externalDirSymlink, 'dir');
      } catch {
        // Skip if symlinks restricted
      }

      const resolved = await resolveBackupPaths(mockHermesHome);
      const relativePaths = resolved.map((r) => r.relativePath);

      assert.ok(relativePaths.includes('plugins/custom_plugin/plugin.json'));
      assert.ok(!relativePaths.some((p) => p.includes('linked_external_dir')));
      assert.ok(!relativePaths.some((p) => p.includes('sensitive.txt')));
    });

    it('should safely omit broken or dangling symlinks without throwing', async () => {
      const skillsDir = path.join(mockHermesHome, 'skills/broken_links');
      await fs.promises.mkdir(skillsDir, { recursive: true });
      await fs.promises.writeFile(path.join(skillsDir, 'valid.txt'), 'valid');

      const brokenLink = path.join(skillsDir, 'dangling_link.txt');
      try {
        await fs.promises.symlink(path.join(mockHermesHome, 'missing_target.txt'), brokenLink);
      } catch {
        // Skip if symlinks restricted
      }

      const resolved = await resolveBackupPaths(mockHermesHome);
      const relativePaths = resolved.map((r) => r.relativePath);

      assert.ok(relativePaths.includes('skills/broken_links/valid.txt'));
      assert.ok(!relativePaths.includes('skills/broken_links/dangling_link.txt'));
    });

    it('should resolve and stage legitimate internal symlinks within HERMES_HOME', async () => {
      // Create legitimate internal target file
      await fs.promises.mkdir(path.join(mockHermesHome, 'memories'), { recursive: true });
      const targetFile = path.join(mockHermesHome, 'memories/SHARED_NOTE.md');
      await fs.promises.writeFile(targetFile, '# Shared Internal Knowledge');

      // Create internal symlink inside skills referencing memories
      const skillsDir = path.join(mockHermesHome, 'skills/internal_ref_skill');
      await fs.promises.mkdir(skillsDir, { recursive: true });

      const internalLink = path.join(skillsDir, 'REFERENCE.md');
      try {
        await fs.promises.symlink(targetFile, internalLink);
      } catch {
        // Skip if symlinks restricted
      }

      const resolved = await resolveBackupPaths(mockHermesHome);
      const relativePaths = resolved.map((r) => r.relativePath);

      assert.ok(relativePaths.includes('memories/SHARED_NOTE.md'));
      assert.ok(relativePaths.includes('skills/internal_ref_skill/REFERENCE.md'));

      // Test staging execution: verify staged content matches
      const stageResult = await stageBackup(mockHermesHome, { tempDir: testTempDir });
      assert.ok(stageResult.stagingDir);

      const stagedRef = path.join(stageResult.stagingDir, 'skills/internal_ref_skill/REFERENCE.md');
      assert.ok(fs.existsSync(stagedRef));
      assert.equal(
        await fs.promises.readFile(stagedRef, 'utf8'),
        '# Shared Internal Knowledge'
      );

      await cleanStagingDirectory(stageResult.stagingDir, testTempDir);
    });

    it('should prevent external symlink targets from being copied during staging', async () => {
      const skillsDir = path.join(mockHermesHome, 'skills/exfiltration_attempt');
      await fs.promises.mkdir(skillsDir, { recursive: true });
      await fs.promises.writeFile(path.join(skillsDir, 'legit.txt'), 'legit payload');

      // Create external file with private data
      const privateFile = path.join(testTempDir, 'host_secret_shadow');
      await fs.promises.writeFile(privateFile, 'root:$6$systempasswordhash');

      // Symlink inside skills pointing to external private file
      const linkPath = path.join(skillsDir, 'shadow_symlink');
      try {
        await fs.promises.symlink(privateFile, linkPath);
      } catch {
        // Skip if symlinks restricted
      }

      const stageResult = await stageBackup(mockHermesHome, { tempDir: testTempDir });
      assert.ok(stageResult.stagingDir);

      const stagedLegit = path.join(stageResult.stagingDir, 'skills/exfiltration_attempt/legit.txt');
      const stagedShadow = path.join(stageResult.stagingDir, 'skills/exfiltration_attempt/shadow_symlink');

      assert.ok(fs.existsSync(stagedLegit));
      assert.ok(!fs.existsSync(stagedShadow));

      await cleanStagingDirectory(stageResult.stagingDir, testTempDir);
    });

    it('should block relative symlinks that traverse above HERMES_HOME', async () => {
      const skillsDir = path.join(mockHermesHome, 'skills/relative_escape');
      await fs.promises.mkdir(skillsDir, { recursive: true });

      // Create external file in testTempDir
      const secretFile = path.join(testTempDir, 'escape_secret.key');
      await fs.promises.writeFile(secretFile, 'SUPER_SECRET_KEY');

      // Create relative symlink: ../../../escape_secret.key
      const relativeEscapeLink = path.join(skillsDir, 'relative_link');
      const relativeTarget = path.relative(skillsDir, secretFile);
      try {
        await fs.promises.symlink(relativeTarget, relativeEscapeLink);
      } catch {
        // Skip if symlinks restricted
      }

      const resolved = await resolveBackupPaths(mockHermesHome);
      const relativePaths = resolved.map((r) => r.relativePath);

      assert.ok(!relativePaths.includes('skills/relative_escape/relative_link'));

      const resolvedSync = resolveBackupPathsSync(mockHermesHome);
      const relativePathsSync = resolvedSync.map((r) => r.relativePath);
      assert.ok(!relativePathsSync.includes('skills/relative_escape/relative_link'));
    });

    it('should block chained symlinks that terminate outside HERMES_HOME', async () => {
      const skillsDir = path.join(mockHermesHome, 'skills/chained_escape');
      await fs.promises.mkdir(skillsDir, { recursive: true });

      // Create external file
      const externalTarget = path.join(testTempDir, 'deep_secret.txt');
      await fs.promises.writeFile(externalTarget, 'TOP_SECRET');

      // intermediate symlink in mockHermesHome
      const hop1 = path.join(skillsDir, 'hop1');
      const hop2 = path.join(skillsDir, 'hop2');

      try {
        await fs.promises.symlink(externalTarget, hop1);
        await fs.promises.symlink(hop1, hop2);
      } catch {
        // Skip if symlinks restricted
      }

      const resolved = await resolveBackupPaths(mockHermesHome);
      const relativePaths = resolved.map((r) => r.relativePath);

      assert.ok(!relativePaths.includes('skills/chained_escape/hop1'));
      assert.ok(!relativePaths.includes('skills/chained_escape/hop2'));
    });

    it('should block root whitelist items when configured as symlinks pointing outside HERMES_HOME', async () => {
      // Create external files
      const externalEnv = path.join(testTempDir, 'external_system.env');
      await fs.promises.writeFile(externalEnv, 'AWS_SECRET_KEY=external');

      // Make mockHermesHome/.env a symlink pointing to external file
      const envSymlink = path.join(mockHermesHome, '.env');
      try {
        await fs.promises.symlink(externalEnv, envSymlink);
      } catch {
        // Skip if symlinks restricted
      }

      const resolved = await resolveBackupPaths(mockHermesHome);
      const relativePaths = resolved.map((r) => r.relativePath);

      // Root .env symlink pointing outside must be excluded
      assert.ok(!relativePaths.includes('.env'));

      const resolvedSync = resolveBackupPathsSync(mockHermesHome);
      const relativePathsSync = resolvedSync.map((r) => r.relativePath);
      assert.ok(!relativePathsSync.includes('.env'));
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

    it('should stage state.db atomically via sqlite3 online backup without companion files', async () => {
      const stateDbPath = path.join(mockHermesHome, 'state.db');
      execFileSync('sqlite3', [
        stateDbPath,
        `
        PRAGMA journal_mode = WAL;
        CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT);
        CREATE TABLE messages (id INTEGER PRIMARY KEY, content TEXT);
        INSERT INTO sessions (id, model) VALUES ('sess_001', 'openai/gpt-5.6-luna');
        INSERT INTO messages (id, content) VALUES (1, 'Hello from Telegram');
        `,
      ]);

      // Create dummy WAL and SHM to ensure companions are excluded from staging
      await fs.promises.writeFile(`${stateDbPath}-wal`, 'active-wal-data');
      await fs.promises.writeFile(`${stateDbPath}-shm`, 'active-shm-data');

      const stageResult = await stageBackup(mockHermesHome, { tempDir: testTempDir });
      assert.ok(stageResult.stagingDir);

      const stagedStateDb = path.join(stageResult.stagingDir, 'state.db');
      assert.ok(fs.existsSync(stagedStateDb));

      // Companions must NOT be staged
      assert.ok(!fs.existsSync(path.join(stageResult.stagingDir, 'state.db-wal')));
      assert.ok(!fs.existsSync(path.join(stageResult.stagingDir, 'state.db-shm')));

      // Integrity of staged database must pass
      const integrityCheck = execFileSync('sqlite3', [stagedStateDb, 'PRAGMA integrity_check;'], {
        encoding: 'utf8',
      }).trim();
      assert.equal(integrityCheck, 'ok');

      // Verify data integrity
      const queryResult = execFileSync(
        'sqlite3',
        [stagedStateDb, 'SELECT s.model, m.content FROM sessions s JOIN messages m ON 1=1;'],
        { encoding: 'utf8' }
      ).trim();
      assert.ok(queryResult.includes('openai/gpt-5.6-luna|Hello from Telegram'));

      await cleanStagingDirectory(stageResult.stagingDir, testTempDir);
    });
  });

  describe('SQLite Live Database Staging & Error Handling', () => {
    it('should successfully backup live state.db using sqlite3 online backup (.bail on)', async () => {
      const sourceDb = path.join(mockHermesHome, 'state.db');
      const destDb = path.join(testTempDir, 'dest_state.db');

      execFileSync('sqlite3', [
        sourceDb,
        `
        PRAGMA journal_mode = WAL;
        CREATE TABLE settings (key TEXT PRIMARY KEY, val TEXT);
        INSERT INTO settings VALUES ('theme', 'dark');
        `,
      ]);

      await stageLiveSqliteDatabase(sourceDb, destDb);
      assert.ok(fs.existsSync(destDb));

      const integrity = execFileSync('sqlite3', [destDb, 'PRAGMA integrity_check;'], {
        encoding: 'utf8',
      }).trim();
      assert.equal(integrity, 'ok');

      const selectResult = execFileSync('sqlite3', [destDb, 'SELECT val FROM settings WHERE key="theme";'], {
        encoding: 'utf8',
      }).trim();
      assert.equal(selectResult, 'dark');
    });

    it('should fallback to copyFile with warning when sqlite3 CLI is missing (ENOENT)', async () => {
      const sourceDb = path.join(mockHermesHome, 'state.db');
      const destDb = path.join(testTempDir, 'fallback_dest.db');

      await fs.promises.writeFile(sourceDb, 'mock-sqlite-database-bytes-for-fallback');

      let warningLogged = null;
      await stageLiveSqliteDatabase(sourceDb, destDb, {
        sqliteBinary: 'nonexistent-sqlite3-bin-xyz',
        onWarning: (msg) => {
          warningLogged = msg;
        },
      });

      assert.ok(fs.existsSync(destDb));
      const content = await fs.promises.readFile(destDb, 'utf8');
      assert.equal(content, 'mock-sqlite-database-bytes-for-fallback');
      assert.ok(warningLogged);
      assert.match(warningLogged, /sqlite3 CLI not found on host/i);
    });

    it('should rethrow structured error when database is corrupt and NOT fall back to copyFile', async () => {
      const sourceDb = path.join(mockHermesHome, 'corrupt_state.db');
      const destDb = path.join(testTempDir, 'corrupt_dest.db');

      // Write corrupted garbage bytes that fail SQLite parsing
      await fs.promises.writeFile(sourceDb, 'CORRUPT_INVALID_SQLITE_HEADER_CONTENT');

      let warningCalled = false;
      await assert.rejects(
        async () => {
          await stageLiveSqliteDatabase(sourceDb, destDb, {
            onWarning: () => {
              warningCalled = true;
            },
          });
        },
        (err) => {
          assert.equal(warningCalled, false, 'Should not issue missing-binary warning on corruption');
          assert.match(err.message, /SQLite online backup failed for/);
          assert.ok(err.code);
          assert.notEqual(err.code, 'ENOENT');
          assert.ok(err.cause);
          return true;
        }
      );
    });

    it('should rethrow structured error on disk I/O, lock contention, or execution failure', async () => {
      const sourceDb = path.join(mockHermesHome, 'state.db');
      const destDb = path.join(testTempDir, 'dest.db');

      await fs.promises.writeFile(sourceDb, 'sample-content');

      const mockExecFileAsync = async () => {
        const error = new Error('database is locked (SQLITE_BUSY)');
        error.code = 'SQLITE_BUSY';
        throw error;
      };

      await assert.rejects(
        async () => {
          await stageLiveSqliteDatabase(sourceDb, destDb, {
            execFileAsync: mockExecFileAsync,
          });
        },
        (err) => {
          assert.match(err.message, /database is locked \(SQLITE_BUSY\)/);
          assert.equal(err.code, 'SQLITE_BUSY');
          assert.ok(err.cause);
          return true;
        }
      );
      assert.ok(!fs.existsSync(destDb));
    });

    it('should rethrow structured error when sqlite3 backup produces empty file from non-empty source', async () => {
      const sourceDb = path.join(mockHermesHome, 'state.db');
      const destDb = path.join(testTempDir, 'empty_dest.db');

      await fs.promises.writeFile(sourceDb, 'non-empty-source-data');

      const mockExecFileAsync = async () => {
        await fs.promises.writeFile(destDb, '');
      };

      await assert.rejects(
        async () => {
          await stageLiveSqliteDatabase(sourceDb, destDb, {
            execFileAsync: mockExecFileAsync,
          });
        },
        (err) => {
          assert.match(err.message, /produced an empty file \(0 bytes\) from a non-empty source/);
          assert.equal(err.code, 'SQLITE_BACKUP_FAILED');
          return true;
        }
      );
    });

    it('should fail stageBackup and clean up staging directory when state.db backup fails', async () => {
      const stateDbPath = path.join(mockHermesHome, 'state.db');
      await fs.promises.writeFile(stateDbPath, 'CORRUPTED_SQLITE_DATABASE_DATA');

      let caughtErr = null;
      try {
        await stageBackup(mockHermesHome, { tempDir: testTempDir });
      } catch (err) {
        caughtErr = err;
      }

      assert.ok(caughtErr, 'stageBackup should reject when state.db fails backup');
      assert.match(caughtErr.message, /SQLite online backup failed for/);

      // Verify no leaked staging directories exist in testTempDir
      const filesInTemp = await fs.promises.readdir(testTempDir);
      const stagingDirs = filesInTemp.filter((f) => f.startsWith('hermes-backup-'));
      assert.equal(stagingDirs.length, 0, 'Staging directory should be cleaned up on failure');
    });

    it('should fallback to copyFile with warning during stageBackup when sqlite3 binary is missing', async () => {
      const stateDbPath = path.join(mockHermesHome, 'state.db');
      await fs.promises.writeFile(stateDbPath, 'mock-state-db-data');

      const warnings = [];
      const stageResult = await stageBackup(mockHermesHome, {
        tempDir: testTempDir,
        sqliteBinary: 'nonexistent-sqlite3-cli-bin',
        onWarning: (msg) => warnings.push(msg),
      });

      assert.ok(stageResult.stagingDir);
      const stagedStateDb = path.join(stageResult.stagingDir, 'state.db');
      assert.ok(fs.existsSync(stagedStateDb));
      const content = await fs.promises.readFile(stagedStateDb, 'utf8');
      assert.equal(content, 'mock-state-db-data');

      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /sqlite3 CLI not found on host/i);

      await cleanStagingDirectory(stageResult.stagingDir, testTempDir);
    });
  });
});
