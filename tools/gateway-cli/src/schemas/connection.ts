import { GATEWAY_URL_SCHEMA } from './gateway-url.ts';
import { SSM_OPTIONS_SCHEMA } from './ssm.ts';
import { TRANSPORT_SCHEMA } from './transport.ts';
import type { z } from 'zod';

/**
 * Reuses the validation already defined for AWS connection options.
 */
const SSM_FIELDS = SSM_OPTIONS_SCHEMA.unwrap().shape;

/**
 * Shared connection options for gateway commands.
 */
export const CONNECTION_OPTIONS_SCHEMA = SSM_OPTIONS_SCHEMA
  .unwrap()
  .extend({

    /**
     * Explicit stack override; apply the default after selecting SSM.
     */
    stack: SSM_FIELDS.stack
      .unwrap()
      .optional()
      .describe('Gateway stack name or ARN.'),

    /**
     * Use an explicit transport or resolve it from the supplied settings.
     */
    transport: TRANSPORT_SCHEMA,

    /**
     * Public endpoint, also used to match a stack when both modes are configured.
     */
    gatewayUrl: GATEWAY_URL_SCHEMA
      .optional()
      .describe('Public gateway URL.')
  })
  .readonly();

/**
 * Validated CLI connection options.
 */
export type ConnectionOptions = z.infer<typeof CONNECTION_OPTIONS_SCHEMA>;
