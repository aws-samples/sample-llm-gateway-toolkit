import { pathToFileURL } from 'node:url';

import type { Config } from '@opencode-ai/plugin';
import type { GatewayModel } from '../schemas/model.ts';
import type { GatewayConnection } from '../connection.ts';

/**
 * Creates the OpenCode command for the active gateway connection.
 * @param connection - Credentials for the selected transport.
 * @param model - Selected model and its advertised token limits.
 * @param helperPath - Absolute path to the helper's entry point.
 * @param pluginPath - Absolute path to the authentication plugin.
 * @returns Command arguments and additional environment variables.
 */
export const createOpenCodeCommand = (
  connection: GatewayConnection,
  model: GatewayModel,
  helperPath: string,
  pluginPath: string
) => {
  const configuration = {
    model: `llm_gateway/${model.id}`,
    small_model: `llm_gateway/${model.id}`,
    enabled_providers: ['llm_gateway'],
    plugin: connection.transport === 'public' ? [[
      pathToFileURL(pluginPath).href,
      {
        gatewayUrl: connection.gatewayUrl,
        nodePath: process.execPath,
        helperPath
      }
    ]] : [],
    provider: {
      llm_gateway: {
        name: 'LiteLLM Gateway',
        npm: '@ai-sdk/anthropic',
        options: {
          baseURL: `${connection.gatewayUrl}/v1`,
          // The SDK requires a key; LiteLLM reads its dedicated header.
          apiKey: connection.apiKey,
          headers: {
            'x-litellm-api-key': `Bearer ${connection.apiKey}`
          }
        },
        models: {
          [model.id]: {
            name: model.id,
            tool_call: true,
            limit: {
              context: model.max_input_tokens,
              output: model.max_output_tokens
            }
          }
        }
      }
    }
  } satisfies Config;

  return ({
    command: 'opencode',
    args: [
      '--model',
      configuration.model
    ],
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify(configuration)
    }
  });
};
