import open from 'open';

import { once } from 'node:events';
import { styleText } from 'node:util';
import { getGateway } from '../ssm/gateway.ts';
import { openTunnel } from '../ssm/tunnel.ts';
import type { TunnelOptions } from '../schemas/tunnel.ts';

/**
 * Keeps private access open until cancellation or disconnection.
 * @param options - Validated AWS settings and optional local port.
 * @param signal - Cancellation controlled by the CLI.
 * @param isAdmin - Whether to open the dashboard in the default browser.
 */
export const runTunnel = async (
  options: TunnelOptions,
  signal: AbortSignal,
  isAdmin = false
) => {
  process.stderr.write(`Connecting to ${options.stack}...\n`);

  // Discover the gateway using the provided options and signal.
  const gateway = await getGateway(options, signal).catch(error => {
    signal.throwIfAborted();
    throw (error);
  });

  // Open the SSM tunnel.
  const tunnel = await openTunnel(gateway, options, signal, options.port);

  // The gateway dashboard URL.
  const dashboardUrl = new URL('/ui/', tunnel.url).href;

  try {
    signal.throwIfAborted();

    const status = styleText('bold', 'Connected', {
      stream: process.stderr
    });

    process.stderr.write(`
${status} (${gateway.region})

API        ${tunnel.url}/v1
Dashboard  ${dashboardUrl}

Press Ctrl+C to disconnect.
`);

    if (isAdmin) {
      try {
        await open(dashboardUrl);
      } catch {
        process.stderr.write(
          'Could not open a browser. Open the dashboard URL above.\n'
        );
      }
    }

    const stopped = AbortSignal.any([signal, tunnel.signal]);

    if (!stopped.aborted) {
      await once(stopped, 'abort');
    }

    if (tunnel.signal.aborted && !signal.aborted) {
      throw (tunnel.signal.reason);
    }
  } finally {
    await tunnel.close();
    process.stderr.write('\nTunnel closed.\n');
  }
};
