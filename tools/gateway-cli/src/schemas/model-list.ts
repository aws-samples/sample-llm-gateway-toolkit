import { z } from 'zod';
import { MODEL_SCHEMA } from './model.ts';

/**
 * Model-list response, retaining metadata for the selected model.
 */
export const MODEL_LIST_SCHEMA = z
  .object({

    /**
     * Models visible to the developer's virtual key.
     */
    data: z
      .array(MODEL_SCHEMA
        .unwrap()
        .pick({
          id: true
        })
        .loose())
      .max(10_000)
      .describe('Available gateway models.')
  })
  .readonly();
