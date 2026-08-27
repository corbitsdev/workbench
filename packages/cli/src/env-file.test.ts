import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { persistEnvVar, upsertEnvAssignment } from "./env-file";

describe("upsertEnvAssignment", () => {
  test("appends when the key is absent", () => {
    expect(
      upsertEnvAssignment(
        "BASE_URL=http://localhost:3000\n",
        "OPERATOR_TENANT_ID",
        "ten_1",
      ),
    ).toBe("BASE_URL=http://localhost:3000\nOPERATOR_TENANT_ID=ten_1\n");
  });

  test("replaces an existing assignment", () => {
    expect(
      upsertEnvAssignment(
        "OPERATOR_TENANT_ID=ten_old\nBASE_URL=x\n",
        "OPERATOR_TENANT_ID",
        "ten_1",
      ),
    ).toBe("OPERATOR_TENANT_ID=ten_1\nBASE_URL=x\n");
  });

  test("uncomments the example assignment rather than appending a second copy", () => {
    expect(
      upsertEnvAssignment(
        "# OPERATOR_TENANT_ID=\nBASE_URL=x\n",
        "OPERATOR_TENANT_ID",
        "ten_1",
      ),
    ).toBe("OPERATOR_TENANT_ID=ten_1\nBASE_URL=x\n");
  });

  test("prefers an uncommented assignment when a commented example is also present", () => {
    expect(
      upsertEnvAssignment(
        "# OPERATOR_TENANT_ID=\nOPERATOR_TENANT_ID=ten_old\n",
        "OPERATOR_TENANT_ID",
        "ten_1",
      ),
    ).toBe("# OPERATOR_TENANT_ID=\nOPERATOR_TENANT_ID=ten_1\n");
  });
});

describe("persistEnvVar", () => {
  test("creates the file when it is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workbench-env-"));
    const envPath = join(dir, ".env");
    await persistEnvVar(envPath, "OPERATOR_TENANT_ID", "ten_1");
    expect(await readFile(envPath, "utf8")).toBe("OPERATOR_TENANT_ID=ten_1\n");
  });

  test("updates an existing .env in place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "workbench-env-"));
    const envPath = join(dir, ".env");
    await writeFile(envPath, "BASE_URL=http://localhost:3000\n", "utf8");
    await persistEnvVar(envPath, "OPERATOR_TENANT_ID", "ten_1");
    expect(await readFile(envPath, "utf8")).toBe(
      "BASE_URL=http://localhost:3000\nOPERATOR_TENANT_ID=ten_1\n",
    );
  });
});
