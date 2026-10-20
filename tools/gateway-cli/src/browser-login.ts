import open from 'open';

import { AuthorizationResponseError } from 'openid-client';
import { receiveCallback } from './callback.ts';
import { createLoginFlow } from './login-flow.ts';
import type { Discovery } from './schemas/discovery.ts';

/**
 * Time allowed for interactive sign-in, in milliseconds.
 */
const LOGIN_TIMEOUT = 5 * 60 * 1_000;

/**
 * Opens Cognito, receives the browser callback, and exchanges its code for tokens.
 * @param settings - Validated public gateway login settings.
 * @param signal - Cancellation controlled by the CLI.
 */
export const loginWithBrowser = async (
  settings: Discovery,
  signal: AbortSignal
) => {
  const loginSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(LOGIN_TIMEOUT)
  ]);

  signal.throwIfAborted();

  try {
    const flow = await createLoginFlow(settings);
    const callback = await receiveCallback({
      callbackUrl: settings.callbackUrl,
      state: flow.state,
      signal: loginSignal,
      onReady: async () => {
        loginSignal.throwIfAborted();
        process.stderr.write(
          `\nSign in using your browser:\n${flow.url.href}\n\n` +
          'Waiting for sign-in. Press Ctrl+C to cancel.\n'
        );

        try {
          await open(flow.url.href);
        } catch {
          process.stderr.write(
            'Could not open your browser. Open the link above manually.\n'
          );
        }
      }
    });

    loginSignal.throwIfAborted();

    const tokens = await flow.complete(callback);

    loginSignal.throwIfAborted();

    return (tokens);
  } catch (error) {
    signal.throwIfAborted();

    if (loginSignal.aborted) {
      throw new Error('Sign-in timed out. Run gateway login to try again.', {
        cause: error
      });
    }

    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'EADDRINUSE'
    ) {
      throw new Error(
        `Port ${new URL(settings.callbackUrl).port} is already in use. ` +
        'Close the other login attempt or application, then try again.',
        { cause: error }
      );
    }

    if (
      error instanceof AuthorizationResponseError &&
      error.error === 'access_denied'
    ) {
      throw new Error('Sign-in was declined. Run gateway login to try again.', {
        cause: error
      });
    }

    throw new Error(
      'Could not complete sign-in. Check your connection and try gateway login again.',
      { cause: error }
    );
  }
};
