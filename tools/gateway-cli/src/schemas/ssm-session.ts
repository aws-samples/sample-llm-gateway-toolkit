import { z } from 'zod';

/**
 * Session fields required by the Session Manager plugin.
 */
export const SSM_SESSION_SCHEMA = z
  .object({

    /**
     * Identifier used to resume or terminate the session.
     */
    SessionId: z
      .string()
      .min(1)
      .describe('SSM session identifier.'),

    /**
     * Secure WebSocket endpoint returned by Systems Manager.
     */
    StreamUrl: z
      .url({
        protocol: /^wss$/
      })
      .describe('Session streaming endpoint.'),

    /**
     * Credential used to establish the session stream.
     */
    TokenValue: z
      .string()
      .min(1)
      .describe('Session streaming token.')
  })
  .readonly();
