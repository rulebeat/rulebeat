import { generateKeyPairSync, sign } from 'node:crypto';

/**
 * A throwaway self-signed certificate for one DNS name, built in memory so no key is ever committed.
 * node:crypto can sign but has no X.509 builder, so the few DER structures needed are written out here.
 */

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const len = body.length;
  const header = len < 0x80
    ? Buffer.from([tag, len])
    : len < 0x100
      ? Buffer.from([tag, 0x81, len])
      : Buffer.from([tag, 0x82, len >> 8, len & 0xff]);
  return Buffer.concat([header, body]);
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [a * 40 + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const pad = (n: number) => String(n).padStart(2, '0');
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(text, 'ascii'));
}

function commonName(name: string): Buffer {
  return der(0x30, der(0x31, der(0x30, oid('2.5.4.3'), der(0x0c, Buffer.from(name, 'utf8')))));
}

export function createSelfSignedCert(hostname: string): { key: string; cert: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecdsaSha256 = der(0x30, oid('1.2.840.10045.4.3.2'));
  const now = Date.now();

  const subjectAltName = der(0x30, der(0x30,
    oid('2.5.29.17'),
    der(0x04, der(0x30, der(0x82, Buffer.from(hostname, 'ascii')))),
  ));
  const tbs = der(0x30,
    der(0xa0, der(0x02, Buffer.from([2]))), // version 3
    der(0x02, Buffer.from([1])),            // serial number
    ecdsaSha256,
    commonName(hostname),                   // issuer: itself
    der(0x30, utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 30 * 86_400_000))),
    commonName(hostname),
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, subjectAltName),
  );
  const signature = sign('sha256', tbs, privateKey);
  const cert = der(0x30, tbs, ecdsaSha256, der(0x03, Buffer.from([0]), signature));

  const pem = (label: string, body: Buffer) =>
    `-----BEGIN ${label}-----\n${body.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: pem('CERTIFICATE', cert),
  };
}
