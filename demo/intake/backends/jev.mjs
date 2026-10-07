// TypeSafe Jev backend: POST https://api.typesafe.ai/v1/systemone
//
// Env: TYPESAFE_API_KEY (required), JEV_MODEL (default jev-latest), JEV_ENDPOINT (override for
// testing). The request body is { model, state, questions } and the response carries
// { model, answers, usage }; answer shapes are the same as the stub's. 401 and 422 are not
// retried; 429 and 529 back off 1 s, 2 s, 4 s. The key and the state are never logged.
// Reference: https://docs.typesafe.ai (official) and the community API reference; the
// field names below should be re-checked against the official page if a call fails with 422.

export class BackendError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.kind = kind; // "config" | "auth" | "validation" | "rate_limit" | "network"
    this.status = status;
  }
}

const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 20_000;
const BACKOFF_MS = [1000, 2000, 4000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function systemOne(state, questions, { env = process.env, fetchImpl = fetch } = {}) {
  const key = env.TYPESAFE_API_KEY;
  if (!key) throw new BackendError("TYPESAFE_API_KEY is not set; the jev backend needs a TypeSafe API key (console.typesafe.ai)", "config");
  const body = JSON.stringify({ model: env.JEV_MODEL || "jev-latest", state, questions });
  const endpoint = env.JEV_ENDPOINT || DEFAULT_ENDPOINT;
  let lastErr;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      lastErr = new BackendError(`jev request failed: ${err?.cause?.message ?? err?.message ?? err}`, "network");
      if (attempt < BACKOFF_MS.length) { await sleep(BACKOFF_MS[attempt]); continue; }
      throw lastErr;
    }
    if (res.status === 401 || res.status === 403) throw new BackendError(`jev rejected the API key (HTTP ${res.status})`, "auth", res.status);
    if (res.status === 422 || res.status === 400) throw new BackendError(`jev rejected the request (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`, "validation", res.status);
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      lastErr = new BackendError(`jev is ${res.status === 429 ? "rate limiting" : "overloaded"} (HTTP ${res.status})`, "rate_limit", res.status);
      if (attempt < BACKOFF_MS.length) { await sleep(BACKOFF_MS[attempt]); continue; }
      throw lastErr;
    }
    if (!res.ok) throw new BackendError(`jev returned HTTP ${res.status}`, "network", res.status);
    const json = await res.json();
    return { model: json.model ?? "jev", answers: json.answers ?? {}, usage: json.usage ?? null };
  }
  throw lastErr ?? new BackendError("jev: exhausted retries", "network");
}
