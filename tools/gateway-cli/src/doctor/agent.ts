import { execa, ExecaError } from 'execa';
import type { AgentName } from '../schemas/agent.ts';
import type { DoctorCheck } from './output.ts';

/**
 * Display names for the supported coding agents.
 */
const AGENT_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot CLI',
  opencode: 'OpenCode'
} satisfies Record<AgentName, string>;

/**
 * Maximum time to wait for version output, in milliseconds.
 */
const VERSION_TIMEOUT = 5_000;

/**
 * Maximum captured version output, in characters.
 */
const MAX_VERSION_CHARS = 4_096;

/**
 * Extract only the version, excluding other executable output.
 */
const VERSION_PATTERN = /\b[0-9]+\.[0-9]+\.[0-9]+\b/;

/**
 * Checks an installed agent without starting a coding session.
 * @param agent - Executable to resolve through PATH.
 * @param signal - Cancellation controlled by the CLI.
 * @param isRequired - Whether this agent was explicitly requested.
 */
export const checkAgent = async (
  agent: AgentName,
  signal: AbortSignal,
  isRequired: boolean
) => {
  const label = AGENT_LABELS[agent];

  signal.throwIfAborted();

  try {
    const { stdout } = await execa(agent, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: VERSION_TIMEOUT,
      maxBuffer: MAX_VERSION_CHARS,
      cancelSignal: signal,
      killDescendants: true,
      shell: false,
      verbose: 'none'
    });
    const version = stdout.match(VERSION_PATTERN)?.[0];

    signal.throwIfAborted();

    return ({
      label,
      status: 'pass',
      detail: version === undefined ? 'Installed' : `Installed · ${version}`
    } satisfies DoctorCheck);
  } catch (error) {
    const isMissing = error instanceof ExecaError && error.code === 'ENOENT';
    const action = isMissing
      ? `Install ${label} and make ${agent} available on PATH.`
      : `Run: ${agent} --version`;

    signal.throwIfAborted();

    return ({
      label,
      status: isRequired ? 'fail' : 'skip',
      detail: isMissing ? 'Not installed' : 'Version check failed',
      action: isRequired ? action : undefined
    } satisfies DoctorCheck);
  }
};
