import { getSession } from '../session.ts';

/**
 * Prints the Cognito access token for a coding agent.
 * @param gatewayUrl - Gateway the running agent is configured to use.
 */
export const printToken = async (gatewayUrl: string) => {
  const session = await getSession(gatewayUrl);

  // Authentication hooks expect only the credential on stdout.
  process.stdout.write(`${session.accessToken}\n`);
};
