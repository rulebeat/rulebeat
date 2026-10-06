import { isIP } from 'node:net';
import type { EmailChannelConfig } from '@/lib/db/notification-channels';
import { guardedFetch, resolveSmtpAddress } from '@/lib/ssrf-guard';

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

/**
 * Sends one email through the channel's SMTP server. The host is resolved once and checked; the
 * mail client is handed that address as its host, so it never resolves the name itself, and the
 * original hostname is kept as the TLS server name so the certificate is still verified against it.
 */
export async function sendSmtpMail(
  cfg: EmailChannelConfig,
  password: string,
  message: { subject: string; text: string },
): Promise<void> {
  const address = await resolveSmtpAddress(cfg);

  const { default: nodemailer } = await import('nodemailer');
  const transporter = nodemailer.createTransport({
    host: address,
    port: cfg.port,
    secure: cfg.tls === 'tls',
    requireTLS: cfg.tls === 'starttls',
    // An IP is not a valid TLS server name, so a host configured as an IP needs none.
    tls: isIP(cfg.host) ? undefined : { servername: cfg.host },
    auth: cfg.username ? { user: cfg.username, pass: password } : undefined,
  });

  await transporter.sendMail({
    from: cfg.fromAddress,
    to: cfg.toAddresses,
    subject: message.subject,
    text: message.text,
  });
}
