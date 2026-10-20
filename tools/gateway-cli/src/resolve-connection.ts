import { SSM_OPTIONS_SCHEMA } from './schemas/ssm.ts';
import { resolveTransport } from './transport.ts';
import type { Configuration } from './schemas/configuration.ts';
import type { ConnectionOptions } from './schemas/connection.ts';

/**
 * Resolves CLI overrides and saved settings without prompting.
 * @param options - Validated command-line options.
 * @param configuration - Previously saved gateway settings.
 */
export const resolveConnection = (
  options: ConnectionOptions,
  configuration: Configuration | undefined
) => {
  const hasAwsOptions = options.stack !== undefined ||
    options.region !== undefined || options.profile !== undefined;
  const hasExplicitTarget = options.gatewayUrl !== undefined || hasAwsOptions;
  const defaults = hasExplicitTarget ? undefined : configuration;
  const ssm = SSM_OPTIONS_SCHEMA.parse({
    stack: options.stack ?? configuration?.ssm?.stack,
    region: options.region ?? configuration?.ssm?.region,
    profile: options.profile ?? configuration?.ssm?.profile
  });
  const transport = resolveTransport({
    transport: options.transport,
    preferredTransport: defaults?.preferredTransport,
    gatewayUrl: options.gatewayUrl ?? defaults?.gatewayUrl,
    ssm: hasAwsOptions ? ssm : defaults?.ssm
  });

  return ({
    transport,
    // An explicit AWS target can intentionally replace the previous gateway.
    gatewayUrl: options.gatewayUrl ?? (hasAwsOptions ? undefined : configuration?.gatewayUrl),
    ssm
  });
};
