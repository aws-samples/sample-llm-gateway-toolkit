import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

/**
 * Creates local credentials without replacing an existing configuration.
 */
const setup = async () => {
  const template = await readFile(new URL('.env.example', import.meta.url), 'utf8');
  const configuration = template
    .replace('LITELLM_MASTER_KEY=', `LITELLM_MASTER_KEY=sk-${randomBytes(32).toString('hex')}`)
    .replace('LITELLM_SALT_KEY=', `LITELLM_SALT_KEY=${randomBytes(32).toString('hex')}`)
    .replace('POSTGRES_PASSWORD=', `POSTGRES_PASSWORD=${randomBytes(32).toString('hex')}`);

  try {
    // Keep credentials stable across restarts and private to the current user.
    await writeFile(new URL('.env', import.meta.url), configuration, {
      flag: 'wx',
      mode: 0o600
    });
  } catch (error) {
    if (error.code === 'EEXIST') {
      console.info('Keeping your existing .env. No credentials changed.');
      return;
    }
    throw error;
  }

  console.info('Created .env with local credentials.');
};

await setup();
