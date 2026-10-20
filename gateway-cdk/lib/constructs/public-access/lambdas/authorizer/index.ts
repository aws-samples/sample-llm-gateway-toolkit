import { readConfiguration } from './configuration.js';
import { createDiscoveryResponse } from './discovery.js';
import { AUTHORIZATION_SCHEMA, EDGE_AUTH_SCHEMA } from './schema.js';
import { createEdgeAuth, rejectRequest } from './verify.js';
import type { CloudFrontRequestEvent } from 'aws-lambda';

/**
 * Public metadata endpoint used by the gateway CLI.
 */
const DISCOVERY_PATH = '/.well-known/llm-gateway';

/**
 * Initialized authentication and public login settings.
 */
type Authorizer = {

  /**
   * Verifies the JWT on each incoming API request.
   */
  readonly verifyRequest: ReturnType<typeof createEdgeAuth>;

  /**
   * Public metadata served directly by the edge function.
   */
  readonly discoveryResponse: ReturnType<typeof createDiscoveryResponse>;
};

/**
 * Retains the verifier and public metadata between invocations.
 */
let authorizer: Authorizer | undefined;

/**
 * Serves login metadata or validates the incoming request.
 * @param event - Incoming CloudFront viewer request.
 */
export const handler = async (event: CloudFrontRequestEvent) => {
  const request = event.Records[0]?.cf.request;
  const isDiscovery = request?.method === 'GET' && request.uri === DISCOVERY_PATH;
  const authorization = AUTHORIZATION_SCHEMA.safeParse(
    request?.headers.authorization
  );

  // Only the exact discovery route can be read without credentials.
  if (request === undefined || (!isDiscovery && !authorization.success)) {
    return (rejectRequest('401'));
  }

  if (authorizer === undefined) {
    try {
      const value = await readConfiguration();
      const configuration: unknown = JSON.parse(value);
      const settings = EDGE_AUTH_SCHEMA.parse(configuration);

      authorizer = {
        verifyRequest: createEdgeAuth(settings),
        discoveryResponse: createDiscoveryResponse(settings)
      };
    } catch {
      return (rejectRequest('503'));
    }
  }

  return (isDiscovery
    ? authorizer.discoveryResponse
    : authorizer.verifyRequest(event));
};
