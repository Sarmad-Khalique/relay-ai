const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/g,
  /\b(?:xox[baprs]|glpat)-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
];

const SECRET_NAME = /(?:_TOKEN|_KEY|_SECRET|_PASSWORD)$/i;

export function secretValuesFromEnvironment(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => SECRET_NAME.test(name) && Boolean(value))
    .map(([, value]) => value as string)
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length);
}

export function redact(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  for (const secret of secrets) redacted = redacted.split(secret).join("[REDACTED]");
  for (const pattern of TOKEN_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted;
}

export function sanitizedProviderEnvironment(
  env: NodeJS.ProcessEnv,
  allowPayg: boolean,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SECRET_NAME.test(name)) continue;
    sanitized[name] = value;
  }
  if (allowPayg) {
    for (const name of ["OPENAI_API_KEY", "CURSOR_API_KEY"]) {
      if (env[name]) sanitized[name] = env[name];
    }
  }
  return sanitized;
}
