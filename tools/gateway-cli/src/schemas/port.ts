import { z } from 'zod';

/**
 * TCP port accepted by the gateway and tunnel commands.
 */
export const PORT_SCHEMA = z
  .coerce.number()
  .int()
  .min(1)
  .max(65_535)
  .describe('TCP port.');
