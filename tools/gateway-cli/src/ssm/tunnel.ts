import { spawn } from 'node:child_process';
import { on } from 'node:events';
import { PORT_SCHEMA } from '../schemas/port.ts';
import { getPluginPath } from './plugin.ts';
import type { ChildProcess } from 'node:child_process';
import type { SsmOptions } from '../schemas/ssm.ts';
import type { getGateway } from './gateway.ts';

import {
  DescribeSessionsCommand,
  SSMClient,
  StartSessionCommand,
  TerminateSessionCommand,
  ValidationException
} from '@aws-sdk/client-ssm';
import {
  createSessionEnvironment,
  SESSION_ENV_NAME
} from './env.ts';

/**
 * Maximum wait for session startup, in milliseconds.
 */
const STARTUP_TIMEOUT_MS = 30_000;

/**
 * Grace period before forcibly stopping the plugin, in milliseconds.
 */
const PLUGIN_STOP_TIMEOUT_MS = 5_000;

/**
 * Maximum wait for AWS session cleanup, in milliseconds.
 */
const CLEANUP_TIMEOUT_MS = 15_000;

/**
 * Startup message containing the port selected by the plugin.
 */
const READY_MESSAGE_PATTERN =
  /Port ([0-9]{1,5}) opened for sessionId ([^\r\n]+)\./;

/**
 * Connection details returned by gateway discovery.
 */
type Gateway = Awaited<ReturnType<typeof getGateway>>;

/**
 * Ends our AWS session or confirms the plugin has already terminated it.
 * @param client - Systems Manager client for the gateway Region.
 * @param sessionId - Session created by this process.
 */
const terminateSession = async (client: SSMClient, sessionId: string) => {
  const signal = AbortSignal.timeout(CLEANUP_TIMEOUT_MS);

  try {
    await client.send(new TerminateSessionCommand({
      SessionId: sessionId
    }), {
      abortSignal: signal
    });
  } catch (error) {
    if (!(error instanceof ValidationException)) {
      throw (error);
    }

    const response = await client.send(new DescribeSessionsCommand({
      State: 'History',
      Filters: [{
        key: 'SessionId',
        value: sessionId
      }]
    }), {
      abortSignal: signal
    });
    const isTerminated = response.Sessions?.some(session =>
      session.SessionId === sessionId && session.Status === 'Terminated'
    );

    if (!isTerminated) {
      throw (error);
    }
  }
};

/**
 * Opens a private tunnel and returns control once its local port is ready.
 * @param gateway - Discovered ECS target and container port.
 * @param options - Validated AWS connection settings.
 * @param signal - Cancels startup.
 * @param port - Optional fixed port; otherwise AWS selects an available port.
 */
export const openTunnel = async (
  gateway: Gateway,
  options: SsmOptions,
  signal: AbortSignal,
  port?: number
) => {
  signal.throwIfAborted();

  const requestedPort = PORT_SCHEMA.optional().parse(port);
  const executable = await getPluginPath();
  const disconnected = new AbortController();
  const startupSignal = AbortSignal.any([
    signal,
    disconnected.signal,
    AbortSignal.timeout(STARTUP_TIMEOUT_MS)
  ]);
  const client = new SSMClient({
    region: gateway.region,
    profile: options.profile
  });
  const input = {
    Target: gateway.target,
    DocumentName: 'AWS-StartPortForwardingSession',
    Reason: 'LiteLLM gateway tunnel',
    Parameters: {
      portNumber: [String(gateway.remotePort)],
      localPortNumber: [String(requestedPort ?? 0)]
    }
  };
  let plugin: ChildProcess | undefined;
  let sessionId: string | undefined;
  let closed = Promise.resolve();
  let closing: Promise<void> | undefined;

  /**
   * Stops our plugin and waits for its process to exit.
   */
  const stopPlugin = async () => {
    if (!plugin) {
      return;
    }

    const timeout = setTimeout(() => {
      plugin?.kill('SIGKILL');
    }, PLUGIN_STOP_TIMEOUT_MS).unref();

    try {
      plugin.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT');
      await closed;
    } finally {
      clearTimeout(timeout);
    }
  };

  /**
   * Closes the local process and AWS session once, including concurrent calls.
   */
  const close = () => {
    closing ??= (async () => {
      try {
        // Attempt both cleanup operations even when one fails.
        const results = await Promise.allSettled([
          stopPlugin(),
          sessionId
            ? terminateSession(client, sessionId)
            : Promise.resolve()
        ]);

        for (const result of results) {
          if (result.status === 'rejected') {
            throw (result.reason);
          }
        }
      } finally {
        client.destroy();
      }
    })();

    return (closing);
  };

  try {
    const session = await client.send(new StartSessionCommand(input), {
      abortSignal: startupSignal
    });

    // Retain the identifier so malformed responses can still be cleaned up.
    sessionId = session.SessionId;

    if (!sessionId) {
      throw new Error('Systems Manager did not return a session identifier.');
    }

    const environment = createSessionEnvironment(session);

    startupSignal.throwIfAborted();

    const child = spawn(executable, [
      SESSION_ENV_NAME,
      gateway.region,
      'StartSession',
      options.profile ?? '',
      JSON.stringify(input)
    ], {
      env: environment,
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const readyMessageLength =
      `Port 65535 opened for sessionId ${sessionId}.`.length;
    let tail = '';

    plugin = child;
    closed = new Promise<void>(resolve => {
      child.once('close', (code, exitSignal) => {
        disconnected.abort(new Error(
          `Session Manager exited (${exitSignal ?? code}).`
        ));
        resolve();
      });
    });
    child.once('error', error => {
      disconnected.abort(new Error(
        'Session Manager could not start.',
        { cause: error }
      ));
    });

    // Keep plugin output out of the agent's terminal.
    child.stderr.resume();

    for await (const [chunk] of on(child.stdout, 'data', {
      signal: startupSignal
    })) {
      if (!Buffer.isBuffer(chunk)) {
        continue;
      }

      const text = `${tail}${chunk.toString()}`;
      const match = READY_MESSAGE_PATTERN.exec(text);

      if (match?.[2] === sessionId) {
        const localPort = PORT_SCHEMA.parse(match[1]);

        child.stdout.resume();
        startupSignal.throwIfAborted();

        return ({
          url: `http://localhost:${localPort}`,
          signal: disconnected.signal,
          close
        });
      }

      // Preserve a startup message split across output chunks.
      tail = text.slice(-readyMessageLength);
    }

    throw new Error('Session Manager did not report an open local port.');
  } catch (error) {
    const reason: unknown = startupSignal.aborted
      ? startupSignal.reason
      : error;

    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [reason, cleanupError],
        'Could not open the SSM tunnel or complete its cleanup.'
      );
    }

    throw (reason);
  }
};
