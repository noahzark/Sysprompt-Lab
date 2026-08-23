import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { namedSchemas } from "./schemas.js";

const SCHEMA_ID_BASE = "https://sysprompt.lab/schemas";

export function jsonSchemaFor(name: keyof typeof namedSchemas): Record<string, unknown> {
  const schema = namedSchemas[name];
  const generated = zodToJsonSchema(schema, {
    name,
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as Record<string, unknown>;

  const definitions = generated.definitions as Record<string, unknown> | undefined;
  const defKey = definitions ? Object.keys(definitions)[0] : undefined;
  const body = defKey && definitions ? definitions[defKey] : generated;
  const objectBody = (body && typeof body === "object" ? body : generated) as Record<string, unknown>;
  const { $schema: _s, definitions: _d, $ref: _r, ...rest } = objectBody;

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: `${SCHEMA_ID_BASE}/${name}.json`,
    title: titleCase(name),
    ...rest,
  };
}

function titleCase(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function emitSchemas(outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const name of Object.keys(namedSchemas) as (keyof typeof namedSchemas)[]) {
    const path = join(outDir, `${name}.json`);
    writeFileSync(path, `${JSON.stringify(jsonSchemaFor(name), null, 2)}\n`, "utf8");
    written.push(path);
  }
  return written;
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, "..", "schemas");
  for (const path of emitSchemas(outDir)) {
    console.log(`wrote ${path}`);
  }
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked.endsWith("emit-schemas.ts") || invoked.endsWith("emit-schemas.js")) {
  main();
}
