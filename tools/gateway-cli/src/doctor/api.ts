import { getGatewayModels } from '../models.ts';
import type { GatewayConnection } from '../connection.ts';
import type { DoctorCheck } from './output.ts';

/**
 * Verifies authenticated API access without invoking a model.
 * @param connection - Credentials for the selected transport.
 * @param signal - Cancellation controlled by the CLI.
 */
export const checkGatewayApi = async (
  connection: GatewayConnection,
  signal: AbortSignal
) => {
  const label = 'LiteLLM API';

  signal.throwIfAborted();

  try {
    const models = await getGatewayModels(connection, signal);
    const modelLabel = models.length === 1 ? 'model' : 'models';

    signal.throwIfAborted();

    if (models.length === 0) {
      return ({
        label,
        status: 'fail',
        detail: 'Authenticated, but no models are available.',
        action: 'Ask your administrator to grant this key access to a model.'
      } satisfies DoctorCheck);
    }

    return ({
      label,
      status: 'pass',
      detail: `Authenticated · ${models.length} ${modelLabel}`
    } satisfies DoctorCheck);
  } catch (error) {
    const response = error instanceof Error && error.cause instanceof Response
      ? error.cause
      : undefined;

    signal.throwIfAborted();

    if (response?.status === 401 || response?.status === 403) {
      return ({
        label,
        status: 'fail',
        detail: 'Authentication rejected.',
        action: connection.transport === 'public'
          ? 'Run: gateway login'
          : 'Start your agent with --transport ssm in a terminal to replace its virtual key.'
      } satisfies DoctorCheck);
    }

    return ({
      label,
      status: 'fail',
      detail: response === undefined
        ? 'Could not read gateway models.'
        : `Gateway returned HTTP ${response.status}.`,
      action: 'Check your connection; if this persists, contact the gateway administrator.'
    } satisfies DoctorCheck);
  }
};
