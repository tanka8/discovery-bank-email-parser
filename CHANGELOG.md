# Changelog

## 1.2.0

### Fixed

- **Free text no longer influences the parsed transaction.** The `Reference:` line (written by whoever pays you) and the merchant text on card payments could change the transaction type, direction, amount, date, balance or account, because those were searched for across the whole email. They are now read from the bank's own text:
  - The type is the bank's label that occurs earliest in the email (at the same position the longer label wins, e.g. "Card payment reversal" over "Card payment"), and the amount is read from directly after that label.
  - The date and balance are the last ones in the email, and a balance is only accepted after the date.
  - Accounts are read from between the amount and the `Reference:` line.
  - On card and ATM lines the amount is the last one followed by `From`, `To`, `Card ending` or the date, and the last `Card ending` is used.
  - A "Cash deposit" whose `Reference:` precedes the amount is no longer read as a card refund.

  Emails that parsed correctly before parse the same way. An email that doesn't have the expected shape now returns `null` rather than a best guess.
- `normalizeEmailText` runs in linear time. Its `<style>` / `<script>` and tag patterns rescanned the rest of the input from every unclosed `<`, so a few hundred KB of `<style` took minutes. Output is unchanged.
- Forex transfers take `foreignCurrency` from the `Exchange Rate 1 XXX = … ZAR` line when it is present, instead of always reading `$` as `USD`. The symbol is still the fallback.

### Changed

- README: install from GitHub only. The package is not on the npm registry. The CLI examples use `npx github:tanka8/discovery-bank-email-parser`.
- Test fixtures and the README example use obviously synthetic balances.
- CI uses `actions/checkout@v7` and `actions/setup-node@v7`.
