import fs from "node:fs/promises";
import path from "node:path";
import { resolveUserPath } from "../utils.js";
import type { ModelInputType } from "./model-catalog.js";

const CODEX_MODELS_CACHE_FILENAME = "models_cache.json";
const CODEX_PROVIDER = "openai-codex";

type CodexCachedModel = {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  supported_reasoning_levels?: unknown;
  input_modalities?: unknown;
  context_window?: unknown;
};

export type OpenAICodexCliCatalogEntry = {
  id: string;
  name: string;
  provider: typeof CODEX_PROVIDER;
  contextWindow?: number;
  reasoning?: boolean;
  input?: ModelInputType[];
};

function resolveCodexHomePath(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return resolveUserPath(configured || "~/.codex");
}

export function resolveCodexModelsCachePath(): string {
  return path.join(resolveCodexHomePath(), CODEX_MODELS_CACHE_FILENAME);
}

function normalizeInputModalities(input: unknown): ModelInputType[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = input.filter(
    (item): item is ModelInputType => item === "text" || item === "image" || item === "document",
  );
  return normalized.length > 0 ? normalized : undefined;
}

function resolveReasoningFlag(levels: unknown): boolean | undefined {
  if (!Array.isArray(levels)) {
    return undefined;
  }
  return levels.some((entry) =>
    Boolean(
      entry &&
      typeof entry === "object" &&
      typeof (entry as { effort?: unknown }).effort === "string",
    ),
  );
}

function toCatalogEntry(model: CodexCachedModel): OpenAICodexCliCatalogEntry | null {
  const slug = typeof model.slug === "string" ? model.slug.trim() : "";
  if (!slug) {
    return null;
  }
  const visibility =
    typeof model.visibility === "string" ? model.visibility.trim().toLowerCase() : "";
  if (visibility !== "list") {
    return null;
  }

  const name = typeof model.display_name === "string" ? model.display_name.trim() : "";
  const contextWindow =
    typeof model.context_window === "number" && model.context_window > 0
      ? model.context_window
      : undefined;

  return {
    provider: CODEX_PROVIDER,
    id: slug,
    name: name || slug,
    contextWindow,
    reasoning: resolveReasoningFlag(model.supported_reasoning_levels),
    input: normalizeInputModalities(model.input_modalities),
  };
}

export async function loadOpenAICodexCliCatalog(): Promise<OpenAICodexCliCatalogEntry[]> {
  const pathname = resolveCodexModelsCachePath();
  try {
    const raw = await fs.readFile(pathname, "utf8");
    const parsed = JSON.parse(raw) as { models?: unknown };
    if (!Array.isArray(parsed.models)) {
      return [];
    }
    return parsed.models
      .map((entry) =>
        entry && typeof entry === "object" ? toCatalogEntry(entry as CodexCachedModel) : null,
      )
      .filter((entry): entry is OpenAICodexCliCatalogEntry => Boolean(entry));
  } catch {
    return [];
  }
}

export async function getOpenAICodexCliCatalogCacheKey(): Promise<string> {
  const pathname = resolveCodexModelsCachePath();
  try {
    const stat = await fs.stat(pathname);
    return `${pathname}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${pathname}:missing`;
  }
}
