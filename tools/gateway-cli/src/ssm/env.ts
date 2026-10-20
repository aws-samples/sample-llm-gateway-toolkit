import { SSM_SESSION_SCHEMA } from '../schemas/ssm-session.ts';
import type { StartSessionCommandOutput } from '@aws-sdk/client-ssm';

/**
 * Environment variable read by the Session Manager plugin.
 */
export const SESSION_ENV_NAME = 'AWS_SSM_START_SESSION_RESPONSE';

/**
 * Inherits the caller's environment and supplies validated session credentials.
 * @param session - Response returned by the StartSession operation.
 */
export const createSessionEnvironment = (session: StartSessionCommandOutput) => {
  const validated = SSM_SESSION_SCHEMA.parse(session);

  return ({
    ...process.env,
    [SESSION_ENV_NAME]: JSON.stringify(validated)
  });
};
