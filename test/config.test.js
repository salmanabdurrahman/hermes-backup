import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, validateConfig, extractSecrets, isValidEmail } from '../src/config.js';
import { createSanitizer, sanitize, normalizeSecrets } from '../src/sanitizer.js';

describe('Config Loader & Validator', () => {
  it('should load default configuration when environment is empty', () => {
    const config = loadConfig({});
    assert.equal(config.hermesHome, path.join(os.homedir(), '.hermes'));
    assert.equal(config.r2.accountId, '');
    assert.equal(config.r2.accessKeyId, '');
    assert.equal(config.r2.secretAccessKey, '');
    assert.equal(config.r2.bucketName, 'hermes-backups');
    assert.equal(config.r2.endpoint, '');
    assert.equal(config.brevo.apiKey, '');
    assert.equal(config.brevo.senderName, 'Hermes Backup Bot');
    assert.equal(config.brevo.senderEmail, '');
    assert.equal(config.brevo.recipientEmail, '');
    assert.equal(config.retentionDays, 3);
    assert.equal(config.tempDir, '/tmp');
  });

  it('should derive R2 endpoint from R2_ACCOUNT_ID when R2_ENDPOINT is omitted', () => {
    const config = loadConfig({
      R2_ACCOUNT_ID: 'abc123def456',
    });
    assert.equal(config.r2.endpoint, 'https://abc123def456.r2.cloudflarestorage.com');
  });

  it('should preserve explicit R2_ENDPOINT override when provided', () => {
    const config = loadConfig({
      R2_ACCOUNT_ID: 'abc123def456',
      R2_ENDPOINT: 'https://custom.endpoint.example.com',
    });
    assert.equal(config.r2.endpoint, 'https://custom.endpoint.example.com');
  });

  it('should expand template variables in R2_ENDPOINT if present', () => {
    const config = loadConfig({
      R2_ACCOUNT_ID: 'abc123def456',
      R2_ENDPOINT: 'https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
    });
    assert.equal(config.r2.endpoint, 'https://abc123def456.r2.cloudflarestorage.com');
  });

  it('should load custom environment overrides properly', () => {
    const customEnv = {
      HERMES_HOME: '/custom/hermes/path',
      R2_ACCOUNT_ID: 'r2-acc-id',
      R2_ACCESS_KEY_ID: 'r2-key-id',
      R2_SECRET_ACCESS_KEY: 'r2-secret-key',
      R2_BUCKET_NAME: 'custom-bucket',
      R2_ENDPOINT: 'https://custom-endpoint.com',
      BREVO_API_KEY: 'xkeysib-test-api-key',
      BREVO_SENDER_NAME: 'Custom Alert Bot',
      BREVO_SENDER_EMAIL: 'sender@example.com',
      BREVO_RECIPIENT_EMAIL: 'recipient@example.com',
      BACKUP_RETENTION_DAYS: '7',
      BACKUP_TEMP_DIR: '/var/tmp',
    };

    const config = loadConfig(customEnv);
    assert.equal(config.hermesHome, '/custom/hermes/path');
    assert.equal(config.r2.accountId, 'r2-acc-id');
    assert.equal(config.r2.accessKeyId, 'r2-key-id');
    assert.equal(config.r2.secretAccessKey, 'r2-secret-key');
    assert.equal(config.r2.bucketName, 'custom-bucket');
    assert.equal(config.r2.endpoint, 'https://custom-endpoint.com');
    assert.equal(config.brevo.apiKey, 'xkeysib-test-api-key');
    assert.equal(config.brevo.senderName, 'Custom Alert Bot');
    assert.equal(config.brevo.senderEmail, 'sender@example.com');
    assert.equal(config.brevo.recipientEmail, 'recipient@example.com');
    assert.equal(config.retentionDays, 7);
    assert.equal(config.tempDir, '/var/tmp');
  });

  it('should handle invalid BACKUP_RETENTION_DAYS by falling back to 3', () => {
    const config = loadConfig({ BACKUP_RETENTION_DAYS: '-5' });
    assert.equal(config.retentionDays, 3);

    const configInvalidStr = loadConfig({ BACKUP_RETENTION_DAYS: 'not-a-number' });
    assert.equal(configInvalidStr.retentionDays, 3);
  });

  it('should validate email format accurately', () => {
    assert.equal(isValidEmail('admin@example.com'), true);
    assert.equal(isValidEmail('user.name+tag@sub.domain.org'), true);
    assert.equal(isValidEmail('invalid-email'), false);
    assert.equal(isValidEmail('@nodomain.com'), false);
    assert.equal(isValidEmail('user@'), false);
    assert.equal(isValidEmail(''), false);
    assert.equal(isValidEmail(null), false);
  });

  it('should pass validation when all required fields are present and valid', () => {
    const validConfig = {
      hermesHome: '/home/salmanabd/.hermes',
      r2: {
        accountId: 'acc123',
        accessKeyId: 'key123',
        secretAccessKey: 'sec123',
        bucketName: 'hermes-backups',
        endpoint: 'https://acc123.r2.cloudflarestorage.com',
      },
      brevo: {
        apiKey: 'xkeysib-key',
        senderName: 'Bot',
        senderEmail: 'bot@example.com',
        recipientEmail: 'admin@example.com',
      },
      retentionDays: 3,
      tempDir: '/tmp',
    };

    const result = validateConfig(validConfig);
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('should collect errors on missing required fields', () => {
    const invalidConfig = {
      hermesHome: '',
      r2: {
        accountId: '',
        accessKeyId: '',
        secretAccessKey: '',
        bucketName: '',
        endpoint: '',
      },
      brevo: {
        apiKey: '',
        senderEmail: 'invalid-email',
        recipientEmail: '',
      },
      retentionDays: 0,
      tempDir: '',
    };

    const result = validateConfig(invalidConfig);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('HERMES_HOME')));
    assert.ok(result.errors.some((e) => e.includes('R2_ACCESS_KEY_ID')));
    assert.ok(result.errors.some((e) => e.includes('R2_SECRET_ACCESS_KEY')));
    assert.ok(result.errors.some((e) => e.includes('R2_BUCKET_NAME')));
    assert.ok(result.errors.some((e) => e.includes('BREVO_API_KEY')));
    assert.ok(result.errors.some((e) => e.includes('BREVO_SENDER_EMAIL')));
    assert.ok(result.errors.some((e) => e.includes('BREVO_RECIPIENT_EMAIL')));
    assert.ok(result.errors.some((e) => e.includes('BACKUP_RETENTION_DAYS')));
    assert.ok(result.errors.some((e) => e.includes('BACKUP_TEMP_DIR')));
  });

  it('should flag unresolved template variables in R2 endpoint or accountId', () => {
    const configWithTemplates = {
      hermesHome: '/home/salmanabd/.hermes',
      r2: {
        accountId: '${R2_ACCOUNT_ID}',
        accessKeyId: 'key123',
        secretAccessKey: 'sec123',
        bucketName: 'hermes-backups',
        endpoint: 'https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
      },
      brevo: {
        apiKey: 'xkeysib-key',
        senderName: 'Bot',
        senderEmail: 'bot@example.com',
        recipientEmail: 'user@example.com',
      },
      retentionDays: 3,
      tempDir: '/tmp',
    };

    const result = validateConfig(configWithTemplates);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('R2_ENDPOINT contains unresolved template variables')));
    assert.ok(result.errors.some((e) => e.includes('R2_ACCOUNT_ID contains unresolved template variables')));
  });

  it('should throw error when throwOnError option is set', () => {
    assert.throws(
      () => {
        validateConfig({}, { throwOnError: true });
      },
      (err) => {
        return err.message.includes('Configuration validation failed') && Array.isArray(err.validationErrors);
      }
    );
  });

  it('should support selective validation for R2 or Brevo only', () => {
    const partialConfig = {
      hermesHome: '/home/.hermes',
      r2: {
        accountId: 'acc123',
        accessKeyId: 'key123',
        secretAccessKey: 'sec123',
        bucketName: 'hermes-backups',
        endpoint: 'https://acc123.r2.cloudflarestorage.com',
      },
      brevo: {
        apiKey: '',
        senderEmail: '',
        recipientEmail: '',
      },
      retentionDays: 3,
      tempDir: '/tmp',
    };

    const r2OnlyResult = validateConfig(partialConfig, { requireBrevo: false });
    assert.equal(r2OnlyResult.valid, true);

    const brevoOnlyResult = validateConfig(partialConfig, { requireR2: false, requireBrevo: true });
    assert.equal(brevoOnlyResult.valid, false);
  });

  it('should extract secret strings >4 chars from config and env objects', () => {
    const config = {
      r2: {
        accountId: 'r2-account-998877',
        accessKeyId: 'r2-access-key-112233',
        secretAccessKey: 'super-secret-s3-key-value',
        bucketName: 'my-bucket',
      },
      brevo: {
        apiKey: 'xkeysib-api-key-test',
      },
      MY_CUSTOM_SECRET: 'custom-secret-password',
      SHORT_VAL: 'abc', // <= 4 chars, should be excluded
    };

    const secrets = extractSecrets(config);
    assert.ok(secrets.includes('r2-account-998877'));
    assert.ok(secrets.includes('r2-access-key-112233'));
    assert.ok(secrets.includes('super-secret-s3-key-value'));
    assert.ok(secrets.includes('xkeysib-api-key-test'));
    assert.ok(secrets.includes('custom-secret-password'));
    assert.ok(!secrets.includes('abc'));
  });
});

describe('Dynamic Secret Sanitizer', () => {
  it('should normalize secrets, deduplicate, and sort descending by length', () => {
    const inputSecrets = ['short5', 'very_long_secret_key_123', 'short5', 'mid_secret', 'tiny'];
    const normalized = normalizeSecrets(inputSecrets);

    assert.equal(normalized[0], 'very_long_secret_key_123');
    assert.equal(normalized[1], 'mid_secret');
    assert.equal(normalized[2], 'short5');
    assert.ok(!normalized.includes('tiny')); // <= 4 chars excluded
  });

  it('should redact secrets (>4 chars) from strings', () => {
    const secrets = ['secret_api_key_99', 'r2_password_xyz'];
    const sanitizer = createSanitizer(secrets);

    const message = 'Failed to connect with secret_api_key_99 and r2_password_xyz at endpoint';
    const sanitized = sanitizer(message);

    assert.equal(sanitized, 'Failed to connect with [REDACTED] and [REDACTED] at endpoint');
  });

  it('should not redact short strings (<= 4 chars)', () => {
    const secrets = ['abc', '1234', 'secret_token_123'];
    const sanitizer = createSanitizer(secrets);

    const text = 'Token 1234 is for user abc with secret_token_123';
    const sanitized = sanitizer(text);

    assert.equal(sanitized, 'Token 1234 is for user abc with [REDACTED]');
  });

  it('should safely escape regex special characters in secrets', () => {
    const secrets = ['key$with.special+chars*and?symbols^[]()'];
    const sanitizer = createSanitizer(secrets);

    const message = 'Error: key$with.special+chars*and?symbols^[]() failed to authenticate';
    const sanitized = sanitizer(message);

    assert.equal(sanitized, 'Error: [REDACTED] failed to authenticate');
  });

  it('should redact overlapping secrets without mangling replacement', () => {
    const secrets = ['secret', 'super_secret_master_key'];
    const sanitizer = createSanitizer(secrets);

    const text = 'Found super_secret_master_key and standard secret';
    const sanitized = sanitizer(text);

    assert.equal(sanitized, 'Found [REDACTED] and standard [REDACTED]');
  });

  it('should sanitize Error message, stack trace, cause, and custom properties', () => {
    const secretKey = 'my_top_secret_auth_token_456';
    const causeSecret = 'underlying_secret_credential_789';
    const sanitizer = createSanitizer([secretKey, causeSecret]);

    const causeErr = new Error(`Root cause: ${causeSecret}`);
    const error = new Error(`Connection refused for key ${secretKey}`, { cause: causeErr });
    error.detail = `Sensitive parameter ${secretKey}`;

    const sanitizedError = sanitizer(error);

    assert.ok(sanitizedError instanceof Error);
    assert.equal(sanitizedError.message, 'Connection refused for key [REDACTED]');
    assert.ok(!sanitizedError.stack.includes(secretKey));
    assert.ok(sanitizedError.stack.includes('[REDACTED]'));
    assert.equal(sanitizedError.detail, 'Sensitive parameter [REDACTED]');
    assert.ok(sanitizedError.cause instanceof Error);
    assert.equal(sanitizedError.cause.message, 'Root cause: [REDACTED]');
  });

  it('should sanitize nested objects and arrays', () => {
    const secrets = ['super_secret_token'];
    const payload = {
      user: 'alice',
      auth: {
        token: 'super_secret_token',
        details: ['super_secret_token', 'public_info'],
      },
    };

    const sanitized = sanitize(payload, secrets);
    assert.deepEqual(sanitized, {
      user: 'alice',
      auth: {
        token: '[REDACTED]',
        details: ['[REDACTED]', 'public_info'],
      },
    });
  });

  it('should handle circular references without infinite loops', () => {
    const secrets = ['my_secret_token'];
    const cyclicObj = {
      token: 'my_secret_token',
    };
    cyclicObj.self = cyclicObj;

    const sanitized = sanitize(cyclicObj, secrets);
    assert.equal(sanitized.token, '[REDACTED]');
    assert.equal(sanitized.self, '[Circular]');
  });

  it('should handle null, undefined, numbers, and booleans safely', () => {
    const sanitizer = createSanitizer(['some_secret']);
    assert.equal(sanitizer(null), null);
    assert.equal(sanitizer(undefined), undefined);
    assert.equal(sanitizer(12345), 12345);
    assert.equal(sanitizer(true), true);
  });
});
