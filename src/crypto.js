import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * Standard cipher algorithm (AES-256 in Galois/Counter Mode).
 */
export const ALGORITHM = 'aes-256-gcm';

/**
 * Byte length of the random salt for scrypt key derivation.
 */
export const SALT_LENGTH = 16;

/**
 * Byte length of the random Initialization Vector (IV) for AES-GCM.
 */
export const IV_LENGTH = 12;

/**
 * Byte length of the GCM authentication tag.
 */
export const TAG_LENGTH = 16;

/**
 * Byte length of the derived symmetric key (256 bits).
 */
export const KEY_LENGTH = 32;

/**
 * Minimum total byte length of an encrypted archive envelope (Salt + IV + Tag).
 */
export const MIN_ENVELOPE_LENGTH = SALT_LENGTH + IV_LENGTH + TAG_LENGTH;

/**
 * Derives a 32-byte cryptographic key using scrypt.
 *
 * @param {string | Buffer} passphrase - Secret passphrase or key material
 * @param {Buffer} salt - 16-byte random salt
 * @returns {Buffer} 32-byte derived key
 */
export function deriveKey(passphrase, salt) {
  if (!passphrase || (typeof passphrase !== 'string' && !Buffer.isBuffer(passphrase))) {
    throw new Error('Passphrase must be a non-empty string or Buffer');
  }
  if (typeof passphrase === 'string' && passphrase.trim().length === 0) {
    throw new Error('Passphrase cannot be empty or whitespace');
  }
  if (!salt || !Buffer.isBuffer(salt) || salt.length !== SALT_LENGTH) {
    throw new Error(`Salt must be a Buffer of exactly ${SALT_LENGTH} bytes`);
  }

  return crypto.scryptSync(passphrase, salt, KEY_LENGTH);
}

/**
 * Encrypts a local archive file using AES-256-GCM.
 * Binary envelope layout: [16-byte Salt][12-byte IV][Ciphertext...][16-byte Auth Tag]
 *
 * @param {string} inputPath - Path to plaintext archive file
 * @param {string} outputPath - Path to write encrypted archive file
 * @param {string | Buffer} passphrase - Encryption passphrase
 * @returns {Promise<{ inputPath: string, outputPath: string, size: number, algorithm: string }>}
 */
export async function encryptArchiveFile(inputPath, outputPath, passphrase) {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Input path must be a non-empty string');
  }
  if (!outputPath || typeof outputPath !== 'string') {
    throw new Error('Output path must be a non-empty string');
  }
  if (!passphrase || (typeof passphrase !== 'string' && !Buffer.isBuffer(passphrase))) {
    throw new Error('Passphrase must be a non-empty string or Buffer');
  }
  if (typeof passphrase === 'string' && passphrase.trim().length === 0) {
    throw new Error('Passphrase cannot be empty or whitespace');
  }

  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputPath);

  if (resolvedInput === resolvedOutput) {
    throw new Error('Input path and output path must be different');
  }

  try {
    const outStat = await fs.promises.stat(resolvedOutput);
    if (outStat.isDirectory()) {
      throw new Error(`Output path cannot be an existing directory: ${resolvedOutput}`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  let inputStat;
  try {
    inputStat = await fs.promises.stat(resolvedInput);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Source file does not exist: ${resolvedInput}`);
    }
    throw err;
  }

  if (!inputStat.isFile()) {
    throw new Error(`Source path is not a regular file: ${resolvedInput}`);
  }

  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  await fs.promises.mkdir(path.dirname(resolvedOutput), { recursive: true });

  const inputStream = fs.createReadStream(resolvedInput);
  const outputStream = fs.createWriteStream(resolvedOutput, { mode: 0o600 });

  try {
    outputStream.write(salt);
    outputStream.write(iv);

    await pipeline(inputStream, cipher, outputStream);

    const authTag = cipher.getAuthTag();
    await fs.promises.appendFile(resolvedOutput, authTag);

    const outputStat = await fs.promises.stat(resolvedOutput);
    return {
      inputPath: resolvedInput,
      outputPath: resolvedOutput,
      size: outputStat.size,
      algorithm: ALGORITHM,
    };
  } catch (err) {
    try {
      await fs.promises.unlink(resolvedOutput);
    } catch {
      // Ignore cleanup error if output file was not created
    }
    throw err;
  }
}

/**
 * Decrypts an encrypted archive file using AES-256-GCM.
 * Validates cryptographic authentication tag before accepting plaintext.
 *
 * @param {string} inputPath - Path to encrypted archive file
 * @param {string} outputPath - Path to write decrypted plaintext file
 * @param {string | Buffer} passphrase - Encryption passphrase
 * @returns {Promise<{ inputPath: string, outputPath: string, size: number }>}
 */
export async function decryptArchiveFile(inputPath, outputPath, passphrase) {
  if (!inputPath || typeof inputPath !== 'string') {
    throw new Error('Input path must be a non-empty string');
  }
  if (!outputPath || typeof outputPath !== 'string') {
    throw new Error('Output path must be a non-empty string');
  }
  if (!passphrase || (typeof passphrase !== 'string' && !Buffer.isBuffer(passphrase))) {
    throw new Error('Passphrase must be a non-empty string or Buffer');
  }
  if (typeof passphrase === 'string' && passphrase.trim().length === 0) {
    throw new Error('Passphrase cannot be empty or whitespace');
  }

  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputPath);

  if (resolvedInput === resolvedOutput) {
    throw new Error('Input path and output path must be different');
  }

  try {
    const outStat = await fs.promises.stat(resolvedOutput);
    if (outStat.isDirectory()) {
      throw new Error(`Output path cannot be an existing directory: ${resolvedOutput}`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  let fileBuffer;
  try {
    fileBuffer = await fs.promises.readFile(resolvedInput);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(`Encrypted file does not exist: ${resolvedInput}`);
    }
    throw err;
  }

  if (fileBuffer.length < MIN_ENVELOPE_LENGTH) {
    throw new Error(
      `Invalid encrypted file: size (${fileBuffer.length} bytes) is smaller than required crypto envelope (${MIN_ENVELOPE_LENGTH} bytes)`
    );
  }

  const salt = fileBuffer.subarray(0, SALT_LENGTH);
  const iv = fileBuffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = fileBuffer.subarray(fileBuffer.length - TAG_LENGTH);
  const ciphertext = fileBuffer.subarray(
    SALT_LENGTH + IV_LENGTH,
    fileBuffer.length - TAG_LENGTH
  );

  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted;
  try {
    decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
  } catch (err) {
    throw new Error(
      `Decryption failed: authentication check failed or incorrect key (${err.message})`,
      { cause: err }
    );
  }

  await fs.promises.mkdir(path.dirname(resolvedOutput), { recursive: true });
  await fs.promises.writeFile(resolvedOutput, decrypted, { mode: 0o600 });

  return {
    inputPath: resolvedInput,
    outputPath: resolvedOutput,
    size: decrypted.length,
  };
}

/**
 * Checks whether client-side archive encryption is activated in configuration.
 *
 * @param {object} [config] - Application configuration object
 * @returns {boolean} True if encryptionKey is configured
 */
export function isEncryptionEnabled(config) {
  if (!config) return false;
  const key = config.encryptionKey;
  return typeof key === 'string' && key.trim().length > 0;
}
