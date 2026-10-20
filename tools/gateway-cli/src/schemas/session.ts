import { z } from 'zod';
import { DISCOVERY_SCHEMA } from './discovery.ts';
import { GATEWAY_URL_SCHEMA } from './gateway-url.ts';

/**
 * Credentials must fit HTTP headers without whitespace or control characters.
 */
const CREDENTIAL_SCHEMA = z
  .string()
  .min(1)
  .max(16_384)
  .regex(
    /^[\x21-\x7E]+$/,
    'Expected a credential without spaces or control characters.'
  );

/**
 * Credentials and gateway settings retained between CLI invocations.
 */
export const SESSION_SCHEMA = z
  .strictObject({

    /**
     * Public gateway associated with these credentials.
     */
    gatewayUrl: GATEWAY_URL_SCHEMA,

    /**
     * Cognito settings used when refreshing the access token.
     */
    settings: DISCOVERY_SCHEMA,

    /**
     * LiteLLM virtual key sent alongside the Cognito access token.
     */
    apiKey: CREDENTIAL_SCHEMA
      .describe('LiteLLM virtual key.'),

    /**
     * Access token presented to the gateway authorizer.
     */
    accessToken: CREDENTIAL_SCHEMA
      .describe('Cognito access token.'),

    /**
     * Refresh token used to renew access without another browser login.
     */
    refreshToken: CREDENTIAL_SCHEMA
      .describe('Cognito refresh token.'),

    /**
     * Access token expiration as Unix time in milliseconds.
     */
    expiresAt: z
      .number()
      .int()
      .positive()
      .describe('Access token expiration as Unix time in milliseconds.')
  })
  .readonly();

/**
 * Validated gateway session.
 */
export type Session = z.infer<typeof SESSION_SCHEMA>;
