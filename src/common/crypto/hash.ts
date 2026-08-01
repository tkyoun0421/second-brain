import { createHash } from "node:crypto";

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
};

export const canonicalJson = (value: unknown): string => JSON.stringify(stableValue(value));

export const sha256 = (value: string): string =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

export const hashRequest = (value: unknown): string => sha256(canonicalJson(value));
