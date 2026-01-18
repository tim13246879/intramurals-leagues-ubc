/**
 * Email service abstraction - supports SMTP (nodemailer) and Azure Communication Services
 *
 * Environment variables:
 *   EMAIL_PROVIDER: 'azure' (default) or 'smtp'
 *
 *   For Azure:
 *     AZURE_COMM_CONNECTION_STRING: Azure Communication Services connection string
 *     AZURE_EMAIL_SENDER: Sender email address from Azure domain
 *
 *   For SMTP:
 *     SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 */

// Polyfill for Node 18 compatibility with Azure SDK
import { webcrypto } from 'crypto';
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

import nodemailer from 'nodemailer';
import { EmailClient } from '@azure/communication-email';

// ============ SMTP Email Service ============

class SmtpEmailService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '465'),
      secure: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
    this.senderAddress = process.env.SMTP_USER;
  }

  isConfigured() {
    return !!process.env.SMTP_USER && !!process.env.SMTP_PASS;
  }

  async sendEmail({ to, subject, html }) {
    if (!this.isConfigured()) {
      console.log('[SMTP] Not configured, skipping email');
      return false;
    }

    try {
      await this.transporter.sendMail({
        from: `"UBC IM Notify" <${this.senderAddress}>`,
        to,
        subject,
        html,
      });
      console.log(`[SMTP] Email sent to ${to}`);
      return true;
    } catch (error) {
      console.error('[SMTP] Failed to send email:', error.message);
      return false;
    }
  }
}

// ============ Azure Communication Services Email ============

class AzureEmailService {
  constructor() {
    const connectionString = process.env.AZURE_COMM_CONNECTION_STRING;
    if (connectionString) {
      this.client = new EmailClient(connectionString);
    }
    this.senderAddress = process.env.AZURE_EMAIL_SENDER;
  }

  isConfigured() {
    return !!this.client && !!this.senderAddress;
  }

  async sendEmail({ to, subject, html }) {
    if (!this.isConfigured()) {
      console.log('[Azure Email] Not configured, skipping email');
      return false;
    }

    const message = {
      senderAddress: this.senderAddress,
      content: {
        subject,
        html,
      },
      recipients: {
        to: [{ address: to }],
      },
    };

    try {
      // Start the send operation
      const poller = await this.client.beginSend(message);
      // Wait for completion (with timeout)
      const result = await poller.pollUntilDone();

      if (result.status === 'Succeeded') {
        console.log(`[Azure Email] Email sent to ${to}`);
        return true;
      } else {
        console.error(`[Azure Email] Send failed with status: ${result.status}`, result.error || '');
        return false;
      }
    } catch (error) {
      // Provide more context for common Azure errors
      const errorMsg = error.message || String(error);
      console.error('[Azure Email] Failed to send email:', errorMsg);
      console.error('[Azure Email] Full error details:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
      if (errorMsg.includes('Denied by the resource provider')) {
        console.error('[Azure Email] This usually means: 1) Sender domain not verified, 2) MailFrom address not configured, or 3) Quota exceeded. Check Azure Communication Services Email configuration.');
      }
      return false;
    }
  }
}

// ============ Email Service Factory ============

let emailServiceInstance = null;

function getEmailService() {
  if (emailServiceInstance) {
    return emailServiceInstance;
  }

  const provider = process.env.EMAIL_PROVIDER || 'azure';

  if (provider === 'smtp') {
    console.log('[Email] Using SMTP provider');
    emailServiceInstance = new SmtpEmailService();
  } else {
    console.log('[Email] Using Azure Communication Services provider');
    emailServiceInstance = new AzureEmailService();
  }

  return emailServiceInstance;
}

// Main export - unified send function
export async function sendEmail({ to, subject, html }) {
  const service = getEmailService();
  return service.sendEmail({ to, subject, html });
}

export function isEmailConfigured() {
  const service = getEmailService();
  return service.isConfigured();
}

// Export for testing/debugging
export { SmtpEmailService, AzureEmailService, getEmailService };
