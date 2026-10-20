import { PORT_SCHEMA } from './port.ts';
import { SSM_OPTIONS_SCHEMA } from './ssm.ts';
import type { z } from 'zod';

/**
 * Connection settings for foreground tunnel commands.
 */
export const TUNNEL_OPTIONS_SCHEMA = SSM_OPTIONS_SCHEMA
  .unwrap()
  .extend({

    /**
     * Local port, or undefined to let the plugin select an available port.
     */
    port: PORT_SCHEMA
      .optional()
      .describe('Local port. Defaults to an available port.')
  })
  .readonly();

/**
 * Validated foreground tunnel settings.
 */
export type TunnelOptions = z.infer<typeof TUNNEL_OPTIONS_SCHEMA>;
