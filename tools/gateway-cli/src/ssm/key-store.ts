import { createHash } from 'node:crypto';
import { VIRTUAL_KEY_SCHEMA } from '../schemas/virtual-key.ts';

/**
 * Opens the OS credential entry for a private gateway's virtual key.
 * @param stackArn - Full stack ARN returned by CloudFormation.
 * @param signal - Cancellation controlled by the CLI.
 */
export const createVirtualKeyStore = async (
  stackArn: string,
  signal?: AbortSignal
) => {
  const { AsyncEntry } = await import('@napi-rs/keyring');
  const identity = createHash('sha256').update(stackArn).digest('hex');

  signal?.throwIfAborted();

  // Bind the entry to this deployment across accounts, regions, and recreations.
  const entry = new AsyncEntry('llm-gateway-toolkit', `ssm-${identity}`, {
    linux: {
      store: 'secret-service'
    }
  });

  /**
   * Reads the saved virtual key, or returns undefined before login.
   */
  const load = async () => {
    try {
      const secret = await entry.getSecret(signal);

      return (secret === null
        ? undefined
        : VIRTUAL_KEY_SCHEMA.parse(Buffer.from(secret).toString('utf8')));
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(
        'Cannot read the saved virtual key. Unlock your credential store or save a new key.',
        { cause: error }
      );
    }
  };

  /**
   * Saves the virtual key directly in the OS credential store.
   * @param apiKey - LiteLLM virtual key verified against this gateway.
   */
  const save = async (apiKey: string) => {
    const value = VIRTUAL_KEY_SCHEMA.parse(apiKey);

    try {
      await entry.setSecret(Buffer.from(value, 'utf8'), signal);
    } catch (error) {
      signal?.throwIfAborted();
      throw new Error(
        'Cannot save the virtual key. Unlock your credential store and try again.',
        { cause: error }
      );
    }
  };

  /**
   * Removes this deployment's virtual key from the OS credential store.
   */
  const clear = async () => {
    await entry.deleteCredential(signal);
  };

  return ({
    load,
    save,
    clear
  });
};
