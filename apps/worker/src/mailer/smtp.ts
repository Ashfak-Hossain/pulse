import { createTransport } from 'nodemailer';
import type { EmailMessage } from './templates.js';

// A mail server that stops answering must fail the send (and the job retries), not hold one of
// the queue's 10 slots for the OS timeout. Each step is below the claim lease in send-email.ts
const TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 30_000,
};

export interface SmtpSender {
  send: (message: EmailMessage) => Promise<void>;
  close: () => void;
}

/** Sends plain-text email through one SMTP server (Mailpit in dev). */
export function createSmtpSender(url: string, from: string): SmtpSender {
  const transport = createTransport(transportOptions(url));
  return {
    send: async ({ to, subject, text }) => {
      await transport.sendMail({ from, to, subject, text });
    },
    close: () => transport.close(),
  };
}

/**
 * One options object: with a URL string first, nodemailer reads a second argument as message
 * defaults and the timeouts would be ignored. A login over plain smtp:// must upgrade to TLS or
 * fail; nodemailer otherwise sends it in clear text when the server's STARTTLS offer is missing
 * (or stripped on the way). Mailpit on this machine has no TLS, and nothing to steal.
 */
export function transportOptions(url: string) {
  const { protocol, username, hostname } = new URL(url);
  const local = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  const requireTLS = protocol === 'smtp:' && username !== '' && !local;
  return { url, requireTLS, ...TIMEOUTS };
}

/**
 * A short label for logs and last_error, and whether a retry can help. 5xx replies are final
 * (a rejected address, say); network errors, timeouts, 4xx and a refused login (fixed in config,
 * then the retry works) are worth another try.
 */
export function smtpFailure(error: unknown): { label: string; permanent: boolean } {
  const fields = typeof error === 'object' && error !== null ? error : {};
  const reply = 'responseCode' in fields ? fields.responseCode : undefined;
  const code = 'code' in fields ? fields.code : undefined;
  if (typeof reply === 'number') {
    const permanent = reply >= 500 && reply < 600 && code !== 'EAUTH';
    return { label: `SMTP ${reply}`, permanent };
  }
  const label = typeof code === 'string' && /^E[A-Z]{2,20}$/.test(code) ? code : 'send failed';
  return { label: `SMTP ${label}`, permanent: false };
}
