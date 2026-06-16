import {
  addTokenUsage,
  emptyTokenUsage,
  type ModelUsage,
  type TokenSemantics,
  type TokenUsage,
} from '../chat-metadata.js'

export function addModelUsage(
  models: Map<string, ModelUsage>,
  modelName: string | undefined,
  usage: TokenUsage,
  requests = 1,
  durationMs?: number,
): void {
  const name = modelName || '(unknown)'
  const model = models.get(name) ?? {
    model: name,
    requests: 0,
    ...emptyTokenUsage(usage.totalTokenSemantics as TokenSemantics),
  }
  model.requests += requests
  addTokenUsage(model, usage)
  if (durationMs !== undefined) model.durationMs = (model.durationMs ?? 0) + durationMs
  models.set(name, model)
}

export function sortedModels(models: Map<string, ModelUsage>): ModelUsage[] {
  return [...models.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.model.localeCompare(b.model))
}

export function uniqueStrings(values: Iterable<string | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => Boolean(value)))].sort()
}
