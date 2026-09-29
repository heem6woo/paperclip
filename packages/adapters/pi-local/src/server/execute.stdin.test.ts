import { createHash } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { execute } from "./execute.js";

it("launches fresh and resumed sessions with complete prompts larger than Linux's argument limit", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-large-prompt-")));
  const command = path.join(root, "pi-fixture.cjs");
  const sessions = new Set<string>();
  await writeFile(command, `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
if (process.argv.includes("--list-models")) {
  console.log("provider  model\\nfixture  model");
} else {
  const session = process.argv[process.argv.indexOf("--session") + 1];
  fs.writeFileSync(session, JSON.stringify({type: "session", cwd: process.cwd()}) + "\\n");
  const prompt = fs.readFileSync(0, "utf8");
  console.log(JSON.stringify({type: "turn_end", message: {
    role: "assistant", content: crypto.createHash("sha256").update(prompt).digest("hex")
  }, toolResults: []}));
}
`);
  await chmod(command, 0o755);
  try {
    let sessionId: string | null = null;
    let sessionParams: Record<string, unknown> | null = null;
    for (const resumed of [false, true]) {
      const body = `START-${resumed}\n${"수정 주문 데이터\n".repeat(12000)}END-${resumed}`;
      let expectedPrompt = "";
      let stdout = "";
      const result = await execute({
        runId: `large-prompt-${resumed}`,
        agent: { id: `large-prompt-${path.basename(root)}`, companyId: "fixture", name: "Pi", adapterType: "pi_local", adapterConfig: {} },
        runtime: { sessionId, sessionParams, sessionDisplayId: null, taskKey: null },
        config: { command, model: "fixture/model", promptTemplate: "Continue assigned task.", timeoutSec: 20 },
        context: { paperclipSessionHandoffMarkdown: body, paperclipWorkspace: { cwd: root, source: "project_primary" } },
        onMeta: async (meta) => { expectedPrompt = String(meta.prompt); },
        onLog: async (stream, chunk) => { if (stream === "stdout") stdout += chunk; },
      });
      if (result.sessionId) sessions.add(result.sessionId);
      expect(result.exitCode).toBe(0);
      expect(expectedPrompt).toBe(`${body}\n\nContinue assigned task.`);
      const event = stdout.split("\n").filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line)).find((event) => event.type === "turn_end");
      expect(event.message.content).toBe(createHash("sha256").update(expectedPrompt).digest("hex"));
      if (resumed) expect(result.sessionId).toBe(sessionId);
      sessionId = result.sessionId ?? null;
      sessionParams = result.sessionParams ?? null;
    }
  } finally {
    await Promise.all([...sessions].map((session) => rm(session, { force: true })));
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
