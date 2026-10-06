import { isIP } from 'node:net';
import type { EmailChannelConfig } from '@/lib/db/notification-channels';
import { guardedFetch, resolveSmtpAddresses } from '@/lib/ssrf-guard';

/**
 * The one outbound send path for notifications. Dispatch (with its retries) and "Send test" both
 * call these, so a destination is checked and connected to the same way wherever a message
 * leaves from. Errors propagate: a SsrfGuardError means the destination was refused.
 */

/** POSTs a JSON body to a webhook URL. Resolves with the response; redirects are refused. */
export function postWebhookJson(url: string, body: unknown): Promise<Response> {
  return guardedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

interface SmtpMessage { subject: string; text: string }

/** How long one address gets to accept the connection before the next checked address is tried. */
const SMTP_CONNECT_TIMEOUT_MS = 10_000;

/** What one attempt does: connect to one already-checked address and send the message through it. */
export type SmtpAddressSender = (
  address: string,
  cfg: EmailChannelConfig,
  password: string,
  message: SmtpMessage,
) => Promise<void>;

/**
 * Hands the mail client the checked address as its host, so it never resolves the name itself, and
 * keeps the original hostname as the TLS server name so the certificate is still verified against it.
 */
const sendViaAddress: SmtpAddressSender = async (address, cfg, password, message) => {
  const { default: nodemailer } = await import('nodemailer');
  const transporter = nodemailer.createTransport({
    host: address,
    port: cfg.port,
    secure: cfg.tls === 'tls',
    requireTLS: cfg.tls === 'starttls',
    // An IP is not a valid TLS server name, so a host configured as an IP needs none.
    tls: isIP(cfg.host) ? undefined : { servername: cfg.host },
    auth: cfg.username ? { user: cfg.username, pass: password } : undefined,
    // The mail client's own default is two minutes per address; a send may try several.
    connectionTimeout: SMTP_CONNECT_TIMEOUT_MS,
  });

  await transporter.sendMail({
    from: cfg.fromAddress,
    to: cfg.toAddresses,
    subject: message.subject,
    text: message.text,
  });
};

let activeSender: SmtpAddressSender = sendViaAddress;

/** Test-only seam: substitute the one-address send so a test never opens a socket. */
export function setSmtpAddressSenderForTests(fn: SmtpAddressSender): void {
  activeSender = fn;
}

/** Restores the real one-address send. */
export function resetSmtpAddressSenderForTests(): void {
  activeSender = sendViaAddress;
}

const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * True when the failure happened before the server said anything, so nothing was sent and no
 * credentials were offered. The mail client overwrites a socket error's code with its own
 * (`ESOCKET`), so a failed `connect` is recognised by its syscall too. An `ETIMEDOUT` from the mail
 * client only counts when it is the connection timeout: a later inactivity timeout may be mid-message.
 */
function isConnectionFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { code?: string; syscall?: string; response?: unknown; responseCode?: unknown };
  // Any reply from the server means a connection was made and the server answered.
  if (e.response !== undefined || e.responseCode !== undefined) return false;
  if (e.syscall === 'connect') return true;
  if (e.code === 'ETIMEDOUT' && /^(Timeout|Greeting never received)/.test(e.message)) return false;
  return e.code !== undefined && CONNECTION_ERROR_CODES.has(e.code);
}

/**
 * Sends one email through the channel's SMTP server. The host is resolved once and checked, and
 * every address tried comes from that one resolution, IPv4 first. Only a failure to connect moves
 * on to the next address; a server's own answer (bad login, rejected recipient) is final, since
 * trying again elsewhere would re-offer the credentials or re-send the message. When every address
 * fails to connect, the first address's error is the one that surfaces.
 */
export async function sendSmtpMail(
  cfg: EmailChannelConfig,
  password: string,
  message: SmtpMessage,
): Promise<void> {
  const addresses = await resolveSmtpAddresses(cfg);
  let firstError: unknown;
  for (const [i, address] of addresses.entries()) {
    try {
      await activeSender(address, cfg, password, message);
      return;
    } catch (err) {
      if (!isConnectionFailure(err)) throw err;
      if (i === 0) firstError = err;
    }
  }
  throw firstError;
}
