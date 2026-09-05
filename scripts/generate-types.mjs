import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileFromFile } from "json-schema-to-typescript";

const schemaDir = path.resolve("schemas");
const outputDir = path.resolve("src/generated");
await mkdir(outputDir, { recursive: true });

const files = (await readdir(schemaDir)).filter((file) => file.endsWith(".schema.json")).sort();
const exports = [];
for (const file of files) {
  const outputName = file.replace(".schema.json", ".ts");
  const generated = await compileFromFile(path.join(schemaDir, file), {
    bannerComment: "/* Generated from canonical JSON Schema. Do not edit. */",
    style: { singleQuote: false, semi: true, trailingComma: "all" },
  });
  await writeFile(path.join(outputDir, outputName), generated, { mode: 0o600 });
  exports.push(`export * from "./${outputName.replace(".ts", ".js")}";`);
}
await writeFile(path.join(outputDir, "index.ts"), `${exports.join("\n")}\n`, { mode: 0o600 });
