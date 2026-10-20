import { z } from 'zod';

/**
 * Maximum credential length, in characters.
 */
const MAX_AUTHORIZATION_LENGTH = 16_384;

/**
 * Cognito settings loaded from Parameter Store.
 */
export const EDGE_AUTH_SCHEMA = z
  .strictObject({

    /**
     * Cognito pool whose signing keys and issuer are trusted.
     */
    userPoolId: z
      .string()
      .min(1)
      .max(128)
      .describe('Trusted Cognito user pool.'),

    /**
     * Application client allowed to obtain gateway access.
     */
    clientId: z
      .string()
      .min(1)
      .max(128)
      .describe('Allowed Cognito application client.'),

    /**
     * Scope required on the access token.
     */
    scope: z
      .string()
      .min(1)
      .max(256)
      .describe('Required inference scope.')
  })
  .readonly();

/**
 * Requires exactly one bounded Authorization header.
 */
export const AUTHORIZATION_SCHEMA = z
  .tuple([
    z.object({

      /**
       * Bearer token supplied by the coding client.
       */
      value: z
        .string()
        .max(MAX_AUTHORIZATION_LENGTH)
        .regex(/^Bearer \S+$/i)
        .describe('One bearer credential.')
    })
  ]);

/**
 * Requires expiry even though the JWT specification makes it optional.
 */
export const TOKEN_EXPIRY_SCHEMA = z
  .object({

    /**
     * Expiry already checked against the clock by the AWS verifier.
     */
    exp: z
      .number()
      .int()
      .positive()
      .describe('Required access-token expiry.')
  });

/**
 * Validated configuration for the Lambda@Edge authorizer.
 */
export type EdgeAuthSettings = z.infer<typeof EDGE_AUTH_SCHEMA>;
