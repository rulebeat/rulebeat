import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { EmailChannelConfig } from './db/notification-channels';

export class SsrfGuardError extends Error {}

const DNS_TIMEOUT_MS = 5_000;

export type DnsLookup = (hostname: string) => Promise<{ address: string }[]>;

async function defaultLookup(hostname: string): Promise<{ address: string }[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

let activeLookup: DnsLookup = defaultLookup;

/** Test-only seam — substitute a fake resolver so tests never touch real DNS. */
export function setDnsLookupForTests(fn: DnsLookup): void {
  activeLookup = fn;
}

export function resetDnsLookupForTests(): void {
  activeLookup = defaultLookup;
}

function ipv4ToInt(parts: number[]): number {
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inIpv4Range(ip: string, base: string, bits: number): boolean {
  const ipParts = ip.split('.').map(Number);
  const baseParts = base.split('.').map(Number);
  if (ipParts.length !== 4 || baseParts.length !== 4) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ipParts) & mask) === (ipv4ToInt(baseParts) & mask);
}

function isBlockedIpv4(ip: string): boolean {
  return (
    inIpv4Range(ip, '127.0.0.0', 8) ||   // loopback
    inIpv4Range(ip, '10.0.0.0', 8) ||    // private
    inIpv4Range(ip, '172.16.0.0', 12) || // private
    inIpv4Range(ip, '192.168.0.0', 16) || // private
    inIpv4Range(ip, '169.254.0.0', 16) || // link-local, incl. cloud metadata
    inIpv4Range(ip, '100.64.0.0', 10) ||  // CGNAT
    inIpv4Range(ip, '198.18.0.0', 15) ||  // benchmark
    inIpv4Range(ip, '240.0.0.0', 4) ||    // reserved
    inIpv4Range(ip, '0.0.0.0', 8) ||      // "this network"
    inIpv4Range(ip, '224.0.0.0', 4)       // multicast
  );
}

function expandIpv6(ip: string): string[] | null {
  // Minimal expansion sufficient for prefix comparison — not a full normalizer.
  if (!ip.includes(':')) return null;
  const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, ''];
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return null;
  const full = [...headParts, ...Array(missing).fill('0'), ...tailParts];
  if (full.length !== 8) return null;
  return full.map(seg => seg.padStart(4, '0'));
}

/** Unwraps an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) to its embedded IPv4 form, else null. */
function unwrapIpv4MappedIpv6(ip: string): string | null {
  const lower = ip.toLowerCase();
  const match = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (match) return match[1];
  // ::ffff:0:0/96 fully-hex form
  const segs = expandIpv6(lower);
  if (segs && segs[0] === '0000' && segs[1] === '0000' && segs[2] === '0000' &&
      segs[3] === '0000' && segs[4] === '0000' && segs[5] === 'ffff') {
    const hi = parseInt(segs[6], 16);
    const lo = parseInt(segs[7], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;

  const mapped = unwrapIpv4MappedIpv6(lower);
  if (mapped) return isBlockedIpv4(mapped);

  const segs = expandIpv6(lower);
  if (!segs) return false;
  const first = parseInt(segs[0], 16);

  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  return false;
}

export function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isBlockedIpv4(ip);
  if (isIP(ip) === 6) return isBlockedIpv6(ip);
  return true; // unparseable — fail closed
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new SsrfGuardError(message)), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Throws if `hostname` (already an IP, or resolved via DNS) is loopback, private, link-local,
 * CGNAT, benchmark, reserved, or multicast. Best-effort: validates the resolved address at check
 * time, does not pin the subsequent connection to it (see spec 021 §1).
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new SsrfGuardError(`Destination address ${hostname} is not a public address.`);
    }
    return;
  }

  let records: { address: string }[];
  try {
    records = await withTimeout(
      activeLookup(hostname),
      DNS_TIMEOUT_MS,
      `Timed out resolving ${hostname}.`,
    );
  } catch (err) {
    if (err instanceof SsrfGuardError) throw err;
    throw new SsrfGuardError(`Could not resolve ${hostname}.`);
  }

  if (records.length === 0) {
    throw new SsrfGuardError(`Could not resolve ${hostname}.`);
  }

  for (const { address } of records) {
    if (isBlockedAddress(address)) {
      throw new SsrfGuardError(`${hostname} resolves to ${address}, which is not a public address.`);
    }
  }
}

export async function assertSafeWebhookUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfGuardError('URL is not valid.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfGuardError(`URL scheme ${parsed.protocol} is not allowed — must be http or https.`);
  }
  await assertPublicHost(parsed.hostname);
}

export async function assertSafeEmailHost(cfg: Pick<EmailChannelConfig, 'host'>): Promise<void> {
  try {
    await assertPublicHost(cfg.host);
  } catch (err) {
    if (err instanceof SsrfGuardError) {
      throw new SsrfGuardError(`SMTP host is not allowed: ${err.message}`);
    }
    throw err;
  }
}

/**
 * Guarded `fetch`: checks the destination, then sends the request with `redirect: 'manual'` and
 * rejects any redirect response outright rather than following it (spec 021 — cheaper than
 * re-validating each hop of a redirect chain, acceptable for an admin-configured destination).
 */
export async function guardedFetch(url: string, init: RequestInit): Promise<Response> {
  await assertSafeWebhookUrl(url);
  const res = await fetch(url, { ...init, redirect: 'manual' });
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new SsrfGuardError(`Refusing to follow a redirect response from ${url}.`);
  }
  return res;
}
