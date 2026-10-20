import { getGateway } from '../ssm/gateway.ts';
import { createVirtualKeyStore } from '../ssm/key-store.ts';
import { openTunnel } from '../ssm/tunnel.ts';
import { checkGatewayApi } from './api.ts';
import type { SsmOptions } from '../schemas/ssm.ts';
import type { DoctorCheck } from './output.ts';

/**
 * Checks private gateway access through a temporary SSM tunnel.
 * @param options - Validated AWS connection settings.
 * @param signal - Cancellation controlled by the CLI.
 * @param report - Receives each result as its check completes.
 * @param expectedGatewayUrl - Public URL identifying the same deployment.
 */
export const checkSsmGateway = async (
  options: SsmOptions,
  signal: AbortSignal,
  report: (check: DoctorCheck) => void,
  expectedGatewayUrl?: string
) => {
  let gateway: Awaited<ReturnType<typeof getGateway>>;
  let apiKey: string | undefined;
  let tunnel: Awaited<ReturnType<typeof openTunnel>>;

  signal.throwIfAborted();

  try {
    gateway = await getGateway(options, signal, expectedGatewayUrl);
    signal.throwIfAborted();

    report({
      label: 'AWS gateway',
      status: 'pass',
      detail: `Ready for SSM · ${gateway.region}`
    });
  } catch (error) {
    signal.throwIfAborted();

    report({
      label: 'AWS gateway',
      status: 'fail',
      detail: error instanceof Error ? error.message : 'Discovery failed.',
      action: 'Check your AWS sign-in, region, stack, and ECS Exec access.'
    });
    ['Virtual key', 'SSM tunnel', 'LiteLLM API'].forEach(label => report({
      label,
      status: 'skip',
      detail: 'Not checked'
    }));
    return;
  }

  try {
    const store = await createVirtualKeyStore(gateway.stack, signal);

    // Diagnostics only read credentials; agent startup handles saving replacements.
    apiKey = await store.load();
    signal.throwIfAborted();

    if (apiKey === undefined) {
      throw new Error('No virtual key is saved for this gateway.');
    }

    report({
      label: 'Virtual key',
      status: 'pass',
      detail: 'Available'
    });
  } catch (error) {
    signal.throwIfAborted();

    report({
      label: 'Virtual key',
      status: 'fail',
      detail: error instanceof Error ? error.message : 'Credential store unavailable.',
      action: 'Start your agent with --transport ssm in a terminal to save a virtual key.'
    });
    ['SSM tunnel', 'LiteLLM API'].forEach(label => report({
      label,
      status: 'skip',
      detail: 'Not checked'
    }));
    return;
  }

  try {
    tunnel = await openTunnel(gateway, options, signal);
  } catch (error) {
    // Startup errors can include cleanup failures, even during cancellation.
    report({
      label: 'SSM tunnel',
      status: 'fail',
      detail: error instanceof Error ? error.message : 'Could not open the tunnel.',
      action: 'Check SSM access and your sessions in AWS Systems Manager.'
    });
    signal.throwIfAborted();

    report({
      label: 'LiteLLM API',
      status: 'skip',
      detail: 'Not checked'
    });
    return;
  }

  try {
    signal.throwIfAborted();

    report({
      label: 'SSM tunnel',
      status: 'pass',
      detail: 'Connected'
    });
    report(await checkGatewayApi({
      transport: 'ssm',
      gatewayUrl: tunnel.url,
      apiKey
    }, AbortSignal.any([signal, tunnel.signal])));
  } catch {
    signal.throwIfAborted();

    report({
      label: 'LiteLLM API',
      status: 'fail',
      detail: 'The private connection was interrupted.',
      action: 'Run: gateway doctor --transport ssm'
    });
  } finally {
    // Close our session after success, failure, or cancellation.
    try {
      await tunnel.close();

      report({
        label: 'Tunnel cleanup',
        status: 'pass',
        detail: 'Closed'
      });
    } catch {
      report({
        label: 'Tunnel cleanup',
        status: 'fail',
        detail: 'Could not confirm session cleanup.',
        action: 'Check your sessions in AWS Systems Manager.'
      });
    }
  }
};
