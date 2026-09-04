/**
 * Proof that the hand-rolled streaming SHA-256 in packages/shared agrees with Node's.
 *
 * It exists because the browser has no streaming digest and this hash decides whether a Video
 * is a Duplicate — a subtly wrong implementation would silently let one through, or block a
 * file that is genuinely new. Run it after touching sha256.ts:
 *
 *   pnpm check:sha256
 */
import { createHash, randomBytes } from "node:crypto";
import { Sha256, sha256Hex } from "../packages/shared/src/sha256.js";

let failures = 0;

function check(label: string, actual: string, expected: string): void {
  if (actual === expected) return;
  failures++;
  console.error(`✗ ${label}\n  got      ${actual}\n  expected ${expected}`);
}

// Sizes chosen around the block boundary (64) and the padding boundary (56), plus the
// >2^32-bit length path a real video takes.
const sizes = [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 1000, 1024 * 1024 + 7];
for (const size of sizes) {
  const data = randomBytes(size);
  check(
    `one-shot ${size}B`,
    sha256Hex(new Uint8Array(data)),
    createHash("sha256").update(data).digest("hex"),
  );
}

// Fed in uneven pieces, the way a File read 8 MiB at a time arrives.
for (const chunkSize of [1, 7, 64, 100, 4096]) {
  const data = randomBytes(300_000);
  const hasher = new Sha256();
  for (let i = 0; i < data.length; i += chunkSize) {
    hasher.update(new Uint8Array(data.subarray(i, i + chunkSize)));
  }
  check(
    `streamed in ${chunkSize}B chunks`,
    hasher.digestHex(),
    createHash("sha256").update(data).digest("hex"),
  );
}

check(
  "empty",
  sha256Hex(new Uint8Array()),
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
);
check(
  "abc",
  sha256Hex(new TextEncoder().encode("abc")),
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
);

// A length past 512 MiB, where the bit count stops fitting in 32 bits. Streamed from a
// repeated block so it costs memory in the megabytes, not the hundreds.
{
  const block = randomBytes(1024 * 1024);
  const hasher = new Sha256();
  const node = createHash("sha256");
  for (let i = 0; i < 600; i++) {
    hasher.update(new Uint8Array(block));
    node.update(block);
  }
  check("600 MiB", hasher.digestHex(), node.digest("hex"));
}

if (failures > 0) {
  console.error(`\n${failures} 项不一致`);
  process.exit(1);
}
console.log("sha256 与 node:crypto 一致");
