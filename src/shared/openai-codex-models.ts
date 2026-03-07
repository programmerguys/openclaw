export const OPENAI_CODEX_GPT54_MODEL_ID = "gpt-5.4";
export const OPENAI_CODEX_GPT54_LEGACY_MODEL_ID = "gpt-5.4-codex";
export const OPENAI_CODEX_GPT53_MODEL_ID = "gpt-5.3-codex";
export const OPENAI_CODEX_GPT53_SPARK_MODEL_ID = "gpt-5.3-codex-spark";

const OPENAI_CODEX_MODEL_ALIAS_TO_CANONICAL: Readonly<Record<string, string>> = {
  [OPENAI_CODEX_GPT54_LEGACY_MODEL_ID]: OPENAI_CODEX_GPT54_MODEL_ID,
};

const OPENAI_CODEX_CANONICAL_TO_ALIASES: Readonly<Record<string, readonly string[]>> = {
  [OPENAI_CODEX_GPT54_MODEL_ID]: [OPENAI_CODEX_GPT54_LEGACY_MODEL_ID],
};

function pushUniqueModelId(target: string[], seen: Set<string>, value?: string | null): void {
  const trimmed = value?.trim();
  if (!trimmed) {
    return;
  }
  const normalized = trimmed.toLowerCase();
  if (seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(trimmed);
}

export function normalizeOpenAICodexModelId(modelId?: string | null): string {
  const trimmed = modelId?.trim();
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === OPENAI_CODEX_GPT54_MODEL_ID) {
    return OPENAI_CODEX_GPT54_MODEL_ID;
  }

  return OPENAI_CODEX_MODEL_ALIAS_TO_CANONICAL[normalized] ?? trimmed;
}

export function listOpenAICodexModelIdCandidates(modelId?: string | null): string[] {
  const trimmed = modelId?.trim();
  if (!trimmed) {
    return [];
  }

  const canonical = normalizeOpenAICodexModelId(trimmed);
  const aliases = OPENAI_CODEX_CANONICAL_TO_ALIASES[canonical.toLowerCase()] ?? [];
  const candidates: string[] = [];
  const seen = new Set<string>();

  pushUniqueModelId(candidates, seen, trimmed);
  pushUniqueModelId(candidates, seen, canonical);
  for (const alias of aliases) {
    pushUniqueModelId(candidates, seen, alias);
  }

  return candidates;
}
