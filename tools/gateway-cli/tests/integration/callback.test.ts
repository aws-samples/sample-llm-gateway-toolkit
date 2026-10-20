import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { text } from 'node:stream/consumers';
import { expect, test, vi } from 'vitest';
import { receiveCallback } from '../../src/callback.ts';
import type { IncomingMessage, RequestOptions, Server } from 'node:http';

/**
 * Bound local network operations so a broken listener cannot hang the suite.
 */
const TEST_TIMEOUT = 2_000;

/**
 * Successful response belonging to the test login attempt.
 */
const CALLBACK_PATH = '/callback?code=test-code&state=test-state';

/**
 * Closes a server owned by the test and waits for its port to be released.
 * @param server - Test server to close.
 */
const closeServer = async (server: Server) => {
  const closed = once(server, 'close');

  server.close();
  server.closeAllConnections();
  await closed;
};

/**
 * Allocates an unused loopback port without touching the developer's login port.
 */
const createOptions = async () => {
  const server = createServer();

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();

  await closeServer(server);

  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP address for the test server.');
  }

  return ({
    callbackUrl: `http://localhost:${address.port}/callback`,
    state: 'test-state',
    signal: AbortSignal.timeout(TEST_TIMEOUT)
  });
};

/**
 * Connects over IPv4 while retaining the registered localhost Host header.
 * @param callbackUrl - Registered redirect URL.
 * @param path - Request path and query.
 * @param init - Method or headers to exercise request validation.
 */
const sendCallback = async (
  callbackUrl: string,
  path = CALLBACK_PATH,
  init: RequestOptions = {}
) => {
  const url = new URL(callbackUrl);
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = request({
      hostname: '127.0.0.1',
      port: url.port,
      path,
      headers: {
        host: url.host
      },
      ...init,
      agent: false,
      signal: AbortSignal.timeout(TEST_TIMEOUT)
    }, resolve);

    outgoing.once('error', reject);
    outgoing.end();
  });

  return ({
    status: response.statusCode,
    headers: response.headers,
    body: await text(response)
  });
};

/**
 * Proves another login can bind the same port after cleanup.
 * @param callbackUrl - Redirect URL used by the completed listener.
 */
const expectPortReleased = async (callbackUrl: string) => {
  const server = createServer();

  server.listen(Number(new URL(callbackUrl).port), '127.0.0.1');
  await once(server, 'listening');
  await closeServer(server);
};

/**
 * Both approval and denial must reach the OAuth client without reflecting secrets.
 */
test.each([
  CALLBACK_PATH,
  '/callback?error=access_denied&state=test-state'
])('receives %s and releases the port', async path => {
  const options = await createOptions();
  const callback = await receiveCallback({
    ...options,
    onReady: async () => {
      const response = await sendCallback(options.callbackUrl, path);

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.body).toBe(
        'Sign-in response received. Return to your terminal.\n'
      );
    }
  });

  expect(callback.href).toBe(new URL(path, options.callbackUrl).href);
  await expectPortReleased(options.callbackUrl);
});

/**
 * Unrelated requests must be rejected without consuming the active login attempt.
 */
test.each([
  {
    name: 'wrong state',
    path: '/callback?code=test-code&state=other',
    init: {}
  },
  {
    name: 'duplicate state',
    path: `${CALLBACK_PATH}&state=test-state`,
    init: {}
  },
  {
    name: 'wrong path',
    path: '/other?code=test-code&state=test-state',
    init: {}
  },
  {
    name: 'wrong method',
    path: CALLBACK_PATH,
    init: {
      method: 'POST'
    }
  },
  {
    name: 'wrong Host header',
    path: CALLBACK_PATH,
    init: {
      headers: {
        host: 'attacker.example'
      }
    }
  }
])('rejects $name and keeps waiting', async ({ path, init }) => {
  const options = await createOptions();
  const callback = await receiveCallback({
    ...options,
    onReady: async () => {
      const rejected = await sendCallback(options.callbackUrl, path, init);

      expect(rejected.status).toBe(400);
      expect(rejected.body).not.toContain('test-code');

      const accepted = await sendCallback(options.callbackUrl);

      expect(accepted.status).toBe(200);
    }
  });

  expect(callback.searchParams.get('code')).toBe('test-code');
  await expectPortReleased(options.callbackUrl);
});

/**
 * A busy port must prevent browser startup and leave its existing owner alone.
 */
test('rejects an occupied port before opening the browser', async () => {
  const options = await createOptions();
  const server = createServer();
  const onReady = vi.fn(async () => undefined);

  server.listen(Number(new URL(options.callbackUrl).port), '127.0.0.1');
  await once(server, 'listening');

  try {
    await expect(receiveCallback({
      ...options,
      onReady
    })).rejects.toMatchObject({
      code: 'EADDRINUSE'
    });
    expect(onReady).not.toHaveBeenCalled();
    expect(server.listening).toBe(true);
  } finally {
    await closeServer(server);
  }

  await expectPortReleased(options.callbackUrl);
});

/**
 * Browser startup errors must retain their cause and release the callback port.
 */
test('cleans up when opening the browser fails', async () => {
  const options = await createOptions();
  const error = new Error('Browser could not start.');

  await expect(receiveCallback({
    ...options,
    onReady: async () => {
      throw error;
    }
  })).rejects.toBe(error);
  await expectPortReleased(options.callbackUrl);
});

/**
 * Cancellation must not leave a late listener or open the browser afterwards.
 */
test('cancels during listener startup', async () => {
  const options = await createOptions();
  const controller = new AbortController();
  const onReady = vi.fn(async () => undefined);
  const pending = receiveCallback({
    ...options,
    signal: AbortSignal.any([options.signal, controller.signal]),
    onReady
  });

  controller.abort();

  await expect(pending).rejects.toMatchObject({
    name: 'AbortError'
  });
  expect(onReady).not.toHaveBeenCalled();
  await expectPortReleased(options.callbackUrl);
});

/**
 * An unfinished HTTP request must not delay cancellation until its timeout.
 */
test('closes an incomplete connection when cancelled', async () => {
  const options = await createOptions();
  const controller = new AbortController();

  await expect(receiveCallback({
    ...options,
    signal: AbortSignal.any([options.signal, controller.signal]),
    onReady: async () => {
      const socket = createConnection({
        host: '127.0.0.1',
        port: Number(new URL(options.callbackUrl).port)
      });

      try {
        await once(socket, 'connect');
        socket.write('GET /callback HTTP/1.1\r\n');
        controller.abort();
        await once(socket, 'close');
      } finally {
        socket.destroy();
      }
    }
  })).rejects.toMatchObject({
    name: 'AbortError'
  });
  await expectPortReleased(options.callbackUrl);
});

/**
 * Cancellation must still work after a callback if the browser opener hangs.
 */
test('cancels while the browser opener remains pending', async () => {
  const options = await createOptions();
  const controller = new AbortController();

  await expect(receiveCallback({
    ...options,
    signal: AbortSignal.any([options.signal, controller.signal]),
    onReady: async () => {
      await sendCallback(options.callbackUrl);

      controller.abort();

      return (new Promise<never>(() => {}));
    }
  })).rejects.toMatchObject({
    name: 'AbortError'
  });
  await expectPortReleased(options.callbackUrl);
});
