import { beforeEach, expect, test, vi } from 'vitest';
import { createCli } from '../../src/cli.ts';
import { loadConfiguration } from '../../src/configuration.ts';
import { runGatewayAgent } from '../../src/commands/agent.ts';
import { runDoctor } from '../../src/commands/doctor.ts';
import { login } from '../../src/commands/login.ts';
import { runTunnel } from '../../src/commands/tunnel.ts';

vi.mock('../../src/configuration.ts', () => ({
  loadConfiguration: vi.fn()
}));
vi.mock('../../src/commands/agent.ts', () => ({
  runGatewayAgent: vi.fn()
}));
vi.mock('../../src/commands/doctor.ts', () => ({
  runDoctor: vi.fn()
}));
vi.mock('../../src/commands/login.ts', () => ({
  login: vi.fn()
}));
vi.mock('../../src/commands/tunnel.ts', () => ({
  runTunnel: vi.fn()
}));

/**
 * Creates a CLI that captures validation errors without printing help.
 */
const createTestCli = () => {
  const program = createCli({
    signal: new AbortController().signal,
    runAgent: async () => 0
  });

  for (const command of [program, ...program.commands]) {
    command.configureOutput({
      writeOut: () => {},
      writeErr: () => {}
    });
  }

  return (program);
};

/**
 * Keep command tests independent of saved settings and previous calls.
 */
beforeEach(() => {
  vi.resetAllMocks();
});

/**
 * Login replaces setup, while internal token handling stays out of help.
 */
test('exposes login and doctor without advertising internal commands', () => {
  const program = createTestCli();
  const help = program.helpInformation();

  expect(help).toContain('login');
  expect(help).toContain('doctor');
  expect(help).not.toContain('setup');
  expect(help).not.toContain('token');
  expect(program.commands.some(command => command.name() === 'setup')).toBe(false);
});

/**
 * Gateway flags must not consume the coding agent's own arguments.
 */
test.each(['claude', 'codex', 'copilot', 'opencode'])(
  'preserves arguments passed to %s',
  async name => {
    await createTestCli().parseAsync([
      name, '--transport', 'ssm', '--model', 'example',
      '--', '--help'
    ], {
      from: 'user'
    });

    expect(runGatewayAgent).toHaveBeenCalledWith(
      name,
      {
        transport: 'ssm',
        model: 'example'
      },
      ['--help'],
      expect.objectContaining({
        signal: expect.any(AbortSignal)
      })
    );
  }
);

/**
 * Doctor uses saved settings by default and validates explicit overrides.
 */
test('passes normalized doctor options to its handler', async () => {
  await createTestCli().parseAsync(['doctor'], {
    from: 'user'
  });
  await createTestCli().parseAsync([
    'doctor', '--transport', 'public',
    '--gateway-url', 'https://gateway.example/',
    '--agent', 'codex'
  ], {
    from: 'user'
  });

  expect(runDoctor).toHaveBeenNthCalledWith(
    1,
    {
      transport: 'auto'
    },
    expect.any(AbortSignal)
  );
  expect(runDoctor).toHaveBeenNthCalledWith(
    2,
    {
      transport: 'public',
      gatewayUrl: 'https://gateway.example',
      agent: 'codex'
    },
    expect.any(AbortSignal)
  );
});

/**
 * Invalid options must fail before diagnostics can open a connection.
 */
test.each([
  ['--agent', 'unsupported'],
  ['--transport', 'unsupported'],
  ['--gateway-url', 'http://gateway.example'],
  ['--region', '']
])('rejects doctor options %j', async (...args) => {
  await expect(createTestCli().parseAsync(['doctor', ...args], {
    from: 'user'
  })).rejects.toThrow();

  expect(runDoctor).not.toHaveBeenCalled();
});

/**
 * Login opens the public flow directly, without a transport selection.
 */
test('passes the public gateway URL through login', async () => {
  await createTestCli().parseAsync([
    'login', 'https://gateway.example/'
  ], {
    from: 'user'
  });

  expect(login).toHaveBeenCalledWith(
    'https://gateway.example',
    expect.any(AbortSignal)
  );
});

/**
 * The public login handler can reuse a saved URL or prompt for one.
 */
test('allows login without a URL', async () => {
  await createTestCli().parseAsync(['login'], {
    from: 'user'
  });

  expect(login).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
});

/**
 * Private access settings belong to agents and tunnels, not browser login.
 */
test('keeps transport and AWS options out of login', async () => {
  const command = createTestCli().commands.find(command => command.name() === 'login');
  const help = command?.helpInformation();

  expect(help).toContain('public gateway');
  expect(help).not.toContain('--transport');
  expect(help).not.toContain('--profile');
  await expect(createTestCli().parseAsync([
    'login', '--transport', 'ssm'
  ], {
    from: 'user'
  })).rejects.toThrow();
  expect(login).not.toHaveBeenCalled();
});

/**
 * Private commands preserve saved AWS settings unless explicitly overridden.
 */
test.each(['tunnel', 'admin'])('merges saved settings for %s', async name => {
  vi.mocked(loadConfiguration).mockResolvedValue({
    preferredTransport: 'ssm',
    ssm: {
      stack: 'ExampleGateway',
      region: 'eu-west-1',
      profile: 'demo'
    }
  });

  await createTestCli().parseAsync([
    name, '--region', 'eu-central-1', '--port', '4000'
  ], {
    from: 'user'
  });

  expect(runTunnel).toHaveBeenCalledWith({
    stack: 'ExampleGateway',
    region: 'eu-central-1',
    profile: 'demo',
    port: 4000
  }, expect.any(AbortSignal), name === 'admin');
});

/**
 * Private commands work before browser login using ambient AWS configuration.
 */
test.each(['tunnel', 'admin'])('allows %s without saved configuration', async name => {
  await createTestCli().parseAsync([name], {
    from: 'user'
  });

  expect(runTunnel).toHaveBeenCalledWith({
    stack: 'LlmGatewayToolkit-Gateway'
  }, expect.any(AbortSignal), name === 'admin');
  expect(login).not.toHaveBeenCalled();
});
