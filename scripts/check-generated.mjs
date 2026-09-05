import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { compileFromFile } from "json-schema-to-typescript";

const schemaDir = path.resolve("schemas");
const outputDir = path.resolve("src/generated");
const files = (await readdir(schemaDir)).filter((file) => file.endsWith(".schema.json")).sort();
const expectedExports = [];
const stale = [];

for (const file of files) {
  const outputName = file.replace(".schema.json", ".ts");
  const expected = await compileFromFile(path.join(schemaDir, file), {
    bannerComment: "/* Generated from canonical JSON Schema. Do not edit. */",
    style: { singleQuote: false, semi: true, trailingComma: "all" },
  });
  const actual = await readFile(path.join(outputDir, outputName), "utf8").catch(() => "");
  if (actual !== expected) stale.push(outputName);
  expectedExports.push(`export * from "./${outputName.replace(".ts", ".js")}";`);
}

const expectedIndex = `${expectedExports.join("\n")}\n`;
const actualIndex = await readFile(path.join(outputDir, "index.ts"), "utf8").catch(() => "");
if (actualIndex !== expectedIndex) stale.push("index.ts");
if (stale.length) {
  process.stderr.write(
    `Generated schema types are stale: ${stale.join(", ")}\nRun pnpm generate.\n`,
  );
  process.exitCode = 1;
} else process.stdout.write("Generated schema types are current.\n");
