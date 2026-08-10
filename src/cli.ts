#!/usr/bin/env node
// Reads an email body (text or HTML) on stdin and prints the parsed
// transaction as JSON. Exits 1 when the email isn't a transaction notification.
//
//   cat notification.html | discovery-bank-email-parser
//   cat old.txt | discovery-bank-email-parser --received-at 2025-06-30T06:05:00Z
import { parseEmail, deriveFlow } from './parser.js';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'Usage: discovery-bank-email-parser [--received-at <ISO date>] < email.html\n\n' +
    'Reads a Discovery Bank notification email on stdin and prints the parsed\n' +
    'transaction as JSON. Exits 1 if the email is not a transaction notification.'
  );
  process.exit(0);
}

const receivedAtIndex = args.indexOf('--received-at');
const receivedAt = receivedAtIndex === -1 ? undefined : args[receivedAtIndex + 1];

if (receivedAtIndex !== -1 && (!receivedAt || Number.isNaN(new Date(receivedAt).getTime()))) {
  console.error('--received-at needs a valid ISO 8601 date');
  process.exit(2);
}

const body = await readStdin();
const tx = parseEmail(body, receivedAt);

if (!tx) {
  console.error('Not a recognised Discovery Bank transaction email.');
  process.exit(1);
}

console.log(JSON.stringify({ ...tx, flow: deriveFlow(tx.type, tx.direction) }, null, 2));
