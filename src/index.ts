export {
  parseEmail,
  normalizeEmailText,
  looksTransactional,
  deriveFlow,
  DEFAULT_ACCOUNT_NAMES,
} from './parser.js';

export type {
  ParsedTransaction,
  ParseOptions,
  TransactionType,
  TransactionFlow,
} from './parser.js';
