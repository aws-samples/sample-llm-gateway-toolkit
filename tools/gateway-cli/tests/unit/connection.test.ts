import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { loadConfiguration, saveConfiguration } from '../../src/configuration.ts';
import { openGatewayConnection } from '../../src/open-connection.ts';
import { resolveConnection } from '../../src/resolve-connection.ts';
import { getSession } from '../../src/session.ts';
import { openSsmConnection } from '../../src/ssm/connection.ts';

vi.mock('../../src/configuration.ts', () => ({
  loadConfiguration: vi.fn(),
  saveConfiguration: vi.fn()
}));
vi.mock('../../src/session.ts', () => ({
  getSession: vi.fn()
}));
vi.mock('../../src/ssm/connection.ts', () => ({
  openSsmConnection: vi.fn()
}));

/**
 * Private connection returned after AWS access and the virtual key are verified.
 */
const PRIVATE_CONNECTION = {
  connection: {
    transport: 'ssm',
    gatewayUrl: 'http://localhost:4000',
    apiKey: `sk-${randomBytes(24).toString('hex')}`
  },
  gateway: {
    stack: 'arn:aws:cloudformation:eu-west-1:123456789012:stack/ExampleGateway/test',
    region: 'eu-west-1',
    gatewayUrl: undefined,
    target: 'ecs:example_task_container',
    remotePort: 4000
  },
  signal: new AbortController().signal,
  close: vi.fn<() => Promise<void>>()
} satisfies Awaited<ReturnType<typeof openSsmConnection>>;

/**
 * Keep connection tests independent of real AWS credentials and terminal output.
 */
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  vi.mocked(openSsmConnection).mockResolvedValue(PRIVATE_CONNECTION);
});

/**
 * Restore terminal output after each connection test.
 */
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Private agents verify access directly, then remember settings for reuse and logout.
 */
test('opens private access without a prior login', async () => {
  const signal = new AbortController().signal;
  const active = await openGatewayConnection({
    transport: 'ssm',
    region: 'eu-west-1',
    profile: 'demo'
  }, signal);

  expect(openSsmConnection).toHaveBeenCalledWith({
    stack: 'LlmGatewayToolkit-Gateway',
    region: 'eu-west-1',
    profile: 'demo'
  }, signal, undefined);
  expect(saveConfiguration).toHaveBeenCalledWith({
    preferredTransport: 'ssm',
    gatewayUrl: undefined,
    ssm: {
      stack: PRIVATE_CONNECTION.gateway.stack,
      region: 'eu-west-1',
      profile: 'demo'
    }
  });
  expect(active).toBe(PRIVATE_CONNECTION);
  expect(active.close).not.toHaveBeenCalled();
  expect(getSession).not.toHaveBeenCalled();
});

/**
 * A fresh CLI must use SSM without prompting for a transport.
 */
test('defaults to private access without saved settings', async () => {
  const signal = new AbortController().signal;

  await openGatewayConnection({
    transport: 'auto'
  }, signal);

  expect(openSsmConnection).toHaveBeenCalledWith({
    stack: 'LlmGatewayToolkit-Gateway'
  }, signal, undefined);
  expect(getSession).not.toHaveBeenCalled();
});

/**
 * Explicit targets override saved preferences before credentials are loaded.
 */
test('resolves explicit public and AWS targets without prompting', () => {
  const configuration = {
    preferredTransport: 'public',
    gatewayUrl: 'https://saved.example'
  } as const;

  expect(resolveConnection({
    transport: 'auto',
    gatewayUrl: 'https://another.example'
  }, configuration)).toMatchObject({
    transport: 'public',
    gatewayUrl: 'https://another.example'
  });
  expect(resolveConnection({
    transport: 'auto',
    region: 'eu-west-1'
  }, configuration)).toMatchObject({
    transport: 'ssm',
    gatewayUrl: undefined
  });
});

/**
 * Conflicting explicit targets need a flag, never an interactive selection.
 */
test('requires an explicit transport for conflicting targets', () => {
  expect(() => resolveConnection({
    transport: 'auto',
    gatewayUrl: 'https://gateway.example',
    profile: 'demo'
  }, undefined)).toThrow('Choose --transport');
  expect(resolveConnection({
    transport: 'ssm',
    gatewayUrl: 'https://gateway.example',
    profile: 'demo'
  }, undefined).transport).toBe('ssm');
});

/**
 * A failed private authentication must not replace previously saved settings.
 */
test('does not save an unverified private connection', async () => {
  vi.mocked(openSsmConnection).mockRejectedValue(new Error('Virtual key rejected.'));

  await expect(openGatewayConnection({
    transport: 'ssm'
  }, new AbortController().signal)).rejects.toThrow('Virtual key rejected.');

  expect(saveConfiguration).not.toHaveBeenCalled();
});

/**
 * A settings write failure must not leave a newly opened tunnel running.
 */
test('closes the private connection when settings cannot be saved', async () => {
  vi.mocked(saveConfiguration).mockRejectedValue(new Error('Disk is full.'));

  await expect(openGatewayConnection({
    transport: 'ssm'
  }, new AbortController().signal)).rejects.toThrow('Disk is full.');

  expect(PRIVATE_CONNECTION.close).toHaveBeenCalledTimes(1);
});

/**
 * A private connection to the same gateway must preserve a public default.
 */
test('preserves public preferences when using SSM for the same gateway', async () => {
  const gatewayUrl = 'https://gateway.example';

  vi.mocked(loadConfiguration).mockResolvedValue({
    preferredTransport: 'public',
    gatewayUrl
  });
  vi.mocked(openSsmConnection).mockResolvedValue({
    ...PRIVATE_CONNECTION,
    gateway: {
      ...PRIVATE_CONNECTION.gateway,
      gatewayUrl
    }
  });

  await openGatewayConnection({
    transport: 'ssm'
  }, new AbortController().signal);

  expect(saveConfiguration).toHaveBeenCalledWith({
    preferredTransport: 'public',
    gatewayUrl,
    ssm: {
      stack: PRIVATE_CONNECTION.gateway.stack,
      region: 'eu-west-1',
      profile: undefined
    }
  });
});

/**
 * Public authentication failures must not silently switch to AWS credentials.
 */
test('requires browser login for public access without falling back to SSM', async () => {
  vi.mocked(loadConfiguration).mockResolvedValue({
    preferredTransport: 'public',
    gatewayUrl: 'https://gateway.example'
  });
  vi.mocked(getSession).mockRejectedValue(new Error('You are not signed in.'));

  await expect(openGatewayConnection({
    transport: 'auto'
  }, new AbortController().signal)).rejects.toThrow('You are not signed in.');

  expect(openSsmConnection).not.toHaveBeenCalled();
  expect(saveConfiguration).not.toHaveBeenCalled();
});
