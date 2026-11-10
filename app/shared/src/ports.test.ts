import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { PORTS, PortError, assertAllowedBind, assertPortFree } from './ports.js';

describe('bind policy', () => {
  it('accepts loopback hosts', () => {
    for (const h of ['127.0.0.1', '::1', 'localhost']) expect(() => assertAllowedBind(h, PORTS.api, {})).not.toThrow();
  });
  it('refuses non-loopback hosts', () => {
    expect(() => assertAllowedBind('0.0.0.0', PORTS.api, {})).toThrow(PortError);
    expect(() => assertAllowedBind('192.168.1.10', PORTS.api, {})).toThrow(/loopback/);
    expect(() => assertAllowedBind('192.168.1.10', PORTS.api, { PHOTOVAULT_IN_CONTAINER: '1' })).toThrow(/loopback/);
  });
  it('allows 0.0.0.0 only inside a container', () => {
    expect(() => assertAllowedBind('0.0.0.0', PORTS.api, { PHOTOVAULT_IN_CONTAINER: '1' })).not.toThrow();
  });
  it('fails fast (no fallback) when a port is busy', async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    await expect(assertPortFree('127.0.0.1', port)).rejects.toThrow(/already in use/);
    await new Promise((r) => srv.close(r));
    await expect(assertPortFree('127.0.0.1', port)).resolves.toBeUndefined();
  });
});
