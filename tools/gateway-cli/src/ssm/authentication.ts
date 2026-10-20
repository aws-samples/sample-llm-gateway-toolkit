import password from '@inquirer/password';
import { createGatewayHeaders } from '../connection.ts';
import { VIRTUAL_KEY_SCHEMA } from '../schemas/virtual-key.ts';
import { createVirtualKeyStore } from './key-store.ts';
import type { GatewayConnection } from '../connection.ts';

/**
 * Maximum time to verify a virtual key, in milliseconds.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Checks a virtual key through the active private tunnel.
 * @param gatewayUrl - Local address returned by the tunnel.
 * @param apiKey - Virtual key to verify.
 * @param signal - Cancellation or tunnel disconnection.
 */
const verifyVirtualKey = async (
  gatewayUrl: string,
  apiKey: string,
  signal: AbortSignal
) => {
  const response = await fetch(`${gatewayUrl}/v1/models`, {
    headers: createGatewayHeaders({
      transport: 'ssm',
      gatewayUrl,
      apiKey
    }),
    redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
  }).catch(error => {
    signal.throwIfAborted();
    throw new Error('Cannot reach the gateway through the SSM tunnel.', {
      cause: error
    });
  });

  await response.body?.cancel();

  if (response.status === 200) {
    return (true);
  }

  if (response.status === 401 || response.status === 403) {
    return (false);
  }

  throw new Error(`Gateway verification failed (HTTP ${response.status}).`);
};

/**
 * Loads a working virtual key or prompts for one before saving it.
 * @param stackArn - Full ARN of the discovered gateway stack.
 * @param gatewayUrl - Local address returned by the tunnel.
 * @param signal - Cancellation or tunnel disconnection.
 */
export const authenticateSsmConnection = async (
  stackArn: string,
  gatewayUrl: string,
  signal: AbortSignal
) => {
  const store = await createVirtualKeyStore(stackArn, signal);
  let apiKey = await store.load();

  if (apiKey !== undefined && !await verifyVirtualKey(gatewayUrl, apiKey, signal)) {
    process.stderr.write('The saved virtual key was rejected. Enter a replacement.\n');
    apiKey = undefined;
  }

  if (apiKey === undefined) {
    signal.throwIfAborted();

    // Preserve piped input for the coding agent instead of consuming it here.
    if (!process.stdin.isTTY) {
      throw new Error(
        'No usable virtual key is saved. Start your agent with --transport ssm in an interactive terminal.'
      );
    }

    const value = await password({
      message: 'LiteLLM virtual key',
      mask: true,
      validate: value => {
        return (
          VIRTUAL_KEY_SCHEMA.safeParse(value.trim()).success ||
          'Paste the virtual key without a Bearer prefix or spaces.'
        );
      }
    }, {
      signal,
      output: process.stderr
    });

    apiKey = VIRTUAL_KEY_SCHEMA.parse(value.trim());

    if (!await verifyVirtualKey(gatewayUrl, apiKey, signal)) {
      throw new Error('The gateway rejected this virtual key. Check the key and try again.');
    }

    // Keep the previous saved key until its replacement has been verified.
    await store.save(apiKey);
  }

  signal.throwIfAborted();

  return ({
    transport: 'ssm',
    gatewayUrl,
    apiKey
  } satisfies GatewayConnection);
};
