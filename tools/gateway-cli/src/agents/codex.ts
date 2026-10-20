import type { GatewayConnection } from '../connection.ts';

/**
 * Maximum time for credential retrieval, in milliseconds.
 */
const AUTH_TIMEOUT = 60_000;

/**
 * Re-read credentials once per minute. The session module
 * contacts Cognito only when the access token needs renewal.
 */
const AUTH_REFRESH_INTERVAL = 60_000;

/**
 * Creates the Codex command for the active gateway connection.
 * @param connection - Credentials for the selected transport.
 * @param model - Model alias selected by the developer.
 * @param helperPath - Absolute path to the helper's entry point.
 * @returns Command arguments and additional environment variables.
 */
export const createCodexCommand = (
  connection: GatewayConnection,
  model: string,
  helperPath: string
) => {
  // Keep the virtual key outside command-line arguments.
  const provider = [
    'name = "LiteLLM Gateway"',
    `base_url = ${JSON.stringify(`${connection.gatewayUrl}/v1`)}`,
    'wire_api = "responses"',
    'supports_websockets = false',
    'env_http_headers = { "x-litellm-api-key" = "GATEWAY_LITELLM_API_KEY" }'
  ];

  if (connection.transport === 'public') {
    // Codex executes Node directly; JSON quoting also produces valid TOML.
    const authentication = [
      `command = ${JSON.stringify(process.execPath)}`,
      `args = ${JSON.stringify([
        helperPath,
        'token',
        connection.gatewayUrl
      ])}`,
      `timeout_ms = ${AUTH_TIMEOUT}`,
      `refresh_interval_ms = ${AUTH_REFRESH_INTERVAL}`
    ].join(', ');

    provider.push(`auth = { ${authentication} }`);
  } else {
    provider.push('requires_openai_auth = false');
  }

  return ({
    command: 'codex',
    args: [
      '--model',
      model,
      '--config',
      'model_provider = "llm_gateway"',
      '--config',
      `model_providers.llm_gateway = { ${provider.join(', ')} }`
    ],
    env: {
      GATEWAY_LITELLM_API_KEY: `Bearer ${connection.apiKey}`
    }
  });
};
