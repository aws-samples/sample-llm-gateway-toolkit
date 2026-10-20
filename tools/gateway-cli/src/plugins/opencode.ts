import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OPENCODE_AUTH_SCHEMA } from '../schemas/opencode-auth.ts';
import { SESSION_SCHEMA } from '../schemas/session.ts';
import type { Config, Plugin } from '@opencode-ai/plugin';

/**
 * Maximum time for credential retrieval, in milliseconds.
 */
const TOKEN_TIMEOUT = 60_000;

/**
 * Maximum captured output per process stream, in bytes.
 */
const TOKEN_OUTPUT_LIMIT = 32_768;

/**
 * Executes the token helper directly, without a shell.
 */
const executeCommand = promisify(execFile);

/**
 * Connects OpenCode's gateway provider to the existing token helper.
 * @param _input - Context supplied by OpenCode.
 * @param options - Gateway address and local helper paths.
 */
export const createGatewayAuth = (async (
  _input: unknown,
  options?: Record<string, unknown>
) => {
  const settings = OPENCODE_AUTH_SCHEMA.parse(options);

  /**
   * Retrieves a usable access token through the existing Node command.
   * @param signal - Cancellation signal for the model request.
   */
  const readAccessToken = async (signal: AbortSignal) => {
    try {
      const execution = executeCommand(settings.nodePath, [
        settings.helperPath,
        'token',
        settings.gatewayUrl
      ], {
        encoding: 'utf8',
        timeout: TOKEN_TIMEOUT,
        maxBuffer: TOKEN_OUTPUT_LIMIT,
        windowsHide: true,
        signal
      });

      execution.child.stdin?.end();

      const { stdout } = await execution;

      return (SESSION_SCHEMA.unwrap().shape.accessToken.parse(stdout.trim()));
    } catch {
      signal.throwIfAborted();

      // Child-process errors can contain credential-bearing stdout or stderr.
      throw new Error(
        'Cannot retrieve gateway credentials. Run gateway doctor or gateway login.'
      );
    }
  };

  /**
   * Adds both credentials after checking the destination and blocks redirects.
   * @param input - Request supplied by the Anthropic SDK.
   * @param init - Request options supplied by the SDK.
   */
  const fetchWithAuth = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, {
      ...init,
      redirect: 'error'
    });

    // Ensure the request is targeting the configured gateway.
    if (new URL(request.url).origin !== settings.gatewayUrl) {
      throw new Error('Refusing to send gateway credentials to another origin.');
    }

    // Extract and validate the API key from the request headers.
    const apiKey = SESSION_SCHEMA.unwrap().shape.apiKey.safeParse(
      request.headers.get('x-api-key')
    );
    if (!apiKey.success) {
      throw new Error('OpenCode did not supply a valid LiteLLM virtual key.');
    }
    request.signal.throwIfAborted();

    // Retrieve the access token using the existing Node command.
    const accessToken = await readAccessToken(request.signal);

    request.signal.throwIfAborted();

    // Let the HTTP client derive Host from the validated URL.
    request.headers.delete('host');
    request.headers.delete('x-api-key');
    request.headers.set('x-litellm-api-key', `Bearer ${apiKey.data}`);
    request.headers.set('authorization', `Bearer ${accessToken}`);

    return (fetch(request));
  };

  /**
   * Installs the authenticated transport on the gateway provider.
   * @param configuration - Configuration assembled by OpenCode.
   */
  const configureProvider = async (configuration: Config) => {
    const provider = configuration.provider?.llm_gateway;

    if (provider === undefined) {
      throw new Error('The gateway provider is missing from OpenCode configuration.');
    }

    provider.options = {
      ...provider.options,
      fetch: fetchWithAuth
    };
  };

  return ({ config: configureProvider });
}) satisfies Plugin;
