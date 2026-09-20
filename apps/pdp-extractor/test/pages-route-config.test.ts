import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("Pages builds exclude server-only route discovery while normal BFF semantics stay dynamic", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      'import config from "./next.config.mjs"; import { dynamic } from "./src/app/api/rag-profile/route.ts"; process.stdout.write(JSON.stringify({ dynamic, pageExtensions: config.pageExtensions }));'
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        NEXT_PUBLIC_DEPLOY_TARGET: "github-pages"
      },
      encoding: "utf8"
    }
  );

  assert.deepEqual(JSON.parse(output), {
    dynamic: "force-dynamic",
    pageExtensions: ["tsx"]
  });
});
