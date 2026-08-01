import { createStopCheckpointResponse, type StopHookInput } from "#app/modules/checkpoint/checkpoint-hook.js";

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function parseHookInput(rawInput: string): StopHookInput | null {
  try {
    const parsed: unknown = JSON.parse(rawInput);

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    return parsed as StopHookInput;
  } catch {
    return null;
  }
}

const rawInput = await readStandardInput();
const input = parseHookInput(rawInput);
const response = input ? createStopCheckpointResponse(input) : null;

if (response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
