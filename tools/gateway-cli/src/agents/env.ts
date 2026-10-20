import { delimiter, dirname, extname } from 'node:path';
import { GATEWAY_URL_SCHEMA } from '../schemas/gateway-url.ts';

/**
 * Supplies the token hook with its gateway and module location.
 * @param gatewayUrl - Public gateway associated with the current session.
 */
export const createTokenEnvironment = (gatewayUrl: string) => {
  const tokenModule = new URL(
    `./token-hook${extname(import.meta.filename)}`,
    import.meta.url
  );

  return ({
    GATEWAY_URL: GATEWAY_URL_SCHEMA.parse(gatewayUrl),
    GATEWAY_TOKEN_MODULE: tokenModule.href,
    // The hook must use the same Node installation as the gateway CLI.
    PATH: [dirname(process.execPath), process.env.PATH]
      .filter(Boolean)
      .join(delimiter)
  });
};

/**
 * Validates the gateway inherited by the token hook.
 */
export const readTokenGatewayUrl = () => {
  return (GATEWAY_URL_SCHEMA.parse(process.env.GATEWAY_URL));
};
