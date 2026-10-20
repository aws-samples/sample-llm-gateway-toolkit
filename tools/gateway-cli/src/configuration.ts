import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { arrayBuffer } from 'node:stream/consumers';
import { CONFIGURATION_SCHEMA } from './schemas/configuration.ts';
import type { Configuration } from './schemas/configuration.ts';

/**
 * Directory containing the developer's gateway settings.
 */
const CONFIGURATION_DIRECTORY = join(homedir(), '.llm-gateway');

/**
 * Saved connection settings, without credentials.
 */
const CONFIGURATION_FILE = join(CONFIGURATION_DIRECTORY, 'config.json');

/**
 * Maximum configuration size, in bytes.
 */
const MAX_CONFIGURATION_BYTES = 32_768;

/**
 * Loads the saved gateway configuration.
 * @returns Validated settings, or undefined before a connection has been saved.
 */
export const loadConfiguration = async () => {
  try {
    // Read one extra byte so oversized files can be rejected.
    const data = Buffer.from(
      await arrayBuffer(
        createReadStream(CONFIGURATION_FILE, {
          end: MAX_CONFIGURATION_BYTES
        })
      )
    );

    if (data.length > MAX_CONFIGURATION_BYTES) {
      throw new Error('Gateway configuration is too large.');
    }

    const value: unknown = JSON.parse(data.toString('utf8'));

    return (CONFIGURATION_SCHEMA.parse(value));
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return (undefined);
    }

    throw new Error(
      `Cannot read gateway configuration. Check ${CONFIGURATION_FILE}.`,
      { cause: error }
    );
  }
};

/**
 * Removes the saved connection settings after credentials have been cleared.
 */
export const clearConfiguration = async () => {
  await rm(CONFIGURATION_FILE, {
    force: true
  });
};

/**
 * Atomically replaces the saved connection settings.
 * @param configuration - Gateway endpoints and preferred transport.
 */
export const saveConfiguration = async (configuration: Configuration) => {
  const value = CONFIGURATION_SCHEMA.parse(configuration);
  const temporary = `${CONFIGURATION_FILE}.${randomUUID()}.tmp`;

  await mkdir(CONFIGURATION_DIRECTORY, {
    recursive: true,
    mode: 0o700
  });

  try {
    await writeFile(
      temporary,
      `${JSON.stringify(value, null, 2)}\n`,
      {
        flag: 'wx',
        mode: 0o600,
        flush: true
      }
    );

    // Replace the configuration only after the temporary file is complete.
    await rename(temporary, CONFIGURATION_FILE);
  } finally {
    await rm(temporary, {
      force: true
    });
  }
};
