import * as oidc from 'openid-client';
import { createOAuthClient } from './oauth-client.ts';
import { withSessionStore } from './session-store.ts';
import { GATEWAY_URL_SCHEMA } from './schemas/gateway-url.ts';
import { SESSION_SCHEMA } from './schemas/session.ts';
import type { Session } from './schemas/session.ts';

/**
 * Renew two minutes early to accommodate agent token caches and clock differences.
 */
const REFRESH_WINDOW = 120_000;

/**
 * Exchanges a refresh token for renewed credentials without opening a browser.
 * @param session - Previously saved gateway session.
 */
const refreshSession = async (session: Session) => {
  try {
    const client = await createOAuthClient(session.settings);
    const tokens = await oidc.refreshTokenGrant(client, session.refreshToken);
    const expiresIn = tokens.expiresIn();

    if (
      tokens.token_type.toLowerCase() !== 'bearer' ||
      expiresIn === undefined ||
      expiresIn <= 0
    ) {
      throw new Error('Cognito did not return a usable access token.');
    }

    return (SESSION_SCHEMA.parse({
      ...session,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? session.refreshToken,
      expiresAt: Date.now() + expiresIn * 1_000
    }));
  } catch (error) {
    if (error instanceof oidc.ResponseBodyError && error.error === 'invalid_grant') {
      throw new Error('Your sign-in is no longer valid. Run gateway login again.', {
        cause: error
      });
    }

    throw new Error(
      'Could not renew your session. Check your connection or sign in again.',
      { cause: error }
    );
  }
};

/**
 * Loads a usable session and saves rotated credentials before releasing the lock.
 * @param gatewayUrl - Expected gateway when called by an already running agent.
 */
export const getSession = async (gatewayUrl?: string) => {
  const expectedUrl = gatewayUrl === undefined
    ? undefined
    : GATEWAY_URL_SCHEMA.parse(gatewayUrl);

  return (withSessionStore(async store => {
    const session = await store.load();

    if (session === undefined) {
      throw new Error('You are not signed in. Run gateway login <gateway-url>.');
    }

    if (expectedUrl !== undefined && session.gatewayUrl !== expectedUrl) {
      throw new Error('Your active gateway changed. Restart the coding agent.');
    }

    if (session.expiresAt > Date.now() + REFRESH_WINDOW) {
      return (session);
    }

    const refreshed = await refreshSession(session);

    try {
      await store.save(refreshed);
    } catch (error) {
      throw new Error(
        'Could not save renewed credentials. Unlock your credential store, ' +
        'check that your home directory is writable, then run gateway login again.',
        { cause: error }
      );
    }

    return (refreshed);
  }));
};
