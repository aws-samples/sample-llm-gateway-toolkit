import { z } from 'zod';

/**
 * Maximum secret size supported by Windows Credential Manager, in bytes.
 */
const MAX_VIRTUAL_KEY_BYTES = 2_560;

/**
 * Printable ASCII keeps the key safe for headers and within the vault limit.
 */
export const VIRTUAL_KEY_SCHEMA = z
  .string()
  .min(1)
  .max(MAX_VIRTUAL_KEY_BYTES)
  .regex(
    /^[\x21-\x7E]+$/,
    'Expected a virtual key without spaces or control characters.'
  )
  .describe('LiteLLM virtual key.');
