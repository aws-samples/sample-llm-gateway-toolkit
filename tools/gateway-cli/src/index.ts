#!/usr/bin/env node
import { CommanderError } from 'commander';
import { createCli } from './cli.ts';
import { runAgentProcess } from './agents/process.ts';

/**
 * Runs the CLI and reports errors after command cleanup.
 */
const main = async () => {
  const controller = new AbortController();
  let isAgentRunning = false;

  /**
   * Requests cancellation while leaving interactive Ctrl+C to the agent.
   * @param signal - Operating-system signal received by this process.
   */
  const stop = (signal: NodeJS.Signals) => {
    // The terminal delivers Ctrl+C to the foreground agent.
    if (signal === 'SIGINT' && isAgentRunning && process.stdin.isTTY) {
      return;
    }

    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    controller.abort(new Error('Cancelled.'));
  };

  /**
   * Gives the agent the terminal until it exits or its connection is cancelled.
   * @param command - Process settings produced by the agent adapter.
   * @param signal - Cancellation from the active gateway connection.
   */
  const runAgent: typeof runAgentProcess = async (command, signal) => {
    isAgentRunning = true;

    try {
      return (await runAgentProcess(
        command,
        AbortSignal.any([controller.signal, signal])
      ));
    } finally {
      isAgentRunning = false;
    }
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try {
    await createCli({
      signal: controller.signal,
      runAgent
    }).parseAsync();
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }

    if (controller.signal.aborted && error === controller.signal.reason) {
      return;
    }

    const message = error instanceof Error
      ? error.message
      : 'The gateway command failed.';

    process.stderr.write(`\nError: ${message}\n`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
};

await main();
