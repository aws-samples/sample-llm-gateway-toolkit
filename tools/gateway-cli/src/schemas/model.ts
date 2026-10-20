import { z } from 'zod';

/**
 * Model metadata required to configure OpenCode's context handling.
 */
export const MODEL_SCHEMA = z
  .object({

    /**
     * Model alias exposed by the gateway.
     */
    id: z
      .string()
      .min(1)
      .max(256)
      .describe('Gateway model alias.'),

    /**
     * Advertised input token limit.
     */
    max_input_tokens: z
      .number()
      .int()
      .positive()
      .describe('Maximum input tokens.'),

    /**
     * Advertised output token limit.
     */
    max_output_tokens: z
      .number()
      .int()
      .positive()
      .describe('Maximum output tokens.')
  })
  .readonly();

/**
 * Gateway model with validated token limits.
 */
export type GatewayModel = z.infer<typeof MODEL_SCHEMA>;
