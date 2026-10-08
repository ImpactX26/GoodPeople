/**
 * One small client for every reasoning call. Gemini Flash-Lite answers first when GEMINI_API_KEY is set;
 * Groq (gpt-oss-120b, then gpt-oss-20b) is the fallback for everything, and goes first for the 30-second
 * watcher so it doesn't spend Gemini's smaller quota. All of them speak the OpenAI chat API, so this is
 * plain fetch. A provider that is rate-limited or failing sits out a cool-down instead of slowing every call.
 */

export type Purpose = "reason" | "watch";

interface Provider {
  name: string;
  model: string;
  baseUrl: string;
  key: string;
  extra: Record<string, unknown>;
}

export type Answer =
  | { ok: true; json: Record<string, unknown>; model: string; ms: number; tokens?: number }
  | { ok: false; error: string; ms: number };

interface Stats {
  calls: number;
  fails: number;
  tokens: number;
  lastMs?: number;
  lastError?: string;
  coolingUntil?: number;
}

const TIMEOUT_MS = 8_000;

/** "```json {…} ```" or prose around the object: keep the object. */
export function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function createLlm(opts: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: () => number } = {}) {
  const env = opts.env ?? process.env;
  const fetchFn = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;

  const providers: Provider[] = [];
  if (env.GEMINI_API_KEY)
    providers.push({
      name: "gemini",
      model: env.LUNA_REASONING_GEMINI_MODEL || "gemini-3.5-flash-lite",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      key: env.GEMINI_API_KEY,
      extra: { reasoning_effort: "low" },
    });
  if (env.GROQ_API_KEY)
    for (const model of ["openai/gpt-oss-120b", "openai/gpt-oss-20b"])
      providers.push({ name: "groq", model, baseUrl: "https://api.groq.com/openai/v1", key: env.GROQ_API_KEY, extra: { reasoning_effort: "low" } });

  const label = (p: Provider) => `${p.name}:${p.model}`;
  const chains: Record<Purpose, Provider[]> = {
    reason: providers,
    watch: [...providers.filter((p) => p.name === "groq"), ...providers.filter((p) => p.name !== "groq")],
  };
  const stats = new Map(providers.map((p) => [label(p), { calls: 0, fails: 0, tokens: 0 } as Stats]));
  const cap = Number(env.LUNA_REASONING_DAILY_CAP) || 800;
  let day = "";
  let callsToday = 0;
  const enabled = providers.length > 0 && env.LUNA_REASONING !== "off";

  /** How long a provider sits out after this failure. */
  function coolFor(status: number, body: string, retryAfter: string | null) {
    if (status === 429) {
      if (/quota|per day|daily/i.test(body)) return 15 * 60_000;
      const s = Number(retryAfter);
      return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, 5 * 60_000) : 30_000;
    }
    return status >= 500 || status === 0 ? 10_000 : 0;
  }

  async function call(p: Provider, system: string, user: string, maxTokens: number): Promise<Answer> {
    const t0 = now();
    const st = stats.get(label(p))!;
    st.calls++;
    let status = 0;
    let body = "";
    let retryAfter: string | null = null;
    try {
      const res = await fetchFn(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: p.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
          temperature: 0.2,
          max_tokens: maxTokens,
          ...p.extra,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = res.status;
      retryAfter = res.headers.get("retry-after");
      body = await res.text();
      if (!res.ok) throw new Error(`${status} ${body.slice(0, 200)}`);
      let data = JSON.parse(body);
      if (Array.isArray(data)) data = data[0];
      const text: string = data?.choices?.[0]?.message?.content ?? "";
      const json = parseJson(text);
      if (!json) throw new Error(`no JSON in the answer: ${text.slice(0, 120)}`);
      const ms = now() - t0;
      const tokens: number | undefined = data?.usage?.total_tokens;
      st.lastMs = ms;
      st.tokens += tokens ?? 0;
      st.lastError = undefined;
      return { ok: true, json, model: label(p), ms, tokens };
    } catch (err) {
      st.fails++;
      st.lastError = String((err as Error)?.message ?? err).slice(0, 200);
      const cool = coolFor(status, body, retryAfter);
      if (cool) st.coolingUntil = now() + cool;
      return { ok: false, error: `${label(p)}: ${st.lastError}`, ms: now() - t0 };
    }
  }

  return {
    enabled,

    /** Ask the chain for this purpose; the first provider that answers with JSON wins. */
    async ask(purpose: Purpose, system: string, user: string, maxTokens = 900): Promise<Answer> {
      const t0 = now();
      if (!enabled) return { ok: false, error: "No reasoning model is set up (GEMINI_API_KEY or GROQ_API_KEY).", ms: 0 };
      const today = new Date(now()).toISOString().slice(0, 10);
      if (today !== day) {
        day = today;
        callsToday = 0;
      }
      if (callsToday >= cap) return { ok: false, error: `Today's reasoning budget (${cap} calls) is used up.`, ms: 0 };
      callsToday++;
      const errors: string[] = [];
      for (const p of chains[purpose]) {
        const st = stats.get(label(p))!;
        if ((st.coolingUntil ?? 0) > now()) {
          errors.push(`${label(p)}: cooling down`);
          continue;
        }
        const a = await call(p, system, user, maxTokens);
        if (a.ok) return a;
        errors.push(a.error);
      }
      return { ok: false, error: errors.join(" | "), ms: now() - t0 };
    },

    status() {
      return {
        enabled,
        cap,
        callsToday,
        providers: providers.map((p) => ({ model: label(p), ...stats.get(label(p))! })),
      };
    },
  };
}

export type Llm = ReturnType<typeof createLlm>;
