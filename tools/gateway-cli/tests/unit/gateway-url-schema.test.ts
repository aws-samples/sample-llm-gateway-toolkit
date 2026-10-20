import { expect, test } from 'vitest';
import { GATEWAY_URL_SCHEMA } from '../../src/schemas/gateway-url.ts';

/**
 * Equivalent addresses must use the same stored login.
 */
test.each([
  'https://gateway.example.com',
  'https://gateway.example.com/',
  '  https://GATEWAY.example.com:443/  '
])('normalizes %s', value => {
  const result = GATEWAY_URL_SCHEMA.parse(value);

  expect(result).toBe('https://gateway.example.com');
});

/**
 * Reject insecure addresses and values that do not identify a gateway origin.
 */
test.each([
  'http://gateway.example.com',
  'gateway.example.com',
  'https://user@gateway.example.com',
  'https://user:password@gateway.example.com',
  'https://gateway.example.com/v1',
  'https://gateway.example.com/?token=secret',
  'https://gateway.example.com/#fragment',
  'file:///tmp/gateway',
  'https://',
  '',
  null
])('rejects %j', value => {
  const result = GATEWAY_URL_SCHEMA.safeParse(value);

  expect(result.success).toBe(false);
});
