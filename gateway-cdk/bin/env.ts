import { z } from 'zod';

/**
 * Environment settings supplied to the CDK application.
 */
const ENV_SCHEMA = z.object({

  /**
   * AWS Region selected by the CDK CLI.
   */
  CDK_DEFAULT_REGION: z
    .string()
    .default('eu-west-1')
    .describe('Deployment Region.'),

  /**
   * AWS account resolved by the CDK CLI.
   */
  CDK_DEFAULT_ACCOUNT: z
    .string()
    .optional()
    .describe('Deployment account.'),

  /**
   * Enable authenticated public inference.
   * @default false
   */
  PUBLIC_ACCESS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true')
    .describe('Enable Cognito, CloudFront, and the internal ALB.')
});

/**
 * Validated deployment environment.
 */
export const env = ENV_SCHEMA.parse(process.env);
