import { styleText } from 'node:util';
import { loadConfiguration } from '../configuration.ts';
import { checkAgent } from '../doctor/agent.ts';
import { formatDoctorCheck } from '../doctor/output.ts';
import { AGENT_NAME_SCHEMA } from '../schemas/agent.ts';
import { resolveConnection } from '../resolve-connection.ts';
import type { DoctorCheck } from '../doctor/output.ts';
import type { DoctorOptions } from '../schemas/doctor.ts';

/**
 * Checks gateway access and installed coding agents without running inference.
 * @param options - Validated connection settings and optional agent selection.
 * @param signal - Cancellation controlled by the CLI.
 */
export const runDoctor = async (
  options: DoctorOptions,
  signal: AbortSignal
) => {
  const checks: DoctorCheck[] = [];
  const agents = options.agent === undefined
    ? AGENT_NAME_SCHEMA.options
    : [options.agent];
  const title = styleText('bold', 'Gateway doctor', {
    stream: process.stdout
  });
  let connection: ReturnType<typeof resolveConnection> | undefined;

  /**
   * Displays a completed check and retains its outcome for the exit status.
   * @param check - Diagnostic result.
   */
  const report = (check: DoctorCheck) => {
    checks.push(check);
    process.stdout.write(`${formatDoctorCheck(check)}\n`);
  };

  signal.throwIfAborted();
  process.stdout.write(`\n${title}\n\n`);

  try {
    const configuration = await loadConfiguration();
    const selected = resolveConnection(options, configuration);

    signal.throwIfAborted();

    if (selected.transport === 'public' && selected.gatewayUrl === undefined) {
      throw new Error('No public gateway URL is configured.');
    }

    connection = selected;

    report({
      label: 'Configuration',
      status: 'pass',
      detail: selected.transport === 'public'
        ? `Public · ${selected.gatewayUrl}`
        : `SSM · ${selected.ssm.stack}`
    });
  } catch (error) {
    signal.throwIfAborted();

    report({
      label: 'Configuration',
      status: 'fail',
      detail: error instanceof Error ? error.message : 'Configuration unavailable.',
      action: 'Choose --transport ssm, or use gateway login for public access.'
    });
  }

  // Load only the checks needed for the selected transport.
  if (connection?.transport === 'public' && connection.gatewayUrl !== undefined) {
    const { checkPublicGateway } = await import('../doctor/public.ts');

    await checkPublicGateway(connection.gatewayUrl, signal, report);
  } else if (connection?.transport === 'ssm') {
    const { checkSsmGateway } = await import('../doctor/ssm.ts');

    await checkSsmGateway(connection.ssm, signal, report, connection.gatewayUrl);
  }

  // Agent availability can still be checked when gateway access fails.
  const agentChecks = await Promise.all(agents.map(agent => {
    return (checkAgent(agent, signal, options.agent !== undefined));
  }));

  agentChecks.forEach(report);
  signal.throwIfAborted();

  const hasFailures = checks.some(check => check.status === 'fail');
  const summary = hasFailures
    ? 'Some checks failed. Follow the actions above.'
    : 'Connection verified. Inference was not tested.';

  if (hasFailures) {
    process.exitCode = 1;
  }

  process.stdout.write(`\n${summary}\n`);
};
