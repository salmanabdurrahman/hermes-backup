import os from 'node:os';
import { validateConfig, isValidEmail } from './config.js';
import { createSanitizer } from './sanitizer.js';

/**
 * Default Brevo Transactional Email REST API endpoint.
 */
export const DEFAULT_BREVO_API_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

/**
 * Default sender name for backup notifications.
 */
export const DEFAULT_SENDER_NAME = 'Hermes Backup Bot';

/**
 * Default recipient name for alerts.
 */
export const DEFAULT_RECIPIENT_NAME = 'VPS Administrator';

/**
 * Escape HTML special characters to prevent injection in email clients.
 * @param {any} input
 * @returns {string}
 */
export function escapeHtml(input) {
  if (input === null || input === undefined) {
    return '';
  }
  const str = typeof input === 'string' ? input : String(input);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format error details into a sanitized, HTML-escaped string.
 * @param {any} error
 * @param {(input: any) => any} [sanitizer]
 * @returns {string}
 */
export function formatErrorDetails(error, sanitizer) {
  if (!error) {
    return 'Unknown error (no error details provided)';
  }

  let rawContent;
  if (error instanceof Error) {
    let details = error.stack || `${error.name || 'Error'}: ${error.message}`;
    if (error.cause) {
      const causeStr = error.cause instanceof Error
        ? (error.cause.stack || `${error.cause.name || 'Error'}: ${error.cause.message}`)
        : String(error.cause);
      details += `\n\nCaused by: ${causeStr}`;
    }
    if (Array.isArray(error.errors)) {
      details += '\n\nNested errors:';
      for (const [idx, nestedErr] of error.errors.entries()) {
        const nestedStr = nestedErr instanceof Error
          ? (nestedErr.stack || `${nestedErr.name || 'Error'}: ${nestedErr.message}`)
          : String(nestedErr);
        details += `\n  [${idx + 1}] ${nestedStr}`;
      }
    }
    rawContent = details;
  } else if (typeof error === 'object') {
    try {
      rawContent = JSON.stringify(error, null, 2);
    } catch {
      rawContent = String(error);
    }
  } else {
    rawContent = String(error);
  }

  const sanitized = sanitizer ? sanitizer(rawContent) : rawContent;
  return escapeHtml(sanitized);
}

/**
 * Build HTML content for backup failure alert email.
 * @param {any} error - Error object, string, or error details
 * @param {object} [options={}]
 * @param {string} [options.hostname] - Hostname override
 * @param {string | Date} [options.timestamp] - Timestamp override
 * @param {object} [options.config] - Application config for secret redaction
 * @param {(input: any) => any} [options.sanitizer] - Custom sanitizer function
 * @returns {string} HTML string
 */
export function buildFailureHtml(error, options = {}) {
  const hostname = options.hostname || os.hostname();
  const timestamp = options.timestamp instanceof Date
    ? options.timestamp.toISOString()
    : (typeof options.timestamp === 'string' && options.timestamp.trim().length > 0
        ? options.timestamp.trim()
        : new Date().toISOString());

  const sanitizer = options.sanitizer || (options.config ? createSanitizer(options.config) : null);
  const formattedError = formatErrorDetails(error, sanitizer);
  const escapedHostname = escapeHtml(hostname);
  const escapedTimestamp = escapeHtml(timestamp);

  return [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#212529;line-height:1.5;">',
    '  <h2 style="color:#d32f2f;margin-top:0;margin-bottom:12px;">⚠️ Hermes Agent Backup Failure</h2>',
    `  <p style="margin-bottom:16px;">A backup operation encountered an error on host <strong>${escapedHostname}</strong>.</p>`,
    '  <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">',
    '    <tr>',
    '      <td style="padding:6px 0;font-weight:bold;width:120px;color:#495057;">Host:</td>',
    `      <td style="padding:6px 0;color:#212529;">${escapedHostname}</td>`,
    '    </tr>',
    '    <tr>',
    '      <td style="padding:6px 0;font-weight:bold;color:#495057;">Timestamp:</td>',
    `      <td style="padding:6px 0;color:#212529;">${escapedTimestamp}</td>`,
    '    </tr>',
    '  </table>',
    '  <p style="margin-top:16px;margin-bottom:8px;font-weight:bold;color:#495057;">Error Details:</p>',
    `  <pre style="background:#f8f9fa;border:1px solid #dee2e6;border-radius:6px;padding:12px;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:13px;color:#c92a2a;white-space:pre-wrap;word-break:break-word;margin:0 0 20px 0;">${formattedError}</pre>`,
    '  <hr style="border:none;border-top:1px solid #e9ecef;margin:20px 0;" />',
    '  <p style="font-size:12px;color:#868e96;margin:0;">Hermes Agent Backup CLI — Automated Failure Alert</p>',
    '</div>',
  ].join('\n');
}

/**
 * Build HTML content for test notification email.
 * @param {object} [options={}]
 * @param {string} [options.hostname] - Hostname override
 * @param {string | Date} [options.timestamp] - Timestamp override
 * @returns {string} HTML string
 */
export function buildTestHtml(options = {}) {
  const hostname = options.hostname || os.hostname();
  const timestamp = options.timestamp instanceof Date
    ? options.timestamp.toISOString()
    : (typeof options.timestamp === 'string' && options.timestamp.trim().length > 0
        ? options.timestamp.trim()
        : new Date().toISOString());

  const escapedHostname = escapeHtml(hostname);
  const escapedTimestamp = escapeHtml(timestamp);

  return [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#212529;line-height:1.5;">',
    '  <h2 style="color:#2b8a3e;margin-top:0;margin-bottom:12px;">✅ Hermes Agent Backup Test Notification</h2>',
    `  <p style="margin-bottom:16px;">This is a test notification confirming that Brevo transactional email delivery is configured correctly for Hermes Agent Backup CLI on host <strong>${escapedHostname}</strong>.</p>`,
    '  <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">',
    '    <tr>',
    '      <td style="padding:6px 0;font-weight:bold;width:120px;color:#495057;">Host:</td>',
    `      <td style="padding:6px 0;color:#212529;">${escapedHostname}</td>`,
    '    </tr>',
    '    <tr>',
    '      <td style="padding:6px 0;font-weight:bold;color:#495057;">Timestamp:</td>',
    `      <td style="padding:6px 0;color:#212529;">${escapedTimestamp}</td>`,
    '    </tr>',
    '    <tr>',
    '      <td style="padding:6px 0;font-weight:bold;color:#495057;">Status:</td>',
    '      <td style="padding:6px 0;color:#2b8a3e;font-weight:bold;">Verified</td>',
    '    </tr>',
    '  </table>',
    '  <hr style="border:none;border-top:1px solid #e9ecef;margin:20px 0;" />',
    '  <p style="font-size:12px;color:#868e96;margin:0;">Hermes Agent Backup CLI — Automated Notification Test</p>',
    '</div>',
  ].join('\n');
}

/**
 * Dispatch an email through Brevo's Transactional Email REST API.
 *
 * @param {object} payload - Email payload parameters
 * @param {string} payload.subject - Email subject line
 * @param {string} payload.htmlContent - HTML body content
 * @param {object} [payload.sender] - Sender info { name, email }
 * @param {Array<{ email: string, name?: string }>} [payload.to] - Recipients array
 * @param {object} config - Application configuration object containing brevo credentials
 * @param {object} [options={}]
 * @param {string} [options.endpoint] - Custom API endpoint URL
 * @param {typeof fetch} [options.fetch] - Custom fetch function
 * @param {boolean} [options.dryRun=false] - If true, skips actual HTTP request
 * @param {boolean} [options.throwOnError=true] - Whether to throw on HTTP or network errors
 * @returns {Promise<{
 *   success: boolean,
 *   messageId?: string,
 *   status?: number,
 *   dryRun?: boolean,
 *   error?: Error
 * }>}
 */
export async function sendBrevoEmail(payload, config, options = {}) {
  const {
    endpoint = DEFAULT_BREVO_API_ENDPOINT,
    fetch: customFetch,
    dryRun = false,
    throwOnError = true,
  } = options;

  const sanitizer = createSanitizer(config);

  try {
    validateConfig(config, { requireR2: false, requireBrevo: true, throwOnError: true });
  } catch (err) {
    const sanitizedError = sanitizer(err);
    if (throwOnError) throw sanitizedError;
    return { success: false, error: sanitizedError };
  }

  if (!payload || typeof payload !== 'object') {
    const error = new Error('Email payload must be a non-empty object');
    if (throwOnError) throw error;
    return { success: false, error };
  }

  if (!payload.subject || typeof payload.subject !== 'string' || payload.subject.trim().length === 0) {
    const error = new Error('Email subject must be a non-empty string');
    if (throwOnError) throw error;
    return { success: false, error };
  }

  if (!payload.htmlContent || typeof payload.htmlContent !== 'string' || payload.htmlContent.trim().length === 0) {
    const error = new Error('Email htmlContent must be a non-empty string');
    if (throwOnError) throw error;
    return { success: false, error };
  }

  const sender = payload.sender || {
    name: config.brevo.senderName || DEFAULT_SENDER_NAME,
    email: config.brevo.senderEmail,
  };

  if (!sender.email || !isValidEmail(sender.email)) {
    const error = new Error(`Invalid sender email address: ${sender.email || '(empty)'}`);
    if (throwOnError) throw error;
    return { success: false, error };
  }

  const to = payload.to || [
    {
      email: config.brevo.recipientEmail,
      name: DEFAULT_RECIPIENT_NAME,
    },
  ];

  if (!Array.isArray(to) || to.length === 0) {
    const error = new Error('Email recipient list (to) must contain at least one recipient');
    if (throwOnError) throw error;
    return { success: false, error };
  }

  for (const [idx, recipient] of to.entries()) {
    if (!recipient || typeof recipient !== 'object' || !recipient.email || !isValidEmail(recipient.email)) {
      const invalidEmail = recipient?.email || '(empty)';
      const error = new Error(`Invalid recipient email address at index ${idx}: ${invalidEmail}`);
      if (throwOnError) throw error;
      return { success: false, error };
    }
  }

  const sanitizedSubject = sanitizer(payload.subject);
  const sanitizedHtmlContent = sanitizer(payload.htmlContent);

  const requestBody = {
    sender,
    to,
    subject: sanitizedSubject,
    htmlContent: sanitizedHtmlContent,
  };

  if (dryRun) {
    return {
      success: true,
      messageId: 'mock-dry-run-message-id',
      status: 200,
      dryRun: true,
    };
  }

  const fetchFn = customFetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    const error = new Error('Global fetch is not available in current environment');
    if (throwOnError) throw error;
    return { success: false, error };
  }

  try {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'accept': 'application/json',
        'api-key': config.brevo.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      let errorBody = '';
      try {
        const errorJson = await response.json();
        errorBody = typeof errorJson === 'object' ? JSON.stringify(errorJson) : String(errorJson);
      } catch {
        try {
          const rawText = await response.text();
          errorBody = rawText.length > 2000 ? `${rawText.slice(0, 2000)}...` : rawText;
        } catch {
          errorBody = response.statusText || 'Unknown response';
        }
      }

      const sanitizedErrorBody = sanitizer(errorBody);
      const apiError = new Error(`Brevo API request failed with status ${response.status}: ${sanitizedErrorBody}`);
      apiError.status = response.status;
      apiError.responseBody = sanitizedErrorBody;

      if (throwOnError) {
        throw apiError;
      }
      return {
        success: false,
        status: response.status,
        error: apiError,
      };
    }

    let messageId = null;
    try {
      const responseData = await response.json();
      if (responseData && typeof responseData === 'object' && responseData.messageId) {
        messageId = responseData.messageId;
      }
    } catch {
      // Non-JSON or empty response on 2xx status
    }

    return {
      success: true,
      messageId,
      status: response.status,
      dryRun: false,
    };
  } catch (err) {
    const sanitizedError = sanitizer(err);
    if (throwOnError) {
      throw sanitizedError;
    }
    return {
      success: false,
      error: sanitizedError,
    };
  }
}

/**
 * Dispatch an error alert email via Brevo.
 *
 * @param {any} error - Error object or string describing failure
 * @param {object} config - Application configuration object
 * @param {object} [options={}]
 * @param {string} [options.hostname] - Hostname override
 * @param {string} [options.subject] - Subject override
 * @param {string | Date} [options.timestamp] - Timestamp override
 * @param {typeof fetch} [options.fetch] - Custom fetch function
 * @param {boolean} [options.dryRun=false] - Dry run flag
 * @param {boolean} [options.throwOnError=false] - If false, catches network errors without throwing
 * @returns {Promise<{
 *   success: boolean,
 *   messageId?: string,
 *   status?: number,
 *   dryRun?: boolean,
 *   error?: Error
 * }>}
 */
export async function sendFailureAlert(error, config, options = {}) {
  const {
    hostname = os.hostname(),
    subject,
    timestamp = new Date().toISOString(),
    throwOnError = false,
    ...restOptions
  } = options;

  const defaultSubject = `[ALERT] Hermes Backup Failed on ${hostname}`;
  const alertSubject = subject || defaultSubject;

  const htmlContent = buildFailureHtml(error, {
    hostname,
    timestamp,
    config,
    ...restOptions,
  });

  return sendBrevoEmail(
    {
      subject: alertSubject,
      htmlContent,
    },
    config,
    {
      throwOnError,
      ...restOptions,
    }
  );
}

/**
 * Dispatch a test notification email via Brevo to verify credentials.
 *
 * @param {object} config - Application configuration object
 * @param {object} [options={}]
 * @param {string} [options.hostname] - Hostname override
 * @param {string} [options.subject] - Subject override
 * @param {string | Date} [options.timestamp] - Timestamp override
 * @param {typeof fetch} [options.fetch] - Custom fetch function
 * @param {boolean} [options.dryRun=false] - Dry run flag
 * @param {boolean} [options.throwOnError=true] - Whether to throw on error (default true for test-notify)
 * @returns {Promise<{
 *   success: boolean,
 *   messageId?: string,
 *   status?: number,
 *   dryRun?: boolean,
 *   error?: Error
 * }>}
 */
export async function sendTestNotification(config, options = {}) {
  const {
    hostname = os.hostname(),
    subject,
    timestamp = new Date().toISOString(),
    throwOnError = true,
    ...restOptions
  } = options;

  const defaultSubject = `[TEST] Hermes Backup Notification on ${hostname}`;
  const testSubject = subject || defaultSubject;

  const htmlContent = buildTestHtml({
    hostname,
    timestamp,
    ...restOptions,
  });

  return sendBrevoEmail(
    {
      subject: testSubject,
      htmlContent,
    },
    config,
    {
      throwOnError,
      ...restOptions,
    }
  );
}
