import input from '@inquirer/input';
import password from '@inquirer/password';
import { loginWithBrowser } from './browser-login.ts';
import { discoverGateway } from './discovery.ts';
import { withSessionStore } from './session-store.ts';
import { GATEWAY_URL_SCHEMA } from './schemas/gateway-url.ts';
import { SESSION_SCHEMA } from './schemas/session.ts';

/**
 * Maximum time to verify gateway access, in milliseconds.
 */
const REQUEST_TIMEOUT = 10_000;

/**
 * Signs in through Cognito and saves credentials after verifying gateway access.
 * @param gatewayUrl - Gateway address, or undefined to prompt for it.
 * @param signal - Cancellation controlled by the CLI.
 */
export const loginPublicGateway = async (
  gatewayUrl: string | undefined,
  signal: AbortSignal
) => {
  const context = {
    signal,
    output: process.stderr
  };

  // Prompt the user for the gateway URL if it was not provided as an argument.
  const address = gatewayUrl ?? await input({
    message: 'Gateway URL',
    validate: value => {
      return (
        GATEWAY_URL_SCHEMA.safeParse(value).success ||
        'Enter the HTTPS gateway URL without a path.'
      );
    }
  }, context);

  const { url, ...settings } = await discoverGateway(address);
  const tokens = await loginWithBrowser(settings, signal);
  const expiresIn = tokens.expiresIn();

  if (
    tokens.token_type.toLowerCase() !== 'bearer' ||
    tokens.refresh_token === undefined ||
    expiresIn === undefined ||
    expiresIn <= 0
  ) {
    throw new Error(
      'Cognito did not return a renewable session. Contact your administrator.'
    );
  }

  const expiresAt = Date.now() + expiresIn * 1_000;

  // Prompt the user for the LiteLLM virtual key.
  const apiKey = await password({
    message: 'LiteLLM virtual key',
    mask: true,
    validate: value => {
      return (
        SESSION_SCHEMA.unwrap().shape.apiKey.safeParse(value.trim()).success ||
        'Paste the virtual key without a Bearer prefix or spaces.'
      );
    }
  }, context);

  // Validate and construct the session object.
  const session = SESSION_SCHEMA.parse({
    gatewayUrl: url,
    settings,
    apiKey: apiKey.trim(),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt
  });

  if (expiresAt <= Date.now()) {
    throw new Error('Browser sign-in expired. Run gateway login again.');
  }

  // Verify gateway access before saving the session.
  const response = await fetch(`${url}/v1/models`, {
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      'x-litellm-api-key': `Bearer ${session.apiKey}`
    },
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)])
  }).catch(error => {
    signal.throwIfAborted();
    throw new Error('Cannot reach the gateway. Check your connection and try again.', {
      cause: error
    });
  });

  await response.body?.cancel();

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      'The gateway rejected your sign-in or virtual key. ' +
      'Check the key or contact your administrator.'
    );
  }

  if (response.status !== 200) {
    throw new Error(
      `Gateway verification failed (HTTP ${response.status}). Try again later.`
    );
  }

  // Save the session to the local store.
  await withSessionStore(async store => {
    signal.throwIfAborted();
    await store.save(session);
  });

  return (url);
};
