import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createLoginFlow } from '../../src/login-flow.ts';
import type { Discovery } from '../../src/schemas/discovery.ts';

/**
 * Public settings for the simulated Cognito application.
 */
const LOGIN_SETTINGS = {
  issuer: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_example',
  clientId: 'exampleclient',
  scope: 'gateway/invoke',
  callbackUrl: 'http://localhost:8765/callback'
} satisfies Discovery;

/**
 * Metadata consumed by the real OpenID Connect discovery implementation.
 */
const SERVER_METADATA = {
  issuer: LOGIN_SETTINGS.issuer,
  authorization_endpoint: 'https://login.example.com/oauth2/authorize',
  token_endpoint: 'https://login.example.com/oauth2/token',
  response_types_supported: ['code'],
  id_token_signing_alg_values_supported: ['RS256']
};

/**
 * Disposable signing key used only to produce test ID tokens.
 */
const SIGNING_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2_048
}).privateKey;

/**
 * Creates a token response bound to the supplied login nonce.
 * @param nonce - Expected nonce, or a deliberately incorrect value.
 */
const createTokenResponse = (nonce: string | null) => {
  const now = Math.floor(Date.now() / 1_000);
  const input = [{
    alg: 'RS256'
  }, {
    iss: LOGIN_SETTINGS.issuer,
    sub: 'test-user',
    aud: LOGIN_SETTINGS.clientId,
    iat: now,
    exp: now + 300,
    nonce
  }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url'))
    .join('.');
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(input),
    SIGNING_KEY
  ).toString('base64url');

  return (Response.json({
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    id_token: `${input}.${signature}`,
    token_type: 'Bearer',
    expires_in: 900
  }));
};

/**
 * Simulate HTTPS discovery while retaining the real OAuth implementation.
 */
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
    expect(String(input)).toBe(
      `${LOGIN_SETTINGS.issuer}/.well-known/openid-configuration`
    );

    return (Response.json(SERVER_METADATA));
  }));
});

/**
 * Restore the original transport after each test.
 */
afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Each login must have fresh PKCE, state, and nonce values.
 */
test('creates a fresh public-client login URL', async () => {
  const flow = await createLoginFlow(LOGIN_SETTINGS);
  const next = await createLoginFlow(LOGIN_SETTINGS);
  const parameters = Object.fromEntries(flow.url.searchParams);

  expect(`${flow.url.origin}${flow.url.pathname}`).toBe(
    SERVER_METADATA.authorization_endpoint
  );
  expect(parameters).toMatchObject({
    client_id: LOGIN_SETTINGS.clientId,
    redirect_uri: LOGIN_SETTINGS.callbackUrl,
    scope: 'openid email gateway/invoke',
    response_type: 'code',
    code_challenge_method: 'S256',
    state: flow.state
  });
  expect(parameters).not.toHaveProperty('client_secret');
  expect(parameters).not.toHaveProperty('code_verifier');
  expect(flow.state).not.toBe(next.state);
  expect(flow.url.searchParams.get('nonce')).not.toBe(
    next.url.searchParams.get('nonce')
  );
  expect(flow.url.searchParams.get('code_challenge')).not.toBe(
    next.url.searchParams.get('code_challenge')
  );
});

/**
 * Discovery must validate the issuer before offering a login URL.
 */
test('rejects metadata from a different issuer', async () => {
  vi.mocked(fetch).mockResolvedValue(Response.json({
    ...SERVER_METADATA,
    issuer: `${LOGIN_SETTINGS.issuer}Other`
  }));

  await expect(createLoginFlow(LOGIN_SETTINGS)).rejects.toMatchObject({
    code: 'OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED'
  });
});

/**
 * A callback from another login attempt must not reach the token endpoint.
 */
test('rejects incorrect state before exchanging the code', async () => {
  const flow = await createLoginFlow(LOGIN_SETTINGS);
  const callback = new URL(
    `${LOGIN_SETTINGS.callbackUrl}?code=test-code&state=incorrect`
  );

  await expect(flow.complete(callback)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
});

/**
 * The code exchange must prove possession of the original PKCE verifier.
 */
test('exchanges the code using the matching verifier and public client', async () => {
  const flow = await createLoginFlow(LOGIN_SETTINGS);
  const callback = new URL(
    `${LOGIN_SETTINGS.callbackUrl}?code=test-code&state=${flow.state}`
  );

  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const body = new URLSearchParams(String(init?.body));
    const challenge = createHash('sha256')
      .update(body.get('code_verifier') ?? '')
      .digest('base64url');

    expect(String(input)).toBe(SERVER_METADATA.token_endpoint);
    expect(init?.method).toBe('POST');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('test-code');
    expect(body.get('redirect_uri')).toBe(LOGIN_SETTINGS.callbackUrl);
    expect(body.get('client_id')).toBe(LOGIN_SETTINGS.clientId);
    expect(body.has('client_secret')).toBe(false);
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(challenge).toBe(flow.url.searchParams.get('code_challenge'));

    return (createTokenResponse(flow.url.searchParams.get('nonce')));
  });

  await expect(flow.complete(callback)).resolves.toMatchObject({
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token'
  });
});

/**
 * An ID token from another login must fail even when the callback state matches.
 */
test('rejects an ID token with an incorrect nonce', async () => {
  const flow = await createLoginFlow(LOGIN_SETTINGS);
  const callback = new URL(
    `${LOGIN_SETTINGS.callbackUrl}?code=test-code&state=${flow.state}`
  );

  vi.mocked(fetch).mockResolvedValue(createTokenResponse('incorrect'));

  await expect(flow.complete(callback)).rejects.toMatchObject({
    code: 'OAUTH_JWT_CLAIM_COMPARISON_FAILED'
  });
});
