import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_NOUL_NO_THRESHOLD,
  DEFAULT_NOUL_YES_THRESHOLD,
  OPENROUTER_DEFAULT_BASE_URL,
  PINNED_JEV_MODEL,
  PluginRuntimeConfigPatchSchema,
  type PluginRuntimeConfig,
} from "../types/decisions.js";

export function resolveDataDir(): string {
  const candidates = [
    process.env.PLUGIN_DATA,
    process.env.JEV_DATA_DIR,
    join(homedir(), ".config", "jev-openrouter"),
  ];
  for (const c of candidates) {
    if (c && c.trim().length > 0 && !c.includes("${")) {
      return resolve(c.trim());
    }
  }
  return resolve(join(homedir(), ".config", "jev-openrouter"));
}

export function ensureDataSubdir(subdir?: string): string {
  const base = resolveDataDir();
  const target = subdir ? join(base, subdir) : base;
  mkdirSync(target, { recursive: true });
  return target;
}

export function defaultRuntimeConfig(): PluginRuntimeConfig {
  const rawMaxLatency = process.env.OPENROUTER_PREFERRED_MAX_LATENCY_P90;
  const parsedLatency = rawMaxLatency ? Number(rawMaxLatency) : undefined;
  const rawCacheTtl = process.env.JEV_CACHE_TTL;
  const parsedCacheTtl = rawCacheTtl ? Number(rawCacheTtl) : undefined;

  return {
    defaultModel: process.env.JEV_DEFAULT_MODEL?.trim() || PINNED_JEV_MODEL,
    baseUrl: process.env.OPENROUTER_BASE_URL?.trim() || OPENROUTER_DEFAULT_BASE_URL,
    httpReferer:
      process.env.OPENROUTER_HTTP_REFERER?.trim() || "https://github.com/kayroalexandre/jev-jove",
    appTitle: process.env.OPENROUTER_APP_TITLE?.trim() || "TypeSafe Jev on OpenRouter",
    appCategories: process.env.OPENROUTER_APP_CATEGORIES?.trim() || "cli-agent,programming-app",
    appVisibility: process.env.OPENROUTER_APP_VISIBILITY === "hidden" ? "hidden" : "public",
    zdr: process.env.OPENROUTER_ZDR === "true",
    preferredMaxLatencyP90:
      parsedLatency && Number.isFinite(parsedLatency) && parsedLatency > 0
        ? parsedLatency
        : undefined,
    defaultCacheEnabled: process.env.JEV_CACHE_ENABLED === "true",
    defaultCacheTtlSeconds:
      parsedCacheTtl && Number.isInteger(parsedCacheTtl) && parsedCacheTtl > 0
        ? parsedCacheTtl
        : undefined,
    defaultConcurrency: 4,
    timeoutMs: 30_000,
    maxRetries: 4,
    defaultNoulYesThreshold: DEFAULT_NOUL_YES_THRESHOLD,
    defaultNoulNoThreshold: DEFAULT_NOUL_NO_THRESHOLD,
    defaultConfidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    dataDir: resolveDataDir(),
  };
}

function configFilePath(): string {
  return join(resolveDataDir(), "config.json");
}

export function loadRuntimeConfig(): PluginRuntimeConfig {
  const defaults = defaultRuntimeConfig();
  const file = configFilePath();
  if (!existsSync(file)) {
    return defaults;
  }
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const parsed = PluginRuntimeConfigPatchSchema.safeParse(raw);
    if (!parsed.success) {
      return defaults;
    }
    const patch = parsed.data;
    return {
      ...defaults,
      ...patch,
      preferredMaxLatencyP90:
        patch.preferredMaxLatencyP90 === null
          ? undefined
          : (patch.preferredMaxLatencyP90 ?? defaults.preferredMaxLatencyP90),
      defaultCacheTtlSeconds:
        patch.defaultCacheTtlSeconds === null
          ? undefined
          : (patch.defaultCacheTtlSeconds ?? defaults.defaultCacheTtlSeconds),
      dataDir: resolveDataDir(),
    };
  } catch {
    return defaults;
  }
}

export function saveRuntimeConfigPatch(patchInput: unknown): PluginRuntimeConfig {
  const patch = PluginRuntimeConfigPatchSchema.parse(patchInput);
  const current = loadRuntimeConfig();
  const next: PluginRuntimeConfig = {
    ...current,
    ...patch,
    preferredMaxLatencyP90:
      patch.preferredMaxLatencyP90 === null
        ? undefined
        : (patch.preferredMaxLatencyP90 ?? current.preferredMaxLatencyP90),
    defaultCacheTtlSeconds:
      patch.defaultCacheTtlSeconds === null
        ? undefined
        : (patch.defaultCacheTtlSeconds ?? current.defaultCacheTtlSeconds),
    dataDir: resolveDataDir(),
  };
  ensureDataSubdir();
  writeFileSync(configFilePath(), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

export function resolveOpenRouterApiKey(): string | null {
  const raw = process.env.OPENROUTER_API_KEY?.trim();
  if (!raw || raw.startsWith("${") || raw === "YOUR_API_KEY") {
    return null;
  }
  return raw;
}
