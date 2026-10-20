import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { GATEWAY_URL_SCHEMA } from './gateway-url.ts';

/**
 * Local executable and script paths passed as separate process arguments.
 */
const FILE_PATH_SCHEMA = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, {
    error: 'Expected an absolute file path.'
  });

/**
 * Settings supplied by the gateway launcher to the OpenCode plugin.
 */
export const OPENCODE_AUTH_SCHEMA = z
  .strictObject({

    /**
     * Only origin allowed to receive gateway credentials.
     */
    gatewayUrl: GATEWAY_URL_SCHEMA,

    /**
     * Node executable used for the existing credential-store integration.
     */
    nodePath: FILE_PATH_SCHEMA
      .describe('Absolute path to Node.js.'),

    /**
     * Entry point providing the gateway token command.
     */
    helperPath: FILE_PATH_SCHEMA
      .describe('Absolute path to the gateway helper.')
  })
  .readonly();
