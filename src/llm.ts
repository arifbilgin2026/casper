/* The model, reached through Bedrock's streaming Converse API.
 *
 * It is on the game's QUALITY path, never its critical path: everything that
 * must happen for the child (the verdict, the star, the next card) is decided
 * in code before this module is consulted, and every caller of stream() has a
 * canned line ready for when it is slow, down, or disabled.
 */
import {
  BedrockRuntimeClient, ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";

const MODEL = process.env.SOYLE_MODEL ?? "us.anthropic.claude-haiku-4-5-20251001-v1:0";

export class Brain {
  private client: BedrockRuntimeClient;
  constructor(region = process.env.BEDROCK_REGION ?? "us-east-1") {
    this.client = new BedrockRuntimeClient({ region });
  }

  /** Stream one reply, piece by piece. Throws on transport errors — callers
   *  treat any throw as "the model is down" and fall back to canned lines. */
  async *stream(userText: string, systemText: string): AsyncGenerator<string> {
    const res = await this.client.send(new ConverseStreamCommand({
      modelId: MODEL,
      system: [{ text: systemText }],
      messages: [{ role: "user", content: [{ text: userText }] }],
      inferenceConfig: { maxTokens: 300, temperature: 0.3 },
    }));
    for await (const ev of res.stream ?? []) {
      const d = ev.contentBlockDelta?.delta;
      if (d && "text" in d && d.text) yield d.text;
    }
  }
}
