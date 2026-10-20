import { discoverGateway } from '../discovery.ts';
import { getSession } from '../session.ts';
import { checkGatewayApi } from './api.ts';
import type { Session } from '../schemas/session.ts';
import type { DoctorCheck } from './output.ts';

/**
 * Checks public discovery, saved credentials, and authenticated API access.
 * @param gatewayUrl - Public gateway selected by the command.
 * @param signal - Cancellation controlled by the CLI.
 * @param report - Receives each result as its check completes.
 */
export const checkPublicGateway = async (
  gatewayUrl: string,
  signal: AbortSignal,
  report: (check: DoctorCheck) => void
) => {
  let session: Session;

  signal.throwIfAborted();

  try {
    await discoverGateway(gatewayUrl);
    signal.throwIfAborted();

    report({
      label: 'Gateway',
      status: 'pass',
      detail: 'Reachable'
    });
  } catch (error) {
    signal.throwIfAborted();

    report({
      label: 'Gateway',
      status: 'fail',
      detail: error instanceof Error ? error.message : 'Discovery failed.',
      action: 'Check the gateway URL and your network connection.'
    });
    ['Saved credentials', 'LiteLLM API'].forEach(label => report({
      label,
      status: 'skip',
      detail: 'Not checked'
    }));
    return;
  }

  try {
    session = await getSession(gatewayUrl);
    signal.throwIfAborted();

    report({
      label: 'Saved credentials',
      status: 'pass',
      detail: 'Available'
    });
  } catch (error) {
    signal.throwIfAborted();

    report({
      label: 'Saved credentials',
      status: 'fail',
      detail: error instanceof Error ? error.message : 'Sign-in unavailable.',
      action: 'Run: gateway login'
    });
    report({
      label: 'LiteLLM API',
      status: 'skip',
      detail: 'Not checked'
    });
    return;
  }

  report(await checkGatewayApi({
    transport: 'public',
    gatewayUrl,
    apiKey: session.apiKey,
    accessToken: session.accessToken
  }, signal));
};
