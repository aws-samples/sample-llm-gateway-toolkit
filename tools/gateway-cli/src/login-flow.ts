import * as oidc from 'openid-client';
import { createOAuthClient } from './oauth-client.ts';
import type { Discovery } from './schemas/discovery.ts';

/**
 * Creates a Cognito login attempt using authorization code flow with PKCE.
 * @param settings - Validated public login settings.
 * @returns An object containing the authorization URL, state, and a function
 * to complete the login flow.
 */
export const createLoginFlow = async (settings: Discovery) => {
  const client = await createOAuthClient(settings);

  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const url = oidc.buildAuthorizationUrl(client, {
    redirect_uri: settings.callbackUrl,
    scope: `openid email ${settings.scope}`,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });

  /**
   * Exchanges the callback code using this attempt's PKCE verifier.
   * @param callbackUrl - URL received by the localhost callback server.
   */
  const complete = (callbackUrl: URL) => {
    return (oidc.authorizationCodeGrant(client, callbackUrl, {
      pkceCodeVerifier: verifier,
      expectedState: state,
      expectedNonce: nonce
    }));
  };

  return ({
    url,
    state,
    complete
  });
};
