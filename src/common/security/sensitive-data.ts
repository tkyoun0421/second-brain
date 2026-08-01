import { ApiError } from "#app/common/errors/errors.js";

interface SensitiveMatch {
  path: string;
  reason: string;
  rule_id: string;
}

const rules: Array<{ reason: string; ruleId: string; expression: RegExp }> = [
  { reason: "private_key", ruleId: "credential.private_key.v1", expression: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/i },
  { reason: "access_token", ruleId: "credential.github_token.v1", expression: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { reason: "access_token", ruleId: "credential.bearer_token.v1", expression: /\b(?:sk|xox)[-_][A-Za-z0-9-]{16,}\b/i },
  { reason: "password_or_connection_string", ruleId: "credential.connection_string.v1", expression: /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]+@/i },
  { reason: "jwt", ruleId: "credential.jwt.v1", expression: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { reason: "env_file_content", ruleId: "credential.env_assignment.v1", expression: /(?:^|\n)\s*(?:[A-Z][A-Z0-9_]*?(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY))\s*=\s*[^\s]+/m },
];

const collectMatches = (value: unknown, path: string, matches: SensitiveMatch[]) => {
  if (typeof value === "string") {
    for (const rule of rules) {
      if (rule.expression.test(value)) {
        matches.push({ path, reason: rule.reason, rule_id: rule.ruleId });
        return;
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectMatches(item, `${path}/${index}`, matches));
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      collectMatches(nested, `${path}/${key}`, matches);
    }
  }
};

export const rejectSensitiveData = (value: unknown): void => {
  const matches: SensitiveMatch[] = [];
  collectMatches(value, "", matches);
  if (matches.length > 0) {
    throw new ApiError({
      statusCode: 422,
      code: "SENSITIVE_DATA_DETECTED",
      message: "저장할 수 없는 민감정보 패턴이 발견되었습니다.",
      details: matches.map((match) => ({
        path: match.path,
        reason: match.reason,
        rule_id: match.rule_id,
      })),
    });
  }
};
