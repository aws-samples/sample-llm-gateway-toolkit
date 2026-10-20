import { z } from 'zod';

/**
 * Public login settings returned by the gateway.
 */
export const DISCOVERY_SCHEMA = z
  .strictObject({

    /**
     * Cognito issuer used to discover the OAuth endpoints.
     */
    issuer: z
      .string()
      .max(2_048)
      .regex(
        /^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9-]+_[A-Za-z0-9]+$/,
        'Expected a Cognito user pool issuer.'
      )
      .describe('Cognito user pool issuer.'),

    /**
     * Public application client used for browser login.
     */
    clientId: z
      .string()
      .min(1)
      .max(128)
      .describe('Cognito application client ID.'),

    /**
     * Scope required by the gateway's authorizer.
     */
    scope: z
      .string()
      .min(1)
      .max(256)
      .regex(/^\S+$/)
      .describe('Required inference scope.'),

    /**
     * Loopback callback already registered by the CDK deployment.
     */
    callbackUrl: z
      .literal('http://localhost:8765/callback')
      .describe('Local browser login callback.')
  })
  .readonly();

/**
 * Validated public gateway login settings.
 */
export type Discovery = z.infer<typeof DISCOVERY_SCHEMA>;
