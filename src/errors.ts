export const EXIT_CODES = {
  accepted: 0,
  invalidInput: 2,
  environment: 3,
  provider: 4,
  verification: 5,
  review: 6,
  awaitingUser: 7,
  cancelled: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export class RelayError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, exitCode: ExitCode, code: string, details?: unknown) {
    super(message);
    this.name = "RelayError";
    this.exitCode = exitCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function asRelayError(error: unknown): RelayError {
  if (error instanceof RelayError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new RelayError(message, EXIT_CODES.provider, "UNEXPECTED_ERROR", error);
}
