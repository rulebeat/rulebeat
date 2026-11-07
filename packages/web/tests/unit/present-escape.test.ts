/**
 * Esc on Present, driven through the frame the way the browser drives it: the frame's key listener is
 * registered on `document` and a keydown is delivered to it. Effects do not run under the static renderer,
 * so `useEffect` runs its callback at once here, against a stand-in `document` that records the listeners.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  useEffect: (effect: () => void) => { effect(); },
}));

const push = vi.fn();
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push }),
}));

const { PresentFrame } = await import('@/app/dashboards/[id]/present/present-screen');

type Listener = (event: { key: string; defaultPrevented?: boolean }) => void;
let keydown: Listener[];

function mountFrame(fullscreenElement: unknown) {
  keydown = [];
  vi.stubGlobal('document', {
    fullscreenElement,
    fullscreenEnabled: false,
    addEventListener: (type: string, fn: Listener) => { if (type === 'keydown') keydown.push(fn); },
    removeEventListener: () => undefined,
  });
  renderToStaticMarkup(createElement(PresentFrame, { name: 'Security posture', exitHref: '/dashboards/d1?window=30', children: null }));
}

const press = (key: string) => keydown.forEach(fn => fn({ key }));

beforeEach(() => {
  push.mockReset();
  vi.unstubAllGlobals();
});

describe('Esc on Present', () => {
  it('leads to the ordinary view with the URL filters', () => {
    mountFrame(null);
    press('Escape');
    expect(push).toHaveBeenCalledExactlyOnceWith('/dashboards/d1?window=30');
  });

  it('leads there too where the browser has no Fullscreen API', () => {
    mountFrame(undefined);
    press('Escape');
    expect(push).toHaveBeenCalledExactlyOnceWith('/dashboards/d1?window=30');
  });

  it('only leaves full screen when the browser is in it', () => {
    mountFrame({});
    press('Escape');
    expect(push).not.toHaveBeenCalled();
  });

  it('ignores other keys', () => {
    mountFrame(null);
    press('Enter');
    expect(push).not.toHaveBeenCalled();
  });
});
