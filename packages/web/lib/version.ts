import pkg from '../package.json';

/**
 * Single source of truth for "what version is this running" — reads straight from package.json
 * rather than a separately-maintained constant, so it can never drift from what was actually
 * published.
 */
export function getAppVersion(): string {
  return pkg.version;
}
