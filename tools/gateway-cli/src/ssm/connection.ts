import { authenticateSsmConnection } from './authentication.ts';
import { getGateway } from './gateway.ts';
import { openTunnel } from './tunnel.ts';
import type { SsmOptions } from '../schemas/ssm.ts';

/**
 * Opens an authenticated private connection for a coding agent.
 * The caller must close the returned tunnel when the agent exits.
 * @param options - Validated AWS connection settings.
 * @param signal - Cancels connection setup.
 * @param expectedGatewayUrl - Public URL to match when both transports are configured.
 */
export const openSsmConnection = async (
  options: SsmOptions,
  signal: AbortSignal,
  expectedGatewayUrl?: string
) => {
  const gateway = await getGateway(options, signal, expectedGatewayUrl).catch(error => {
    signal.throwIfAborted();
    throw (error);
  });
  const tunnel = await openTunnel(gateway, options, signal);
  const setupSignal = AbortSignal.any([signal, tunnel.signal]);

  try {
    const connection = await authenticateSsmConnection(
      gateway.stack,
      tunnel.url,
      setupSignal
    );

    setupSignal.throwIfAborted();

    return ({
      connection,
      gateway,
      signal: tunnel.signal,
      close: tunnel.close
    });
  } catch (error) {
    const reason: unknown = setupSignal.aborted ? setupSignal.reason : error;

    try {
      await tunnel.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [reason, cleanupError],
        'Could not prepare the private connection or complete its cleanup.'
      );
    }

    throw (reason);
  }
};
