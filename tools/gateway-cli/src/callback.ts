import { addAbortListener, once } from 'node:events';
import { createServer } from 'node:http';
import { createCallbackSchema } from './schemas/callback.ts';

/**
 * HTTP request and header timeout, in milliseconds.
 */
const REQUEST_TIMEOUT = 10_000;

/**
 * Settings for receiving one browser login response.
 */
export type CallbackOptions = {

  /**
   * Validated localhost redirect URL.
   */
  readonly callbackUrl: string;

  /**
   * State identifying the current login attempt.
   */
  readonly state: string;

  /**
   * Cancels startup and waiting for the browser response.
   */
  readonly signal: AbortSignal;

  /**
   * Opens the browser after the local port is listening.
   */
  readonly onReady: () => Promise<unknown>;
};

/**
 * Receives a matching callback and closes the listener on every exit path.
 * @param options - Callback address, login state, cancellation, and browser opener.
 */
export const receiveCallback = async (options: CallbackOptions) => {
  options.signal.throwIfAborted();

  const callback = new URL(options.callbackUrl);
  const schema = createCallbackSchema(options.callbackUrl, options.state);
  const server = createServer({
    headersTimeout: REQUEST_TIMEOUT,
    requestTimeout: REQUEST_TIMEOUT
  });
  let abortSubscription: ReturnType<typeof addAbortListener> | undefined;

  // A promise that rejects if the operation is aborted.
  const cancelled = new Promise<never>((_, reject) => {
    abortSubscription = addAbortListener(options.signal, () => {
      reject(options.signal.reason);
    });
  });

  // A promise that resolves when a valid callback is received.
  const completed = new Promise<URL>((resolve, reject) => {
    server.once('error', reject);
    server.on('request', (request, response) => {
      const result = schema.safeParse({
        method: request.method,
        host: request.headersDistinct.host,
        url: request.url
      });

      response.writeHead(result.success ? 200 : 400, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': 'default-src \'none\'; frame-ancestors \'none\'',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        connection: 'close'
      });

      if (!result.success) {
        response.end(
          'This request does not match the active login. Return to your terminal.\n'
        );
        return;
      }

      response.once('finish', () => resolve(result.data));
      response.end('Sign-in response received. Return to your terminal.\n');
    });
  });

  /**
   * Starts listening before invoking the browser opener.
   */
  const start = async () => {
    const listening = once(server, 'listening', {
      signal: options.signal
    });

    // Start the server.
    server.listen({
      host: '127.0.0.1',
      port: Number(callback.port),
      signal: options.signal
    });

    // Wait for the server to start.
    await listening;

    // Invoke the onReady callback after the server has started.
    await options.onReady();
  };

  try {
    const [url] = await Promise.race([
      Promise.all([completed, start()]),
      cancelled
    ]);

    return (url);
  } finally {
    abortSubscription?.[Symbol.dispose]();
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
};
