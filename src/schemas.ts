import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import taskPacketSchema from "../schemas/task-packet.schema.json" with { type: "json" };
import implementationResultSchema from "../schemas/implementation-result.schema.json" with { type: "json" };
import verificationResultSchema from "../schemas/verification-result.schema.json" with { type: "json" };
import reviewResultSchema from "../schemas/review-result.schema.json" with { type: "json" };
import runManifestSchema from "../schemas/run-manifest.schema.json" with { type: "json" };
import { EXIT_CODES, ProvenWayError } from "./errors.js";
import type {
  ImplementationResult,
  ReviewResult,
  RunManifest,
  TaskPacket,
  VerificationResult,
} from "./generated/index.js";

export type { ImplementationResult, ReviewResult, RunManifest, TaskPacket, VerificationResult };

const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => void;
addFormats(ajv);

export const validators: {
  taskPacket: ValidateFunction<TaskPacket>;
  implementationResult: ValidateFunction<ImplementationResult>;
  verificationResult: ValidateFunction<VerificationResult>;
  reviewResult: ValidateFunction<ReviewResult>;
  runManifest: ValidateFunction<RunManifest>;
} = {
  taskPacket: ajv.compile<TaskPacket>(taskPacketSchema),
  implementationResult: ajv.compile<ImplementationResult>(implementationResultSchema),
  verificationResult: ajv.compile<VerificationResult>(verificationResultSchema),
  reviewResult: ajv.compile<ReviewResult>(reviewResultSchema),
  runManifest: ajv.compile<RunManifest>(runManifestSchema),
};

export function validateOrThrow<T>(
  validator: ValidateFunction<T>,
  value: unknown,
  label: string,
): T {
  if (validator(value)) return value;
  throw new ProvenWayError(
    `Invalid ${label}: ${formatAjvErrors(validator.errors)}`,
    EXIT_CODES.provider,
    "INVALID_STRUCTURED_OUTPUT",
    validator.errors,
  );
}

export function parseJsonOutput<T>(
  validator: ValidateFunction<T>,
  value: string,
  label: string,
): T {
  try {
    return validateOrThrow(validator, JSON.parse(stripCodeFence(value)) as unknown, label);
  } catch (error) {
    if (error instanceof ProvenWayError) throw error;
    throw new ProvenWayError(
      `Invalid JSON for ${label}: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.provider,
      "INVALID_STRUCTURED_OUTPUT",
    );
  }
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return "unknown validation error";
  return errors
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
    .join("; ");
}
