import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('defaults to loopback:8480', () => {
    const c = loadConfig({});
    expect(c.host).toBe('127.0.0.1');
    expect(c.apiPort).toBe(8480);
    expect(c.dataRoot).toBeNull();
  });
  it('rejects non-loopback hosts outside a container', () => {
    expect(() => loadConfig({ PHOTOVAULT_HOST: '0.0.0.0' })).toThrow(/loopback/);
    expect(() => loadConfig({ PHOTOVAULT_HOST: '192.168.1.5', PHOTOVAULT_IN_CONTAINER: '1' })).toThrow(/loopback/);
  });
  it('allows 0.0.0.0 inside a container (compose publishes it to 127.0.0.1 only)', () => {
    expect(loadConfig({ PHOTOVAULT_HOST: '0.0.0.0', PHOTOVAULT_IN_CONTAINER: '1' }).host).toBe('0.0.0.0');
  });
  it('demo mode is off unless asked for', () => {
    expect(loadConfig({}).syntheticMedia).toBe(false);
    expect(loadConfig({ PHOTOVAULT_DEMO_MODE: '1' }).syntheticMedia).toBe(true);
  });
});
