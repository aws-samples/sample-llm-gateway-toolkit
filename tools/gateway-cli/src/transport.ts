import type { SsmOptions } from './schemas/ssm.ts';
import type { Transport } from './schemas/transport.ts';

/**
 * Settings used to choose a transport without opening a connection.
 */
export type TransportOptions = {

  /**
   * Explicit transport choice, or auto to use the saved configuration.
   */
  readonly transport: Transport;

  /**
   * Transport preference saved after public login or a private connection.
   */
  readonly preferredTransport?: Exclude<Transport, 'auto'>;

  /**
   * Public gateway URL configured during login or supplied explicitly.
   */
  readonly gatewayUrl?: string;

  /**
   * AWS target saved after a private connection or supplied explicitly.
   */
  readonly ssm?: SsmOptions;
};

/**
 * Selects a transport from validated command options and saved settings.
 * @param options - Requested transport and configured gateway endpoints.
 * @returns The selected transport, defaulting to SSM before configuration.
 */
export const resolveTransport = (options: TransportOptions) => {
  const {
    transport,
    preferredTransport,
    gatewayUrl,
    ssm
  } = options;

  if (transport !== 'auto') {
    return (transport);
  }

  if (preferredTransport !== undefined) {
    return (preferredTransport);
  }

  if (gatewayUrl !== undefined && ssm !== undefined) {
    throw new Error(
      'Choose --transport public or --transport ssm when supplying both a gateway URL and AWS options.'
    );
  }

  return (gatewayUrl === undefined ? 'ssm' : 'public');
};
