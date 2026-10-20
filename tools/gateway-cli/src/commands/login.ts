import { loadConfiguration, saveConfiguration } from '../configuration.ts';
import { loginPublicGateway } from '../public-login.ts';

/**
 * Signs in through Cognito and saves the verified public gateway.
 * @param address - Public gateway URL, or undefined to reuse saved settings.
 * @param signal - Cancellation controlled by the CLI.
 */
export const login = async (
  address: string | undefined,
  signal: AbortSignal
) => {
  const configuration = await loadConfiguration();
  const gatewayUrl = await loginPublicGateway(
    address ?? configuration?.gatewayUrl,
    signal
  );

  signal.throwIfAborted();

  await saveConfiguration({
    preferredTransport: 'public',
    gatewayUrl,
    // Preserve private access only when it belongs to the same public gateway.
    ssm: configuration?.gatewayUrl === gatewayUrl ? configuration.ssm : undefined
  });

  process.stdout.write(`Signed in to ${gatewayUrl}.\n`);
};
