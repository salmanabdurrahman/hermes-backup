import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import {
  generateArchiveName,
  createArchive,
  createArchiveStream,
  validateArchive,
  cleanupArchive,
  cleanupTempResources,
  registerProcessCleanup,
  withStagingCleanup,
} from '../src/archiver.js';
import { cleanStagingDirectory } from '../src/stager.js';

describe('Streaming tar.gz Archiver & Staging Cleanup Engine', () => {
  let testTempDir;
  let mockStagingDir;

  beforeEach(async () => {
    testTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hermes-test-archiver-'));
    mockStagingDir = path.join(testTempDir, 'mock_staging');
    await fs.promises.mkdir(mockStagingDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(testTempDir, { recursive: true, force: true });
    } catch {
      // Ignore test directory cleanup error
    }
  });

  describe('Archive Name Generation', () => {
    it('should generate archive name with default current timestamp', () => {
      const name = generateArchiveName();
      assert.ok(/^hermes-backup-\d{4}-\d{2}-\d{2}_\d{6}\.tar\.gz$/.test(name));
    });

    it('should format archive name from Date object', () => {
      const date = new Date(2026, 7, 29, 9, 30, 0); // 2026-08-29 09:30:00
      const name = generateArchiveName(date);
      assert.equal(name, 'hermes-backup-2026-08-29_093000.tar.gz');
    });

    it('should format archive name from string timestamp', () => {
      const name = generateArchiveName('2026-08-29_120000');
      assert.equal(name, 'hermes-backup-2026-08-29_120000.tar.gz');
    });

    it('should fallback to default timestamp when whitespace-only string or invalid type is provided', () => {
      const blankName = generateArchiveName('   ');
      assert.ok(/^hermes-backup-\d{4}-\d{2}-\d{2}_\d{6}\.tar\.gz$/.test(blankName));

      const numName = generateArchiveName(12345);
      assert.ok(/^hermes-backup-\d{4}-\d{2}-\d{2}_\d{6}\.tar\.gz$/.test(numName));
    });
  });

  describe('Archive Packaging & Validation', () => {
    it('should throw error when staging directory does not exist', async () => {
      const nonExistent = path.join(testTempDir, 'does-not-exist');
      await assert.rejects(
        () => createArchive(nonExistent),
        (err) => err.message.includes('Staging directory does not exist')
      );
    });

    it('should throw error when staging path is not a directory', async () => {
      const filePath = path.join(testTempDir, 'a-file.txt');
      await fs.promises.writeFile(filePath, 'sample');
      await assert.rejects(
        () => createArchive(filePath),
        (err) => err.message.includes('Staging path is not a directory')
      );
    });

    it('should throw error when staging directory is empty', async () => {
      await assert.rejects(
        () => createArchive(mockStagingDir),
        (err) => err.message.includes('Cannot create archive from empty staging directory')
      );
    });

    it('should package staged files into a valid tar.gz archive and return metadata', async () => {
      // Create staged structure
      await fs.promises.writeFile(path.join(mockStagingDir, 'config.yaml'), 'model: hermes\ntemperature: 0.7');
      await fs.promises.mkdir(path.join(mockStagingDir, 'memories'), { recursive: true });
      await fs.promises.writeFile(path.join(mockStagingDir, 'memories/MEMORY.md'), '# Long-Term Memory Profile');
      await fs.promises.mkdir(path.join(mockStagingDir, 'mnemosyne/data'), { recursive: true });
      await fs.promises.writeFile(path.join(mockStagingDir, 'mnemosyne/data/mnemosyne.db'), 'sqlite-binary-data');
      await fs.promises.writeFile(path.join(mockStagingDir, 'mnemosyne/data/mnemosyne.db-wal'), 'sqlite-wal-data');

      const archiveResult = await createArchive(mockStagingDir, {
        outputDir: testTempDir,
        timestamp: '2026-08-29_100000',
      });

      assert.equal(archiveResult.archiveName, 'hermes-backup-2026-08-29_100000.tar.gz');
      assert.equal(archiveResult.archivePath, path.join(testTempDir, 'hermes-backup-2026-08-29_100000.tar.gz'));
      assert.ok(archiveResult.size > 0);
      assert.equal(archiveResult.timestamp, '2026-08-29_100000');
      assert.ok(fs.existsSync(archiveResult.archivePath));

      // Validate archive using validateArchive
      const validation = await validateArchive(archiveResult.archivePath);
      assert.equal(validation.valid, true);
      assert.ok(validation.size > 0);
      assert.ok(validation.entries.includes('config.yaml'));
      assert.ok(validation.entries.includes('memories/MEMORY.md') || validation.entries.includes('memories/'));
      assert.ok(validation.entries.includes('mnemosyne/data/mnemosyne.db'));
      assert.ok(validation.entries.includes('mnemosyne/data/mnemosyne.db-wal'));

      // Test extraction with system tar tool to verify PRD restoration compatibility
      const extractTarget = path.join(testTempDir, 'extracted_restore');
      await fs.promises.mkdir(extractTarget, { recursive: true });

      execFileSync('tar', ['-xzvf', archiveResult.archivePath, '-C', extractTarget]);

      const restoredConfig = await fs.promises.readFile(path.join(extractTarget, 'config.yaml'), 'utf8');
      const restoredMemory = await fs.promises.readFile(path.join(extractTarget, 'memories/MEMORY.md'), 'utf8');
      const restoredDb = await fs.promises.readFile(path.join(extractTarget, 'mnemosyne/data/mnemosyne.db'), 'utf8');

      assert.equal(restoredConfig, 'model: hermes\ntemperature: 0.7');
      assert.equal(restoredMemory, '# Long-Term Memory Profile');
      assert.equal(restoredDb, 'sqlite-binary-data');
    });

    it('should create a readable archive stream', async () => {
      await fs.promises.writeFile(path.join(mockStagingDir, 'SOUL.md'), '# Hermes Soul');
      await fs.promises.mkdir(path.join(mockStagingDir, 'skills/weather'), { recursive: true });
      await fs.promises.writeFile(path.join(mockStagingDir, 'skills/weather/SKILL.md'), '# Weather Skill');

      const stream = await createArchiveStream(mockStagingDir);
      assert.ok(stream instanceof Readable || typeof stream.pipe === 'function');

      const streamArchivePath = path.join(testTempDir, 'streamed-archive.tar.gz');
      const writeStream = fs.createWriteStream(streamArchivePath);

      await new Promise((resolve, reject) => {
        stream.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
        stream.on('error', reject);
      });

      const validation = await validateArchive(streamArchivePath);
      assert.equal(validation.valid, true);
      assert.ok(validation.entries.includes('SOUL.md'));
      assert.ok(validation.entries.includes('skills/weather/SKILL.md') || validation.entries.includes('skills/'));
    });

    it('should throw error when validating non-existent, empty, or corrupt archive', async () => {
      // Invalid input type
      await assert.rejects(
        () => validateArchive(null),
        (err) => err.message.includes('Archive path must be a non-empty string')
      );
      await assert.rejects(
        () => validateArchive(''),
        (err) => err.message.includes('Archive path must be a non-empty string')
      );

      // Non-existent
      await assert.rejects(
        () => validateArchive(path.join(testTempDir, 'non-existent.tar.gz')),
        (err) => err.message.includes('Archive file not found')
      );

      // Empty (0 bytes)
      const emptyFile = path.join(testTempDir, 'empty.tar.gz');
      await fs.promises.writeFile(emptyFile, '');
      await assert.rejects(
        () => validateArchive(emptyFile),
        (err) => err.message.includes('Archive is empty or not a regular file')
      );

      // Corrupted file content
      const corruptFile = path.join(testTempDir, 'corrupt.tar.gz');
      await fs.promises.writeFile(corruptFile, 'not a valid gzip or tar binary header data');
      await assert.rejects(
        () => validateArchive(corruptFile),
        (err) => err.message.includes('Archive validation failed')
      );
    });
  });

  describe('Cleanup Engine & Safe Deletion', () => {
    it('should safely delete archive file', async () => {
      // Non-string arguments should return false safely
      assert.equal(await cleanupArchive(null), false);
      assert.equal(await cleanupArchive(undefined), false);
      assert.equal(await cleanupArchive(''), false);

      const archiveFile = path.join(testTempDir, 'test-cleanup.tar.gz');
      await fs.promises.writeFile(archiveFile, 'fake archive data');

      assert.ok(fs.existsSync(archiveFile));
      const result = await cleanupArchive(archiveFile, { tempDir: testTempDir });
      assert.equal(result, true);
      assert.ok(!fs.existsSync(archiveFile));

      // Idempotent: deleting non-existent file returns true
      const secondResult = await cleanupArchive(archiveFile, { tempDir: testTempDir });
      assert.equal(secondResult, true);
    });

    it('should guard against deleting root or home directory', async () => {
      await assert.rejects(
        () => cleanupArchive('/', { tempDir: testTempDir }),
        (err) => err.message.includes('Refusing to delete potentially unsafe')
      );

      await assert.rejects(
        () => cleanupArchive(os.homedir(), { tempDir: testTempDir }),
        (err) => err.message.includes('Refusing to delete potentially unsafe')
      );
    });

    it('should clean up both staging and archive resources via cleanupTempResources', async () => {
      const stageDir = path.join(testTempDir, 'hermes-backup-stage-123');
      await fs.promises.mkdir(stageDir, { recursive: true });
      await fs.promises.writeFile(path.join(stageDir, 'file.txt'), 'content');

      const archiveFile = path.join(testTempDir, 'hermes-backup-archive-123.tar.gz');
      await fs.promises.writeFile(archiveFile, 'tar-content');

      assert.ok(fs.existsSync(stageDir));
      assert.ok(fs.existsSync(archiveFile));

      const cleanResult = await cleanupTempResources({
        stagingDir: stageDir,
        archivePath: archiveFile,
        tempDir: testTempDir,
      });

      assert.equal(cleanResult.stagingCleaned, true);
      assert.equal(cleanResult.archiveCleaned, true);
      assert.ok(!fs.existsSync(stageDir));
      assert.ok(!fs.existsSync(archiveFile));
    });

    it('should guarantee cleanup in withStagingCleanup on success', async () => {
      const stageDir = path.join(testTempDir, 'guaranteed-stage-success');
      await fs.promises.mkdir(stageDir, { recursive: true });
      await fs.promises.writeFile(path.join(stageDir, 'item.txt'), 'data');

      const executedResult = await withStagingCleanup(
        stageDir,
        async (dir) => {
          assert.ok(fs.existsSync(dir));
          return 'completed-successfully';
        },
        { tempDir: testTempDir }
      );

      assert.equal(executedResult, 'completed-successfully');
      assert.ok(!fs.existsSync(stageDir));
    });

    it('should guarantee cleanup in withStagingCleanup on error / exception', async () => {
      const stageDir = path.join(testTempDir, 'guaranteed-stage-error');
      await fs.promises.mkdir(stageDir, { recursive: true });
      await fs.promises.writeFile(path.join(stageDir, 'item.txt'), 'data');

      await assert.rejects(
        () =>
          withStagingCleanup(
            stageDir,
            async (dir) => {
              assert.ok(fs.existsSync(dir));
              throw new Error('Forced simulation error during upload');
            },
            { tempDir: testTempDir }
          ),
        (err) => err.message.includes('Forced simulation error during upload')
      );

      // Staging directory must be cleaned up despite the exception
      assert.ok(!fs.existsSync(stageDir));
    });

    it('should register and unregister process cleanup handlers properly', () => {
      let cleaned = false;
      const cleanupFn = () => {
        cleaned = true;
      };

      const unregister = registerProcessCleanup(cleanupFn);
      assert.equal(typeof unregister, 'function');

      // Unregister should cleanly remove it without throwing
      unregister();
    });
  });
});
