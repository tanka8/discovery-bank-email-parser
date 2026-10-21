export type TransactionType =
  | 'card_payment'
  | 'card_reversal'
  | 'incoming_payment'
  | 'payment'
  | 'debit_order'
  | 'forex_transfer'
  | 'transfer'
  | 'atm_withdrawal';

export type TransactionFlow = 'expense' | 'income' | 'transfer';

/**
 * User-facing classification, derived from the bank's transaction type and
 * direction. `card_reversal` stays `expense` so refunds subtract from net
 * spend rather than inflating income.
 */
export function deriveFlow(
  type: TransactionType,
  direction: 'debit' | 'credit'
): TransactionFlow {
  if (type === 'transfer' || type === 'forex_transfer') return 'transfer';
  if (direction === 'credit' && type !== 'card_reversal') return 'income';
  return 'expense';
}

export interface ParsedTransaction {
  type: TransactionType;
  direction: 'debit' | 'credit';
  /** ZAR amount. `0` for foreign-currency card payments — see `foreignAmount`. */
  amount: number;
  foreignAmount?: number;
  foreignCurrency?: string;
  exchangeRate?: number;
  description?: string;
  /** Raw account text, e.g. `"Transaction Account"` or `"account ending ***1234"`. */
  fromAccountRaw?: string;
  toAccountRaw?: string;
  balanceAfter?: number;
  /** ISO 8601, always with the `+02:00` (SAST) offset. */
  transactedAt: string;
}

/**
 * Whether an email looks like money-movement mail at all.
 *
 * Most emails that fail to parse are supposed to fail: marketing blasts,
 * statement-ready notices, competition mailers. Use this to tell those apart
 * from a real transaction the parser couldn't handle — e.g. to alert only on
 * the latter.
 *
 * `"Available balance:"` covers card payments, payments, debit orders, incoming
 * payments and ATM withdrawals. Transfers and forex transfers omit it, so the
 * exchange-rate line stands in for those.
 */
export function looksTransactional(rawText: string): boolean {
  const text = normalizeEmailText(rawText);
  return TRANSACTIONAL_MARKERS.some(re => re.test(text));
}

const TRANSACTIONAL_MARKERS = [
  /Available\s+balance:/i,
  /Exchange\s+Rate\s+1\s+\w+\s*=\s*[\d.]+\s+ZAR/i,
];

export interface ParseOptions {
  /**
   * When the email was received. Discovery's emails carry a day and month but
   * no year, so the year is inferred relative to this instant. Pass the
   * original receipt time when reparsing stored emails, otherwise a message
   * reparsed months later infers the wrong year. Defaults to now.
   */
  receivedAt?: Date | string;
  /**
   * Account names to recognise in `From <name>` / `To <name>` lines. Discovery
   * shows the product name rather than a number for own-account references, and
   * the set differs per customer. Defaults to {@link DEFAULT_ACCOUNT_NAMES}.
   */
  accountNames?: readonly string[];
}

/** Account product names recognised out of the box. */
export const DEFAULT_ACCOUNT_NAMES: readonly string[] = [
  'Credit Card',
  'Demand Savings',
  'GBP Account',
  'Notice Savings',
  'Transaction Account',
];

function parseAmount(raw: string): number {
  return parseFloat(raw.replace(/,/g, ''));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseDate(raw: string, anchor: Date): string | null {
  const months: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12',
  };
  const match = raw.match(/(\d{1,2})\s+(\w+)\s+at\s+(\d{2}:\d{2})/i);
  if (!match) return null;
  const [, day, monthName, time] = match;
  const month = months[monthName.toLowerCase()];
  if (!month) return null;

  // Discovery emails give South African time (SAST, UTC+2, no DST) with no
  // year. Anchor inference to when this email was originally received so
  // reparsing it months or years later is deterministic. If the inferred date
  // lands more than a day after receipt (e.g. 31 December received on
  // 1 January), the transaction happened in the previous year.
  const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
  const build = (y: number) => `${y}-${month}-${day.padStart(2, '0')}T${time}:00.000+02:00`;
  let year = new Date(anchor.getTime() + SAST_OFFSET_MS).getUTCFullYear();
  if (new Date(build(year)).getTime() - anchor.getTime() > 24 * 3600 * 1000) year -= 1;
  const result = build(year);
  return Number.isNaN(new Date(result).getTime()) ? null : result;
}

function dateAnchor(value?: Date | string): Date {
  const parsed = value instanceof Date ? value : value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Replace each `<style>…</style>` / `<script>…</script>` block with a space.
 * Equivalent to `/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi`, but linear: that
 * pattern rescans to the end of the input from every opening tag that has no
 * closer, so a few hundred KB of `<style` took minutes. An opener with no
 * closing tag is left in place (the tag pass removes the tag itself).
 */
function stripStyleAndScriptBlocks(raw: string): string {
  const open = /<(style|script)\b/gi;
  const closers = { style: /<\/style>/gi, script: /<\/script>/gi };
  // Once a search for a closer fails, no later opener of that kind can have one.
  const exhausted = { style: false, script: false };
  let out = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = open.exec(raw)) !== null) {
    const kind = match[1].toLowerCase() as 'style' | 'script';
    if (exhausted[kind]) continue;
    const tagEnd = raw.indexOf('>', open.lastIndex);
    if (tagEnd === -1) break; // no `>` left, so no later opening tag can complete either
    const closer = closers[kind];
    closer.lastIndex = tagEnd + 1;
    const close = closer.exec(raw);
    if (!close) {
      exhausted[kind] = true;
      continue;
    }
    out += raw.slice(cursor, match.index) + ' ';
    cursor = close.index + close[0].length;
    open.lastIndex = cursor;
  }
  return cursor === 0 ? raw : out + raw.slice(cursor);
}

/**
 * Replace each tag with a space. Equivalent to `.replace(/<[^>]+>/g, ' ')`
 * (so `<>` is not a tag), but linear: the regex rescans to the end of the
 * input from every `<` that has no `>` after it.
 */
function stripTags(raw: string): string {
  let out = '';
  let cursor = 0;
  let start = raw.indexOf('<');
  while (start !== -1) {
    const end = raw.indexOf('>', start + 1);
    if (end === -1) break; // no `>` left, so no later tag can complete either
    if (end === start + 1) {
      start = raw.indexOf('<', end);
      continue;
    }
    out += raw.slice(cursor, start) + ' ';
    cursor = end + 1;
    start = raw.indexOf('<', cursor);
  }
  return cursor === 0 ? raw : out + raw.slice(cursor);
}

/**
 * Strip `<style>`/`<script>` blocks and tags, decode the HTML entities
 * Discovery's emails use, and collapse whitespace — so `"R&nbsp;1,120.00"`
 * becomes `"R 1,120.00"` and the amount patterns (which expect a literal space
 * after `R`) match.
 *
 * {@link parseEmail} calls this itself; it is exported so callers can store the
 * same normalised text they parsed. Idempotent — running it on already
 * normalised text is a no-op.
 */
export function normalizeEmailText(raw: string): string {
  return stripTags(stripStyleAndScriptBlocks(raw))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    // Last, so an escaped entity like `&amp;lt;` decodes to `&lt;`, not `<`.
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The labels Discovery puts at the head of a transaction line. The label that
 * occurs *earliest* in the body decides the type. Longer labels are listed
 * first so that, at the same position, "Card payment reversal" beats "Card
 * payment". "Forex transfer" and "Incoming payment" need no such care: they
 * start before the bare "Transfer" / "Payment" they contain.
 */
const LABEL_RE =
  /\b(?:Card\s+payment\s+reversal|Card\s+payment|Cash\s+deposit|Discovery\s+Pay|Incoming\s+payment|ATM\s+withdrawal|Debit\s+order|Forex\s+transfer|Transfer|Payment)\b/i;

/**
 * Normalised (lower-case, single-spaced) label -> type. "cash deposit" is
 * absent on purpose: it only counts as a card refund when the body has a card
 * line, which `parseEmail` checks.
 */
const LABEL_TYPES: Readonly<Record<string, TransactionType>> = {
  'card payment reversal': 'card_reversal',
  'card payment': 'card_payment',
  // Discovery Pay is a person-to-person send. It's a payment in every respect
  // the model cares about, so it shares the 'payment' type rather than adding
  // one.
  'discovery pay': 'payment',
  'incoming payment': 'incoming_payment',
  'atm withdrawal': 'atm_withdrawal',
  'debit order': 'debit_order',
  'forex transfer': 'forex_transfer',
  'transfer': 'transfer',
  'payment': 'payment',
};

/** Currency for a forex amount's symbol, used when the email has no rate line. */
const FOREX_SYMBOL_CURRENCY: Readonly<Record<string, string>> = {
  '£': 'GBP',
  '$': 'USD',
  '€': 'EUR',
};

/**
 * The last match of a global `re` in `text`. Free-text fields (reference,
 * merchant) sit in front of the bank's own date, balance and card lines, so
 * where a value can appear more than once the last occurrence is the bank's.
 */
function lastMatch(re: RegExp, text: string): RegExpExecArray | undefined {
  let last: RegExpExecArray | undefined;
  for (const match of text.matchAll(re)) last = match;
  return last;
}

// "Card payment [reversal] ", or the "Cash deposit " label of a card refund.
const CARD_LINE_LABEL = /^(?:Card\s+payment\s+reversal|Card\s+payment|Cash\s+deposit)\s+/i;
const ATM_LINE_LABEL = /^ATM\s+withdrawal\s+/i;

// " – R 388.00". Currency is R or ZAR for local transactions, 3-letter ISO code
// for foreign. [–—-] covers en-dash, em-dash, and hyphen-minus.
const CARD_AMOUNT = /\s+[–—-]\s+(R|ZAR|[A-Z]{3})\s*([\d,]+\.\d{2})/gi;

// " - R 990.00" on an ATM withdrawal, which is a hyphen-minus without the
// mandatory spaces and ZAR only.
const ATM_AMOUNT = /\s*[-–—]\s*(R)\s*([\d,]+\.\d{2})/gi;

// What the bank prints straight after the amount: the account, the card, or
// the date. Sticky, so it is only tested at one position.
const AMOUNT_FOLLOWER =
  /\s+(?:From\b|To\b|Card\s+ending\b|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,)/iy;

interface DescribedAmount {
  /** The text between the label and the amount: merchant or ATM location. */
  description: string;
  currency: string;
  amount: number;
  /** Offset in the searched text just past the amount. */
  end: number;
}

/**
 * Read "DESCRIPTION – CURRENCY AMOUNT" from text that starts at `labelRe`'s
 * label. The description is merchant-controlled and may itself contain
 * " – R 1.00", so prefer an amount the bank follows with `From`, `To`,
 * `Card ending` or the date, and the last such one, since the description comes
 * first. If none is followed that way, use the first amount.
 */
function findDescribedAmount(
  rest: string,
  labelRe: RegExp,
  amountRe: RegExp
): DescribedAmount | null {
  const label = labelRe.exec(rest);
  if (!label) return null;
  const body = rest.slice(label[0].length);

  let first: RegExpExecArray | undefined;
  let preferred: RegExpExecArray | undefined;
  for (const match of body.matchAll(amountRe)) {
    first ??= match;
    AMOUNT_FOLLOWER.lastIndex = match.index + match[0].length;
    if (AMOUNT_FOLLOWER.test(body)) preferred = match;
  }
  const chosen = preferred ?? first;
  if (!chosen) return null;

  // These emails have no "Reference:" line. One in the description means a
  // different kind of email (e.g. a real cash deposit) is being read as a card
  // line, with its payer-controlled reference supplying the amount.
  const description = body.slice(0, chosen.index).trim();
  if (!description || /Reference:/i.test(description)) return null;

  return {
    description,
    currency: chosen[1].toUpperCase(),
    amount: parseAmount(chosen[2]),
    end: label[0].length + chosen.index + chosen[0].length,
  };
}

/**
 * Parse the text or HTML body of a Discovery Bank transaction notification.
 *
 * Returns `null` for anything that isn't a transaction notification — OTPs,
 * marketing, statements — and for transaction emails whose amount or date can't
 * be read. Callers should treat `null` as "not a transaction", not as an error.
 *
 * The `Reference:` line and a card's merchant text are free text written by
 * other people, so they only ever become `description`. The type, amount, date,
 * balance and accounts come from the bank's own text around them.
 *
 * @param rawText Email body, text or HTML. Normalised internally.
 * @param options Receipt time for year inference, or a `Date`/ISO string
 *   shorthand for `{ receivedAt }`.
 */
export function parseEmail(
  rawText: string,
  options?: ParseOptions | Date | string
): ParsedTransaction | null {
  const opts: ParseOptions =
    options instanceof Date || typeof options === 'string'
      ? { receivedAt: options }
      : options ?? {};

  const text = normalizeEmailText(rawText);
  const anchor = dateAnchor(opts.receivedAt);
  const accountNames = (opts.accountNames ?? DEFAULT_ACCOUNT_NAMES)
    .map(escapeRegExp)
    .join('|');

  // ── Detect transaction type ───────────────────────────────────────────────
  // The bank's own label is the first thing in the transaction line; every
  // free-text field it echoes back (reference, merchant) comes after it. So the
  // type is whichever label occurs earliest, not whichever keyword ranks
  // highest, and every amount below is read from the text that follows *that*
  // label occurrence.
  const labelMatch = LABEL_RE.exec(text);
  if (!labelMatch) return null;
  const rest = text.slice(labelMatch.index);

  const label = labelMatch[0].toLowerCase().replace(/\s+/g, ' ');
  let type: TransactionType | null;
  if (label === 'cash deposit') {
    // Discovery labels a card refund "Cash deposit", but the body has card-payment
    // shape: "MERCHANT – CURRENCY AMOUNT", "To Credit Card", "Card ending". Match
    // on that shape, not the label alone, and treat it as a reversal so the refund
    // nets against the original spend instead of being booked as income. A literal
    // cash deposit (no card, no merchant) has no such line and stays unhandled.
    type = /\bCard\s+ending\b/i.test(rest) ? 'card_reversal' : null;
  } else {
    type = LABEL_TYPES[label] ?? null;
  }
  if (!type) return null;

  // ── Common fields ─────────────────────────────────────────────────────────

  // Date: "Friday, 5 June at 17:42". Free-text fields (reference, merchant) come
  // before the bank's own date line, so the last date in the body is the bank's.
  const dateMatch = lastMatch(
    /\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,\s+\d{1,2}\s+\w+\s+at\s+\d{2}:\d{2})\b/gi,
    text
  );
  const transactedAt = dateMatch ? parseDate(dateMatch[1], anchor) : null;
  if (!dateMatch || !transactedAt) return null;

  // Available balance — Discovery sometimes omits the space: "R37,083.18".
  // Likewise the last one is the bank's. It follows the date line, so ignore
  // anything before it: some emails (e.g. foreign card payments) carry no
  // balance, and a balance inside the merchant text must not stand in for it.
  const balanceMatch = lastMatch(
    /Available\s+balance:\s*R\s*([\d,]+\.\d{2})/gi,
    text.slice(dateMatch.index + dateMatch[0].length)
  );
  const balanceAfter = balanceMatch ? parseAmount(balanceMatch[1]) : undefined;

  // Reference line
  const refMatch = text.match(/Reference:\s+(.+?)(?=\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,|\s+Available\s+balance|$)/i);
  const reference = refMatch ? refMatch[1].trim() : undefined;

  // Account references. The bank prints the accounts after the amount and
  // before any "Reference:", so look only there: an account name inside the
  // reference or the merchant text must not become the transaction's account.
  // `offset` is where the amount ends in `rest`.
  const accountsAfter = (offset: number) => {
    let scope = rest.slice(offset);
    const referenceAt = scope.search(/Reference:/i);
    if (referenceAt !== -1) scope = scope.slice(0, referenceAt);

    const fromEndingMatch = scope.match(/From\s+account\s+ending\s+(\*+\d{4})/i);
    const toEndingMatch   = scope.match(/To\s+account\s+ending\s+(\*+\d{4})/i);
    const fromNameMatch = accountNames ? scope.match(new RegExp(`From\\s+(${accountNames})`, 'i')) : null;
    const toNameMatch   = accountNames ? scope.match(new RegExp(`To\\s+(${accountNames})`, 'i')) : null;

    const fromAccountRaw = fromEndingMatch
      ? `account ending ${fromEndingMatch[1]}`
      : (fromNameMatch?.[1] ?? undefined);

    const toAccountRaw = toEndingMatch
      ? `account ending ${toEndingMatch[1]}`
      : (toNameMatch?.[1] ?? undefined);

    return { fromAccountRaw, toAccountRaw };
  };

  // ── Type-specific parsing ─────────────────────────────────────────────────
  // Each pattern is anchored (`^`) to `rest`, which starts at the detected
  // label, so `Payment R…` can no longer match inside `Incoming payment R…`.

  switch (type) {
    case 'card_payment':
    case 'card_reversal': {
      const isReversal = type === 'card_reversal';
      const direction  = isReversal ? 'credit' : 'debit';

      // "Card payment [reversal] MERCHANT – CURRENCY AMOUNT", or the same line
      // under Discovery's "Cash deposit" refund label.
      const cardLine = findDescribedAmount(rest, CARD_LINE_LABEL, CARD_AMOUNT);
      if (!cardLine) return null;
      const { description: merchant, currency, amount: parsedAmt } = cardLine;
      const { fromAccountRaw, toAccountRaw } = accountsAfter(cardLine.end);

      // "Card ending ***1234" on card payments, "Card ending: ***1234" on
      // refunds. It follows the amount, so take the last one: the merchant
      // descriptor in front of the amount is merchant-controlled text.
      const cardMatch = lastMatch(/Card\s+ending:?\s+\*+(\d{4})/gi, rest);

      // Card account: card ending takes priority, fall back to named account
      const cardRaw = cardMatch
        ? `account ending ***${cardMatch[1]}`
        : (isReversal ? toAccountRaw : fromAccountRaw);

      if (currency === 'R' || currency === 'ZAR') {
        return {
          type, direction,
          amount: parsedAmt,
          description: merchant,
          fromAccountRaw: isReversal ? undefined : cardRaw,
          toAccountRaw:   isReversal ? cardRaw   : undefined,
          balanceAfter,
          transactedAt,
        };
      }

      // Foreign currency — the ZAR equivalent is not shown in the email, so the
      // caller has to convert (or wait for the statement) to fill `amount`.
      return {
        type, direction,
        amount: 0,
        foreignAmount:    parsedAmt,
        foreignCurrency:  currency,
        description:      merchant,
        fromAccountRaw: isReversal ? undefined : cardRaw,
        toAccountRaw:   isReversal ? cardRaw   : undefined,
        balanceAfter,
        transactedAt,
      };
    }

    case 'atm_withdrawal': {
      // "ATM withdrawal At OR Tambo Branch Kempton P - R 990.00"
      // Uses a hyphen-minus, not an em-dash
      const atmLine = findDescribedAmount(rest, ATM_LINE_LABEL, ATM_AMOUNT);
      if (!atmLine) return null;
      const { fromAccountRaw } = accountsAfter(atmLine.end);
      return {
        type,
        direction: 'debit',
        amount: atmLine.amount,
        description: atmLine.description,
        fromAccountRaw,
        balanceAfter,
        transactedAt,
      };
    }

    case 'incoming_payment': {
      const match = rest.match(/^Incoming\s+payment\s+(?:R|ZAR)\s*([\d,]+\.\d{2})/i);
      if (!match) return null;
      const { toAccountRaw } = accountsAfter(match[0].length);
      return {
        type, direction: 'credit', amount: parseAmount(match[1]),
        description: reference, toAccountRaw, balanceAfter, transactedAt,
      };
    }

    case 'payment': {
      // "Payment R 300.00 From Demand Savings Reference: Parking", or
      // "Discovery Pay R 2.50 To Bob Smith From account ending ***1234".
      const match = rest.match(/^(?:Discovery\s+Pay|Payment)\s+(?:R|ZAR)\s*([\d,]+\.\d{2})/i);
      if (!match) return null;
      const { fromAccountRaw } = accountsAfter(match[0].length);

      // Only Discovery Pay names the payee. Prefer it over the free-text
      // reference: it's the counterparty, so money sent to someone lands on the
      // same person as money received from them, where a chatty reference would
      // group with nothing.
      const payeeMatch = rest.match(
        /^Discovery\s+Pay\s+(?:R|ZAR)\s*[\d,]+\.\d{2}\s+To\s+(.+?)\s+(?:From\b|Reference:)/i
      );

      return {
        type, direction: 'debit', amount: parseAmount(match[1]),
        description: payeeMatch?.[1].trim() ?? reference,
        fromAccountRaw, balanceAfter, transactedAt,
      };
    }

    case 'debit_order': {
      const match = rest.match(/^Debit\s+order\s+(?:R|ZAR)\s*([\d,]+\.\d{2})/i);
      if (!match) return null;
      const { fromAccountRaw } = accountsAfter(match[0].length);
      return {
        type, direction: 'debit', amount: parseAmount(match[1]),
        description: reference, fromAccountRaw, balanceAfter, transactedAt,
      };
    }

    case 'forex_transfer': {
      // "Forex transfer R 3,296.84 to £ 149.04"
      const forexMatch = rest.match(/^Forex\s+transfer\s+R\s*([\d,]+\.\d{2})\s+to\s+([£$€])\s*([\d,]+\.\d{2})/i);
      if (!forexMatch) return null;
      const { fromAccountRaw, toAccountRaw } = accountsAfter(forexMatch[0].length);
      const rateMatch  = rest.match(/Exchange\s+Rate\s+1\s+(\w+)\s*=\s*([\d.]+)\s+ZAR/i);

      // The rate line names the foreign currency ("1 AUD = 18.75 ZAR"); `$` alone
      // could be USD, AUD, CAD… Use the symbol only when there is no rate line.
      const rateCurrency = rateMatch && /^[A-Za-z]{3}$/.test(rateMatch[1])
        ? rateMatch[1].toUpperCase()
        : undefined;

      return {
        type, direction: 'debit',
        amount: parseAmount(forexMatch[1]),
        foreignAmount: parseAmount(forexMatch[3]),
        foreignCurrency: rateCurrency ?? FOREX_SYMBOL_CURRENCY[forexMatch[2]],
        exchangeRate: rateMatch ? parseFloat(rateMatch[2]) : undefined,
        fromAccountRaw,
        toAccountRaw,
        transactedAt,
      };
    }

    case 'transfer': {
      const match = rest.match(/^Transfer\s+(?:R|ZAR)\s*([\d,]+\.\d{2})/i);
      if (!match) return null;
      const { fromAccountRaw, toAccountRaw } = accountsAfter(match[0].length);
      return {
        type, direction: 'debit', amount: parseAmount(match[1]),
        fromAccountRaw, toAccountRaw, transactedAt,
      };
    }

    default:
      return null;
  }
}
