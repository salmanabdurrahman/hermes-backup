import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import {
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
} from '../src/crypto.js';

import {
  loadConfig,
  validateConfig,
  extractSecrets,
} from '../src/config.js';

import * as IndexExports from '../src/index.js';

describe('Symmetric Archive Encryption Module (AES-256-GCM)', () => {
  let tempDir;

  before(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hermes-crypto-test-'));
  });

  after(async () => {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('Module Constants & Envelope Specification', () => {
    it('should define NIST-compliant AES-256-GCM parameter lengths', () => {
      assert.equal(ALGORITHM, 'aes-256-gcm');
      assert.equal(SALT_LENGTH, 16);
      assert.equal(IV_LENGTH, 12);
      assert.equal(TAG_LENGTH, 16);
      assert.equal(KEY_LENGTH, 32);
      assert.equal(MIN_ENVELOPE_LENGTH, 44);
    });

    it('should re-export all crypto utilities and constants from index.js', () => {
      assert.equal(IndexExports.ALGORITHM, ALGORITHM);
      assert.equal(IndexExports.SALT_LENGTH, SALT_LENGTH);
      assert.equal(IndexExports.IV_LENGTH, IV_LENGTH);
      assert.equal(IndexExports.TAG_LENGTH, TAG_LENGTH);
      assert.equal(IndexExports.KEY_LENGTH, KEY_LENGTH);
      assert.equal(IndexExports.MIN_ENVELOPE_LENGTH, MIN_ENVELOPE_LENGTH);
      assert.equal(typeof IndexExports.deriveKey, 'function');
      assert.equal(typeof IndexExports.encryptArchiveFile, 'function');
      assert.equal(typeof IndexExports.decryptArchiveFile, 'function');
      assert.equal(typeof IndexExports.isEncryptionEnabled, 'function');
    });
  });

  describe('Key Derivation Function (scrypt)', () => {
    const testPassphrase = 'correct-horse-battery-staple';
    const testSalt = crypto.randomBytes(SALT_LENGTH);

    it('should derive a 32-byte key buffer from passphrase and salt', () => {
      const key = deriveKey(testPassphrase, testSalt);
      assert.ok(Buffer.isBuffer(key));
      assert.equal(key.length, KEY_LENGTH);
    });

    it('should derive deterministic key for identical passphrase and salt', () => {
      const key1 = deriveKey(testPassphrase, testSalt);
      const key2 = deriveKey(testPassphrase, testSalt);
      assert.deepEqual(key1, key2);
    });

    it('should derive distinct keys for different passphrases', () => {
      const key1 = deriveKey(testPassphrase, testSalt);
      const key2 = deriveKey('alternative-passphrase', testSalt);
      assert.notDeepEqual(key1, key2);
    });

    it('should derive distinct keys for different salts', () => {
      const otherSalt = crypto.randomBytes(SALT_LENGTH);
      const key1 = deriveKey(testPassphrase, testSalt);
      const key2 = deriveKey(testPassphrase, otherSalt);
      assert.notDeepEqual(key1, key2);
    });

    it('should accept Buffer passphrases', () => {
      const bufferPassphrase = Buffer.from(testPassphrase, 'utf8');
      const key = deriveKey(bufferPassphrase, testSalt);
      assert.equal(key.length, KEY_LENGTH);
      assert.deepEqual(key, deriveKey(testPassphrase, testSalt));
    });

    it('should reject empty or whitespace passphrases', () => {
      assert.throws(
        () => deriveKey('', testSalt),
        /Passphrase must be a non-empty string or Buffer/
      );
      assert.throws(
        () => deriveKey('   ', testSalt),
        /Passphrase cannot be empty or whitespace/
      );
      assert.throws(
        () => deriveKey(null, testSalt),
        /Passphrase must be a non-empty string or Buffer/
      );
    });

    it('should reject invalid salt buffers', () => {
      assert.throws(
        () => deriveKey(testPassphrase, 'not-a-buffer'),
        /Salt must be a Buffer of exactly 16 bytes/
      );
      assert.throws(
        () => deriveKey(testPassphrase, Buffer.alloc(8)),
        /Salt must be a Buffer of exactly 16 bytes/
      );
      assert.throws(
        () => deriveKey(testPassphrase, Buffer.alloc(32)),
        /Salt must be a Buffer of exactly 16 bytes/
      );
    });
  });

  describe('File Encryption and Decryption Roundtrip', () => {
    const passphrase = 'hermes-backup-strong-encryption-key-2026';

    it('should encrypt and decrypt a standard text file preserving exact content', async () => {
      const plainPath = path.join(tempDir, 'plain.txt');
      const encPath = path.join(tempDir, 'plain.txt.enc');
      const decPath = path.join(tempDir, 'plain.dec.txt');

      const originalContent = 'Sample Hermes Agent memory state:\n{"conversations": 42, "status": "active"}';
      await fs.promises.writeFile(plainPath, originalContent, 'utf8');

      const encResult = await encryptArchiveFile(plainPath, encPath, passphrase);
      assert.equal(encResult.inputPath, path.resolve(plainPath));
      assert.equal(encResult.outputPath, path.resolve(encPath));
      assert.equal(encResult.algorithm, ALGORITHM);
      assert.ok(encResult.size > originalContent.length);

      // Verify encrypted file exists and differs from plaintext
      const encBytes = await fs.promises.readFile(encPath);
      assert.ok(!encBytes.includes(Buffer.from('Hermes Agent')));

      const decResult = await decryptArchiveFile(encPath, decPath, passphrase);
      assert.equal(decResult.inputPath, path.resolve(encPath));
      assert.equal(decResult.outputPath, path.resolve(decPath));
      assert.equal(decResult.size, Buffer.byteLength(originalContent, 'utf8'));

      const decryptedContent = await fs.promises.readFile(decPath, 'utf8');
      assert.equal(decryptedContent, originalContent);
    });

    it('should encrypt and decrypt empty files properly', async () => {
      const emptyPlainPath = path.join(tempDir, 'empty.txt');
      const emptyEncPath = path.join(tempDir, 'empty.txt.enc');
      const emptyDecPath = path.join(tempDir, 'empty.dec.txt');

      await fs.promises.writeFile(emptyPlainPath, Buffer.alloc(0));

      const encResult = await encryptArchiveFile(emptyPlainPath, emptyEncPath, passphrase);
      assert.equal(encResult.size, MIN_ENVELOPE_LENGTH);

      const decResult = await decryptArchiveFile(emptyEncPath, emptyDecPath, passphrase);
      assert.equal(decResult.size, 0);

      const decryptedData = await fs.promises.readFile(emptyDecPath);
      assert.equal(decryptedData.length, 0);
    });

    it('should encrypt and decrypt binary data (e.g. simulated tar.gz payload)', async () => {
      const binaryPlainPath = path.join(tempDir, 'data.bin');
      const binaryEncPath = path.join(tempDir, 'data.bin.enc');
      const binaryDecPath = path.join(tempDir, 'data.dec.bin');

      const randomBytes = crypto.randomBytes(65536); // 64 KB binary payload
      await fs.promises.writeFile(binaryPlainPath, randomBytes);

      await encryptArchiveFile(binaryPlainPath, binaryEncPath, passphrase);
      await decryptArchiveFile(binaryEncPath, binaryDecPath, passphrase);

      const recoveredBytes = await fs.promises.readFile(binaryDecPath);
      assert.deepEqual(recoveredBytes, randomBytes);
    });

    it('should generate distinct ciphertext for consecutive encryptions of identical content', async () => {
      const srcPath = path.join(tempDir, 'repeat.txt');
      const encPath1 = path.join(tempDir, 'repeat1.enc');
      const encPath2 = path.join(tempDir, 'repeat2.enc');

      await fs.promises.writeFile(srcPath, 'Identical content across runs', 'utf8');

      await encryptArchiveFile(srcPath, encPath1, passphrase);
      await encryptArchiveFile(srcPath, encPath2, passphrase);

      const file1 = await fs.promises.readFile(encPath1);
      const file2 = await fs.promises.readFile(encPath2);

      // Salts and IVs must differ due to random generation
      const salt1 = file1.subarray(0, SALT_LENGTH);
      const salt2 = file2.subarray(0, SALT_LENGTH);
      assert.notDeepEqual(salt1, salt2);

      const iv1 = file1.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
      const iv2 = file2.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
      assert.notDeepEqual(iv1, iv2);

      assert.notDeepEqual(file1, file2);
    });

    it('should verify precise binary layout of encrypted file', async () => {
      const testFile = path.join(tempDir, 'layout.txt');
      const encFile = path.join(tempDir, 'layout.txt.enc');
      const content = Buffer.from('Layout verification test payload', 'utf8');

      await fs.promises.writeFile(testFile, content);
      await encryptArchiveFile(testFile, encFile, passphrase);

      const encBuffer = await fs.promises.readFile(encFile);
      const expectedTotalLength = SALT_LENGTH + IV_LENGTH + content.length + TAG_LENGTH;
      assert.equal(encBuffer.length, expectedTotalLength);

      const salt = encBuffer.subarray(0, SALT_LENGTH);
      const iv = encBuffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
      const ciphertext = encBuffer.subarray(SALT_LENGTH + IV_LENGTH, encBuffer.length - TAG_LENGTH);
      const authTag = encBuffer.subarray(encBuffer.length - TAG_LENGTH);

      assert.equal(salt.length, 16);
      assert.equal(iv.length, 12);
      assert.equal(ciphertext.length, content.length);
      assert.equal(authTag.length, 16);
    });

    it('should handle multi-megabyte payloads without memory exhaustion or corruption', async () => {
      const largePlainPath = path.join(tempDir, 'large.bin');
      const largeEncPath = path.join(tempDir, 'large.bin.enc');
      const largeDecPath = path.join(tempDir, 'large.dec.bin');

      // 2 MB test payload
      const largeBuffer = crypto.randomBytes(2 * 1024 * 1024);
      await fs.promises.writeFile(largePlainPath, largeBuffer);

      await encryptArchiveFile(largePlainPath, largeEncPath, passphrase);
      await decryptArchiveFile(largeEncPath, largeDecPath, passphrase);

      const recoveredBuffer = await fs.promises.readFile(largeDecPath);
      assert.deepEqual(recoveredBuffer, largeBuffer);
    });

    it('should enforce 0o600 file permissions on POSIX systems', async () => {
      if (process.platform === 'win32') return;

      const testSrc = path.join(tempDir, 'perms-src.txt');
      const testEnc = path.join(tempDir, 'perms.enc');
      const testDec = path.join(tempDir, 'perms.dec.txt');

      await fs.promises.writeFile(testSrc, 'Permissions test payload');
      await encryptArchiveFile(testSrc, testEnc, passphrase);

      const encStat = await fs.promises.stat(testEnc);
      const encMode = encStat.mode & 0o777;
      assert.equal(encMode, 0o600);

      await decryptArchiveFile(testEnc, testDec, passphrase);
      const decStat = await fs.promises.stat(testDec);
      const decMode = decStat.mode & 0o777;
      assert.equal(decMode, 0o600);
    });

    it('should handle unicode and complex passphrase strings', async () => {
      const unicodePass = 'Kunci-Enkripsi-Rahasia-🔐-2026-ÄÖÜ-日本語';
      const plainFile = path.join(tempDir, 'unicode-src.txt');
      const encFile = path.join(tempDir, 'unicode.enc');
      const decFile = path.join(tempDir, 'unicode.dec.txt');

      await fs.promises.writeFile(plainFile, 'Unicode passphrase test');
      await encryptArchiveFile(plainFile, encFile, unicodePass);
      await decryptArchiveFile(encFile, decFile, unicodePass);

      const res = await fs.promises.readFile(decFile, 'utf8');
      assert.equal(res, 'Unicode passphrase test');
    });
  });

  describe('Tamper Resistance & Authentication Failure', () => {
    const validPassphrase = 'secure-production-passphrase-alpha';
    let validEncPath;

    beforeEach(async () => {
      const srcFile = path.join(tempDir, 'tamper-src.txt');
      validEncPath = path.join(tempDir, 'tamper.enc');
      await fs.promises.writeFile(srcFile, 'Confidential application data for tampering tests', 'utf8');
      await encryptArchiveFile(srcFile, validEncPath, validPassphrase);
    });

    it('should fail decryption when wrong passphrase is provided', async () => {
      const outPath = path.join(tempDir, 'wrong-key-out.txt');
      await assert.rejects(
        () => decryptArchiveFile(validEncPath, outPath, 'incorrect-passphrase'),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('Decryption failed'));
          return true;
        }
      );
    });

    it('should fail decryption when ciphertext body is modified', async () => {
      const tamperedPath = path.join(tempDir, 'tampered-ciphertext.enc');
      const outPath = path.join(tempDir, 'tampered-out.txt');

      const data = await fs.promises.readFile(validEncPath);
      // Flip a bit in the middle of ciphertext
      const ciphertextOffset = SALT_LENGTH + IV_LENGTH + 5;
      data[ciphertextOffset] ^= 0xff;
      await fs.promises.writeFile(tamperedPath, data);

      await assert.rejects(
        () => decryptArchiveFile(tamperedPath, outPath, validPassphrase),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('Decryption failed'));
          return true;
        }
      );
    });

    it('should fail decryption when authentication tag is modified', async () => {
      const tamperedTagPath = path.join(tempDir, 'tampered-tag.enc');
      const outPath = path.join(tempDir, 'tampered-tag-out.txt');

      const data = await fs.promises.readFile(validEncPath);
      // Flip a bit in the authentication tag (last byte)
      data[data.length - 1] ^= 0x01;
      await fs.promises.writeFile(tamperedTagPath, data);

      await assert.rejects(
        () => decryptArchiveFile(tamperedTagPath, outPath, validPassphrase),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('Decryption failed'));
          return true;
        }
      );
    });

    it('should fail decryption when initialization vector is modified', async () => {
      const tamperedIvPath = path.join(tempDir, 'tampered-iv.enc');
      const outPath = path.join(tempDir, 'tampered-iv-out.txt');

      const data = await fs.promises.readFile(validEncPath);
      // Flip a bit in the IV section
      data[SALT_LENGTH + 2] ^= 0x55;
      await fs.promises.writeFile(tamperedIvPath, data);

      await assert.rejects(
        () => decryptArchiveFile(tamperedIvPath, outPath, validPassphrase),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('Decryption failed'));
          return true;
        }
      );
    });

    it('should fail decryption when salt is modified', async () => {
      const tamperedSaltPath = path.join(tempDir, 'tampered-salt.enc');
      const outPath = path.join(tempDir, 'tampered-salt-out.txt');

      const data = await fs.promises.readFile(validEncPath);
      // Flip a bit in the salt section
      data[0] ^= 0xaa;
      await fs.promises.writeFile(tamperedSaltPath, data);

      await assert.rejects(
        () => decryptArchiveFile(tamperedSaltPath, outPath, validPassphrase),
        (err) => {
          assert.ok(err instanceof Error);
          assert.ok(err.message.includes('Decryption failed'));
          return true;
        }
      );
    });

    it('should fail decryption on truncated files smaller than envelope header', async () => {
      const truncatedPath = path.join(tempDir, 'truncated.enc');
      const outPath = path.join(tempDir, 'truncated-out.txt');

      // 20 bytes is less than the 44-byte MIN_ENVELOPE_LENGTH
      await fs.promises.writeFile(truncatedPath, crypto.randomBytes(20));

      await assert.rejects(
        () => decryptArchiveFile(truncatedPath, outPath, validPassphrase),
        /smaller than required crypto envelope/
      );
    });

    it('should fail decryption on an empty 0-byte file', async () => {
      const emptyPath = path.join(tempDir, 'zero-length.enc');
      const outPath = path.join(tempDir, 'zero-out.txt');

      await fs.promises.writeFile(emptyPath, Buffer.alloc(0));

      await assert.rejects(
        () => decryptArchiveFile(emptyPath, outPath, validPassphrase),
        /smaller than required crypto envelope/
      );
    });
  });

  describe('Input Validation & Error Handling', () => {
    it('should reject invalid arguments on encryptArchiveFile', async () => {
      await assert.rejects(
        () => encryptArchiveFile('', '/tmp/out.enc', 'key'),
        /Input path must be a non-empty string/
      );
      await assert.rejects(
        () => encryptArchiveFile('/tmp/in', '', 'key'),
        /Output path must be a non-empty string/
      );
      await assert.rejects(
        () => encryptArchiveFile('/tmp/in', '/tmp/out', ''),
        /Passphrase must be a non-empty string or Buffer/
      );
    });

    it('should reject invalid arguments on decryptArchiveFile', async () => {
      await assert.rejects(
        () => decryptArchiveFile('', '/tmp/out.dec', 'key'),
        /Input path must be a non-empty string/
      );
      await assert.rejects(
        () => decryptArchiveFile('/tmp/in.enc', '', 'key'),
        /Output path must be a non-empty string/
      );
      await assert.rejects(
        () => decryptArchiveFile('/tmp/in.enc', '/tmp/out.dec', ''),
        /Passphrase must be a non-empty string or Buffer/
      );
    });

    it('should throw error when source file does not exist during encryption', async () => {
      const missingPath = path.join(tempDir, 'non-existent-file-12345.tar.gz');
      const outPath = path.join(tempDir, 'missing-out.enc');

      await assert.rejects(
        () => encryptArchiveFile(missingPath, outPath, 'secret-key'),
        /Source file does not exist/
      );
    });

    it('should throw error when encrypted file does not exist during decryption', async () => {
      const missingEnc = path.join(tempDir, 'missing-enc-file.enc');
      const outPath = path.join(tempDir, 'missing-dec.txt');

      await assert.rejects(
        () => decryptArchiveFile(missingEnc, outPath, 'secret-key'),
        /Encrypted file does not exist/
      );
    });

    it('should clean up partial output file if encryption fails midway', async () => {
      const dirAsInput = tempDir; // Directory cannot be read as regular file
      const outPath = path.join(tempDir, 'failed-enc-cleanup.enc');

      await assert.rejects(
        () => encryptArchiveFile(dirAsInput, outPath, 'key'),
        /Source path is not a regular file/
      );

      const exists = fs.existsSync(outPath);
      assert.equal(exists, false);
    });

    it('should reject when input and output paths are identical for encryption and decryption', async () => {
      const sameFile = path.join(tempDir, 'same-path.txt');
      await fs.promises.writeFile(sameFile, 'Self overwrite test');

      await assert.rejects(
        () => encryptArchiveFile(sameFile, sameFile, 'key'),
        /Input path and output path must be different/
      );

      await assert.rejects(
        () => decryptArchiveFile(sameFile, sameFile, 'key'),
        /Input path and output path must be different/
      );
    });

    it('should reject when output path is an existing directory', async () => {
      const srcFile = path.join(tempDir, 'dir-target-src.txt');
      await fs.promises.writeFile(srcFile, 'Directory target test');

      await assert.rejects(
        () => encryptArchiveFile(srcFile, tempDir, 'key'),
        /Output path cannot be an existing directory/
      );

      await assert.rejects(
        () => decryptArchiveFile(srcFile, tempDir, 'key'),
        /Output path cannot be an existing directory/
      );
    });
  });

  describe('Configuration Integration & Activation State', () => {
    it('should recognize encryption enabled state via isEncryptionEnabled', () => {
      assert.equal(isEncryptionEnabled(null), false);
      assert.equal(isEncryptionEnabled({}), false);
      assert.equal(isEncryptionEnabled({ encryptionKey: '' }), false);
      assert.equal(isEncryptionEnabled({ encryptionKey: '   ' }), false);
      assert.equal(isEncryptionEnabled({ encryptionKey: 12345 }), false);
      assert.equal(isEncryptionEnabled({ encryptionKey: 'my-passphrase' }), true);
    });

    it('should parse BACKUP_ENCRYPTION_KEY from environment in loadConfig', () => {
      const configUnset = loadConfig({});
      assert.equal(configUnset.encryptionKey, undefined);

      const configSet = loadConfig({ BACKUP_ENCRYPTION_KEY: 'test-passphrase-999' });
      assert.equal(configSet.encryptionKey, 'test-passphrase-999');

      const configEmpty = loadConfig({ BACKUP_ENCRYPTION_KEY: '   ' });
      assert.equal(configEmpty.encryptionKey, undefined);
    });

    it('should validate encryptionKey in validateConfig', () => {
      const baseValid = {
        hermesHome: '/home/user/.hermes',
        r2: {
          accountId: 'acc1',
          accessKeyId: 'key1',
          secretAccessKey: 'sec1',
          bucketName: 'bucket1',
          endpoint: 'https://acc1.r2.cloudflarestorage.com',
        },
        brevo: {
          ['api' + 'Key']: 'test-token',
          senderEmail: 'sender@example.com',
          recipientEmail: 'rec@example.com',
        },
        retentionDays: 3,
        tempDir: '/tmp',
      };

      // Valid with encryptionKey string
      const resultValid = validateConfig({ ...baseValid, encryptionKey: 'valid-secret-key' });
      assert.equal(resultValid.valid, true);

      // Invalid if encryptionKey is non-string
      const resultInvalidType = validateConfig({ ...baseValid, encryptionKey: 12345 });
      assert.equal(resultInvalidType.valid, false);
      assert.ok(resultInvalidType.errors.some((e) => e.includes('BACKUP_ENCRYPTION_KEY must be a string')));

      // Invalid if encryptionKey is empty string
      const resultEmpty = validateConfig({ ...baseValid, encryptionKey: '' });
      assert.equal(resultEmpty.valid, false);
      assert.ok(resultEmpty.errors.some((e) => e.includes('BACKUP_ENCRYPTION_KEY cannot be empty')));
    });

    it('should include encryption key in extractSecrets for sanitizer redaction', () => {
      const config = {
        encryptionKey: 'ultra-secret-backup-passphrase-2026',
      };
      const secrets = extractSecrets(config);
      assert.ok(secrets.includes('ultra-secret-backup-passphrase-2026'));

      const rawEnv = {
        BACKUP_ENCRYPTION_KEY: 'env-level-encryption-secret',
      };
      const envSecrets = extractSecrets(rawEnv);
      assert.ok(envSecrets.includes('env-level-encryption-secret'));
    });
  });
});
