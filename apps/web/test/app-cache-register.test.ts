// ADR-0019: the app registers its worker only in production builds in a secure context.
import { describe, expect, it, vi } from 'vitest';
import { WORKER_URL, registerAppCache, type WorkerHost } from '../src/offline/register.js';

function host() {
  const register = vi.fn(() => Promise.resolve());
  const value: WorkerHost = { serviceWorker: { register } };
  return { value, register };
}

describe('registering the worker', () => {
  it('registers /sw.js for the whole site in a production build', async () => {
    const { value, register } = host();
    await registerAppCache({ production: true, host: value });
    expect(WORKER_URL).toBe('/sw.js');
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('does nothing in development, where Vite serves the files', async () => {
    const { value, register } = host();
    await registerAppCache({ production: false, host: value });
    expect(register).not.toHaveBeenCalled();
  });

  it('does nothing without service workers (plain http:// outside localhost)', async () => {
    await expect(registerAppCache({ production: true, host: {} })).resolves.toBeUndefined();
  });

  it('leaves the app as it is when registration fails', async () => {
    const value: WorkerHost = {
      serviceWorker: {
        register: () => Promise.reject(new DOMException('denied', 'SecurityError')),
      },
    };
    await expect(registerAppCache({ production: true, host: value })).resolves.toBeUndefined();
  });
});
