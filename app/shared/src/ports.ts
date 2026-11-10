import net from 'node:net';

/** Default ports. Every one is configurable; all default to loopback (127.0.0.1) only. */
export const PORTS = { postgres: 54329, api: 8480, delivery: 8481, webDev: 5173, /** development API (demo database) */ devApi: 8482 } as const;

export class PortError extends Error {}

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Throws unless the host is loopback. The one exception is a container (PHOTOVAULT_IN_CONTAINER=1): inside Docker the server must listen on
 * all interfaces of the container so the published port works, and docker-compose.yml publishes it to 127.0.0.1 on the host only.
 */
export function assertAllowedBind(host: string, _port: number, env: NodeJS.ProcessEnv = process.env): void {
  if (LOOPBACK_HOSTS.has(host)) return;
  if (env.PHOTOVAULT_IN_CONTAINER === '1' && host === '0.0.0.0') return;
  throw new PortError(`Refusing to bind ${host}; AI PhotoVault listens on loopback (127.0.0.1) only. See docs/SECURITY.md before exposing it.`);
}

/** Fail-fast availability probe. Never falls back to another port. */
export function assertPortFree(host: string, port: number): Promise<void> {
  assertAllowedBind(host, port);
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      reject(new PortError(err.code === 'EADDRINUSE' ? `Port ${host}:${port} is already in use.` : String(err)));
    });
    probe.once('listening', () => probe.close(() => resolve()));
    probe.listen(port, host);
  });
}
