/**
 * The page holds one revision of the dashboard (ADR 0013). A counting response computed from a newer one
 * means the saved filters moved underneath it: the bar and every number reload together, unless a layout
 * edit is open, which a reload must not discard. Then the page keeps showing one revision, bar included,
 * and takes the newer one when the edit ends.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  CHANGED_NOTICE_DEFERRED, CHANGED_NOTICE_RELOADED, incomingDashboard, noticeFor, reportedRevision, seeRevision,
} from '@/lib/dashboard-revision';
import { WidgetRequestProvider, useRevisionReport } from '@/components/dashboard/widget-request';

describe('a response computed from another revision', () => {
  it('is ignored when it is the held one or older', () => {
    expect(seeRevision({ held: 4, handled: 4 }, 4)).toEqual({ view: { held: 4, handled: 4 }, newer: false });
    expect(seeRevision({ held: 4, handled: 4 }, 3).newer).toBe(false);
  });

  it('is a reload when it is newer, and only once however many widgets report it', () => {
    const first = seeRevision({ held: 4, handled: 4 }, 5);
    expect(first.newer).toBe(true);
    expect(seeRevision(first.view, 5).newer).toBe(false);
    expect(seeRevision(first.view, 6).newer).toBe(true);
  });
});

describe('the dashboard a reload brings', () => {
  it('is taken when it is newer and no layout edit is open', () => {
    expect(incomingDashboard({ held: 4, incoming: 5, layoutEditOpen: false })).toBe('adopt');
  });

  it('waits while a layout edit is open, and is taken once the edit ends', () => {
    expect(incomingDashboard({ held: 4, incoming: 5, layoutEditOpen: true })).toBe('defer');
    expect(incomingDashboard({ held: 4, incoming: 5, layoutEditOpen: false })).toBe('adopt');
  });

  it('never takes an older one, such as the page the server rendered before this tab saved', () => {
    expect(incomingDashboard({ held: 5, incoming: 4, layoutEditOpen: false })).toBe('same');
    expect(incomingDashboard({ held: 5, incoming: 5, layoutEditOpen: false })).toBe('same');
  });
});

describe('the conflict notice', () => {
  it('says the bar and every number were reloaded only when they were', () => {
    expect(noticeFor('adopt')).toBe(CHANGED_NOTICE_RELOADED);
    expect(CHANGED_NOTICE_RELOADED).toMatch(/filter bar and every number were reloaded/);
    expect(noticeFor('defer')).toBe(CHANGED_NOTICE_DEFERRED);
    expect(CHANGED_NOTICE_DEFERRED).not.toMatch(/were reloaded/);
    expect(CHANGED_NOTICE_DEFERRED).toMatch(/layout/);
  });
});

describe('the revision a counting response reports', () => {
  it('is read from the response body when it is a number', () => {
    expect(reportedRevision({ revision: 7, total: 3 })).toBe(7);
    expect(reportedRevision({ revision: '7' })).toBeUndefined();
    expect(reportedRevision({})).toBeUndefined();
    expect(reportedRevision(null)).toBeUndefined();
  });

  it('reaches the page from a widget rendered under its request scope', () => {
    const onRevision = vi.fn();
    let report: ((revision: number) => void) | undefined;
    const Probe = () => { report = useRevisionReport(); return null; };
    renderToStaticMarkup(createElement(
      WidgetRequestProvider, { value: { dashboardId: 'd1', widgetId: 'w1', changes: '', onRevision } }, createElement(Probe),
    ));
    report!(9);
    expect(onRevision).toHaveBeenCalledWith(9);
  });

  it('is nobody\'s concern outside a page that listens', () => {
    let report: ((revision: number) => void) | undefined = () => undefined;
    const Probe = () => { report = useRevisionReport(); return null; };
    renderToStaticMarkup(createElement(Probe));
    expect(report).toBeUndefined();
  });
});
