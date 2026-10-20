import type { GatewayConnection } from '../connection.ts';

/**
 * Interval between credential checks, in milliseconds.
 */
const AUTH_REFRESH_INTERVAL = 60_000;

/**
 * Creates the Claude command for the active gateway connection.
 * @param connection - Credentials for the selected transport.
 * @param model - Model alias selected by the developer.
 * @param tokenCommand - Quoted Cognito token command for public access.
 * @param settingsPath - Absolute path to the temporary settings file.
 * @returns Command arguments, environment variables, and settings to write.
 */
export const createClaudeCommand = (
  connection: GatewayConnection,
  model: string,
  tokenCommand: string | undefined,
  settingsPath: string
) => {
  const isPublic = connection.transport === 'public';

  if (isPublic && !tokenCommand?.trim()) {
    throw new Error('Public gateway access requires a token command.');
  }

  const settings = {
    apiKeyHelper: isPublic ? tokenCommand : '',
    env: {
      // Map Claude's model choices and background tasks to gateway aliases.
      ANTHROPIC_BASE_URL: connection.gatewayUrl,
      ANTHROPIC_CUSTOM_HEADERS: `x-litellm-api-key: Bearer ${connection.apiKey}`,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus',

      // Select native credentials and clear inherited sign-in settings.
      ANTHROPIC_AUTH_TOKEN: isPublic ? '' : connection.apiKey,
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      CLAUDE_CODE_API_KEY_HELPER_TTL_MS: String(AUTH_REFRESH_INTERVAL),

      // Provider authentication belongs to the gateway.
      CLAUDE_CODE_USE_BEDROCK: '0',
      CLAUDE_CODE_USE_VERTEX: '0',
      CLAUDE_CODE_USE_FOUNDRY: '0',
      CLAUDE_CODE_USE_ANTHROPIC_AWS: '0'
    }
  };

  return ({
    command: 'claude',
    args: [
      '--model',
      model,
      '--settings',
      settingsPath
    ],
    env: settings.env,
    settings
  });
};
