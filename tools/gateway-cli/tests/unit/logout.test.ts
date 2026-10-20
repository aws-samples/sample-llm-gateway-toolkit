import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Configuration, tokenRevocation } from 'openid-client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createOAuthClient } from '../../src/oauth-client.ts';
import type { Session } from '../../src/schemas/session.ts';

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: vi.fn()
}));
vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: class {

    /**
     * Unique credential identifier within the simulated store.
     */
    private readonly identity: string;

    /**
     * Opens an entry without consulting the real OS credential store.
     */
    constructor(service: string, account: string) {
      this.identity = `${service}/${account}`;
    }

    /**
     * Reads the secret retained by this test.
     */
    getSecret = async () => {
      return (CREDENTIALS.get(this.identity) ?? null);
    };

    /**
     * Saves a copy of the supplied secret.
     */
    setSecret = async (value: Uint8Array) => {
      CREDENTIALS.set(this.identity, [...value]);
    };

    /**
     * Simulates successful deletion or a locked public credential.
     */
    deleteCredential = async () => {
      if (isCredentialStoreLocked && this.identity.endsWith('/gateway-auth')) {
        throw new Error('Credential store is locked.');
      }

      return (CREDENTIALS.delete(this.identity));
    };
  }
}));
vi.mock('openid-client', async importOriginal => ({
  ...await importOriginal<typeof import('openid-client')>(),
  tokenRevocation: vi.fn()
}));
vi.mock('../../src/oauth-client.ts', () => ({
  createOAuthClient: vi.fn()
}));

/**
 * Credentials stay in memory while session files use a temporary home directory.
 */
const CREDENTIALS = new Map<string, number[]>();

/**
 * Deployment identity saved after a private connection.
 */
const STACK_ARN = 'arn:aws:cloudformation:eu-west-1:123456789012:stack/ExampleGateway/test';

/**
 * Public session used to exercise the real encryption and cleanup path.
 */
const SESSION = {
  gatewayUrl: 'https://gateway.example',
  settings: {
    issuer: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_example',
    clientId: 'exampleclient',
    scope: 'gateway/invoke',
    callbackUrl: 'http://localhost:8765/callback'
  },
  apiKey: `sk-${randomBytes(24).toString('hex')}`,
  accessToken: randomBytes(32).toString('base64url'),
  refreshToken: randomBytes(32).toString('base64url'),
  expiresAt: Date.now() + 60_000
} satisfies Session;

/**
 * Isolated files belonging to the current test.
 */
let directory: string;

/**
 * Simulate credential deletion failures without touching the OS keychain.
 */
let isCredentialStoreLocked = false;

/**
 * Use real persistence with an isolated filesystem and a simulated credential store.
 */
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  CREDENTIALS.clear();
  isCredentialStoreLocked = false;
  directory = await mkdtemp(join(tmpdir(), 'gateway-logout-'));
  vi.mocked(homedir).mockReturnValue(directory);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.mocked(createOAuthClient).mockResolvedValue(
    new Configuration({ issuer: SESSION.settings.issuer }, SESSION.settings.clientId)
  );
});

/**
 * Remove only test files and restore terminal output.
 */
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, {
    recursive: true,
    force: true
  });
});

/**
 * Store credentials for the public and private paths to the same gateway.
 */
const saveCredentials = async () => {
  const { saveConfiguration } = await import('../../src/configuration.ts');
  const { withSessionStore } = await import('../../src/session-store.ts');
  const { createVirtualKeyStore } = await import('../../src/ssm/key-store.ts');
  const privateStore = await createVirtualKeyStore(STACK_ARN);

  await saveConfiguration({
    preferredTransport: 'public',
    gatewayUrl: SESSION.gatewayUrl,
    ssm: {
      stack: STACK_ARN,
      region: 'eu-west-1'
    }
  });
  await privateStore.save(SESSION.apiKey);
  await withSessionStore(store => store.save(SESSION));
};

/**
 * Logout must clear both transports and require a new public sign-in.
 */
test('clears saved credentials and requires login for public access', async () => {
  const { logout } = await import('../../src/commands/logout.ts');
  const { loadConfiguration } = await import('../../src/configuration.ts');
  const { withSessionStore } = await import('../../src/session-store.ts');
  const { openGatewayConnection } = await import('../../src/open-connection.ts');

  await saveCredentials();
  await logout();

  expect(CREDENTIALS.size).toBe(0);
  expect(await loadConfiguration()).toBeUndefined();
  expect(await withSessionStore(store => store.load())).toBeUndefined();
  expect(tokenRevocation).toHaveBeenCalledWith(
    expect.any(Configuration),
    SESSION.refreshToken,
    { token_type_hint: 'refresh_token' }
  );
  await expect(openGatewayConnection({
    transport: 'public',
    gatewayUrl: SESSION.gatewayUrl
  }, new AbortController().signal)).rejects.toThrow('You are not signed in.');
});

/**
 * Missing Cognito connectivity must not preserve usable local credentials.
 */
test('clears local credentials when Cognito revocation fails', async () => {
  const { logout } = await import('../../src/commands/logout.ts');
  const { loadConfiguration } = await import('../../src/configuration.ts');

  await saveCredentials();
  vi.mocked(tokenRevocation).mockRejectedValue(new Error('Offline.'));

  await expect(logout()).rejects.toThrow(
    'Local credentials were removed, but Cognito revocation could not be confirmed.'
  );
  expect(CREDENTIALS.size).toBe(0);
  expect(await loadConfiguration()).toBeUndefined();
  expect(process.stdout.write).not.toHaveBeenCalledWith('Signed out.\n');
});

/**
 * Private credentials must also be cleared without a public session or AWS calls.
 */
test('removes the private key when no public session exists', async () => {
  const { logout } = await import('../../src/commands/logout.ts');
  const { saveConfiguration, loadConfiguration } = await import('../../src/configuration.ts');
  const { createVirtualKeyStore } = await import('../../src/ssm/key-store.ts');
  const store = await createVirtualKeyStore(STACK_ARN);

  await saveConfiguration({
    preferredTransport: 'ssm',
    ssm: { stack: STACK_ARN }
  });
  await store.save(SESSION.apiKey);
  await logout();

  expect(CREDENTIALS.size).toBe(0);
  expect(await loadConfiguration()).toBeUndefined();
  expect(createOAuthClient).not.toHaveBeenCalled();
  expect(tokenRevocation).not.toHaveBeenCalled();
});

/**
 * A failed deletion must be reported and remain retryable after unlocking the vault.
 */
test('attempts both cleanups and reports credential-store failures', async () => {
  const { logout } = await import('../../src/commands/logout.ts');
  const { withSessionStore } = await import('../../src/session-store.ts');

  await saveCredentials();
  isCredentialStoreLocked = true;

  await expect(logout()).rejects.toThrow('Could not remove all saved credentials.');
  expect([...CREDENTIALS.keys()]).toEqual(['llm-gateway-toolkit/gateway-auth']);
  expect(await withSessionStore(store => store.load())).toBeUndefined();
  expect(process.stdout.write).not.toHaveBeenCalledWith('Signed out.\n');

  isCredentialStoreLocked = false;
  await logout();

  expect(CREDENTIALS.size).toBe(0);
});

/**
 * Repeated logout must be harmless and leave unrelated credentials untouched.
 */
test('allows logout when already signed out', async () => {
  const { logout } = await import('../../src/commands/logout.ts');

  CREDENTIALS.set('another-application/account', [1, 2, 3]);
  await logout();
  await logout();

  expect([...CREDENTIALS.keys()]).toEqual(['another-application/account']);
  expect(tokenRevocation).not.toHaveBeenCalled();
});
