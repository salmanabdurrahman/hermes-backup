import path from 'node:path';
import os from 'node:os';
import dotenv from 'dotenv';

// Load local .env if present
dotenv.config();

/**
 * Validate email address format.
 * @param {string} email
 * @returns {boolean}
 */
export function isValidEmail(email) {
  if (typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

/**
 * Load and parse configuration from environment variables with fallback defaults.
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {Record<string, any>}
 */
export function loadConfig(env = process.env) {
  const accountId = (env.R2_ACCOUNT_ID || '').trim();
  let rawEndpoint = (env.R2_ENDPOINT || '').trim();
  if (rawEndpoint && rawEndpoint.includes('${')) {
    rawEndpoint = rawEndpoint.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, k) => (env[k] || '').trim());
  }
  const endpoint = rawEndpoint || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');

  const retentionDaysRaw = env.BACKUP_RETENTION_DAYS;
  const retentionDays = retentionDaysRaw !== undefined && retentionDaysRaw !== ''
    ? parseInt(retentionDaysRaw, 10)
    : 3;

  return {
    hermesHome: (env.HERMES_HOME || '').trim() || path.join(os.homedir(), '.hermes'),
    r2: {
      accountId,
      accessKeyId: (env.R2_ACCESS_KEY_ID || '').trim(),
      secretAccessKey: (env.R2_SECRET_ACCESS_KEY || '').trim(),
      bucketName: (env.R2_BUCKET_NAME || 'hermes-backups').trim(),
      endpoint,
    },
    brevo: {
      apiKey: (env.BREVO_API_KEY || '').trim(),
      senderName: (env.BREVO_SENDER_NAME || 'Hermes Backup Bot').trim(),
      senderEmail: (env.BREVO_SENDER_EMAIL || '').trim(),
      recipientEmail: (env.BREVO_RECIPIENT_EMAIL || '').trim(),
    },
    retentionDays: Number.isInteger(retentionDays) && retentionDays > 0 ? retentionDays : 3,
    tempDir: (env.BACKUP_TEMP_DIR || '').trim() || '/tmp',
    encryptionKey: (env.BACKUP_ENCRYPTION_KEY || '').trim() || undefined,
  };
}

/**
 * Validate configuration structure and required credentials.
 * @param {ReturnType<typeof loadConfig>} config
 * @param {object} [options]
 * @param {boolean} [options.requireR2=true]
 * @param {boolean} [options.requireBrevo=true]
 * @param {boolean} [options.throwOnError=false]
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateConfig(config, options = {}) {
  const { requireR2 = true, requireBrevo = true, throwOnError = false } = options;
  const errors = [];

  if (!config) {
    errors.push('Configuration object is required');
  } else {
    if (!config.hermesHome) {
      errors.push('HERMES_HOME must be specified');
    }

    if (requireR2) {
      if (!config.r2?.accountId && !config.r2?.endpoint) {
        errors.push('R2_ACCOUNT_ID or R2_ENDPOINT must be specified');
      }
      if (config.r2?.endpoint && config.r2.endpoint.includes('${')) {
        errors.push('R2_ENDPOINT contains unresolved template variables (${...})');
      }
      if (config.r2?.accountId && config.r2.accountId.includes('${')) {
        errors.push('R2_ACCOUNT_ID contains unresolved template variables (${...})');
      }
      if (!config.r2?.accessKeyId) {
        errors.push('R2_ACCESS_KEY_ID must be specified');
      }
      if (!config.r2?.secretAccessKey) {
        errors.push('R2_SECRET_ACCESS_KEY must be specified');
      }
      if (!config.r2?.bucketName) {
        errors.push('R2_BUCKET_NAME must be specified');
      }
    }

    if (requireBrevo) {
      if (!config.brevo?.apiKey) {
        errors.push('BREVO_API_KEY must be specified');
      }
      if (!config.brevo?.senderEmail) {
        errors.push('BREVO_SENDER_EMAIL must be specified');
      } else if (!isValidEmail(config.brevo.senderEmail)) {
        errors.push('BREVO_SENDER_EMAIL is not a valid email address');
      }
      if (!config.brevo?.recipientEmail) {
        errors.push('BREVO_RECIPIENT_EMAIL must be specified');
      } else if (!isValidEmail(config.brevo.recipientEmail)) {
        errors.push('BREVO_RECIPIENT_EMAIL is not a valid email address');
      }
    }

    if (config.retentionDays <= 0 || !Number.isInteger(config.retentionDays)) {
      errors.push('BACKUP_RETENTION_DAYS must be a positive integer');
    }

    if (!config.tempDir) {
      errors.push('BACKUP_TEMP_DIR must be specified');
    }

    if (config.encryptionKey !== undefined) {
      if (typeof config.encryptionKey !== 'string') {
        errors.push('BACKUP_ENCRYPTION_KEY must be a string');
      } else if (config.encryptionKey.trim().length === 0) {
        errors.push('BACKUP_ENCRYPTION_KEY cannot be empty when specified');
      }
    }
  }

  if (errors.length > 0 && throwOnError) {
    const error = new Error(`Configuration validation failed: ${errors.join(', ')}`);
    error.validationErrors = errors;
    throw error;
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Extract all secret and credential values (>4 characters) from configuration or environment.
 * @param {Record<string, any>} [configOrEnv]
 * @returns {string[]}
 */
export function extractSecrets(configOrEnv = {}) {
  const secrets = new Set();

  const addIfSecret = (val) => {
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed.length > 4) {
        secrets.add(trimmed);
      }
    }
  };

  // If it's a nested config object
  if (configOrEnv.encryptionKey) {
    addIfSecret(configOrEnv.encryptionKey);
  }
  if (configOrEnv.r2) {
    addIfSecret(configOrEnv.r2.accessKeyId);
    addIfSecret(configOrEnv.r2.secretAccessKey);
    addIfSecret(configOrEnv.r2.accountId);
  }
  if (configOrEnv.brevo) {
    addIfSecret(configOrEnv.brevo.apiKey);
  }

  // Iterate over raw key-value pairs (for raw env objects or flat config)
  for (const [key, value] of Object.entries(configOrEnv)) {
    if (typeof value === 'string') {
      const upperKey = key.toUpperCase();
      if (
        upperKey.includes('SECRET') ||
        upperKey.includes('KEY') ||
        upperKey.includes('TOKEN') ||
        upperKey.includes('PASSWORD') ||
        upperKey.includes('AUTH') ||
        upperKey.includes('API') ||
        upperKey.includes('ACCOUNT_ID') ||
        upperKey.includes('ENCRYPTION')
      ) {
        addIfSecret(value);
      }
    }
  }

  return Array.from(secrets);
}
