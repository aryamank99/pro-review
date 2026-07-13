#!/usr/bin/env node

import { main } from "../src/pro-review/cli.mjs";

main(process.argv.slice(2)).catch((error) => {
  console.error(error?.message || String(error));
  if (error?.details) {
    console.error(JSON.stringify(error.details, null, 2));
  }
  process.exitCode = error?.exitCode || 1;
});
