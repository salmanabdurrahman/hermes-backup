import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
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

  const clientConfig = {
    region: 'auto',
    endpoint: config.r2.endpoint,
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
 * @param {string} [options.contentType='application/gzip'] - MIME content type
 * @param {boolean} [options.dryRun=false] - If true, skips network upload
 * @returns {Promise<{
 *   key: string,
 *   bucket: string,
 *   size: number,
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

  if (dryRun) {
    return {
      key: objectKey,
      bucket: bucketName,
      size: fileStat.size,
      etag: '"dry-run-etag"',
      timestamp: nowIso,
      dryRun: true,
    };
  }

  const client = customClient || createR2Client(config);

  const mergedMetadata = {
    hostname: os.hostname(),
    timestamp: nowIso,
    ...(typeof uncompressedSize === 'number' && uncompressedSize >= 0
      ? { 'uncompressed-size': String(uncompressedSize) }
      : {}),
    ...metadata,
  };

  // Convert all metadata values to strings as required by S3 API
  const stringMetadata = {};
  for (const [k, v] of Object.entries(mergedMetadata)) {
    if (v !== undefined && v !== null) {
      stringMetadata[k.toLowerCase()] = String(v);
    }
  }

  const fileStream = fs.createReadStream(resolvedPath);

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: objectKey,
    Body: fileStream,
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
