import { z } from 'zod';
import { GATEWAY_URL_SCHEMA } from './gateway-url.ts';
import { SSM_OPTIONS_SCHEMA } from './ssm.ts';

/**
 * Public and private gateway endpoints available to the CLI.
 */
const ENDPOINTS_SCHEMA = z
  .strictObject({

    /**
     * Public inference endpoint.
     */
    gatewayUrl: GATEWAY_URL_SCHEMA
      .optional()
      .describe('Public gateway URL.'),

    /**
     * AWS target used for private access.
     */
    ssm: SSM_OPTIONS_SCHEMA
      .optional()
      .describe('Private gateway connection settings.')
  });

/**
 * Saved settings require an endpoint for the preferred transport.
 */
export const CONFIGURATION_SCHEMA = z
  .discriminatedUnion('preferredTransport', [
    ENDPOINTS_SCHEMA
      .required({
        gatewayUrl: true
      })
      .extend({

        /**
         * Use the public endpoint by default.
         */
        preferredTransport: z
          .literal('public')
          .describe('Preferred connection transport.')
      }),
    ENDPOINTS_SCHEMA
      .required({
        ssm: true
      })
      .extend({

        /**
         * Use the private endpoint by default.
         */
        preferredTransport: z
          .literal('ssm')
          .describe('Preferred connection transport.')
      })
  ])
  .readonly();

/**
 * Validated gateway connection settings.
 */
export type Configuration = z.infer<typeof CONFIGURATION_SCHEMA>;
