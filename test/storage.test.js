import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import {
  BACKUP_FILE_REGEX,
  formatBytes,
  createR2Client,
  uploadBackup,
  downloadBackup,
  listBackups,
  getLatestBackup,
  pruneExpiredBackups,
  formatBackupListTable,
} from '../src/storage.js';

describe('Storage Module — Cloudflare R2 Client & Remote Retention Pruner', () => {
  let tempTestDir;

  beforeEach(async () => {
    tempTestDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hermes-storage-test-'));
  });

  afterEach(async () => {
    if (tempTestDir && fs.existsSync(tempTestDir)) {
      await fs.promises.rm(tempTestDir, { recursive: true, force: true });
    }
  });

  const validConfig = {
    hermesHome: '/home/salmanabd/.hermes',
    r2: {
      accountId: 'test-account-id-12345',
      accessKeyId: 'test-access-key-id-67890',
      secretAccessKey: 'test-secret-access-key-abcdef',
      bucketName: 'test-hermes-bucket',
      endpoint: 'https://test-account-id-12345.r2.cloudflarestorage.com',
    },
    brevo: {
      apiKey: 'test-brevo-key-12345',
      senderName: 'Bot',
      senderEmail: 'bot@example.com',
      recipientEmail: 'admin@example.com',
    },
    retentionDays: 3,
    tempDir: '/tmp',
  };

  describe('formatBytes helper', () => {
    it('should format bytes across all units', () => {
      assert.equal(formatBytes(0), '0 B');
      assert.equal(formatBytes(512), '512 B');
      assert.equal(formatBytes(1024), '1 KB');
      assert.equal(formatBytes(1536), '1.5 KB');
      assert.equal(formatBytes(1048576), '1 MB');
      assert.equal(formatBytes(104857600), '100 MB');
      assert.equal(formatBytes(1073741824), '1 GB');
      assert.equal(formatBytes(1099511627776), '1 TB');
    });

    it('should handle invalid or negative values safely', () => {
      assert.equal(formatBytes(-100), '0 B');
      assert.equal(formatBytes(NaN), '0 B');
      assert.equal(formatBytes(null), '0 B');
      assert.equal(formatBytes(undefined), '0 B');
    });
  });

  describe('BACKUP_FILE_REGEX pattern', () => {
    it('should match valid hermes backup filenames', () => {
      assert.ok(BACKUP_FILE_REGEX.test('hermes-backup-2026-08-29_120000.tar.gz'));
      assert.ok(BACKUP_FILE_REGEX.test('hermes-backup-1999-01-01_000000.tar.gz'));
    });

    it('should reject non-standard filenames', () => {
      assert.equal(BACKUP_FILE_REGEX.test('hermes-backup.tar.gz'), false);
      assert.equal(BACKUP_FILE_REGEX.test('other-backup-2026-08-29_120000.tar.gz'), false);
      assert.equal(BACKUP_FILE_REGEX.test('hermes-backup-2026-08-29_120000.zip'), false);
      assert.equal(BACKUP_FILE_REGEX.test('notes.txt'), false);
    });
  });

  describe('createR2Client factory', () => {
    it('should instantiate S3Client with valid R2 configuration', () => {
      const client = createR2Client(validConfig);
      assert.ok(client);
      assert.equal(typeof client.send, 'function');
    });

    it('should throw error when R2 configuration is missing required keys', () => {
      assert.throws(
        () => {
          createR2Client({
            hermesHome: '/home/.hermes',
            r2: { accountId: '', accessKeyId: '', secretAccessKey: '', bucketName: '' },
          });
        },
        (err) => err.message.includes('Configuration validation failed')
      );
    });
  });

  describe('uploadBackup', () => {
    it('should throw error if archive file is missing or empty', async () => {
      const nonExistent = path.join(tempTestDir, 'non-existent.tar.gz');
      await assert.rejects(
        async () => {
          await uploadBackup(nonExistent, validConfig);
        },
        (err) => err.message.includes('Archive file not found')
      );

      const emptyFile = path.join(tempTestDir, 'empty.tar.gz');
      await fs.promises.writeFile(emptyFile, '');
      await assert.rejects(
        async () => {
          await uploadBackup(emptyFile, validConfig);
        },
        (err) => err.message.includes('Archive is empty or not a regular file')
      );
    });

    it('should perform dry-run upload without invoking S3Client', async () => {
      const dummyArchive = path.join(tempTestDir, 'hermes-backup-2026-08-29_100000.tar.gz');
      await fs.promises.writeFile(dummyArchive, 'mock archive content for dry-run');

      const result = await uploadBackup(dummyArchive, validConfig, { dryRun: true });

      const expectedDigest = crypto
        .createHash('sha256')
        .update('mock archive content for dry-run')
        .digest('hex');

      assert.equal(result.dryRun, true);
      assert.equal(result.key, 'backups/hermes-backup-2026-08-29_100000.tar.gz');
      assert.equal(result.bucket, 'test-hermes-bucket');
      assert.equal(result.size, 32);
      assert.equal(result.sha256, expectedDigest);
      assert.equal(result.etag, '"dry-run-etag"');
      assert.ok(result.timestamp);
    });

    it('should upload archive using PutObjectCommand with metadata and SHA-256', async () => {
      const dummyArchive = path.join(tempTestDir, 'hermes-backup-2026-08-29_100000.tar.gz');
      await fs.promises.writeFile(dummyArchive, 'valid mock archive binary payload');

      const expectedDigest = crypto
        .createHash('sha256')
        .update('valid mock archive binary payload')
        .digest('hex');

      let capturedCommand = null;
      const mockClient = {
        send: async (command) => {
          capturedCommand = command;
          return {
            ETag: '"a1b2c3d4e5f6"',
          };
        },
      };

      const result = await uploadBackup(dummyArchive, validConfig, {
        client: mockClient,
        uncompressedSize: 85000000,
        metadata: { custom_tag: 'automated-cron' },
      });

      assert.equal(result.dryRun, false);
      assert.equal(result.key, 'backups/hermes-backup-2026-08-29_100000.tar.gz');
      assert.equal(result.bucket, 'test-hermes-bucket');
      assert.equal(result.sha256, expectedDigest);
      assert.equal(result.etag, 'a1b2c3d4e5f6');

      assert.ok(capturedCommand instanceof PutObjectCommand);
      assert.equal(capturedCommand.input.Bucket, 'test-hermes-bucket');
      assert.equal(capturedCommand.input.Key, 'backups/hermes-backup-2026-08-29_100000.tar.gz');
      assert.equal(capturedCommand.input.ContentType, 'application/gzip');
      assert.equal(capturedCommand.input.ContentLength, 33);
      assert.equal(capturedCommand.input.Metadata['sha256'], expectedDigest);
      assert.equal(capturedCommand.input.Metadata['uncompressed-size'], '85000000');
      assert.equal(capturedCommand.input.Metadata['custom_tag'], 'automated-cron');
      assert.ok(capturedCommand.input.Metadata['hostname']);
      assert.ok(capturedCommand.input.Metadata['timestamp']);

      // Verify payload is an in-memory Buffer to guarantee retry resilience
      assert.ok(Buffer.isBuffer(capturedCommand.input.Body));
      assert.equal(capturedCommand.input.Body.toString('utf8'), 'valid mock archive binary payload');
    });

    it('should use pre-calculated SHA-256 and normalize metadata prefix when supplied', async () => {
      const dummyArchive = path.join(tempTestDir, 'hermes-backup-custom-sha.tar.gz');
      await fs.promises.writeFile(dummyArchive, 'custom payload');

      const customSha = 'f8a55c6d91234567890abcdef1234567890abcdef1234567890abcdef1234567';

      let capturedCommand = null;
      const mockClient = {
        send: async (command) => {
          capturedCommand = command;
          return { ETag: '"hash-etag"' };
        },
      };

      const result = await uploadBackup(dummyArchive, validConfig, {
        client: mockClient,
        sha256: customSha,
        metadata: {
          'x-amz-meta-custom-header': 'normalized-value',
        },
      });

      assert.equal(result.sha256, customSha);
      assert.equal(capturedCommand.input.Metadata['sha256'], customSha);
      assert.equal(capturedCommand.input.Metadata['custom-header'], 'normalized-value');
    });

    it('should provide retry resilience by supporting multiple reads of in-memory buffer Body', async () => {
      const dummyArchive = path.join(tempTestDir, 'hermes-backup-retry.tar.gz');
      const testContent = 'retry resilience payload check';
      await fs.promises.writeFile(dummyArchive, testContent);

      let attempts = 0;
      let bodyReadAttempts = [];

      const mockClient = {
        send: async (command) => {
          attempts++;
          const body = command.input.Body;
          assert.ok(Buffer.isBuffer(body), 'Body must be an in-memory buffer');
          bodyReadAttempts.push(body.toString('utf8'));

          if (attempts === 1) {
            // Simulate transient network failure on first attempt
            const transientErr = new Error('Transient socket hang up');
            transientErr.code = 'ECONNRESET';
            throw transientErr;
          }

          return { ETag: '"retry-success-etag"' };
        },
      };

      // In real SDK, retry happens inside client.send. Here we verify that if client retries,
      // the Body buffer is re-readable across attempts without exhaustion.
      let capturedCommand;
      const capturingClient = {
        send: async (command) => {
          capturedCommand = command;
          // First attempt reads buffer
          const firstRead = command.input.Body.toString('utf8');
          // Simulated retry reads buffer again
          const secondRead = command.input.Body.toString('utf8');
          assert.equal(firstRead, testContent);
          assert.equal(secondRead, testContent);
          return { ETag: '"etag-ok"' };
        },
      };

      const result = await uploadBackup(dummyArchive, validConfig, { client: capturingClient });
      assert.equal(result.etag, 'etag-ok');
    });

    it('should sanitize secrets in error if upload fails', async () => {
      const dummyArchive = path.join(tempTestDir, 'hermes-backup-2026-08-29_100000.tar.gz');
      await fs.promises.writeFile(dummyArchive, 'payload');

      const mockClient = {
        send: async () => {
          throw new Error(`Upload failed with secret key ${validConfig.r2.secretAccessKey} and token`);
        },
      };

      await assert.rejects(
        async () => {
          await uploadBackup(dummyArchive, validConfig, { client: mockClient });
        },
        (err) => {
          return (
            !err.message.includes(validConfig.r2.secretAccessKey) &&
            err.message.includes('[REDACTED]')
          );
        }
      );
    });
  });

  describe('listBackups', () => {
    it('should list backups with metadata and sort descending by lastModified', async () => {
      const mockContents = [
        {
          Key: 'backups/hermes-backup-2026-08-27_030000.tar.gz',
          Size: 15000000,
          LastModified: new Date('2026-08-27T03:00:00Z'),
          ETag: '"etag-1"',
        },
        {
          Key: 'backups/hermes-backup-2026-08-29_030000.tar.gz',
          Size: 18000000,
          LastModified: new Date('2026-08-29T03:00:00Z'),
          ETag: '"etag-3"',
        },
        {
          Key: 'backups/hermes-backup-2026-08-28_030000.tar.gz',
          Size: 16000000,
          LastModified: new Date('2026-08-28T03:00:00Z'),
          ETag: '"etag-2"',
        },
        {
          Key: 'backups/random-manual-note.txt',
          Size: 500,
          LastModified: new Date('2026-08-28T05:00:00Z'),
          ETag: '"etag-txt"',
        },
      ];

      const mockClient = {
        send: async (command) => {
          assert.ok(command instanceof ListObjectsV2Command);
          assert.equal(command.input.Bucket, 'test-hermes-bucket');
          assert.equal(command.input.Prefix, 'backups/');
          return {
            Contents: mockContents,
            IsTruncated: false,
          };
        },
      };

      const result = await listBackups(validConfig, { client: mockClient });

      assert.equal(result.totalCount, 4);
      assert.equal(result.totalBytes, 49000500);

      // Verify newest first
      assert.equal(result.backups[0].name, 'hermes-backup-2026-08-29_030000.tar.gz');
      assert.equal(result.backups[0].isBackup, true);
      assert.equal(result.backups[0].etag, 'etag-3');

      assert.equal(result.backups[1].name, 'random-manual-note.txt');
      assert.equal(result.backups[1].isBackup, false);

      assert.equal(result.backups[2].name, 'hermes-backup-2026-08-28_030000.tar.gz');
      assert.equal(result.backups[2].isBackup, true);

      assert.equal(result.backups[3].name, 'hermes-backup-2026-08-27_030000.tar.gz');
      assert.equal(result.backups[3].isBackup, true);
    });

    it('should handle empty bucket cleanly', async () => {
      const mockClient = {
        send: async () => ({
          Contents: undefined,
          IsTruncated: false,
        }),
      };

      const result = await listBackups(validConfig, { client: mockClient });
      assert.deepEqual(result.backups, []);
      assert.equal(result.totalCount, 0);
      assert.equal(result.totalBytes, 0);
    });

    it('should paginate across multiple ListObjectsV2Command calls', async () => {
      let callCount = 0;
      const mockClient = {
        send: async (command) => {
          callCount++;
          if (callCount === 1) {
            assert.equal(command.input.ContinuationToken, undefined);
            return {
              Contents: [
                {
                  Key: 'backups/hermes-backup-2026-08-28_000000.tar.gz',
                  Size: 1000,
                  LastModified: new Date('2026-08-28T00:00:00Z'),
                },
              ],
              IsTruncated: true,
              NextContinuationToken: 'token-page-2',
            };
          } else {
            assert.equal(command.input.ContinuationToken, 'token-page-2');
            return {
              Contents: [
                {
                  Key: 'backups/hermes-backup-2026-08-29_000000.tar.gz',
                  Size: 2000,
                  LastModified: new Date('2026-08-29T00:00:00Z'),
                },
              ],
              IsTruncated: false,
            };
          }
        },
      };

      const result = await listBackups(validConfig, { client: mockClient });
      assert.equal(callCount, 2);
      assert.equal(result.totalCount, 2);
      assert.equal(result.totalBytes, 3000);
      assert.equal(result.backups[0].name, 'hermes-backup-2026-08-29_000000.tar.gz');
      assert.equal(result.backups[1].name, 'hermes-backup-2026-08-28_000000.tar.gz');
    });

    it('should sanitize secrets if listBackups fails', async () => {
      const mockClient = {
        send: async () => {
          throw new Error(`S3 Error with ${validConfig.r2.accessKeyId} credential failure`);
        },
      };

      await assert.rejects(
        async () => {
          await listBackups(validConfig, { client: mockClient });
        },
        (err) => !err.message.includes(validConfig.r2.accessKeyId) && err.message.includes('[REDACTED]')
      );
    });
  });

  describe('pruneExpiredBackups', () => {
    it('should identify and delete backups older than retentionDays', async () => {
      const now = new Date('2026-08-29T12:00:00Z');
      // 3 days retention cutoff is 2026-08-26T12:00:00Z

      const storedBackups = [
        {
          Key: 'backups/hermes-backup-2026-08-29_000000.tar.gz', // ~0.5 day old -> keep
          Size: 10000000,
          LastModified: new Date('2026-08-29T00:00:00Z'),
        },
        {
          Key: 'backups/hermes-backup-2026-08-27_000000.tar.gz', // ~2.5 days old -> keep
          Size: 12000000,
          LastModified: new Date('2026-08-27T00:00:00Z'),
        },
        {
          Key: 'backups/hermes-backup-2026-08-25_000000.tar.gz', // ~4.5 days old -> delete
          Size: 11000000,
          LastModified: new Date('2026-08-25T00:00:00Z'),
        },
        {
          Key: 'backups/hermes-backup-2026-08-24_000000.tar.gz', // ~5.5 days old -> delete
          Size: 9000000,
          LastModified: new Date('2026-08-24T00:00:00Z'),
        },
        {
          Key: 'backups/manual-archive-2026-08-20.tar.gz', // Not matching BACKUP_FILE_REGEX -> ignore
          Size: 5000000,
          LastModified: new Date('2026-08-20T00:00:00Z'),
        },
      ];

      let capturedDelete = null;
      const mockClient = {
        send: async (command) => {
          if (command instanceof ListObjectsV2Command) {
            return {
              Contents: storedBackups,
              IsTruncated: false,
            };
          }
          if (command instanceof DeleteObjectsCommand) {
            capturedDelete = command;
            return {
              Deleted: command.input.Delete.Objects.map((o) => ({ Key: o.Key })),
              Errors: [],
            };
          }
          throw new Error(`Unexpected command: ${command.constructor.name}`);
        },
      };

      const result = await pruneExpiredBackups(validConfig, {
        client: mockClient,
        retentionDays: 3,
        now,
        dryRun: false,
      });

      assert.equal(result.prunedCount, 2);
      assert.equal(result.totalFreedBytes, 20000000);
      assert.equal(result.dryRun, false);
      assert.equal(result.errors.length, 0);

      assert.equal(result.pruned[0].name, 'hermes-backup-2026-08-25_000000.tar.gz');
      assert.equal(result.pruned[1].name, 'hermes-backup-2026-08-24_000000.tar.gz');

      assert.ok(capturedDelete instanceof DeleteObjectsCommand);
      assert.equal(capturedDelete.input.Bucket, 'test-hermes-bucket');
      assert.deepEqual(capturedDelete.input.Delete.Objects, [
        { Key: 'backups/hermes-backup-2026-08-25_000000.tar.gz' },
        { Key: 'backups/hermes-backup-2026-08-24_000000.tar.gz' },
      ]);
    });

    it('should support dry-run mode without issuing DeleteObjectsCommand', async () => {
      const now = new Date('2026-08-29T12:00:00Z');
      const storedBackups = [
        {
          Key: 'backups/hermes-backup-2026-08-20_000000.tar.gz',
          Size: 5000000,
          LastModified: new Date('2026-08-20T00:00:00Z'),
        },
      ];

      let deleteIssued = false;
      const mockClient = {
        send: async (command) => {
          if (command instanceof ListObjectsV2Command) {
            return { Contents: storedBackups, IsTruncated: false };
          }
          if (command instanceof DeleteObjectsCommand) {
            deleteIssued = true;
            return { Deleted: [] };
          }
        },
      };

      const result = await pruneExpiredBackups(validConfig, {
        client: mockClient,
        retentionDays: 3,
        now,
        dryRun: true,
      });

      assert.equal(result.dryRun, true);
      assert.equal(result.prunedCount, 1);
      assert.equal(result.totalFreedBytes, 5000000);
      assert.equal(deleteIssued, false);
    });

    it('should return empty pruned list when no backups are expired', async () => {
      const now = new Date('2026-08-29T12:00:00Z');
      const storedBackups = [
        {
          Key: 'backups/hermes-backup-2026-08-29_000000.tar.gz',
          Size: 5000000,
          LastModified: new Date('2026-08-29T00:00:00Z'),
        },
      ];

      const mockClient = {
        send: async (command) => {
          if (command instanceof ListObjectsV2Command) {
            return { Contents: storedBackups, IsTruncated: false };
          }
        },
      };

      const result = await pruneExpiredBackups(validConfig, {
        client: mockClient,
        retentionDays: 3,
        now,
      });

      assert.equal(result.prunedCount, 0);
      assert.equal(result.totalFreedBytes, 0);
      assert.deepEqual(result.pruned, []);
    });

    it('should support string retentionDays and string now date', async () => {
      const nowStr = '2026-08-29T12:00:00Z';
      const storedBackups = [
        {
          Key: 'backups/hermes-backup-2026-08-20_000000.tar.gz',
          Size: 5000000,
          LastModified: new Date('2026-08-20T00:00:00Z'),
        },
      ];

      const mockClient = {
        send: async (command) => {
          if (command instanceof ListObjectsV2Command) {
            return { Contents: storedBackups, IsTruncated: false };
          }
          if (command instanceof DeleteObjectsCommand) {
            return {
              Deleted: [{ Key: 'backups/hermes-backup-2026-08-20_000000.tar.gz' }],
              Errors: [],
            };
          }
        },
      };

      const result = await pruneExpiredBackups(validConfig, {
        client: mockClient,
        retentionDays: '3',
        now: nowStr,
      });

      assert.equal(result.prunedCount, 1);
      assert.equal(result.totalFreedBytes, 5000000);
    });

    it('should validate retentionDays argument', async () => {
      await assert.rejects(
        async () => {
          await pruneExpiredBackups(validConfig, { retentionDays: -1 });
        },
        (err) => err.message.includes('Retention days must be a positive integer')
      );

      await assert.rejects(
        async () => {
          await pruneExpiredBackups(validConfig, { retentionDays: 'not-a-number' });
        },
        (err) => err.message.includes('Retention days must be a positive integer')
      );

      await assert.rejects(
        async () => {
          await pruneExpiredBackups(validConfig, { now: 'invalid-date-string' });
        },
        (err) => err.message.includes('Invalid reference date')
      );
    });
  });

  describe('formatBackupListTable helper', () => {
    it('should format empty backups array gracefully', () => {
      const output = formatBackupListTable([]);
      assert.equal(output, 'No backups found in remote storage.');
    });

    it('should format non-empty backups into structured aligned table', () => {
      const backups = [
        {
          name: 'hermes-backup-2026-08-29_100000.tar.gz',
          size: 25000000,
          lastModified: new Date('2026-08-29T10:00:00Z'),
          etag: 'etag12345',
        },
        {
          name: 'hermes-backup-2026-08-28_100000.tar.gz',
          size: 24000000,
          lastModified: new Date('2026-08-28T10:00:00Z'),
          etag: 'etag67890',
        },
      ];

      const table = formatBackupListTable(backups);
      assert.ok(table.includes('Backup Archive'));
      assert.ok(table.includes('Size'));
      assert.ok(table.includes('Last Modified'));
      assert.ok(table.includes('ETag'));
      assert.ok(table.includes('hermes-backup-2026-08-29_100000.tar.gz'));
      assert.ok(table.includes('23.84 MB'));
      assert.ok(table.includes('etag12345'));
    });
  });

  describe('downloadBackup', () => {
    it('should download archive from R2 and verify SHA-256', async () => {
      const payload = Buffer.from('simulated-backup-content-12345');
      const expectedSha = crypto.createHash('sha256').update(payload).digest('hex');
      const destPath = path.join(tempTestDir, 'downloaded.tar.gz');

      let capturedCommand;
      const mockClient = {
        send: async (command) => {
          capturedCommand = command;
          return {
            Body: payload,
            ETag: '"etag-download-123"',
            Metadata: {
              sha256: expectedSha,
            },
            LastModified: new Date('2026-08-29T12:00:00Z'),
          };
        },
      };

      const result = await downloadBackup(
        'hermes-backup-2026-08-29_120000.tar.gz',
        destPath,
        validConfig,
        {
          client: mockClient,
        }
      );

      assert.equal(capturedCommand.input.Bucket, 'test-hermes-bucket');
      assert.equal(
        capturedCommand.input.Key,
        'backups/hermes-backup-2026-08-29_120000.tar.gz'
      );
      assert.equal(result.sha256, expectedSha);
      assert.equal(result.size, payload.length);
      assert.ok(fs.existsSync(destPath));

      const fileOnDisk = await fs.promises.readFile(destPath);
      assert.deepEqual(fileOnDisk, payload);
    });

    it('should detect SHA-256 checksum mismatch, unlink corrupted destination, and throw error', async () => {
      const payload = Buffer.from('corrupted-payload-data');
      const destPath = path.join(tempTestDir, 'corrupt.tar.gz');

      const mockClient = {
        send: async () => ({
          Body: payload,
          Metadata: {
            sha256: 'deadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678',
          },
        }),
      };

      await assert.rejects(
        () =>
          downloadBackup('hermes-backup.tar.gz', destPath, validConfig, {
            client: mockClient,
          }),
        (err) => err.message.includes('SHA-256 checksum mismatch')
      );

      assert.ok(!fs.existsSync(destPath));
    });

    it('should reject invalid arguments on downloadBackup', async () => {
      await assert.rejects(
        () => downloadBackup('', '/tmp/dest', validConfig),
        (err) => err.message.includes('Backup key must be a non-empty string')
      );

      await assert.rejects(
        () => downloadBackup('key', '', validConfig),
        (err) => err.message.includes('Destination path must be a non-empty string')
      );
    });
  });

  describe('getLatestBackup', () => {
    it('should return the newest backup sorted by LastModified', async () => {
      const mockContents = [
        {
          Key: 'backups/hermes-backup-2026-08-28_100000.tar.gz',
          Size: 1000,
          LastModified: new Date('2026-08-28T10:00:00Z'),
          ETag: '"etag1"',
        },
        {
          Key: 'backups/hermes-backup-2026-08-29_120000.tar.gz',
          Size: 2000,
          LastModified: new Date('2026-08-29T12:00:00Z'),
          ETag: '"etag2"',
        },
      ];

      const mockClient = {
        send: async () => ({
          Contents: mockContents,
          IsTruncated: false,
        }),
      };

      const latest = await getLatestBackup(validConfig, { client: mockClient });
      assert.ok(latest);
      assert.equal(latest.key, 'backups/hermes-backup-2026-08-29_120000.tar.gz');
      assert.equal(latest.size, 2000);
    });

    it('should return null when no backups exist', async () => {
      const mockClient = {
        send: async () => ({
          Contents: [],
          IsTruncated: false,
        }),
      };

      const latest = await getLatestBackup(validConfig, { client: mockClient });
      assert.equal(latest, null);
    });
  });
});
