/**
 * The credential vault for candidate accounts on employer ATS tenants.
 *
 * Workday and its kin require an account per employer tenant, so the arm creates
 * one using the user's managed applicant alias and a generated password. Neither
 * is ever shown to the user, and the password is encrypted here BEFORE it reaches
 * Postgres, so the `site_accounts` row (already service-role-only, deny-all RLS)
 * is not enough on its own to log in as anyone.
 *
 * Encryption is AES-256-GCM with the key in `SITE_ACCOUNT_ENC_KEY` (32 bytes,
 * hex). GCM is authenticated, so a tampered ciphertext fails to decrypt rather
 * than silently yielding garbage that we would then type into a login form.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomInt,
  timingSafeEqual
} from "node:crypto";
import { requireEnv } from "@/lib/env";

/** Envelope version prefix, so the format can change without ambiguity. */
const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM's standard nonce length
const KEY_BYTES = 32;

/**
 * The encryption key as raw bytes.
 *
 * Throws when unset or the wrong length: a short key silently weakening every
 * stored credential is far worse than a loud failure at the call site.
 */
function encryptionKey(): Buffer {
  const key = Buffer.from(requireEnv("SITE_ACCOUNT_ENC_KEY"), "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `SITE_ACCOUNT_ENC_KEY must be ${KEY_BYTES} bytes as hex (${KEY_BYTES * 2} chars)`
    );
  }
  return key;
}

/** Encrypt a password into the stored envelope. */
export function encryptPassword(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64")
  ].join(":");
}

/**
 * Decrypt a stored envelope. Throws on a malformed envelope, an unknown version,
 * or a failed authentication tag (tampering or the wrong key).
 */
export function decryptPassword(envelope: string): string {
  const parts = envelope.split(":");
  if (parts.length !== 4) throw new Error("site account credential is malformed");
  const [version, ivB64, tagB64, dataB64] = parts;
  if (version !== VERSION) throw new Error(`unsupported credential version: ${version}`);

  const decipher = createDecipheriv(
    ALGORITHM,
    encryptionKey(),
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final()
  ]).toString("utf8");
}

/**
 * Character classes for generated passwords. ATS password policies are strict and
 * mutually inconsistent, so a generated password deliberately includes at least
 * one of each class and uses only punctuation that form validators reliably
 * accept (no quotes, backslashes, angle brackets, or spaces).
 */
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^*()-_=+.?";
const PASSWORD_LENGTH = 20;

/**
 * A random password for one tenant account.
 *
 * `randomInt` is a CSPRNG with rejection sampling built in, so there is no
 * modulo bias. Each class is guaranteed present, then the remainder is filled
 * from the union and the whole thing is shuffled so the guaranteed characters do
 * not always land in the same positions.
 */
export function generatePassword(): string {
  const all = LOWER + UPPER + DIGITS + SYMBOLS;
  const chars = [
    LOWER[randomInt(LOWER.length)],
    UPPER[randomInt(UPPER.length)],
    DIGITS[randomInt(DIGITS.length)],
    SYMBOLS[randomInt(SYMBOLS.length)]
  ];
  while (chars.length < PASSWORD_LENGTH) chars.push(all[randomInt(all.length)]);

  // Fisher-Yates with a CSPRNG source.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export type SiteAccountStatus = "pending_verification" | "verified" | "locked";

export interface SiteAccount {
  tenantHost: string;
  email: string;
  password: string;
  status: SiteAccountStatus;
}

export interface SiteAccountRow {
  tenant_host: string;
  email: string;
  password_encrypted: string;
  status: SiteAccountStatus;
}

/**
 * The account for this user on this tenant, creating one if absent.
 *
 * Returns null when the account is LOCKED: a tenant that keeps rejecting our
 * credentials is a dead end, and re-trying it every run burns a browser slot for
 * nothing. The caller should fail the run with an honest reason instead.
 */
export async function ensureSiteAccount(
  service: SupabaseClient,
  args: { userId: string; tenantHost: string; ats: string; email: string }
): Promise<SiteAccount | null> {
  const tenantHost = args.tenantHost.toLowerCase();

  const { data: existing } = await service
    .from("site_accounts")
    .select("tenant_host, email, password_encrypted, status")
    .eq("user_id", args.userId)
    .eq("tenant_host", tenantHost)
    .maybeSingle();

  if (existing) {
    const row = existing as SiteAccountRow;
    if (row.status === "locked") return null;
    return {
      tenantHost: row.tenant_host,
      email: row.email,
      password: decryptPassword(row.password_encrypted),
      status: row.status
    };
  }

  const password = generatePassword();
  const { data: inserted } = await service
    .from("site_accounts")
    .insert({
      user_id: args.userId,
      tenant_host: tenantHost,
      ats: args.ats,
      email: args.email,
      password_encrypted: encryptPassword(password)
    })
    .select("tenant_host, email, password_encrypted, status")
    .maybeSingle();

  if (inserted) {
    const row = inserted as SiteAccountRow;
    return {
      tenantHost: row.tenant_host,
      email: row.email,
      // Decrypt what was stored rather than trusting `password`, so a broken
      // key surfaces here instead of at the login form.
      password: decryptPassword(row.password_encrypted),
      status: row.status
    };
  }

  // A concurrent dispatch won the unique (user_id, tenant_host) race: read the
  // row it created rather than creating a second account on the same tenant,
  // which is exactly how duplicate candidate profiles happen.
  const { data: raced } = await service
    .from("site_accounts")
    .select("tenant_host, email, password_encrypted, status")
    .eq("user_id", args.userId)
    .eq("tenant_host", tenantHost)
    .maybeSingle();
  if (!raced) return null;

  const row = raced as SiteAccountRow;
  if (row.status === "locked") return null;
  return {
    tenantHost: row.tenant_host,
    email: row.email,
    password: decryptPassword(row.password_encrypted),
    status: row.status
  };
}

/** Mark the tenant account verified. Idempotent (see the SQL function). */
export async function markSiteAccountVerified(
  service: SupabaseClient,
  userId: string,
  tenantHost: string
): Promise<boolean> {
  const { data } = await service.rpc("mark_site_account_verified", {
    p_user_id: userId,
    p_tenant_host: tenantHost.toLowerCase()
  });
  return data === true;
}

/**
 * Record a rejected login, returning the resulting status. The SQL function
 * locks the account once failures reach the ceiling.
 */
export async function recordSiteAccountFailure(
  service: SupabaseClient,
  userId: string,
  tenantHost: string
): Promise<SiteAccountStatus | null> {
  const { data } = await service.rpc("record_site_account_failure", {
    p_user_id: userId,
    p_tenant_host: tenantHost.toLowerCase()
  });
  return typeof data === "string" ? (data as SiteAccountStatus) : null;
}

/**
 * Constant-time comparison for the sidecar's shared bearer.
 *
 * Used instead of `===` so a token cannot be recovered a byte at a time by
 * timing the response. Length is compared first because timingSafeEqual throws
 * on differing lengths.
 */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
