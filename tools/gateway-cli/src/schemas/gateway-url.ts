import { z } from 'zod';

/**
 * Maximum gateway URL length, in characters.
 */
const MAX_URL_LENGTH = 2_048;

/**
 * Validates and normalizes the public gateway address.
 */
export const GATEWAY_URL_SCHEMA = z
  .string()
  .trim()
  .max(MAX_URL_LENGTH)
  .pipe(z.url({
    protocol: /^https$/,
    error: 'Enter a valid HTTPS gateway URL.'
  }))
  .transform(value => new URL(value))
  .refine(url => {
    return (
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    );
  }, {
    error: 'Use the gateway URL without credentials, a path, query, or fragment.'
  })
  .transform(url => url.origin)
  .describe('Public gateway URL.');
