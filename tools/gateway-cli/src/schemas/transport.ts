import { z } from 'zod';

/**
 * Transport requested when connecting to the gateway.
 */
export const TRANSPORT_SCHEMA = z
  .enum(['auto', 'public', 'ssm'])
  .default('auto')
  .describe('Connection transport.');

/**
 * Validated transport preference.
 */
export type Transport = z.infer<typeof TRANSPORT_SCHEMA>;
