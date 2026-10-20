import { tokenRevocation } from 'openid-client';
import { createOAuthClient } from '../oauth-client.ts';
import { withSessionStore } from '../session-store.ts';
import { createVirtualKeyStore } from '../ssm/key-store.ts';

import {
  clearConfiguration,
  loadConfiguration
} from '../configuration.ts';

/**
 * Removes the configured private key without requiring AWS access.
 */
const clearPrivateCredentials = async () => {
  const configuration = await loadConfiguration();

  if (configuration?.ssm !== undefined) {
    const store = await createVirtualKeyStore(configuration.ssm.stack);

    await store.clear();
  }
};

/**
 * Revokes the public refresh token and clears its local session.
 */
const clearPublicCredentials = async () => {
  return (withSessionStore(async store => {
    let revocationError: unknown;

    try {
      const session = await store.load();

      if (session !== undefined) {
        const client = await createOAuthClient(session.settings);

        await tokenRevocation(client, session.refreshToken, {
          token_type_hint: 'refresh_token'
        });
      }
    } catch (error) {
      revocationError = error;
    }

    // Offline revocation failures must not prevent local sign-out.
    await store.clear();

    return (revocationError);
  }));
};

/**
 * Clears saved gateway credentials without changing ambient AWS authentication.
 */
export const logout = async () => {
  const results = await Promise.allSettled([
    clearPublicCredentials(),
    clearPrivateCredentials()
  ]);
  const failures = results
    .filter(result => result.status === 'rejected')
    .map(result => result.reason);
  const publicResult = results[0];

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      'Could not remove all saved credentials. Unlock your credential store and run gateway logout again.'
    );
  }

  await clearConfiguration();

  if (publicResult.status === 'fulfilled' && publicResult.value !== undefined) {
    throw new Error(
      'Local credentials were removed, but Cognito revocation could not be confirmed.',
      { cause: publicResult.value }
    );
  }

  process.stdout.write('Signed out.\n');
};
