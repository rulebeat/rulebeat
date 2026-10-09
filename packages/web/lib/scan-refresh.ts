/**
 * What happens on screen once a scan has been started. The run answers before its findings are
 * stored, so the screen waits this long and then reads them: a tab that reads its own view (the
 * explorer) reads that again, and any other tab refreshes the page as before.
 */
export const SCAN_REFRESH_DELAY_MS = 4000;

export function refreshAfterScan(onFinished: (() => void) | undefined, refreshPage: () => void): void {
  setTimeout(onFinished ?? refreshPage, SCAN_REFRESH_DELAY_MS);
}
