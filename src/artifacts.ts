import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ArtifactMetadata {
  name: string;
  path: string;
  sha256: string;
  bytes: number;
  media_type: string;
  stage: string;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function writePrivateArtifact(
  runDirectory: string,
  name: string,
  value: string | Buffer,
  mediaType: string,
  stage: string,
): Promise<ArtifactMetadata> {
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  await chmod(runDirectory, 0o700);
  const target = path.join(runDirectory, name);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return {
    name,
    path: target,
    sha256: sha256(buffer),
    bytes: buffer.byteLength,
    media_type: mediaType,
    stage,
  };
}

export async function writeJsonArtifact(
  runDirectory: string,
  name: string,
  value: unknown,
  stage: string,
): Promise<ArtifactMetadata> {
  return writePrivateArtifact(
    runDirectory,
    name,
    `${JSON.stringify(value, null, 2)}\n`,
    "application/json",
    stage,
  );
}

export async function metadataForExistingArtifact(
  file: string,
  name: string,
  mediaType: string,
  stage: string,
): Promise<ArtifactMetadata> {
  const value = await readFile(file);
  await chmod(file, 0o600);
  return {
    name,
    path: file,
    sha256: sha256(value),
    bytes: value.byteLength,
    media_type: mediaType,
    stage,
  };
}
