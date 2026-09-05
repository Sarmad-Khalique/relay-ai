import * as prompts from "@clack/prompts";
import { EXIT_CODES, RelayError } from "./errors.js";

export interface RelayUi {
  readonly interactive: boolean;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  success(message: string): void;
  confirm(message: string, initialValue?: boolean): Promise<boolean>;
  input(message: string, placeholder?: string): Promise<string>;
  select(message: string, options: Array<{ value: string; label: string }>): Promise<string>;
}

export class ConsoleUi implements RelayUi {
  readonly interactive = process.stdin.isTTY && process.stdout.isTTY;

  info(message: string): void {
    prompts.log.info(message);
  }

  warn(message: string): void {
    prompts.log.warn(message);
  }

  error(message: string): void {
    prompts.log.error(message);
  }

  success(message: string): void {
    prompts.log.success(message);
  }

  async confirm(message: string, initialValue = false): Promise<boolean> {
    this.requireInteractive();
    const answer = await prompts.confirm({ message, initialValue });
    return unwrapPrompt(answer);
  }

  async input(message: string, placeholder?: string): Promise<string> {
    this.requireInteractive();
    const answer = await prompts.text({ message, ...(placeholder ? { placeholder } : {}) });
    return unwrapPrompt(answer).trim();
  }

  async select(message: string, options: Array<{ value: string; label: string }>): Promise<string> {
    this.requireInteractive();
    const answer = await prompts.select({ message, options });
    return unwrapPrompt(answer);
  }

  private requireInteractive(): void {
    if (!this.interactive) {
      throw new RelayError(
        "This operation requires an interactive terminal",
        EXIT_CODES.awaitingUser,
        "TTY_REQUIRED",
      );
    }
  }
}

function unwrapPrompt<T>(value: T | symbol): T {
  if (prompts.isCancel(value)) {
    throw new RelayError("Operation cancelled", EXIT_CODES.cancelled, "CANCELLED");
  }
  return value;
}
