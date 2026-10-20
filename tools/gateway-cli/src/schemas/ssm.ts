import { z } from 'zod';

/**
 * AWS settings used to discover and connect to the private gateway.
 */
export const SSM_OPTIONS_SCHEMA = z
  .strictObject({

    /**
     * CloudFormation stack that owns the gateway.
     */
    stack: z
      .string()
      .trim()
      .min(1)
      .max(2_048)
      .default('LlmGatewayToolkit-Gateway')
      .describe('Gateway stack name or ARN.'),

    /**
     * Optional override for the AWS SDK's region resolution.
     */
    region: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .describe('AWS Region. Defaults to your AWS configuration.'),

    /**
     * Optional override for the AWS SDK's credential profile.
     */
    profile: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .optional()
      .describe('AWS profile. Defaults to your AWS configuration.')
  })
  .readonly();

/**
 * Validated private gateway settings.
 */
export type SsmOptions = z.infer<typeof SSM_OPTIONS_SCHEMA>;
