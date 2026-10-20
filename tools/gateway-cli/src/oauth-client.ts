import * as oidc from 'openid-client';
import type { Discovery } from './schemas/discovery.ts';

/**
 * Maximum duration of each OAuth request, in seconds.
 */
const OAUTH_TIMEOUT = 10;

/**
 * Discovers Cognito endpoints for the public OAuth client.
 * @param settings - Validated gateway login settings.
 * @returns Discovered public-client configuration.
 */
export const createOAuthClient = (settings: Discovery) => {
  return (oidc.discovery(
    new URL(settings.issuer),
    settings.clientId,
    undefined,
    oidc.None(),
    { timeout: OAUTH_TIMEOUT }
  ));
};
