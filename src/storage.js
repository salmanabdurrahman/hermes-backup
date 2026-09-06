import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { validateConfig } from './config.js';
import { createSanitizer } from './sanitizer.js';

/**
 * Regex matching standard Hermes backup archive filenames.
 */
export const BACKUP_FILE_REGEX = /^hermes-backup-\d{4}-\d{2}-\d{2}_\d{6}\.tar\.gz$/;

/**
 * Format raw byte size into a human-readable string.
 * @param {number} bytes
 * @param {number} [decimals=2]
 * @returns {string}
 */
export function formatBytes(bytes, decimals = 2) {
  if (typeof bytes !== 'number' || isNaN(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes === 0) return '0 B';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const idx = Math.min(i, sizes.length - 1);

  return `${parseFloat((bytes / Math.pow(k, idx)).toFixed(dm))} ${sizes[idx]}`;
}

/**
 * Creates and configures an AWS S3Client instance for Cloudflare R2.
 *
 * @param {object} config - Configuration object containing r2 settings
 * @param {object} [clientOverrides={}] - Custom S3Client configuration overrides
 * @returns {S3Client}
 */
export function createR2Client(config, clientOverrides = {}) {
  validateConfig(config, { requireR2: true, requireBrevo: false, throwOnError: true });

  const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 50,
  });

  const clientConfig = {
    region: 'auto',
    endpoint: config.r2.endpoint,
    forcePathStyle: true,
    requestHandler: new NodeHttpHandler({
      httpsAgent,
    }),
    credentials: {
      accessKeyId: config.r2.accessKeyId,
      secretAccessKey: config.r2.secretAccessKey,
    },
    ...clientOverrides,
  };

  return new S3Client(clientConfig);
}

/**
 * Uploads a local backup archive to Cloudflare R2 bucket.
 *
 * @param {string} archivePath - Absolute or relative path to the .tar.gz archive
 * @param {object} config - Application configuration object
 * @param {object} [options={}]
 * @param {S3Client} [options.client] - Optional pre-instantiated S3Client
 * @param {string} [options.bucketName] - Bucket name override
 * @param {string} [options.key] - Custom S3 object key (defaults to backups/<filename>)
 * @param {Record<string, string>} [options.metadata] - Custom metadata fields
 * @param {number} [options.uncompressedSize] - Uncompressed size in bytes for metadata
 * @param {string} [options.sha256] - Pre-calculated SHA-256 checksum (computed from file if omitted)
 * @param {string} [options.contentType='application/gzip'] - MIME content type
 * @param {boolean} [options.dryRun=false] - If true, skips network upload
 * @returns {Promise<{
 *   key: string,
 *   bucket: string,
 *   size: number,
 *   sha256: string,
 *   etag: string,
 *   timestamp: string,
 *   dryRun: boolean
 * }>}
 */
export async function uploadBackup(archivePath, config, options = {}) {
  const {
    client: customClient,
    bucketName = config?.r2?.bucketName || 'hermes-backups',
    key: customKey,
    metadata = {},
    uncompressedSize,
    sha256: customSha256,
    contentType = 'application/gzip',
    dryRun = false,
  } = options;

  if (!archivePath || typeof archivePath !== 'string') {
    throw new Error('Archive path must be a non-empty string');
  }

  const resolvedPath = path.resolve(archivePath);
  let fileStat;
  try {
    fileStat = await fs.promises.stat(resolvedPath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Archive file not found: ${resolvedPath}`);
    }
    throw err;
  }

  if (!fileStat.isFile() || fileStat.size === 0) {
    throw new Error(`Archive is empty or not a regular file (0 bytes): ${resolvedPath}`);
  }

  const archiveBasename = path.basename(resolvedPath);
  const objectKey = customKey || `backups/${archiveBasename}`;
  const nowIso = new Date().toISOString();

  // Load payload into in-memory buffer to prevent AWS SDK v3 stream rewind hangs on retries
  const fileBuffer = await fs.promises.readFile(resolvedPath);
  const calculatedSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const finalSha256 = customSha256 || calculatedSha256;

  if (dryRun) {
    return {
      key: objectKey,
      bucket: bucketName,
      size: fileStat.size,
      sha256: finalSha256,
      etag: '"dry-run-etag"',
      timestamp: nowIso,
      dryRun: true,
    };
  }

  const client = customClient || createR2Client(config);

  const mergedMetadata = {
    hostname: os.hostname(),
    timestamp: nowIso,
    sha256: finalSha256,
    ...(typeof uncompressedSize === 'number' && uncompressedSize >= 0
      ? { 'uncompressed-size': String(uncompressedSize) }
      : {}),
    ...metadata,
  };

  // Convert all metadata values to strings as required by S3 API
  const stringMetadata = {};
  for (const [k, v] of Object.entries(mergedMetadata)) {
    if (v !== undefined && v !== null) {
      const normalizedKey = k.toLowerCase().replace(/^x-amz-meta-/, '');
      stringMetadata[normalizedKey] = String(v);
    }
  }

  // Ensure sha256 metadata is explicitly set
  stringMetadata.sha256 = String(finalSha256);

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: objectKey,
    Body: fileBuffer,
    ContentLength: fileStat.size,
    ContentType: contentType,
    Metadata: stringMetadata,
  });

  try {
    const response = await client.send(command);
    const etag = response.ETag ? response.ETag.replace(/^"|"$/g, '') : '';

    return {
      key: objectKey,
      bucket: bucketName,
      size: fileStat.size,
      sha256: finalSha256,
      etag,
      timestamp: nowIso,
      dryRun: false,
    };
  } catch (err) {
    const sanitizer = createSanitizer(config);
    throw sanitizer(err);
  }
}

/**
 * Lists backups stored in the Cloudflare R2 bucket.
 *
 * @param {object} config - Application configuration object
 * @param {object} [options={}]
 * @param {S3Client} [options.client] - Optional pre-instantiated S3Client
 * @param {string} [options.bucketName] - Bucket name override
 * @param {string} [options.prefix='backups/'] - Prefix filter for objects
 * @param {number} [options.maxKeys] - Max keys per page
 * @returns {Promise<{
 *   backups: Array<{
 *     key: string,
 *     name: string,
 *     size: number,
 *     lastModified: Date,
 *     etag: string,
 *     isBackup: boolean
 *   }>,
 *   totalCount: number,
 *   totalBytes: number
 * }>}
 */
export async function listBackups(config, options = {}) {
  const {
    client: customClient,
    bucketName = config?.r2?.bucketName || 'hermes-backups',
    prefix = 'backups/',
    maxKeys,
  } = options;

  const client = customClient || createR2Client(config);
  const backups = [];
  let totalBytes = 0;
  let continuationToken;

  try {
    do {
      const command = new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        ...(maxKeys ? { MaxKeys: maxKeys } : {}),
      });

      const response = await client.send(command);
      const contents = response.Contents || [];

      for (const item of contents) {
        if (!item.Key) continue;

        const name = path.posix.basename(item.Key);
        const isBackup = BACKUP_FILE_REGEX.test(name);
        const size = typeof item.Size === 'number' ? item.Size : 0;
        const lastModified = item.LastModified instanceof Date ? item.LastModified : new Date(item.LastModified || 0);
        const etag = item.ETag ? item.ETag.replace(/^"|"$/g, '') : '';

        backups.push({
          key: item.Key,
          name,
          size,
          lastModified,
          etag,
          isBackup,
        });

        totalBytes += size;
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    // Sort backups descending by lastModified (newest first)
    backups.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());

    return {
      backups,
      totalCount: backups.length,
      totalBytes,
    };
  } catch (err) {
    const sanitizer = createSanitizer(config);
    throw sanitizer(err);
  }
}

/**
 * Deletes expired backups in Cloudflare R2 bucket older than the retention period.
 *
 * @param {object} config - Application configuration object
 * @param {object} [options={}]
 * @param {S3Client} [options.client] - Optional pre-instantiated S3Client
 * @param {string} [options.bucketName] - Bucket name override
 * @param {number} [options.retentionDays] - Retention window in days (defaults to config.retentionDays or 3)
 * @param {string} [options.prefix='backups/'] - Prefix filter for backups
 * @param {Date} [options.now=new Date()] - Reference point for age calculation
 * @param {boolean} [options.dryRun=false] - If true, identifies candidates without deleting
 * @returns {Promise<{
 *   pruned: Array<{ key: string, name: string, size: number, lastModified: Date }>,
 *   prunedCount: number,
 *   totalFreedBytes: number,
 *   cutoffDate: Date,
 *   dryRun: boolean,
 *   errors: string[]
 * }>}
 */
export async function pruneExpiredBackups(config, options = {}) {
  const {
    client: customClient,
    bucketName = config?.r2?.bucketName || 'hermes-backups',
    retentionDays: rawRetentionDays = config?.retentionDays ?? 3,
    prefix = 'backups/',
    now = new Date(),
    dryRun = false,
  } = options;

  const retentionDays = typeof rawRetentionDays === 'string'
    ? parseInt(rawRetentionDays, 10)
    : rawRetentionDays;

  if (typeof retentionDays !== 'number' || retentionDays <= 0 || !Number.isInteger(retentionDays)) {
    throw new Error(`Retention days must be a positive integer, received: ${rawRetentionDays}`);
  }

  const referenceNow = now instanceof Date ? now : new Date(now);
  if (isNaN(referenceNow.getTime())) {
    throw new Error(`Invalid reference date for pruning: ${now}`);
  }

  const cutoffDate = new Date(referenceNow.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const { backups } = await listBackups(config, {
    client: customClient,
    bucketName,
    prefix,
  });

  // Filter only standard backup archives older than cutoff
  const expiredBackups = backups.filter(
    (b) => b.isBackup && b.lastModified.getTime() < cutoffDate.getTime()
  );

  let totalFreedBytes = 0;
  for (const item of expiredBackups) {
    totalFreedBytes += item.size;
  }

  if (expiredBackups.length === 0 || dryRun) {
    return {
      pruned: expiredBackups.map((b) => ({
        key: b.key,
        name: b.name,
        size: b.size,
        lastModified: b.lastModified,
      })),
      prunedCount: expiredBackups.length,
      totalFreedBytes,
      cutoffDate,
      dryRun,
      errors: [],
    };
  }

  const client = customClient || createR2Client(config);
  const errors = [];
  const deletedKeys = new Set();

  // AWS S3 DeleteObjectsCommand allows up to 1000 objects per request
  const CHUNK_SIZE = 1000;
  for (let i = 0; i < expiredBackups.length; i += CHUNK_SIZE) {
    const chunk = expiredBackups.slice(i, i + CHUNK_SIZE);
    const deleteCommand = new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: {
        Objects: chunk.map((item) => ({ Key: item.key })),
        Quiet: false,
      },
    });

    try {
      const response = await client.send(deleteCommand);
      if (response.Deleted) {
        for (const d of response.Deleted) {
          if (d.Key) deletedKeys.add(d.Key);
        }
      }
      if (response.Errors && response.Errors.length > 0) {
        for (const errItem of response.Errors) {
          errors.push(`Failed to delete ${errItem.Key}: ${errItem.Code} - ${errItem.Message}`);
        }
      }
    } catch (err) {
      const sanitizer = createSanitizer(config);
      throw sanitizer(err);
    }
  }

  const actuallyPruned = expiredBackups.filter((b) => deletedKeys.has(b.key));
  let actualFreedBytes = 0;
  for (const item of actuallyPruned) {
    actualFreedBytes += item.size;
  }

  return {
    pruned: actuallyPruned.map((b) => ({
      key: b.key,
      name: b.name,
      size: b.size,
      lastModified: b.lastModified,
    })),
    prunedCount: actuallyPruned.length,
    totalFreedBytes: actualFreedBytes,
    cutoffDate,
    dryRun: false,
    errors,
  };
}

/**
 * Formats an array of backup objects into an ASCII table string.
 *
 * @param {Array<{ key: string, name: string, size: number, lastModified: Date, etag: string }>} backups
 * @returns {string}
 */
export function formatBackupListTable(backups = []) {
  if (!Array.isArray(backups) || backups.length === 0) {
    return 'No backups found in remote storage.';
  }

  const rows = backups.map((b) => {
    const dateStr = b.lastModified instanceof Date
      ? b.lastModified.toISOString().replace('T', ' ').substring(0, 19) + ' UTC'
      : String(b.lastModified);

    return {
      name: b.name || b.key,
      size: formatBytes(b.size),
      lastModified: dateStr,
      etag: b.etag || '-',
    };
  });

  const headers = {
    name: 'Backup Archive',
    size: 'Size',
    lastModified: 'Last Modified',
    etag: 'ETag',
  };

  const colWidths = {
    name: Math.max(headers.name.length, ...rows.map((r) => r.name.length)),
    size: Math.max(headers.size.length, ...rows.map((r) => r.size.length)),
    lastModified: Math.max(headers.lastModified.length, ...rows.map((r) => r.lastModified.length)),
    etag: Math.max(headers.etag.length, ...rows.map((r) => r.etag.length)),
  };

  const pad = (str, len) => str.padEnd(len, ' ');

  const headerLine = `${pad(headers.name, colWidths.name)}  ${pad(headers.size, colWidths.size)}  ${pad(headers.lastModified, colWidths.lastModified)}  ${pad(headers.etag, colWidths.etag)}`;
  const separatorLine = `${'-'.repeat(colWidths.name)}  ${'-'.repeat(colWidths.size)}  ${'-'.repeat(colWidths.lastModified)}  ${'-'.repeat(colWidths.etag)}`;

  const dataLines = rows.map(
    (r) => `${pad(r.name, colWidths.name)}  ${pad(r.size, colWidths.size)}  ${pad(r.lastModified, colWidths.lastModified)}  ${pad(r.etag, colWidths.etag)}`
  );

  return [headerLine, separatorLine, ...dataLines].join('\n');
}

/**
 * Downloads a backup archive from Cloudflare R2 bucket.
 * Streams content to destination path and verifies SHA-256 digest against object metadata.
 *
 * @param {string} key - S3 object key or archive filename
 * @param {string} destinationPath - Path where the downloaded file will be saved
 * @param {object} config - Application configuration object
 * @param {object} [options={}]
 * @param {S3Client} [options.client] - Optional pre-instantiated S3Client
 * @param {string} [options.bucketName] - Bucket name override
 * @returns {Promise<{
 *   key: string,
 *   bucket: string,
 *   destinationPath: string,
 *   size: number,
 *   sha256: string,
 *   etag: string,
 *   metadata: Record<string, string>,
 *   lastModified: Date
 * }>}
 */
export async function downloadBackup(key, destinationPath, config, options = {}) {
  const {
    client: customClient,
    bucketName = config?.r2?.bucketName || 'hermes-backups',
  } = options;

  if (!key || typeof key !== 'string') {
    throw new Error('Backup key must be a non-empty string');
  }
  if (!destinationPath || typeof destinationPath !== 'string') {
    throw new Error('Destination path must be a non-empty string');
  }

  const resolvedDest = path.resolve(destinationPath);
  const client = customClient || createR2Client(config);

  let objectKey = key.trim();
  if (!objectKey.startsWith('backups/') && !objectKey.includes('/')) {
    objectKey = `backups/${objectKey}`;
  }

  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
    });

    const response = await client.send(command);
    if (!response.Body) {
      throw new Error(`Empty response body for object: ${objectKey}`);
    }

    await fs.promises.mkdir(path.dirname(resolvedDest), { recursive: true });

    let bodyStream = response.Body;
    if (Buffer.isBuffer(bodyStream) || typeof bodyStream === 'string') {
      bodyStream = Readable.from(bodyStream);
    }

    const hash = crypto.createHash('sha256');
    const hashTransform = new Transform({
      transform(chunk, encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    const fileWriteStream = fs.createWriteStream(resolvedDest);
    await pipeline(bodyStream, hashTransform, fileWriteStream);

    const actualSha256 = hash.digest('hex');
    const fileStat = await fs.promises.stat(resolvedDest);

    // Normalize metadata headers (S3 returns metadata keys lowercased)
    const rawMetadata = response.Metadata || {};
    const metadata = {};
    for (const [k, v] of Object.entries(rawMetadata)) {
      metadata[k.toLowerCase()] = v;
    }

    const expectedSha256 = metadata.sha256;
    if (expectedSha256 && expectedSha256.toLowerCase() !== actualSha256.toLowerCase()) {
      try {
        await fs.promises.unlink(resolvedDest);
      } catch {
        // Ignore unlink failure
      }
      throw new Error(
        `SHA-256 checksum mismatch for ${objectKey}: expected ${expectedSha256}, got ${actualSha256}`
      );
    }

    return {
      key: objectKey,
      bucket: bucketName,
      destinationPath: resolvedDest,
      size: fileStat.size,
      sha256: actualSha256,
      etag: response.ETag ? response.ETag.replace(/^"|"$/g, '') : '',
      metadata,
      lastModified: response.LastModified instanceof Date ? response.LastModified : new Date(response.LastModified || 0),
    };
  } catch (err) {
    try {
      if (fs.existsSync(resolvedDest)) {
        await fs.promises.unlink(resolvedDest);
      }
    } catch {
      // Ignore cleanup error
    }

    const sanitizer = createSanitizer(config);
    throw sanitizer(err);
  }
}

/**
 * Resolves the latest backup archive from Cloudflare R2 bucket.
 *
 * @param {object} config - Application configuration object
 * @param {object} [options={}]
 * @param {S3Client} [options.client] - Optional pre-instantiated S3Client
 * @param {string} [options.bucketName] - Bucket name override
 * @param {string} [options.prefix='backups/'] - Prefix filter for objects
 * @returns {Promise<{
 *   key: string,
 *   name: string,
 *   size: number,
 *   lastModified: Date,
 *   etag: string,
 *   isBackup: boolean
 * } | null>}
 */
export async function getLatestBackup(config, options = {}) {
  const result = await listBackups(config, options);
  const backups = result.backups.filter((b) => b.isBackup);
  if (backups.length === 0) {
    return null;
  }
  return backups[0];
}
