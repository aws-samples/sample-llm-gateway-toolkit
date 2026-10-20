import type { GatewayConnection } from '../connection.ts';

/**
 * Creates the Copilot command for the active gateway connection.
 * @param connection - Credentials for the selected transport.
 * @param model - Model alias selected by the developer.
 * @param tokenCommand - Quoted Cognito token command for public access.
 * @returns Command arguments and additional environment variables.
 */
export const createCopilotCommand = (
  connection: GatewayConnection,
  model: string,
  tokenCommand: string | undefined
) => {
  const isPublic = connection.transport === 'public';

  if (isPublic && !tokenCommand?.trim()) {
    throw new Error('Public gateway access requires a token command.');
  }

  return ({
    command: 'copilot',
    args: [
      '--secret-env-vars=COPILOT_PROVIDER_HEADERS',
      '--model',
      model
    ],
    env: {
      // Use the gateway's Responses API over HTTP streaming.
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_BASE_URL: `${connection.gatewayUrl}/v1`,
      COPILOT_PROVIDER_WIRE_API: 'responses',
      COPILOT_PROVIDER_TRANSPORT: 'http',

      // Keep inherited model overrides aligned with the selected alias.
      COPILOT_MODEL: model,
      COPILOT_PROVIDER_MODEL_ID: model,
      COPILOT_PROVIDER_WIRE_MODEL: model,

      // Public requests use Cognito; SSM uses the virtual-key header directly.
      COPILOT_PROVIDER_API_KEY: undefined,
      COPILOT_PROVIDER_BEARER_TOKEN: undefined,
      COPILOT_PROVIDER_API_KEY_COMMAND: isPublic ? tokenCommand : undefined,
      COPILOT_PROVIDER_HEADERS: `x-litellm-api-key: Bearer ${connection.apiKey}`
    }
  });
};
