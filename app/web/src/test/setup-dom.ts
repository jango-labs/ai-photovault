import { afterEach, expect, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import * as matchers from 'vitest-axe/matchers';


expect.extend(matchers);
// the suites run in parallel with the database and end-to-end projects; give asynchronous queries room so a busy machine does not fail a correct test
configure({ asyncUtilTimeout: 8000 });
afterEach(() => { cleanup(); vi.useRealTimers(); });

// jsdom has no layout. Give elements a deterministic size so virtualised components render rows.
const W = 1000, H = 600;
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => W });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => H });
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => W });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => H });
HTMLElement.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, top: 0, left: 0, right: W, bottom: H, width: W, height: H, toJSON() {} } as DOMRect; };
HTMLElement.prototype.scrollIntoView = function () {};
class RO { constructor(private cb: ResizeObserverCallback) {} observe(el: Element) { this.cb([{ target: el, contentRect: { width: W, height: H } as DOMRectReadOnly } as ResizeObserverEntry], this as unknown as ResizeObserver); } unobserve() {} disconnect() {} }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;      // plain assignment: vi.unstubAllGlobals() in tests must not remove it
Object.defineProperty(window, 'matchMedia', { writable: true, value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }) });
