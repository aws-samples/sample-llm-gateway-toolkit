import { randomBytes, randomUUID, subtle } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { arrayBuffer } from 'node:stream/consumers';
import { lock } from 'proper-lockfile';
import { SESSION_SCHEMA } from './schemas/session.ts';

import type { AsyncEntry } from '@napi-rs/keyring';
import type { Session } from './schemas/session.ts';

/**
 * Private directory shared by the CLI and agent token commands.
 */
const SESSION_DIRECTORY = join(homedir(), '.llm-gateway', 'auth');

/**
 * Encrypted session; its encryption key lives in the OS credential store.
 */
const SESSION_FILE = join(SESSION_DIRECTORY, 'session.enc');

/**
 * Maximum encrypted session size, in bytes.
 */
const MAX_SESSION_BYTES = 1_048_576;

/**
 * AES-256 key length, in bytes.
 * Store this small key in the OS vault; tokens can exceed credential size limits.
 */
const KEY_BYTES = 32;

/**
 * Fresh AES-GCM initialization vector length, in bytes.
 */
const IV_BYTES = 12;

/**
 * Required authentication tag length, in bits.
 */
const TAG_BITS = 128;

/**
 * Creates session operations used while holding the shared file lock.
 * @param entry - OS credential entry containing the encryption key.
 */
const createSessionStore = (entry: AsyncEntry) => {

  /**
   * Decrypts and validates the saved session, or returns undefined before login.
   * @returns The decrypted session, or undefined if no valid session exists.
   */
  const load = async () => {
    try {
      // Read the encrypted session file into a buffer.
      const data = Buffer.from(
        await arrayBuffer(
          createReadStream(SESSION_FILE, {
            end: MAX_SESSION_BYTES
          })
        )
      );
      const secret = await entry.getSecret();

      if (
        data.length > MAX_SESSION_BYTES ||
        data.length <= IV_BYTES + TAG_BITS / 8 ||
        secret === null ||
        secret.length !== KEY_BYTES
      ) {
        throw new Error('Invalid saved session or encryption key.');
      }

      // Import the encryption key from the OS credential store.
      const key = await subtle.importKey(
        'raw',
        Uint8Array.from(secret),
        'AES-GCM',
        false,
        ['decrypt']
      );

      // Decrypt the session from the file.
      const plaintext = await subtle.decrypt({
        name: 'AES-GCM',
        iv: data.subarray(0, IV_BYTES),
        tagLength: TAG_BITS
      }, key, data.subarray(IV_BYTES));

      // Parse the decrypted session JSON.
      const session: unknown = JSON.parse(
        Buffer
          .from(plaintext)
          .toString('utf8')
      );

      return (SESSION_SCHEMA.parse(session));
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return (undefined);
      }

      throw new Error(
        'Cannot read the saved session. Unlock your credential store or sign in again.',
        { cause: error }
      );
    }
  };

  /**
   * Encrypts the complete session and replaces the previous file atomically.
   * @param session - Session obtained from login or token refresh.
   * @returns A promise that resolves once the session has been saved.
   */
  const save = async (session: Session) => {
    const value = SESSION_SCHEMA.parse(session);
    const secret = await entry.getSecret();
    const bytes = secret === null
      ? randomBytes(KEY_BYTES)
      : Uint8Array.from(secret);
    const iv = randomBytes(IV_BYTES);
    const temporary = `${SESSION_FILE}.${randomUUID()}.tmp`;

    if (bytes.length !== KEY_BYTES) {
      throw new Error('Invalid session key. Run gateway logout, then gateway login.');
    }

    // Import the encryption key for encrypting the session.
    const key = await subtle.importKey(
      'raw',
      bytes,
      'AES-GCM',
      false,
      ['encrypt']
    );

    // Encrypt the session data with the imported key.
    const ciphertext = await subtle.encrypt({
      name: 'AES-GCM',
      iv,
      tagLength: TAG_BITS
    }, key, Buffer.from(JSON.stringify(value)));

    // Combine the IV and ciphertext into a single buffer for storage.
    const data = Buffer.concat([iv, Buffer.from(ciphertext)]);

    if (secret === null) {
      await entry.setSecret(bytes);
    }

    try {
      // Write the encrypted session data.
      await writeFile(temporary, data, {
        flag: 'wx',
        mode: 0o600,
        flush: true
      });

      // Atomically replace the old session file with the new one.
      await rename(temporary, SESSION_FILE);
    } finally {
      await rm(temporary, {
        force: true
      });
    }
  };

  /**
   * Deletes the encryption key before removing the encrypted session file.
   */
  const clear = async () => {
    try {
      await entry.deleteCredential();
    } finally {
      await rm(SESSION_FILE, { force: true });
    }
  };

  return ({
    load,
    save,
    clear
  });
};

/**
 * Serializes session access so concurrent agents cannot reuse a rotated refresh token.
 * Browser login must finish before entering this operation.
 * @param operation - Session read, write, refresh, or logout operation.
 * @returns The result of the provided operation.
 */
export const withSessionStore = async <T>(
  operation: (store: ReturnType<typeof createSessionStore>) => Promise<T>
) => {
  await mkdir(SESSION_DIRECTORY, {
    recursive: true,
    mode: 0o700
  });

  // Acquire a lock on the session directory to prevent concurrent access.
  const release = await lock(SESSION_DIRECTORY, {
    lockfilePath: join(SESSION_DIRECTORY, '.lock'),
    retries: {
      retries: 30,
      minTimeout: 100,
      maxTimeout: 500
    }
  });

  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');

    // Create a new keyring entry for storing the encryption key.
    const entry = new AsyncEntry('llm-gateway-toolkit', 'gateway-auth', {
      linux: {
        store: 'secret-service'
      }
    });

    // Execute the provided operation with the created session store.
    return (await operation(createSessionStore(entry)));
  } finally {
    await release();
  }
};
