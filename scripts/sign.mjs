// minisign signatures (algorithm "ED": Ed25519 over the file's BLAKE2b-512 hash), written with
// Node's crypto so CI needs no minisign binary. Verify with `minisign -Vm <file> -P <public key>`
// or the `minisign-verify` crate.
//
// Secret key format (CATALOG_SIGNING_KEY): base64(keynum[8] || ed25519 seed[32]). Generate a pair with
//   node scripts/sign.mjs --keygen <dir>     -> <dir>/catalog-minisign.key, <dir>/catalog-minisign.pub
// Sign files (writes <file>.minisig next to each):
//   CATALOG_SIGNING_KEY=… node scripts/sign.mjs <file>...
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// DER prefixes that wrap a raw 32-byte Ed25519 seed / public key for Node's KeyObject.
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const keyId = (keynum) => Buffer.from(keynum).reverse().toString("hex").toUpperCase();

/** Parses CATALOG_SIGNING_KEY. */
export function parseSecretKey(text) {
  const raw = Buffer.from(text.trim(), "base64");
  if (raw.length !== 40) throw new Error("signing key must be base64 of 40 bytes (keynum + seed)");
  const keynum = raw.subarray(0, 8);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw.subarray(8)]), format: "der", type: "pkcs8" });
  return { keynum, privateKey };
}

/** The minisign public key line (base64) for a secret key. */
export function publicKeyOf({ keynum, privateKey }) {
  const pk = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32);
  return Buffer.concat([Buffer.from("Ed"), keynum, pk]).toString("base64");
}

/** A .minisig for `data`. */
export function signBytes(data, key, trustedComment) {
  const hash = createHash("blake2b512").update(data).digest();
  const sig = sign(null, hash, key.privateKey);
  const globalSig = sign(null, Buffer.concat([sig, Buffer.from(trustedComment)]), key.privateKey);
  return [
    `untrusted comment: signature from KnobDeck catalog key ${keyId(key.keynum)}`,
    Buffer.concat([Buffer.from("ED"), key.keynum, sig]).toString("base64"),
    `trusted comment: ${trustedComment}`,
    globalSig.toString("base64"),
    "",
  ].join("\n");
}

/** Checks a .minisig against a public key line; returns the trusted comment or throws. */
export function verifyBytes(data, minisig, publicKeyB64) {
  const pub = Buffer.from(publicKeyB64.trim(), "base64");
  const lines = minisig.split("\n");
  const sigLine = Buffer.from(lines[1], "base64");
  const trusted = lines[2].replace(/^trusted comment: /, "");
  const globalSig = Buffer.from(lines[3], "base64");
  if (sigLine.subarray(0, 2).toString() !== "ED") throw new Error("not a prehashed (ED) signature");
  if (!sigLine.subarray(2, 10).equals(pub.subarray(2, 10))) throw new Error("signed with another key");
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub.subarray(10)]), format: "der", type: "spki" });
  const sig = sigLine.subarray(10);
  const hash = createHash("blake2b512").update(data).digest();
  if (!verify(null, hash, key, sig)) throw new Error("bad signature");
  if (!verify(null, Buffer.concat([sig, Buffer.from(trusted)]), key, globalSig)) throw new Error("bad trusted comment signature");
  return trusted;
}

/** Writes <file>.minisig for each file. */
export function signFiles(files, keyText, now = Math.floor(Date.now() / 1000)) {
  const key = parseSecretKey(keyText);
  for (const file of files) {
    writeFileSync(`${file}.minisig`, signBytes(readFileSync(file), key, `timestamp:${now}\tfile:${basename(file)}`));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--keygen") {
    const dir = args[1] ?? ".";
    const { privateKey } = generateKeyPairSync("ed25519");
    const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
    const keynum = randomBytes(8);
    writeFileSync(join(dir, "catalog-minisign.key"), Buffer.concat([keynum, seed]).toString("base64") + "\n", { mode: 0o600 });
    const pub = publicKeyOf({ keynum, privateKey });
    writeFileSync(join(dir, "catalog-minisign.pub"), `untrusted comment: minisign public key ${keyId(keynum)}\n${pub}\n`);
    console.log(pub);
  } else {
    const keyText = process.env.CATALOG_SIGNING_KEY;
    if (!keyText) throw new Error("CATALOG_SIGNING_KEY is not set");
    signFiles(args, keyText);
  }
}
