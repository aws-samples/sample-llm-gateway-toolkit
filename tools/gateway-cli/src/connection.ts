/**
 * Credentials used by an agent's active gateway connection.
 */
export type GatewayConnection = {

  /**
   * Public gateway origin or the local SSM tunnel address.
   */
  readonly gatewayUrl: string;

  /**
   * LiteLLM virtual key associated with this gateway.
   */
  readonly apiKey: string;
} & ({

  /**
   * Public inference authenticated by Cognito.
   */
  readonly transport: 'public';

  /**
   * Current Cognito access token for this gateway.
   */
  readonly accessToken: string;
} | {

  /**
   * Private inference through an authenticated SSM session.
   */
  readonly transport: 'ssm';
});

/**
 * Creates the authentication headers required by the selected transport.
 * @param connection - Credentials for the active gateway connection.
 */
export const createGatewayHeaders = (connection: GatewayConnection) => {
  const headers = new Headers({
    'x-litellm-api-key': `Bearer ${connection.apiKey}`
  });

  if (connection.transport === 'public') {
    headers.set('authorization', `Bearer ${connection.accessToken}`);
  }

  return (headers);
};
