// Generate a scrypt hash for the admin password.
// Usage: npm run hash-password -- "your-strong-password"
// Then put the output into ADMIN_PASSWORD_HASH in .env (and remove ADMIN_PASSWORD).
import { hashPassword } from '../src/auth.js';

const pw = process.argv[2];
if (!pw) {
  console.error('Usage: npm run hash-password -- "your-strong-password"');
  process.exit(1);
}
if (pw.length < 10) {
  console.error('Please choose a password of at least 10 characters.');
  process.exit(1);
}

console.log('\nAdd this to your .env:\n');
console.log(`ADMIN_PASSWORD_HASH=${hashPassword(pw)}\n`);
console.log('Then remove the plaintext ADMIN_PASSWORD line.\n');
