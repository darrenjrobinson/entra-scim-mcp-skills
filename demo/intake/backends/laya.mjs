// Laya backend: the open-weight, Jev-compatible System One model, run locally through
// @receptron/laya (ONNX Runtime; no Python). Opt in with:
//
//   npm install @receptron/laya        # ~50 KB package; pulls onnxruntime-node
//   LIFECYCLE_INTAKE_BACKEND=laya      # first call downloads ~1.7 GB of fp32 weights from
//                                      # Hugging Face into ~/.cache/receptron-laya (LAYA_CACHE)
//
// Budget about 2 GB of RAM for the loaded model. Env passthrough: LAYA_CACHE (cache dir),
// LAYA_MODEL_DIR (pre-exported ONNX directory), LAYA_SUBFOLDER (e.g. "multilingual").
// The package is deliberately not a dependency of this repo so that `npm install` stays
// light for readers who only want the stub.
import { BackendError } from "./jev.mjs";

let instance = null;

export async function systemOne(state, questions, { env = process.env } = {}) {
  if (!instance) {
    let mod;
    try {
      mod = await import("@receptron/laya");
    } catch {
      throw new BackendError("@receptron/laya is not installed. Run: npm install @receptron/laya (the first call then downloads ~1.7 GB of weights)", "config");
    }
    const opts = {};
    if (env.LAYA_MODEL_DIR) opts.modelDir = env.LAYA_MODEL_DIR;
    if (env.LAYA_CACHE) opts.cacheDir = env.LAYA_CACHE;
    if (env.LAYA_SUBFOLDER) opts.subfolder = env.LAYA_SUBFOLDER;
    instance = await mod.Laya.load(opts);
  }
  const result = await instance.systemOne(state, questions);
  return { model: result.model ?? "laya", answers: result.answers ?? {}, usage: result.usage ?? null };
}

export async function close() {
  if (instance?.close) await instance.close();
  instance = null;
}
