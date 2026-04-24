#!/usr/bin/env node
/**
 * Reset (or initialise) the admin password.
 *
 * Usage:
 *   npm run reset-admin-password                # generates a random password
 *   npm run reset-admin-password -- mySecret    # sets the given password
 *
 * Prints the new password to stdout exactly once. The previous password is
 * irrecoverable after this runs (only the hash is stored).
 *
 * Safe to run on a live server — no schema changes, just an UPDATE on a
 * single row. If the admin user does not exist yet, it is created with
 * api_key = config.apiKey (same behaviour as the first-run seed).
 */
import { randomBytes } from 'crypto';
import { config } from '../config';
import { getDb, closeDb } from '../database/db';
import { userRepo } from '../database/repositories/userRepo';
import { hashPassword } from '../auth/password';

const ADMIN_USERNAME = 'admin';

function generatePassword(): string {
  return randomBytes(12).toString('base64url');
}

function main(): void {
  // Touch the DB so migrations run before we touch users.
  getDb();

  const provided = process.argv[2];
  const password = provided && provided.length >= 4 ? provided : generatePassword();
  if (provided && provided.length < 4) {
    console.error('Provided password is shorter than 4 characters — generating a random one instead.');
  }

  const hash = hashPassword(password);
  let user = userRepo.findByUsername(ADMIN_USERNAME);

  if (!user) {
    if (!config.apiKey) {
      console.error('API_KEY is empty in .env — cannot create admin without an api_key.');
      process.exit(1);
    }
    userRepo.create({
      username: ADMIN_USERNAME,
      password_hash: hash,
      api_key: config.apiKey,
      role: 'admin',
    });
    user = userRepo.findByUsername(ADMIN_USERNAME);
    console.log(`Created new admin user.`);
  } else {
    userRepo.updatePasswordHash(user.id, hash);
    console.log(`Updated password for existing admin user (id=${user.id}).`);
  }

  console.log('');
  console.log('============================================================');
  console.log(`  username: ${ADMIN_USERNAME}`);
  console.log(`  password: ${password}`);
  console.log('============================================================');
  console.log('Copy this password now — it will not be shown again.');

  closeDb();
}

main();
