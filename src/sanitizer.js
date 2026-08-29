import { extractSecrets } from './config.js';

/**
 * Escape special characters for safe regular expression matching.
 * @param {string} str
 * @returns {string}
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalizes input into an array of distinct secret strings (>4 characters),
 * sorted in descending order of length to prevent partial substring matches.
 * @param {string[] | Set<string> | Record<string, any>} secretsInput
 * @returns {string[]}
 */
export function normalizeSecrets(secretsInput) {
  let rawList = [];

  if (!secretsInput) {
    return [];
  }

  if (Array.isArray(secretsInput) || secretsInput instanceof Set) {
    rawList = Array.from(secretsInput);
  } else if (typeof secretsInput === 'object') {
    rawList = extractSecrets(secretsInput);
  }

  const validSecrets = new Set();
  for (const item of rawList) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed.length > 4) {
        validSecrets.add(trimmed);
      }
    }
  }

  // Sort descending by length so longer strings match first
  return Array.from(validSecrets).sort((a, b) => b.length - a.length);
}

/**
 * Build a dynamic sanitizer function using a provided list of secrets.
 * @param {string[] | Set<string> | Record<string, any>} secretsInput
 * @returns {(input: any) => any}
 */
export function createSanitizer(secretsInput = []) {
  const secrets = normalizeSecrets(secretsInput);
  const patterns = secrets.map((secret) => ({
    regex: new RegExp(escapeRegex(secret), 'g'),
    replacement: '[REDACTED]',
  }));

  /**
   * Internal recursive string/object sanitizer.
   * @param {any} target
   * @param {WeakSet<object>} seen
   * @returns {any}
   */
  function sanitizeValue(target, seen = new WeakSet()) {
    if (target === null || target === undefined) {
      return target;
    }

    if (typeof target === 'string') {
      let result = target;
      for (const { regex, replacement } of patterns) {
        result = result.replace(regex, replacement);
      }
      return result;
    }

    if (target instanceof Error) {
      if (seen.has(target)) {
        return '[Circular Error]';
      }
      seen.add(target);

      const sanitizedMessage = sanitizeValue(target.message, seen);
      const sanitizedStack = target.stack ? sanitizeValue(target.stack, seen) : undefined;
      const sanitizedErr = new Error(sanitizedMessage);
      sanitizedErr.name = target.name;
      if (sanitizedStack) {
        sanitizedErr.stack = sanitizedStack;
      }
      if (target.cause) {
        sanitizedErr.cause = sanitizeValue(target.cause, seen);
      }

      // Preserve custom enumerable and non-enumerable properties
      for (const key of Object.getOwnPropertyNames(target)) {
        if (!['name', 'message', 'stack', 'cause'].includes(key)) {
          sanitizedErr[key] = sanitizeValue(target[key], seen);
        }
      }

      return sanitizedErr;
    }

    if (typeof target === 'object') {
      if (seen.has(target)) {
        return '[Circular]';
      }
      seen.add(target);

      if (Array.isArray(target)) {
        return target.map((item) => sanitizeValue(item, seen));
      }

      const sanitizedObj = {};
      for (const [key, val] of Object.entries(target)) {
        sanitizedObj[key] = sanitizeValue(val, seen);
      }
      return sanitizedObj;
    }

    return target;
  }

  return function sanitize(input) {
    return sanitizeValue(input);
  };
}

/**
 * Sanitize an error object or string dynamically with given secrets.
 * @param {any} input
 * @param {string[] | Set<string> | Record<string, any>} [secrets]
 * @returns {any}
 */
export function sanitize(input, secrets = []) {
  const sanitizer = createSanitizer(secrets);
  return sanitizer(input);
}
