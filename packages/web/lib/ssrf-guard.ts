import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { EmailChannelConfig } from './db/notification-channels';

export class SsrfGuardError extends Error {}

/** A redirect response is refused, never followed. Separate class so callers can tell it from a blocked address. */
export class RedirectRefusedError extends SsrfGuardError {}

const DNS_TIMEOUT_MS = 5_000;
const DEFAULT_SEND_TIMEOUT_MS = 10_000;
// Callers only read a short prefix of an error body, so a response past this size is cut off.
const MAX_RESPONSE_BYTES = 1_048_576;

export type DnsLookup = (hostname: string) => Promise<{ address: string }[]>;

/** An address that has already passed the public-address check. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

async function defaultLookup(hostname: string): Promise<{ address: string }[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

let activeLookup: DnsLookup = defaultLookup;

/** What a send does once the destination has resolved and passed the check: connect and return the response. */
export type GuardedTransport = (url: string, init: RequestInit, addresses: ResolvedAddress[]) => Promise<Response>;

let activeTransport: GuardedTransport = requestPinned;
const testAllowedAddresses = new Set<string>();
let testTrustedCa: string | undefined;

/** Test-only seam — substitute a fake resolver so tests never touch real DNS. */
export function setDnsLookupForTests(fn: DnsLookup): void {
  activeLookup = fn;
}

/** Test-only seam: substitute the connection step so a send never opens a real socket. */
export function setGuardedTransportForTests(fn: GuardedTransport): void {
  activeTransport = fn;
}

/** Test-only seam: treat these exact addresses as public, so a send can reach a local test server. */
export function allowAddressesForTests(addresses: string[]): void {
  for (const address of addresses) testAllowedAddresses.add(address);
}

/** Test-only seam: trust this PEM certificate for HTTPS sends, so a test server can use a self-signed one. */
export function trustCertificateForTests(pem: string): void {
  testTrustedCa = pem;
}

/** Restores the real resolver and transport and clears every address and certificate allowed for a test. */
export function resetDnsLookupForTests(): void {
  activeLookup = defaultLookup;
  activeTransport = requestPinned;
  testAllowedAddresses.clear();
  testTrustedCa = undefined;
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
  const unscoped = ip.split('%')[0];
  const [head, tail] = unscoped.includes('::') ? unscoped.split('::') : [unscoped, ''];
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  // A dotted-quad tail (`::ffff:1.2.3.4`) stands for the last two groups.
  const last = tailParts.length > 0 ? tailParts : headParts;
  if (last.length > 0 && last[last.length - 1].includes('.')) {
    const quad = last.pop()!.split('.').map(Number);
    if (quad.length !== 4 || quad.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    last.push(((quad[0] << 8) | quad[1]).toString(16), ((quad[2] << 8) | quad[3]).toString(16));
  }
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return null;
  const full = [...headParts, ...Array(missing).fill('0'), ...tailParts];
  if (full.length !== 8) return null;
  return full.map(seg => seg.padStart(4, '0'));
}

/** Reads two 16-bit hex groups as one dotted IPv4 address. */
function ipv4FromGroups(hi: string, lo: string): string {
  const h = parseInt(hi, 16);
  const l = parseInt(lo, 16);
  return `${(h >> 8) & 0xff}.${h & 0xff}.${(l >> 8) & 0xff}.${l & 0xff}`;
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
    return ipv4FromGroups(segs[6], segs[7]);
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

  // ::/96 IPv4-compatible (RFC 4291, deprecated): some stacks still route it to the embedded IPv4
  // address. The form is never a legitimate destination, so it is blocked whatever the tail is.
  if (segs.slice(0, 6).every(s => s === '0000')) return true;
  // 100::/64 is the discard-only prefix (RFC 6666): traffic to it is dropped, never delivered.
  if (segs[0] === '0100' && segs.slice(1, 4).every(s => s === '0000')) return true;

  // 64:ff9b::/96 NAT64 (RFC 6052): the last 32 bits are the IPv4 address that gets connected to.
  if (segs[0] === '0064' && segs[1] === 'ff9b' && segs.slice(2, 6).every(s => s === '0000')) {
    return isBlockedIpv4(ipv4FromGroups(segs[6], segs[7]));
  }
  // 64:ff9b:1::/48 is the local-use NAT64 range (RFC 8215): never a public destination, and where
  // the IPv4 bits sit depends on the operator's prefix length, so the whole range is blocked.
  if (segs[0] === '0064' && segs[1] === 'ff9b' && segs[2] === '0001') return true;
  // 2002::/16 6to4: the 32 bits after the prefix are the IPv4 address of the relay or host.
  if (segs[0] === '2002') return isBlockedIpv4(ipv4FromGroups(segs[1], segs[2]));
  // 2001:0000::/32 Teredo tunnels: the destination is whatever the tunnel server maps it to.
  if (segs[0] === '2001' && segs[1] === '0000') return true;

  return false;
}

export function isBlockedAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isBlockedIpv4(ip);
  if (isIP(ip) === 6) return isBlockedIpv6(ip);
  return true; // unparseable — fail closed
}

function isBlockedForSend(ip: string): boolean {
  return !testAllowedAddresses.has(ip) && isBlockedAddress(ip);
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
 * Resolves `hostname` once (or takes it as-is when already an IP) and returns the addresses, every
 * one of which is public. Throws if any address is loopback, private, link-local, CGNAT, benchmark,
 * reserved, multicast or a tunnel form that embeds one of those. A send connects only to what this
 * returns, so the address that was checked is the address that is connected to.
 */
async function resolvePublicAddresses(hostname: string): Promise<ResolvedAddress[]> {
  if (isIP(hostname)) {
    if (isBlockedForSend(hostname)) {
      throw new SsrfGuardError(`Destination address ${hostname} is not a public address.`);
    }
    return [{ address: hostname, family: isIP(hostname) === 6 ? 6 : 4 }];
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

  const resolved: ResolvedAddress[] = [];
  for (const { address } of records) {
    if (isBlockedForSend(address)) {
      throw new SsrfGuardError(`${hostname} resolves to ${address}, which is not a public address.`);
    }
    resolved.push({ address, family: isIP(address) === 6 ? 6 : 4 });
  }
  return resolved;
}

/** Throws if `hostname` is, or resolves to, anything but a public address. */
export async function assertPublicHost(hostname: string): Promise<void> {
  await resolvePublicAddresses(hostname);
}

function parseWebhookUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfGuardError('URL is not valid.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfGuardError(`URL scheme ${parsed.protocol} is not allowed — must be http or https.`);
  }
  return parsed;
}

export async function assertSafeWebhookUrl(url: string): Promise<void> {
  await assertPublicHost(parseWebhookUrl(url).hostname);
}

async function resolvePublicSmtpHost(host: string): Promise<ResolvedAddress[]> {
  try {
    return await resolvePublicAddresses(host);
  } catch (err) {
    if (err instanceof SsrfGuardError) {
      throw new SsrfGuardError(`SMTP host is not allowed: ${err.message}`);
    }
    throw err;
  }
}

export async function assertSafeEmailHost(cfg: Pick<EmailChannelConfig, 'host'>): Promise<void> {
  await resolvePublicSmtpHost(cfg.host);
}

/** How many of an SMTP host's checked addresses a send will try, so a dead host cannot stall it for long. */
export const MAX_SMTP_ADDRESSES = 3;

/**
 * Resolves an SMTP host once and returns the checked addresses to connect to, in the order to try
 * them: IPv4 first, then IPv6, keeping the resolver's order within a family, at most
 * `MAX_SMTP_ADDRESSES`. The caller hands one address at a time to the mail client as the host (with
 * the original name kept for TLS), so the client never resolves the name itself.
 */
export async function resolveSmtpAddresses(cfg: Pick<EmailChannelConfig, 'host'>): Promise<string[]> {
  const addresses = await resolvePublicSmtpHost(cfg.host);
  const ordered = [
    ...addresses.filter(a => a.family === 4),
    ...addresses.filter(a => a.family === 6),
  ].map(a => a.address);
  return [...new Set(ordered)].slice(0, MAX_SMTP_ADDRESSES);
}

/** Connects to one of the already-checked addresses only: the socket's own lookup is answered from them. */
function pinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const usable = options.family === 4 || options.family === 6
      ? addresses.filter(a => a.family === options.family)
      : addresses;
    if (usable.length === 0) {
      callback(Object.assign(new Error('No checked address matches the requested family.'), { code: 'ENOTFOUND' }), '', 4);
      return;
    }
    if (options.all) {
      callback(null, usable);
      return;
    }
    callback(null, usable[0].address, usable[0].family);
  };
}

/** The real connection step: node:http(s) with the lookup pinned, TLS verified against the URL's own hostname. */
function requestPinned(url: string, init: RequestInit, addresses: ResolvedAddress[]): Promise<Response> {
  const target = new URL(url);
  const client = target.protocol === 'https:' ? https : http;
  const signal = init.signal ?? AbortSignal.timeout(DEFAULT_SEND_TIMEOUT_MS);
  if (init.body != null && typeof init.body !== 'string') {
    return Promise.reject(new TypeError('Only a string request body can be sent.'));
  }

  const headers: Record<string, string> = Object.fromEntries(new Headers(init.headers).entries());
  if (typeof init.body === 'string') headers['content-length'] = String(Buffer.byteLength(init.body));

  return new Promise<Response>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const onAbort = () => {
      req.destroy();
      reject(signal.reason);
    };
    const settle = () => signal.removeEventListener('abort', onAbort);

    // A fresh connection per send (no shared agent), so a pooled socket never skips this check.
    const req = client.request(target, {
      method: init.method ?? 'GET',
      headers,
      agent: false,
      lookup: pinnedLookup(addresses),
      ...(testTrustedCa ? { ca: testTrustedCa } : {}),
    }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        if (size < MAX_RESPONSE_BYTES) chunks.push(chunk);
        size += chunk.length;
      });
      res.on('end', () => {
        settle();
        try {
          const status = res.statusCode ?? 0;
          const resHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) value.forEach(v => resHeaders.append(name, v));
            else if (value !== undefined) resHeaders.set(name, value);
          }
          const bodyless = status === 204 || status === 205 || status === 304;
          resolve(new Response(bodyless ? null : new Uint8Array(Buffer.concat(chunks)), {
            status,
            statusText: res.statusMessage,
            headers: resHeaders,
          }));
        } catch (err) {
          reject(err);
        }
      });
      res.on('error', err => { settle(); reject(err); });
    });
    req.on('error', err => { settle(); reject(err); });
    signal.addEventListener('abort', onAbort, { once: true });
    req.end(init.body ?? undefined);
  });
}

/**
 * Guarded `fetch` for an admin-configured destination: resolves the host once, rejects it unless
 * every address is public, then connects only to those addresses (TLS still verified against the
 * URL's hostname). A redirect response is rejected outright rather than followed (spec 021 —
 * cheaper than re-validating each hop of a redirect chain). The body must be a string.
 */
export async function guardedFetch(url: string, init: RequestInit): Promise<Response> {
  const parsed = parseWebhookUrl(url);
  const addresses = await resolvePublicAddresses(parsed.hostname);
  const res = await activeTransport(url, init, addresses);
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new RedirectRefusedError(`Refusing to follow a redirect response from ${url}.`);
  }
  return res;
}
