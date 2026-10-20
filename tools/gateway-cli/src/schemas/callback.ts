import { z } from 'zod';

/**
 * Maximum callback URL length, in characters.
 */
const MAX_CALLBACK_URL_LENGTH = 8_192;

/**
 * Validates browser requests against the current login attempt.
 * @param callbackUrl - Validated localhost redirect URL.
 * @param state - State created for the current login attempt.
 */
export const createCallbackSchema = (callbackUrl: string, state: string) => {
  const callback = new URL(callbackUrl);

  return (z
    .strictObject({

      /**
       * Authorization code callbacks arrive as GET requests.
       */
      method: z
        .literal('GET')
        .describe('Callback request method.'),

      /**
       * Require exactly one Host header for the registered address.
       */
      host: z
        .tuple([z.literal(callback.host)])
        .describe('Registered callback Host header.'),

      /**
       * Bind the request to the redirect URL and current login attempt.
       */
      url: z
        .string()
        .max(MAX_CALLBACK_URL_LENGTH)
        .transform(value => URL.parse(value, callback))
        .pipe(z.instanceof(URL))
        .refine(url => {
          return (
            url.origin === callback.origin &&
            url.pathname === callback.pathname &&
            url.username === '' &&
            url.password === '' &&
            url.hash === ''
          );
        })
        .refine(url => {
          const states = url.searchParams.getAll('state');

          return (states.length === 1 && states[0] === state);
        })
        .describe('Callback URL for the current login attempt.')
    })
    .transform(({ url }) => url));
};
