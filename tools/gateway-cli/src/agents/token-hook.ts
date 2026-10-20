import { printToken } from '../commands/token.ts';
import { readTokenGatewayUrl } from './env.ts';

/**
 * Prints a current access token for Claude and Copilot's credential hooks.
 */
const main = async () => {
  try {
    await printToken(readTokenGatewayUrl());
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : 'Gateway authentication failed. Run gateway login.';

    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
};

await main();
