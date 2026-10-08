/**
 * Luna's reasoning layer: an LLM on top of each agent's rules. The rules stay in charge of safety and speed;
 * the reasoning checks every hand-off, explains it, and can act through guarded tools. Without a model key
 * (GEMINI_API_KEY, GROQ_API_KEY) or with LUNA_REASONING=off it stays quiet and the agents run as before.
 */
import type { Luna } from "../luna.ts";
import { createLlm } from "./llm.ts";
import { createReasoner } from "./reasoner.ts";

export function startReasoning(luna: Luna) {
  const llm = createLlm();
  const reasoner = createReasoner({ rt: luna.runtime, llm, watchMs: Number(process.env.LUNA_WATCH_MS) || 30_000 });
  if (llm.enabled) {
    reasoner.start();
    console.log(`Luna reasoning on: ${llm.status().providers.map((p) => p.model).join(" → ")}`);
  } else console.log("Luna reasoning off (no GEMINI_API_KEY or GROQ_API_KEY): the agents' rules run alone");
  return reasoner;
}
