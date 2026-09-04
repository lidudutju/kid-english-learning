#!/usr/bin/env node
/**
 * Generates the app password and the hash to store as a Worker secret.
 *
 * The password is generated rather than chosen because the KDF is deliberately weak —
 * see docs/adr/0003. Do not replace the output with something memorable.
 */
import { randomBytes, pbkdf2Sync } from "node:crypto";

// Crockford-ish base32 minus the characters that get misread when typed on a phone.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const GROUPS = 5;
const PER_GROUP = 4;
const ITERATIONS = 1000;

function generate() {
  const total = GROUPS * PER_GROUP;
  const bytes = randomBytes(total * 2);
  let chars = "";
  for (let i = 0; i < total; i++) {
    // Rejection-free enough: 65536 % 31 bias is ~0.05%, immaterial next to 97 bits.
    chars += ALPHABET[bytes.readUInt16BE(i * 2) % ALPHABET.length];
  }
  return chars.match(new RegExp(`.{${PER_GROUP}}`, "g")).join("-");
}

const args = process.argv.slice(2);
const apply = args.includes("--set");
const password = args.find((a) => !a.startsWith("--")) ?? generate();
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
const stored = `pbkdf2$sha256$${ITERATIONS}$${salt.toString("hex")}$${hash.toString("hex")}`;

const bits = Math.log2(ALPHABET.length) * GROUPS * PER_GROUP;

console.log(`
Password (save this in your password manager — it is not recoverable):

    ${password}

Entropy: ~${bits.toFixed(0)} bits
`);

if (!apply) {
  console.log(`Store the hash as a Worker secret:

    cd apps/worker && npx wrangler secret put APP_PASSWORD_HASH
    # paste:
    ${stored}

For local development, put this line in apps/worker/.dev.vars:

    APP_PASSWORD_HASH=${stored}

(Or re-run with --set to push the hash to the Worker without printing it.)
`);
  process.exit(0);
}

// --set exists so the password can be read off a screen while the hash goes straight to
// Cloudflare. Nothing is written to disk and the hash is never printed, so a shared terminal
// transcript does not leak the one value worth protecting.
const { spawnSync } = await import("node:child_process");
const { dirname, resolve } = await import("node:path");
const { fileURLToPath } = await import("node:url");

const worker = resolve(dirname(fileURLToPath(import.meta.url)), "..", "apps", "worker");
const result = spawnSync("npx", ["wrangler", "secret", "put", "APP_PASSWORD_HASH"], {
  cwd: worker,
  input: stored,
  stdio: ["pipe", "inherit", "inherit"],
});

if (result.status !== 0) {
  console.error("\nFailed to set the secret. The password above is therefore NOT in use yet.");
  process.exit(1);
}
console.log("APP_PASSWORD_HASH updated on the Worker. The password above is now the live one.");
