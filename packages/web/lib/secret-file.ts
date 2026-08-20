/**
 * Reads a secret out of a mounted file — the generic counterpart to `azure-credential.ts`'s
 * `readSecretFile`, shared by the non-Azure secrets (`AUTH_SECRET_FILE`,
 * `RULEBEAT_ENCRYPTION_KEY_FILE`, `AUTH_MICROSOFT_ENTRA_ID_SECRET_FILE`). Kept separate from the
 * Azure-specific reader so its `AzureNotConfiguredError` typing and the already-tested Azure
 * credential chokepoint stay untouched.
 */
import { readFileSync } from 'node:fs';

/**
 * `.trim()` is load-bearing. `echo "secret" > file` appends a newline, and a downstream check
 * (Entra, an HMAC comparison) rejects the value with an error that never mentions the trailing
 * byte — see the identical note on `azure-credential.ts`'s `readSecretFile`.
 */
export function readSecretFileTrimmed(path: string, varName: string): string {
  const contents = readFileSync(path, 'utf8').trim();
  if (!contents) throw new Error(`${varName} points at ${path}, which is empty.`);
  return contents;
}
