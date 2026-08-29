import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {
  DEFAULT_BREVO_API_ENDPOINT,
  DEFAULT_SENDER_NAME,
  DEFAULT_RECIPIENT_NAME,
  escapeHtml,
  formatErrorDetails,
  buildFailureHtml,
  buildTestHtml,
  sendBrevoEmail,
  sendFailureAlert,
  sendTestNotification,
} from '../src/notifier.js';
import * as HermesBackup from '../src/index.js';
import { createSanitizer } from '../src/sanitizer.js';

describe('Brevo REST API Transactional Email Notifier', () => {
  const validConfig = {
    hermesHome: '/home/salmanabd/.hermes',
    r2: {
      accountId: 'test-account-id',
      accessKeyId: 'test-access-key-id',
      secretAccessKey: 'test-secret-access-key',
      bucketName: 'hermes-backups',
      endpoint: 'https://test-account-id.r2.cloudflarestorage.com',
    },
    brevo: {
      apiKey: 'xkeysib-test-secret-api-key-1234567890',
      senderName: 'Hermes Alert Bot',
      senderEmail: 'notifications@example.com',
      recipientEmail: 'admin@example.com',
    },
    retentionDays: 3,
    tempDir: '/tmp',
  };

  describe('HTML escaping and error formatting', () => {
    it('should escape HTML special characters correctly', () => {
      assert.equal(escapeHtml(''), '');
      assert.equal(escapeHtml(null), '');
      assert.equal(escapeHtml(undefined), '');
      assert.equal(
        escapeHtml('<script>alert("xss & \'injection\'")</script>'),
        '&lt;script&gt;alert(&quot;xss &amp; &#39;injection&#39;&quot;)&lt;/script&gt;'
      );
      assert.equal(escapeHtml(12345), '12345');
    });

    it('should format string and object errors gracefully', () => {
      assert.equal(formatErrorDetails(null), 'Unknown error (no error details provided)');
      assert.equal(formatErrorDetails('Simple error message'), 'Simple error message');

      const objError = { code: 'ERR_TIMEOUT', retryable: false };
      const formattedObj = formatErrorDetails(objError);
      assert.ok(formattedObj.includes('ERR_TIMEOUT'));
    });

    it('should format Error instances and sanitize sensitive tokens in error stack', () => {
      const sensitiveToken = 'super-secret-auth-token-999';
      const rawError = new Error(`Connection failed with token ${sensitiveToken}`);
      const sanitizer = createSanitizer([sensitiveToken]);

      const formatted = formatErrorDetails(rawError, sanitizer);
      assert.ok(!formatted.includes(sensitiveToken));
      assert.ok(formatted.includes('[REDACTED]'));
    });

    it('should format Error with cause and nested aggregate errors cleanly', () => {
      const rootCause = new Error('Socket timeout on upstream');
      const mainError = new Error('Backup failed due to network disruption', { cause: rootCause });

      const formatted = formatErrorDetails(mainError);
      assert.ok(formatted.includes('Backup failed due to network disruption'));
      assert.ok(formatted.includes('Caused by:'));
      assert.ok(formatted.includes('Socket timeout on upstream'));

      const aggError = new Error('Multiple validation failures');
      aggError.errors = [new Error('Disk full'), new Error('Permission denied')];
      const formattedAgg = formatErrorDetails(aggError);
      assert.ok(formattedAgg.includes('Nested errors:'));
      assert.ok(formattedAgg.includes('[1] Error: Disk full'));
      assert.ok(formattedAgg.includes('[2] Error: Permission denied'));
    });
  });

  describe('HTML template builders', () => {
    it('should build failure HTML containing host, timestamp, and sanitized error details', () => {
      const error = new Error('Database locked during backup staging');
      const html = buildFailureHtml(error, {
        hostname: 'vps-node-alpha',
        timestamp: '2026-08-29T10:00:00.000Z',
        config: validConfig,
      });

      assert.ok(html.includes('Hermes Agent Backup Failure'));
      assert.ok(html.includes('vps-node-alpha'));
      assert.ok(html.includes('2026-08-29T10:00:00.000Z'));
      assert.ok(html.includes('Database locked during backup staging'));
    });

    it('should build failure HTML with Date object timestamp and default hostname', () => {
      const error = 'Disk write failed';
      const date = new Date('2026-08-29T12:30:00.000Z');
      const html = buildFailureHtml(error, { timestamp: date });

      assert.ok(html.includes(os.hostname()));
      assert.ok(html.includes('2026-08-29T12:30:00.000Z'));
      assert.ok(html.includes('Disk write failed'));
    });

    it('should build test notification HTML confirming successful channel setup', () => {
      const html = buildTestHtml({
        hostname: 'vps-node-alpha',
        timestamp: '2026-08-29T10:00:00.000Z',
      });

      assert.ok(html.includes('Hermes Agent Backup Test Notification'));
      assert.ok(html.includes('vps-node-alpha'));
      assert.ok(html.includes('2026-08-29T10:00:00.000Z'));
      assert.ok(html.includes('Verified'));
    });
  });

  describe('sendBrevoEmail core dispatcher', () => {
    it('should reject invalid or missing configuration', async () => {
      const invalidConfig = {
        brevo: {
          apiKey: '',
          senderEmail: 'invalid-email',
          recipientEmail: '',
        },
      };

      await assert.rejects(
        async () => {
          await sendBrevoEmail(
            { subject: 'Test', htmlContent: '<p>Body</p>' },
            invalidConfig,
            { throwOnError: true }
          );
        },
        (err) => {
          assert.ok(err.message.includes('BREVO_API_KEY'));
          return true;
        }
      );
    });

    it('should return error object when throwOnError is false on invalid config', async () => {
      const invalidConfig = { brevo: { apiKey: '' } };
      const result = await sendBrevoEmail(
        { subject: 'Test', htmlContent: '<p>Body</p>' },
        invalidConfig,
        { throwOnError: false }
      );

      assert.equal(result.success, false);
      assert.ok(result.error);
    });

    it('should validate payload fields', async () => {
      await assert.rejects(
        async () => {
          await sendBrevoEmail(null, validConfig);
        },
        /Email payload must be a non-empty object/
      );

      await assert.rejects(
        async () => {
          await sendBrevoEmail({ subject: '', htmlContent: '<p>test</p>' }, validConfig);
        },
        /Email subject must be a non-empty string/
      );

      await assert.rejects(
        async () => {
          await sendBrevoEmail({ subject: 'Valid Subject', htmlContent: '' }, validConfig);
        },
        /Email htmlContent must be a non-empty string/
      );

      await assert.rejects(
        async () => {
          await sendBrevoEmail(
            { subject: 'Valid', htmlContent: '<p>test</p>', to: [] },
            validConfig
          );
        },
        /Email recipient list \(to\) must contain at least one recipient/
      );

      await assert.rejects(
        async () => {
          await sendBrevoEmail(
            {
              subject: 'Valid',
              htmlContent: '<p>test</p>',
              to: [{ email: 'invalid-email-format', name: 'Admin' }],
            },
            validConfig
          );
        },
        /Invalid recipient email address at index 0/
      );

      await assert.rejects(
        async () => {
          await sendBrevoEmail(
            {
              subject: 'Valid',
              htmlContent: '<p>test</p>',
              sender: { email: 'bad-sender-email', name: 'Sender' },
            },
            validConfig
          );
        },
        /Invalid sender email address/
      );
    });

    it('should truncate excessively long error responses from Brevo API', async () => {
      const longHtml = '<html><body><h1>502 Bad Gateway</h1>' + 'x'.repeat(3000) + '</body></html>';
      const mockFetch = async () => {
        return {
          ok: false,
          status: 502,
          json: async () => {
            throw new Error('Not JSON');
          },
          text: async () => longHtml,
        };
      };

      await assert.rejects(
        async () => {
          await sendBrevoEmail(
            { subject: 'Test', htmlContent: '<p>Test</p>' },
            validConfig,
            { fetch: mockFetch, throwOnError: true }
          );
        },
        (err) => {
          assert.ok(err.message.includes('502'));
          assert.ok(err.responseBody.includes('...'));
          assert.ok(err.responseBody.length <= 2010);
          return true;
        }
      );
    });

    it('should support dry-run mode without invoking network calls', async () => {
      let fetchCalled = false;
      const mockFetch = async () => {
        fetchCalled = true;
        return { ok: true, status: 201, json: async () => ({ messageId: '<msg-123>' }) };
      };

      const result = await sendBrevoEmail(
        { subject: 'Dry run subject', htmlContent: '<p>Dry run body</p>' },
        validConfig,
        { dryRun: true, fetch: mockFetch }
      );

      assert.equal(fetchCalled, false);
      assert.equal(result.success, true);
      assert.equal(result.dryRun, true);
      assert.equal(result.messageId, 'mock-dry-run-message-id');
    });

    it('should dispatch POST request with correct Brevo headers and payload', async () => {
      let capturedUrl = '';
      let capturedOptions = null;

      const mockFetch = async (url, options) => {
        capturedUrl = url;
        capturedOptions = options;
        return {
          ok: true,
          status: 201,
          json: async () => ({ messageId: '<brevo-message-unique-id-987>' }),
        };
      };

      const result = await sendBrevoEmail(
        {
          subject: 'Custom Subject Alert',
          htmlContent: '<p>Custom alert content</p>',
        },
        validConfig,
        { fetch: mockFetch }
      );

      assert.equal(capturedUrl, DEFAULT_BREVO_API_ENDPOINT);
      assert.equal(capturedOptions.method, 'POST');
      assert.equal(capturedOptions.headers['api-key'], validConfig.brevo.apiKey);
      assert.equal(capturedOptions.headers['accept'], 'application/json');
      assert.equal(capturedOptions.headers['content-type'], 'application/json');

      const parsedBody = JSON.parse(capturedOptions.body);
      assert.equal(parsedBody.sender.name, 'Hermes Alert Bot');
      assert.equal(parsedBody.sender.email, 'notifications@example.com');
      assert.equal(parsedBody.to[0].email, 'admin@example.com');
      assert.equal(parsedBody.subject, 'Custom Subject Alert');
      assert.equal(parsedBody.htmlContent, '<p>Custom alert content</p>');

      assert.equal(result.success, true);
      assert.equal(result.messageId, '<brevo-message-unique-id-987>');
      assert.equal(result.status, 201);
    });

    it('should sanitize credentials leaked inside payload subject and body', async () => {
      let capturedBody = '';
      const secretKey = validConfig.brevo.apiKey;

      const mockFetch = async (url, options) => {
        capturedBody = options.body;
        return {
          ok: true,
          status: 201,
          json: async () => ({ messageId: '<msg-id>' }),
        };
      };

      await sendBrevoEmail(
        {
          subject: `Alert with secret: ${secretKey}`,
          htmlContent: `<p>Failed with secret: ${secretKey}</p>`,
        },
        validConfig,
        { fetch: mockFetch }
      );

      assert.ok(!capturedBody.includes(secretKey) || capturedBody.indexOf(secretKey) === capturedBody.lastIndexOf(secretKey));
      const parsedBody = JSON.parse(capturedBody);
      assert.equal(parsedBody.subject, 'Alert with secret: [REDACTED]');
      assert.equal(parsedBody.htmlContent, '<p>Failed with secret: [REDACTED]</p>');
    });

    it('should handle Brevo API error responses and sanitize error messages', async () => {
      const mockFetch = async () => {
        return {
          ok: false,
          status: 401,
          json: async () => ({
            code: 'unauthorized',
            message: `Key ${validConfig.brevo.apiKey} is invalid`,
          }),
        };
      };

      await assert.rejects(
        async () => {
          await sendBrevoEmail(
            { subject: 'Test', htmlContent: '<p>Test</p>' },
            validConfig,
            { fetch: mockFetch, throwOnError: true }
          );
        },
        (err) => {
          assert.ok(err.message.includes('401'));
          assert.ok(!err.message.includes(validConfig.brevo.apiKey));
          assert.ok(err.message.includes('[REDACTED]'));
          return true;
        }
      );
    });

    it('should handle network exceptions and return sanitized error when throwOnError is false', async () => {
      const mockFetch = async () => {
        throw new Error(`fetch failed: DNS lookup error on key ${validConfig.brevo.apiKey}`);
      };

      const result = await sendBrevoEmail(
        { subject: 'Test', htmlContent: '<p>Test</p>' },
        validConfig,
        { fetch: mockFetch, throwOnError: false }
      );

      assert.equal(result.success, false);
      assert.ok(result.error);
      assert.ok(!result.error.message.includes(validConfig.brevo.apiKey));
      assert.ok(result.error.message.includes('[REDACTED]'));
    });
  });

  describe('sendFailureAlert and sendTestNotification helpers', () => {
    it('should send failure alert with default subject and sanitized stack trace', async () => {
      let capturedOptions = null;
      const mockFetch = async (url, options) => {
        capturedOptions = options;
        return {
          ok: true,
          status: 201,
          json: async () => ({ messageId: '<failure-alert-id>' }),
        };
      };

      const customError = new Error(`R2 upload failed with secret: ${validConfig.r2.secretAccessKey}`);
      const result = await sendFailureAlert(customError, validConfig, {
        hostname: 'vps-node-1',
        fetch: mockFetch,
      });

      assert.equal(result.success, true);
      assert.equal(result.messageId, '<failure-alert-id>');

      const parsed = JSON.parse(capturedOptions.body);
      assert.equal(parsed.subject, '[ALERT] Hermes Backup Failed on vps-node-1');
      assert.ok(parsed.htmlContent.includes('[REDACTED]'));
      assert.ok(!parsed.htmlContent.includes(validConfig.r2.secretAccessKey));
    });

    it('should not throw on network failure during sendFailureAlert by default', async () => {
      const mockFetch = async () => {
        throw new Error('Connection refused to Brevo API');
      };

      const result = await sendFailureAlert('Some backup error', validConfig, {
        fetch: mockFetch,
      });

      assert.equal(result.success, false);
      assert.ok(result.error);
      assert.ok(result.error.message.includes('Connection refused'));
    });

    it('should send test notification successfully', async () => {
      let capturedOptions = null;
      const mockFetch = async (url, options) => {
        capturedOptions = options;
        return {
          ok: true,
          status: 201,
          json: async () => ({ messageId: '<test-notify-id>' }),
        };
      };

      const result = await sendTestNotification(validConfig, {
        hostname: 'vps-node-1',
        fetch: mockFetch,
      });

      assert.equal(result.success, true);
      assert.equal(result.messageId, '<test-notify-id>');

      const parsed = JSON.parse(capturedOptions.body);
      assert.equal(parsed.subject, '[TEST] Hermes Backup Notification on vps-node-1');
      assert.ok(parsed.htmlContent.includes('Hermes Agent Backup Test Notification'));
    });

    it('should rethrow errors during sendTestNotification by default', async () => {
      const mockFetch = async () => {
        return {
          ok: false,
          status: 403,
          text: async () => 'Account suspended',
        };
      };

      await assert.rejects(
        async () => {
          await sendTestNotification(validConfig, { fetch: mockFetch });
        },
        /Brevo API request failed with status 403/
      );
    });
  });

  describe('Index Module Re-exports', () => {
    it('should export all notifier functions and constants from src/index.js', () => {
      assert.equal(typeof HermesBackup.escapeHtml, 'function');
      assert.equal(typeof HermesBackup.formatErrorDetails, 'function');
      assert.equal(typeof HermesBackup.buildFailureHtml, 'function');
      assert.equal(typeof HermesBackup.buildTestHtml, 'function');
      assert.equal(typeof HermesBackup.sendBrevoEmail, 'function');
      assert.equal(typeof HermesBackup.sendFailureAlert, 'function');
      assert.equal(typeof HermesBackup.sendTestNotification, 'function');
      assert.equal(HermesBackup.DEFAULT_BREVO_API_ENDPOINT, 'https://api.brevo.com/v3/smtp/email');
      assert.equal(HermesBackup.DEFAULT_SENDER_NAME, 'Hermes Backup Bot');
      assert.equal(HermesBackup.DEFAULT_RECIPIENT_NAME, 'VPS Administrator');
    });
  });
});
