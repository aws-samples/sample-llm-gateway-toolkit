import { loadConfiguration, saveConfiguration } from './configuration.ts';
import { resolveConnection } from './resolve-connection.ts';
import type { GatewayConnection } from './connection.ts';
import type { ConnectionOptions } from './schemas/connection.ts';

/**
 * Prepares public credentials or opens an authenticated private tunnel.
 * The caller must close the returned tunnel when its command finishes.
 * @param options - Connection overrides supplied on the command line.
 * @param signal - Cancellation controlled by the CLI.
 */
export const openGatewayConnection = async (
  options: ConnectionOptions,
  signal: AbortSignal
) => {
  const configuration = await loadConfiguration();
  const selected = resolveConnection(options, configuration);

  signal.throwIfAborted();

  if (selected.transport === 'ssm') {
    const { openSsmConnection } = await import('./ssm/connection.ts');

    process.stderr.write(`Connecting to ${selected.ssm.stack}...\n`);

    const active = await openSsmConnection(
      selected.ssm,
      signal,
      selected.gatewayUrl
    );
    const ssm = {
      stack: active.gateway.stack,
      region: active.gateway.region,
      profile: selected.ssm.profile
    };
    const preferences = configuration?.preferredTransport === 'public' &&
      configuration.gatewayUrl === active.gateway.gatewayUrl
      ? configuration
      : {
        preferredTransport: 'ssm' as const,
        gatewayUrl: active.gateway.gatewayUrl
      };

    try {
      signal.throwIfAborted();

      // Retain the verified deployment so subsequent commands and logout find its key.
      await saveConfiguration({
        ...preferences,
        ssm
      });

      return (active);
    } catch (error) {
      await active.close();
      throw (error);
    }
  }

  const { getSession } = await import('./session.ts');
  const session = await getSession(selected.gatewayUrl).catch(error => {
    signal.throwIfAborted();
    throw (error);
  });

  signal.throwIfAborted();

  return ({
    connection: {
      transport: 'public',
      gatewayUrl: session.gatewayUrl,
      apiKey: session.apiKey,
      accessToken: session.accessToken
    } satisfies GatewayConnection,
    signal,
    close: undefined
  });
};
