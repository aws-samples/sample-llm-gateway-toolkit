import { stripVTControlCharacters, styleText } from 'node:util';

/**
 * Terminal style and symbol for each diagnostic outcome.
 */
const CHECK_STYLES = {
  pass: ['green', '✓'],
  fail: ['red', '✗'],
  skip: ['gray', '–']
} as const;

/**
 * Width reserved for diagnostic labels.
 */
const CHECK_LABEL_WIDTH = 20;

/**
 * One diagnostic result and its optional recovery action.
 */
export type DoctorCheck = {

  /**
   * Short name of the check.
   */
  readonly label: string;

  /**
   * Whether the check passed, failed, or could not run.
   */
  readonly status: keyof typeof CHECK_STYLES;

  /**
   * Human-readable result.
   */
  readonly detail: string;

  /**
   * Next action when the check needs attention.
   */
  readonly action?: string;
};

/**
 * Removes terminal escapes and keeps diagnostic text on one line.
 * @param value - Label, result, or recovery action.
 */
const cleanText = (value: string) => {
  return (stripVTControlCharacters(value)
    .replace(/\s+/g, ' ')
    .trim());
};

/**
 * Formats a result with an optional recovery action beneath it.
 * @param check - Completed diagnostic check.
 */
export const formatDoctorCheck = (check: DoctorCheck) => {
  const [color, marker] = CHECK_STYLES[check.status];
  const symbol = styleText(color, marker, { stream: process.stdout });
  const label = cleanText(check.label).padEnd(CHECK_LABEL_WIDTH);
  const detail = cleanText(check.detail);
  const action = check.action === undefined
    ? ''
    : `\n  ${cleanText(check.action)}`;

  return (`${symbol} ${label} ${detail}${action}`);
};
