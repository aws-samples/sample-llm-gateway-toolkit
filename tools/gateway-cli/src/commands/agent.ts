import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAgentCommand } from '../agents/prepare.ts';
import { openGatewayConnection } from '../open-connection.ts';
import type { CliContext } from '../cli.ts';
import type { AgentName, AgentOptions } from '../schemas/agent.ts';

/**
 * Runs an agent, removes temporary settings, and closes its private connection.
 * @param agent - Supported coding agent to launch.
 * @param options - Validated connection and model options.
 * @param args - Additional arguments passed directly to the coding agent.
 * @param context - Cancellation and terminal handling from the entry point.
 */
export const runGatewayAgent = async (
  agent: AgentName,
  options: AgentOptions,
  args: readonly string[],
  context: CliContext
) => {
  const active = await openGatewayConnection(options, context.signal);
  const signal = AbortSignal.any([context.signal, active.signal]);

  try {
    signal.throwIfAborted();

    const directory = await mkdtemp(join(tmpdir(), 'llm-gateway-'));

    try {
      const command = await prepareAgentCommand(
        agent,
        active.connection,
        options.model,
        join(directory, 'claude.json'),
        signal
      );

      signal.throwIfAborted();
      process.stderr.write(
        `Starting ${agent} via ${active.connection.transport} (${options.model})...\n`
      );

      process.exitCode = await context.runAgent({
        ...command,
        args: [...command.args, ...args]
      }, signal);
    } finally {
      await rm(directory, {
        recursive: true,
        force: true
      });
    }
  } finally {
    await active.close?.();
  }
};
