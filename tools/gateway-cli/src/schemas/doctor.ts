import { AGENT_NAME_SCHEMA } from './agent.ts';
import { CONNECTION_OPTIONS_SCHEMA } from './connection.ts';
import type { z } from 'zod';

/**
 * Connection settings and optional coding agent for diagnostic checks.
 */
export const DOCTOR_OPTIONS_SCHEMA = CONNECTION_OPTIONS_SCHEMA
  .unwrap()
  .extend({

    /**
     * Check one agent, or report availability for all supported agents.
     */
    agent: AGENT_NAME_SCHEMA
      .optional()
      .describe('Coding agent to check. Defaults to all supported agents.')
  })
  .readonly();

/**
 * Validated diagnostic command options.
 */
export type DoctorOptions = z.infer<typeof DOCTOR_OPTIONS_SCHEMA>;
