import { writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGatewayModel } from '../models.ts';
import { createClaudeCommand } from './claude.ts';
import { createCodexCommand } from './codex.ts';
import { createCopilotCommand } from './copilot.ts';
import { createTokenEnvironment } from './env.ts';
import { createOpenCodeCommand } from './opencode.ts';
import type { GatewayConnection } from '../connection.ts';
import type { AgentName } from '../schemas/agent.ts';

/**
 * Paths and URLs stay in the environment, outside shell command syntax.
 */
const TOKEN_COMMAND = 'node -e "import(process.env.GATEWAY_TOKEN_MODULE)"';

/**
 * Prepares an agent's gateway configuration without modifying its user settings.
 * @param agent - Coding agent selected on the command line.
 * @param connection - Credentials for the active gateway transport.
 * @param model - Requested LiteLLM model alias.
 * @param settingsPath - Private temporary file used for Claude settings.
 * @param signal - Cancellation for model discovery.
 */
export const prepareAgentCommand = async (
  agent: AgentName,
  connection: GatewayConnection,
  model: string,
  settingsPath: string,
  signal: AbortSignal
) => {
  const extension = extname(import.meta.filename);
  const helperPath = fileURLToPath(
    new URL(`../index${extension}`, import.meta.url)
  );
  const tokenCommand = connection.transport === 'public'
    ? TOKEN_COMMAND
    : undefined;
  const tokenEnvironment = tokenCommand === undefined
    ? {}
    : createTokenEnvironment(connection.gatewayUrl);

  switch (agent) {
    case 'codex':
      return (createCodexCommand(connection, model, helperPath));

    case 'copilot': {
      const command = createCopilotCommand(connection, model, tokenCommand);

      return ({
        ...command,
        env: {
          ...command.env,
          ...tokenEnvironment
        }
      });
    }

    case 'opencode': {
      const metadata = await getGatewayModel(connection, model, signal);
      const pluginPath = fileURLToPath(new URL(
        `../plugins/opencode${extension}`,
        import.meta.url
      ));

      return (createOpenCodeCommand(
        connection,
        metadata,
        helperPath,
        pluginPath
      ));
    }

    case 'claude': {
      const command = createClaudeCommand(
        connection,
        model,
        tokenCommand,
        settingsPath
      );
      const env = {
        ...command.env,
        ...tokenEnvironment
      };

      await writeFile(settingsPath, JSON.stringify({
        ...command.settings,
        env
      }, null, 2), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      });

      return ({
        ...command,
        env
      });
    }
  }
};
