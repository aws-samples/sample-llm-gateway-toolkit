import { z } from 'zod';
import { CONNECTION_OPTIONS_SCHEMA } from './connection.ts';

/**
 * Coding agents supported by the gateway CLI.
 */
export const AGENT_NAME_SCHEMA = z
  .enum(['claude', 'codex', 'copilot', 'opencode'])
  .describe('Coding agent to run.');

/**
 * Connection and model options shared by all coding agents.
 */
export const AGENT_OPTIONS_SCHEMA = CONNECTION_OPTIONS_SCHEMA
  .unwrap()
  .extend({

    /**
     * Model alias configured in LiteLLM and permitted by the virtual key.
     */
    model: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .default('claude-sonnet')
      .describe('Gateway model alias.')
  })
  .readonly();

/**
 * Supported coding-agent name.
 */
export type AgentName = z.infer<typeof AGENT_NAME_SCHEMA>;

/**
 * Validated coding-agent command options.
 */
export type AgentOptions = z.infer<typeof AGENT_OPTIONS_SCHEMA>;
