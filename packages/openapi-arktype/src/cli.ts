#!/usr/bin/env node

import { parseArgs } from "node:util";
import { generate } from "./codegen/index.js";

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: "string", short: "i" },
      output: { type: "string", short: "o" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  const showHelp = values.help || (!values.input && !values.output);
  if (showHelp) {
    const usage = `Usage: openapi-arktype generate -i <spec> -o <outdir>

Options:
  -i, --input   Path or URL to OpenAPI spec (JSON or YAML)
  -o, --output  Output directory for generated TypeScript files
  -h, --help    Show this help message`;

    if (values.help) {
      console.log(usage);
      process.exit(0);
    }
    console.error(usage);
    process.exit(1);
  }

  if (!values.input) {
    console.error("Error: --input is required");
    process.exit(1);
  }

  if (!values.output) {
    console.error("Error: --output is required");
    process.exit(1);
  }

  const isUrl =
    values.input.startsWith("http://") || values.input.startsWith("https://");

  const result = await generate({
    ...(isUrl ? { url: values.input } : { path: values.input }),
    outDir: values.output,
  });

  for (const diag of result.diagnostics) {
    const prefix = diag.level === "warn" ? "WARN" : "INFO";
    console.error(`[${prefix}] ${diag.path.join("/")}: ${diag.message}`);
  }

  console.log(`Generated ${result.files.length} files:`);
  for (const file of result.files) {
    console.log(`  ${file}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
