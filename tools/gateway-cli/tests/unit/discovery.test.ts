import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { discoverGateway } from '../../src/discovery.ts';
import type { Discovery } from '../../src/schemas/discovery.ts';

/**
 * Public address used by the simulated gateway.
 */
const GATEWAY_URL = 'https://gateway.example.com';

/**
 * Public settings matching the gateway's Cognito configuration.
 */
const LOGIN_SETTINGS = {
  issuer: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_example',
  clientId: 'exampleclient',
  scope: 'gateway/invoke',
  callbackUrl: 'http://localhost:8765/callback'
} satisfies Discovery;

/**
 * Prevent unit tests from contacting a deployed gateway.
 */
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>());
});

/**
 * Restore the original transport after each test.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Discovery sends no credentials and must stay on the supplied gateway.
 */
test('loads public login settings without following redirects', async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json(LOGIN_SETTINGS));

  const result = await discoverGateway(`${GATEWAY_URL}/`);

  expect(result).toEqual({
    url: GATEWAY_URL,
    ...LOGIN_SETTINGS
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledWith(`${GATEWAY_URL}/.well-known/llm-gateway`, {
    headers: {
      accept: 'application/json'
    },
    redirect: 'error',
    signal: expect.any(AbortSignal)
  });
});

/**
 * Reject insecure input before starting a network request.
 */
test('validates the gateway URL before connecting', async () => {
  await expect(discoverGateway('http://gateway.example.com')).rejects.toThrow();

  expect(fetch).not.toHaveBeenCalled();
});

/**
 * HTTP failures should retain the status for troubleshooting.
 */
test.each([401, 403, 404, 503])('reports HTTP %i', async status => {
  vi.mocked(fetch).mockResolvedValue(new Response('Unavailable', {
    status
  }));

  await expect(discoverGateway(GATEWAY_URL)).rejects.toThrow(`HTTP ${status}`);
});

/**
 * Network failures should tell the developer what to check.
 */
test('explains connection failures', async () => {
  vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'));

  await expect(discoverGateway(GATEWAY_URL)).rejects.toThrow(
    'Check the URL and your connection.'
  );
});

/**
 * Reject settings outside the supported Cognito login flow.
 */
test.each([
  {
    issuer: 'https://cognito-idp.eu-west-1.amazonaws.com.attacker.example/pool'
  },
  {
    callbackUrl: 'https://attacker.example/callback'
  },
  {
    scope: 'gateway/invoke unwanted/scope'
  },
  {
    clientId: ''
  },
  {
    clientSecret: 'unexpected'
  }
])('rejects invalid login settings: %j', async overrides => {
  vi.mocked(fetch).mockResolvedValue(Response.json({
    ...LOGIN_SETTINGS,
    ...overrides
  }));

  await expect(discoverGateway(GATEWAY_URL)).rejects.toThrow(
    'Could not read valid gateway login settings.'
  );
});

/**
 * Empty and malformed responses should produce a readable error.
 */
test.each([null, 'not json'])('rejects an unreadable response: %j', async body => {
  vi.mocked(fetch).mockResolvedValue(new Response(body));

  await expect(discoverGateway(GATEWAY_URL)).rejects.toThrow(
    'Could not read valid gateway login settings.'
  );
});

/**
 * Stop downloading as soon as the accumulated response exceeds the limit.
 */
test('cancels an oversized response stream', async () => {
  const cancel = vi.fn();
  const document = JSON.stringify(LOGIN_SETTINGS).padEnd(8_193, ' ');
  const body = new ReadableStream<Uint8Array>({
    start: controller => {
      const encoder = new TextEncoder();

      controller.enqueue(encoder.encode(document.slice(0, 4_096)));
      controller.enqueue(encoder.encode(document.slice(4_096)));
    },
    cancel
  });

  vi.mocked(fetch).mockResolvedValue(new Response(body));

  await expect(discoverGateway(GATEWAY_URL)).rejects.toThrow(
    'Could not read valid gateway login settings.'
  );
  expect(cancel).toHaveBeenCalledTimes(1);
});
