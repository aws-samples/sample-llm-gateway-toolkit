import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

/**
 * Region containing the configuration parameter, supplied by CDK.
 */
declare const CONFIGURATION_REGION: string;

/**
 * Configuration parameter name, supplied by CDK.
 */
declare const CONFIGURATION_PARAMETER_NAME: string;

/**
 * Maximum duration of an SSM read, in milliseconds.
 */
const REQUEST_TIMEOUT = 1_500;

/**
 * Reuses the SSM client across warm invocations.
 */
const client = new SSMClient({
  region: CONFIGURATION_REGION,
  maxAttempts: 1
});

/**
 * Reads the JSON configuration stored by CDK.
 */
export const readConfiguration = async () => {
  const response = await client.send(new GetParameterCommand({
    Name: CONFIGURATION_PARAMETER_NAME
  }), {
    abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT)
  });

  if (response.Parameter?.Value === undefined) {
    throw new Error('The authorizer configuration is missing.');
  }

  return (response.Parameter?.Value);
};
