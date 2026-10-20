import { Command, InvalidArgumentError, Option } from 'commander';
import { prettifyError } from 'zod';
import { loadConfiguration } from './configuration.ts';
import { AGENT_NAME_SCHEMA, AGENT_OPTIONS_SCHEMA } from './schemas/agent.ts';
import { CONNECTION_OPTIONS_SCHEMA } from './schemas/connection.ts';
import { DOCTOR_OPTIONS_SCHEMA } from './schemas/doctor.ts';
import { GATEWAY_URL_SCHEMA } from './schemas/gateway-url.ts';
import { TUNNEL_OPTIONS_SCHEMA } from './schemas/tunnel.ts';

import type { runAgentProcess } from './agents/process.ts';
import type { AgentName } from './schemas/agent.ts';

/**
 * Execution controls shared by CLI commands.
 */
export type CliContext = {

  /**
   * Cancels commands and allows cleanup before exiting.
   */
  readonly signal: AbortSignal;

  /**
   * Runs an agent with terminal input and connection cancellation.
   */
  readonly runAgent: typeof runAgentProcess;
};

/**
 * Creates the gateway command line without opening connections.
 * @param context - Cancellation and terminal handling from the entry point.
 */
export const createCli = (context: CliContext) => {
  const { signal } = context;
  const program = new Command()
    .name('gateway')
    .description('Access your LiteLLM gateway.')
    .exitOverride()
    .showHelpAfterError();

  // Coding agents.
  for (const name of AGENT_NAME_SCHEMA.options) {
    registerAgentCommand(program, name, context);
  }

  // Private access.
  registerPrivateCommand(program, 'tunnel', signal);
  registerPrivateCommand(program, 'admin', signal);

  // Authentication.
  registerLoginCommand(program, signal);
  registerLogoutCommand(program);
  registerTokenCommand(program);

  // Diagnostics.
  registerDoctorCommand(program, signal);

  program.action(() => {
    program.outputHelp();
  });

  return (program);
};

/**
 * Adds the transport and AWS options shared by gateway commands.
 * @param command - Command receiving the connection options.
 */
const addConnectionOptions = (command: Command) => {
  const fields = CONNECTION_OPTIONS_SCHEMA.unwrap().shape;

  return (command
    .addOption(new Option('-t, --transport <mode>', fields.transport.description)
      .choices(fields.transport.unwrap().options)
      .default(fields.transport.parse(undefined)))
    .option('-s, --stack <name>', fields.stack.description)
    .option('-r, --region <region>', fields.region.description)
    .option('--profile <name>', fields.profile.description));
};

/**
 * Registers a coding agent and preserves arguments following --.
 * @param program - Root gateway command.
 * @param name - Supported coding agent.
 * @param context - Cancellation and terminal handling.
 */
const registerAgentCommand = (
  program: Command,
  name: AgentName,
  context: CliContext
) => {
  const fields = AGENT_OPTIONS_SCHEMA.unwrap().shape;

  addConnectionOptions(program.command(name))
    .description(`Run ${name} through the gateway.`)
    .argument('[args...]', 'Agent arguments, after --.')
    .addOption(new Option('-g, --gateway-url <url>', fields.gatewayUrl.description)
      .argParser(parseGatewayUrl))
    .option(
      '-m, --model <alias>',
      fields.model.description,
      fields.model.parse(undefined)
    )
    .addHelpText('after', '\nPut gateway options before -- and agent options after it.')
    .action(async (
      args: string[],
      values: Record<string, unknown>,
      command: Command
    ) => {
      const result = AGENT_OPTIONS_SCHEMA.safeParse(values);

      if (!result.success) {
        return (command.error(prettifyError(result.error)));
      }

      const { runGatewayAgent } = await import('./commands/agent.ts');

      await runGatewayAgent(name, result.data, args, context);
    });
};

/**
 * Registers a tunnel or dashboard command using saved AWS settings.
 * @param program - Root gateway command.
 * @param name - Private command to register.
 * @param signal - Cancellation controlled by the CLI.
 */
const registerPrivateCommand = (
  program: Command,
  name: 'tunnel' | 'admin',
  signal: AbortSignal
) => {
  const fields = TUNNEL_OPTIONS_SCHEMA.unwrap().shape;
  const description = name === 'admin'
    ? 'Open the private administration dashboard.'
    : 'Open a private gateway tunnel.';
  const command = program
    .command(name)
    .description(description)
    .option('-s, --stack <name>', fields.stack.description)
    .option('-r, --region <region>', fields.region.description)
    .option('--profile <name>', fields.profile.description)
    .option('-p, --port <port>', fields.port.description)
    .addHelpText(
      'after',
      '\nUses saved gateway settings, then the default stack and AWS configuration.'
    );

  command.action(async () => {
    const configuration = await loadConfiguration();
    const result = TUNNEL_OPTIONS_SCHEMA.safeParse({
      ...configuration?.ssm,
      ...command.opts<Record<string, unknown>>()
    });

    if (!result.success) {
      return (command.error(prettifyError(result.error)));
    }

    const { runTunnel } = await import('./commands/tunnel.ts');

    await runTunnel(result.data, signal, name === 'admin');
  });
};

/**
 * Registers browser sign-in for public gateway access.
 * @param program - Root gateway command.
 * @param signal - Cancellation controlled by the CLI.
 */
const registerLoginCommand = (program: Command, signal: AbortSignal) => {
  program
    .command('login')
    .description('Sign in to a public gateway with your browser.')
    .argument('[url]', 'Public gateway URL.', parseGatewayUrl)
    .action(async (gatewayUrl: string | undefined) => {
      const { login } = await import('./commands/login.ts');

      await login(gatewayUrl, signal);
    });
};

/**
 * Registers sign-out and local credential removal.
 * @param program - Root gateway command.
 */
const registerLogoutCommand = (program: Command) => {
  program
    .command('logout')
    .description('Sign out and remove saved authentication credentials.')
    .action(async () => {
      const { logout } = await import('./commands/logout.ts');

      await logout();
    });
};

/**
 * Registers gateway diagnostics with an optional coding agent check.
 * @param program - Root gateway command.
 * @param signal - Cancellation controlled by the CLI.
 */
const registerDoctorCommand = (program: Command, signal: AbortSignal) => {
  const fields = DOCTOR_OPTIONS_SCHEMA.unwrap().shape;

  addConnectionOptions(program.command('doctor'))
    .description('Check gateway access and installed coding agents.')
    .addOption(new Option('-g, --gateway-url <url>', fields.gatewayUrl.description)
      .argParser(parseGatewayUrl))
    .addOption(new Option('-a, --agent <name>', fields.agent.description)
      .choices(fields.agent.unwrap().options))
    .addHelpText('after', '\nUses saved settings. Checks access without running inference.')
    .action(async (
      values: Record<string, unknown>,
      command: Command
    ) => {
      const result = DOCTOR_OPTIONS_SCHEMA.safeParse(values);

      if (!result.success) {
        return (command.error(prettifyError(result.error)));
      }

      const { runDoctor } = await import('./commands/doctor.ts');

      await runDoctor(result.data, signal);
    });
};

/**
 * Registers the token command used internally by coding agents.
 * @param program - Root gateway command.
 */
const registerTokenCommand = (program: Command) => {
  program
    .command('token', {
      hidden: true
    })
    .description('Print an access token for a configured coding agent.')
    .argument('<url>', 'Public gateway URL.', parseGatewayUrl)
    .action(async (address: string) => {
      const { printToken } = await import('./commands/token.ts');

      await printToken(address);
    });
};

/**
 * Validates a public gateway address supplied on the command line.
 * @param value - Gateway URL entered by the developer.
 */
const parseGatewayUrl = (value: string) => {
  const result = GATEWAY_URL_SCHEMA.safeParse(value);

  if (!result.success) {
    throw new InvalidArgumentError(prettifyError(result.error));
  }

  return (result.data);
};
