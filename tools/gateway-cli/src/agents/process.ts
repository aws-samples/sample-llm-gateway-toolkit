import { constants } from 'node:os';
import { execa, ExecaError } from 'execa';

/**
 * Process settings produced by a coding-agent adapter.
 */
export type AgentCommand = {

  /**
   * Installed agent executable resolved through PATH.
   */
  readonly command: string;

  /**
   * Arguments passed directly to the executable.
   */
  readonly args: readonly string[];

  /**
   * Environment overrides; undefined removes an inherited value.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
};

/**
 * Runs an agent in the current terminal and waits for it to exit.
 * @param command - Executable, arguments, and credentials from its adapter.
 * @param signal - Stops the agent when the command or connection is cancelled.
 * @returns The agent's exit code, including conventional signal exit codes.
 */
export const runAgentProcess = async (
  command: AgentCommand,
  signal: AbortSignal
) => {
  signal.throwIfAborted();

  try {
    await execa(command.command, command.args, {
      env: command.env,
      stdio: 'inherit',
      cancelSignal: signal,
      shell: false,
      verbose: 'none',
      // Interactive Unix agents must stay attached to the terminal.
      killDescendants: process.platform === 'win32' || !process.stdin.isTTY
    });

    signal.throwIfAborted();

    return (0);
  } catch (error) {
    signal.throwIfAborted();

    if (error instanceof ExecaError) {
      if (error.code === 'ENOENT') {
        throw new Error(
          `Cannot find ${command.command}. Install it and make it available on PATH.`,
          { cause: error }
        );
      }

      if (error.exitCode !== undefined) {
        return (error.exitCode);
      }

      if (error.signal !== undefined) {
        const signalNumber = constants.signals[error.signal];

        return (signalNumber === undefined ? 1 : 128 + signalNumber);
      }
    }

    // Execa errors include arguments, which may contain confidential prompts.
    throw new Error(`Could not run ${command.command}.`, {
      cause: error
    });
  }
};
