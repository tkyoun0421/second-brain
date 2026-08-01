import { spawn } from "node:child_process";

const readStandardInput = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

const parseInput = (rawInput) => {
  try {
    const value = JSON.parse(rawInput);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
};

const writeResponse = (response) => process.stdout.write(`${JSON.stringify(response)}\n`);

const runVerification = () => new Promise((resolve) => {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmCommand, ["run", "verify"], { cwd: process.cwd(), stdio: "ignore" });
  child.once("error", () => resolve(false));
  child.once("exit", (code) => resolve(code === 0));
});

const input = parseInput(await readStandardInput());
if (input?.hook_event_name !== "Stop" || input.stop_hook_active) {
  writeResponse({});
} else if (await runVerification()) {
  writeResponse({});
} else {
  writeResponse({
    decision: "block",
    reason: "Required production verification failed. Run `npm run verify`, fix the failure, and rerun it before finalizing.",
  });
}
