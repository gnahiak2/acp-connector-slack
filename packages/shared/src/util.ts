import { randomBytes, randomUUID } from "node:crypto";

const TOKEN_PATTERNS = [
  /xox[abposr]-[A-Za-z0-9-]{10,}/g,
  /xapp-[A-Za-z0-9-]{10,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const redactText = (value: string, secrets: readonly string[] = []): string => {
  let result = value;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    result = result.split(secret).join("[REDACTED]");
  }
  for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  return result;
};

export const redactObject = <T>(value: T, secrets: readonly string[] = []): T => {
  const seen = new WeakSet<object>();
  const walk = (input: unknown, depth: number): unknown => {
    if (depth > 12) return "[TRUNCATED]";
    if (typeof input === "string") return redactText(input, secrets);
    if (Array.isArray(input)) return input.map((item) => walk(item, depth + 1));
    if (input && typeof input === "object") {
      if (seen.has(input)) return "[CIRCULAR]";
      seen.add(input);
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input)) {
        if (/token|secret|password|authorization|privatekey|cookie/i.test(key)) {
          output[key] = "[REDACTED]";
        } else {
          output[key] = walk(item, depth + 1);
        }
      }
      return output;
    }
    return input;
  };
  return walk(value, 0) as T;
};

export const truncateUtf8 = (value: string, maxBytes: number): { text: string; truncated: boolean } => {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return { text: value, truncated: false };
  let end = Math.max(0, maxBytes);
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
};

export const newId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll("-", "")}`;
export const newApprovalId = (): string => `apr_${randomBytes(9).toString("hex")}`;
export const newToken = (): string => randomBytes(32).toString("base64url");
export const isoNow = (): string => new Date().toISOString();

export const preview = (value: string, limit = 180): string => {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
};
