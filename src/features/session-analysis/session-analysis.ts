import type { JsonObject, SessionStats } from '../../../shared/types.ts'
import { isObject } from '../../../shared/is-object.ts'
import {
  messageUsage,
  turnUsageByMessage,
  type MessageUsage,
} from '../conversation/message-usage.ts'
import { toolDataLength } from '../conversation/tool-presentation.ts'
import {
  toolCallsInMessage,
  toolContentText,
  toolResultInMessage,
  type ToolExecution,
} from '../conversation/tool-protocol.ts'

export type SessionAnalysisTarget = { kind: 'message' | 'turn'; index: number } | {
  kind: 'tool'
  id: string
}

export interface AnalyzedTurn {
  messageIndex: number
  number: number
  cost: number
  usage: MessageUsage
  toolCallCount: number
}

export interface AnalyzedToolCall {
  id: string
  name: string
  requestMessageIndex: number
  turnMessageIndex?: number
  inputLength: number
  outputLength: number
  isError: boolean
  pending: boolean
  durationMs?: number
}

export interface AnalyzedRequest {
  messageIndex: number
  title: string
  cost: number
  usage: MessageUsage
  modelCallCount: number
  toolCalls: AnalyzedToolCall[]
  failedToolCalls: number
  complete: boolean
  durationMs?: number
}

export interface ToolSummary {
  name: string
  count: number
  failed: number
  inputLength: number
  outputLength: number
  durationMs: number
  measuredDurationCount: number
}

export interface SessionAnalysis {
  requests: AnalyzedRequest[]
  turns: AnalyzedTurn[]
  toolCalls: AnalyzedToolCall[]
  tools: ToolSummary[]
  totalCost: number
  costAvailable: boolean
  attributedCost: number
  attributionAvailable: boolean
  unattributedCost: number
  averageTurnCost: number
  medianTurnCost: number
  turnCount: number
  averageToolCallsPerTurn: number
  totalToolCalls: number
  failedToolCalls: number
  contextPercent?: number
  tokens: MessageUsage
  tokensAvailable: boolean
}

interface AnalysisTelemetry {
  requestDurations?: ReadonlyMap<number, number>
  toolDurations?: ReadonlyMap<string, number>
  toolExecutions?: ToolExecution[]
}

interface MutableRequest extends AnalyzedRequest {
  usage: MessageUsage
}

const emptyUsage = (): MessageUsage => ({
  cacheMiss: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  output: 0,
})

/** Reconstructs assistant turns, user cycles, and their calls from Pi's public contract. */
export function analyzeSession(
  messages: JsonObject[],
  stats: SessionStats | null,
  running: boolean,
  telemetry: AnalysisTelemetry = {},
): SessionAnalysis {
  const resultsByCallId = new Map(messages.flatMap((message) => {
    const result = toolResultInMessage(message)
    return result ? [[result.toolCallId, result] as const] : []
  }))
  const executionsByCallId = new Map(
    telemetry.toolExecutions?.map((execution) => [execution.id, execution]) ?? [],
  )
  const requests: MutableRequest[] = []
  const seenToolCallIds = new Set<string>()
  /** Collects assistant turns and live tool calls that precede the first user message. */
  const unrequested = createActiveRequest()
  let currentRequest = unrequested

  messages.forEach((message, messageIndex) => {
    if (message.role === 'user') {
      currentRequest = {
        messageIndex,
        title: messageTitle(message),
        cost: 0,
        usage: emptyUsage(),
        modelCallCount: 0,
        toolCalls: [],
        failedToolCalls: 0,
        complete: true,
        durationMs: typeof message.timestamp === 'number'
          ? telemetry.requestDurations?.get(message.timestamp)
          : undefined,
      }
      requests.push(currentRequest)
      return
    }

    if (message.role === 'assistant') {
      const usage = messageUsage(message)
      if (usage) {
        addUsage(currentRequest.usage, usage)
        currentRequest.modelCallCount += 1
      }
      for (const call of toolCallsInMessage(message)) {
        const execution = executionsByCallId.get(call.id)
        const result = resultsByCallId.get(call.id) ?? execution?.result
        const analyzedCall: AnalyzedToolCall = {
          id: call.id,
          name: call.name,
          requestMessageIndex: currentRequest.messageIndex,
          turnMessageIndex: messageIndex,
          inputLength: toolDataLength(call.args),
          outputLength: result ? toolContentText(result.content).length : 0,
          isError: result?.isError === true,
          pending: result === undefined,
          durationMs: telemetry.toolDurations?.get(call.id),
        }
        currentRequest.toolCalls.push(analyzedCall)
        seenToolCallIds.add(call.id)
      }
      return
    }

    if (message.role === 'toolResult') {
      const usage = messageUsage(message)
      if (usage) addUsage(currentRequest.usage, usage)
    }
  })

  const activeRequest = requests.at(-1) ?? unrequested
  for (const execution of telemetry.toolExecutions ?? []) {
    if (seenToolCallIds.has(execution.id)) continue
    const call: AnalyzedToolCall = {
      id: execution.id,
      name: execution.name,
      requestMessageIndex: activeRequest.messageIndex,
      inputLength: toolDataLength(execution.args),
      outputLength: execution.result ? toolContentText(execution.result.content).length : 0,
      isError: execution.result?.isError === true,
      pending: execution.result === undefined,
      durationMs: telemetry.toolDurations?.get(execution.id),
    }
    activeRequest.toolCalls.push(call)
    seenToolCallIds.add(execution.id)
  }
  if (unrequested.modelCallCount > 0 || unrequested.toolCalls.length > 0)
    requests.unshift(unrequested)

  requests.forEach((request, index) => {
    request.cost = request.usage.cost
    request.failedToolCalls = request.toolCalls.filter((call) => call.isError).length
    request.complete = index < requests.length - 1 || !running
  })

  const toolCalls = requests.flatMap((request) => request.toolCalls)
  const attributedCost = requests.reduce((total, request) => total + request.cost, 0)
  const statsCost = finiteNumber(stats?.cost)
  const attributionAvailable = requests.some((request) => request.modelCallCount > 0)
  const totalCost = statsCost ?? attributedCost
  const turns = [...turnUsageByMessage(messages)].map(([messageIndex, usage], index) => ({
    messageIndex,
    number: index + 1,
    cost: usage.cost,
    usage,
    toolCallCount: toolCallsInMessage(messages[messageIndex] ?? {}).length,
  }))
  const turnCosts = turns.map((turn) => turn.cost).sort((a, b) => a - b)
  const parsedUsage = requests.reduce(
    (total, request) => addUsage(total, request.usage),
    emptyUsage(),
  )
  const statsTokens = statsUsage(stats)
  const tokens = statsTokens ?? parsedUsage
  const totalToolCalls = Math.max(stats?.toolCalls ?? 0, toolCalls.length)

  return {
    requests,
    turns,
    toolCalls,
    tools: summarizeTools(toolCalls),
    totalCost,
    costAvailable: statsCost !== undefined || attributionAvailable,
    attributedCost,
    attributionAvailable,
    unattributedCost: statsCost === undefined ? 0 : Math.max(0, statsCost - attributedCost),
    averageTurnCost: turnCosts.length
      ? turnCosts.reduce((total, cost) => total + cost, 0) / turnCosts.length
      : 0,
    medianTurnCost: median(turnCosts),
    turnCount: turnCosts.length,
    averageToolCallsPerTurn: turnCosts.length ? totalToolCalls / turnCosts.length : 0,
    totalToolCalls,
    failedToolCalls: toolCalls.filter((call) => call.isError).length,
    contextPercent: finiteNumber(stats?.contextUsage?.percent),
    tokens,
    tokensAvailable: statsTokens !== null || attributionAvailable,
  }
}

/** Builds a bounded, data-only prompt from the deterministic session report. */
export function buildSessionAnalysisPrompt(analysis: SessionAnalysis): string {
  const percent = (value: number, total: number) =>
    total > 0 ? Math.round(value / total * 1_000) / 10 : null
  const visibleTurnCost = analysis.turns.reduce((total, turn) => total + turn.cost, 0)
  const turnNumbers = new Map(
    analysis.turns.map((turn) => [turn.messageIndex, turn.number] as const),
  )
  const toolCallsByTurn = new Map<number, AnalyzedToolCall[]>()
  for (const call of analysis.toolCalls) {
    if (call.turnMessageIndex === undefined) continue
    const calls = toolCallsByTurn.get(call.turnMessageIndex) ?? []
    calls.push(call)
    toolCallsByTurn.set(call.turnMessageIndex, calls)
  }
  const turnSnapshot = (turn: AnalyzedTurn) => {
    const calls = toolCallsByTurn.get(turn.messageIndex) ?? []
    const measuredCalls = calls.filter((call) => call.durationMs !== undefined)
    return {
      turn: turn.number,
      cost: turn.cost,
      costPercentOfVisibleTurns: percent(turn.cost, visibleTurnCost),
      cacheMiss: turn.usage.cacheMiss,
      cacheRead: turn.usage.cacheRead,
      cacheWrite: turn.usage.cacheWrite,
      output: turn.usage.output,
      toolCallCount: turn.toolCallCount,
      tools: calls.slice(0, 8).map((call) => call.name),
      toolFailures: calls.filter((call) => call.isError).length,
      toolInputLength: calls.reduce((total, call) => total + call.inputLength, 0),
      toolOutputLength: calls.reduce((total, call) => total + call.outputLength, 0),
      measuredToolDurations: measuredCalls.length,
      measuredToolDurationMs: measuredCalls.length > 0
        ? measuredCalls.reduce((total, call) => total + (call.durationMs ?? 0), 0)
        : null,
    }
  }
  const toolCallSnapshot = (call: AnalyzedToolCall) => ({
    turn: call.turnMessageIndex === undefined
      ? null
      : turnNumbers.get(call.turnMessageIndex) ?? null,
    name: call.name,
    inputLength: call.inputLength,
    outputLength: call.outputLength,
    durationMs: call.durationMs ?? null,
    failed: call.isError,
    pending: call.pending,
  })
  const costliestTurns = [...analysis.turns]
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5)
    .map(turnSnapshot)
  const largestToolOutputs = [...analysis.toolCalls]
    .filter((call) => call.outputLength > 0)
    .sort((a, b) => b.outputLength - a.outputLength)
    .slice(0, 4)
    .map(toolCallSnapshot)
  const slowestToolCalls = [...analysis.toolCalls]
    .filter((call) => call.durationMs !== undefined)
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, 4)
    .map(toolCallSnapshot)
  const failedToolCalls = analysis
    .toolCalls
    .filter((call) => call.isError)
    .slice(0, 5)
    .map(toolCallSnapshot)
  const topThreeTurnCost = costliestTurns
    .slice(0, 3)
    .reduce((total, turn) => total + turn.cost, 0)
  const inputTokens = analysis.tokens.cacheMiss
    + analysis.tokens.cacheRead
    + analysis.tokens.cacheWrite
  const observedToolCalls = analysis.toolCalls.length
  const measuredToolDurations =
    analysis.toolCalls.filter((call) => call.durationMs !== undefined).length
  const snapshot = {
    indicators: {
      cost: {
        totalSession: analysis.costAvailable ? analysis.totalCost : null,
        visibleTurnsTotal: visibleTurnCost,
        unmatchedToVisibleTurns: analysis.costAvailable
          ? Math.max(0, analysis.totalCost - visibleTurnCost)
          : null,
        turns: analysis.turnCount,
        averagePerTurn: analysis.turnCount > 0 ? analysis.averageTurnCost : null,
        medianPerTurn: analysis.turnCount > 0 ? analysis.medianTurnCost : null,
        maximumPerTurn: costliestTurns[0]?.cost ?? null,
        topTurnPercentOfVisibleTurnCost: percent(costliestTurns[0]?.cost ?? 0, visibleTurnCost),
        topThreeTurnsPercentOfVisibleTurnCost: percent(topThreeTurnCost, visibleTurnCost),
      },
      cacheAndContext: {
        contextUsedPercent: analysis.contextPercent ?? null,
        tokens: analysis.tokensAvailable
          ? {
            input: inputTokens,
            cacheMiss: analysis.tokens.cacheMiss,
            cacheRead: analysis.tokens.cacheRead,
            cacheWrite: analysis.tokens.cacheWrite,
            output: analysis.tokens.output,
          }
          : null,
        cacheReadPercentOfInput: analysis.tokensAvailable
          ? percent(analysis.tokens.cacheRead, inputTokens)
          : null,
        cacheMissPercentOfInput: analysis.tokensAvailable
          ? percent(analysis.tokens.cacheMiss, inputTokens)
          : null,
      },
      tools: {
        totalCalls: analysis.totalToolCalls,
        observedCalls: observedToolCalls,
        averageCallsPerTurn: analysis.turnCount > 0 ? analysis.averageToolCallsPerTurn : null,
        explicitFailures: analysis.failedToolCalls,
        observedFailurePercent: percent(analysis.failedToolCalls, observedToolCalls),
        pendingCalls: analysis.toolCalls.filter((call) => call.pending).length,
        measuredDurations: measuredToolDurations,
        durationCoveragePercent: percent(measuredToolDurations, observedToolCalls),
      },
    },
    evidence: {
      costliestTurns,
      mostUsedTools: analysis.tools.slice(0, 6),
      largestToolOutputs,
      slowestToolCalls,
      failedToolCalls,
    },
    dataQuality: {
      sessionCostAvailable: analysis.costAvailable,
      tokensAvailable: analysis.tokensAvailable,
      toolDetailsPartial: observedToolCalls < analysis.totalToolCalls,
      toolsWithoutTurn: analysis
        .toolCalls
        .filter(
          (call) => call.turnMessageIndex === undefined || !turnNumbers.has(call.turnMessageIndex),
        )
        .length,
    },
  }
  return [
    'Analyse uniquement le snapshot JSON ci-dessous. Concentre-toi sur les turns et les tools, sans paraphraser tous les KPI.',
    'Réponds en français, en 120 mots maximum, avec exactement cette structure Markdown :',
    '**Bilan** — une phrase qui qualifie la session sans jugement vague.',
    '- **Turns clés** — cite un à trois turns par numéro, classés d’abord par coût ; donne leur coût et leur part du coût visible, puis les métriques qui les distinguent.',
    '- **Outils** — relève les tools fréquents, en échec, volumineux ou lents et rattache-les à leur turn lorsqu’il est connu.',
    '- **Cache & contexte** — explique seulement le signal global ou propre aux turns clés.',
    '**Priorité** — une seule action concrète fondée sur le signal le plus important, ou « Aucune action prioritaire ».',
    'Un turn est clé ici par son coût absolu et sa part du coût des turns visibles. Les tools associés servent à le caractériser, jamais à leur attribuer ce coût.',
    'Appuie chaque constat sur une ou deux valeurs. Si un axe est sain, dis-le ; si les données manquent ou sont partielles, nuance-le brièvement.',
    'cacheReadPercentOfInput mesure la part des tokens d’entrée relus depuis le cache : une valeur élevée est généralement positive. Les longueurs des tools sont des caractères, pas des tokens ni un coût monétaire. Les durées ne valent que pour les appels mesurés.',
    'N’attribue aucune cause non observée et ne déduis jamais le contenu de la conversation ou des tools.',
    '<session_analysis_json>',
    JSON.stringify(snapshot),
    '</session_analysis_json>',
  ]
    .join('\n')
}

function createActiveRequest(): MutableRequest {
  return {
    messageIndex: -1,
    title: 'Request in progress',
    cost: 0,
    usage: emptyUsage(),
    modelCallCount: 0,
    toolCalls: [],
    failedToolCalls: 0,
    complete: false,
  }
}

/** Accumulates one MessageUsage record into another, mutating the target in place. */
function addUsage(target: MessageUsage, usage: MessageUsage): MessageUsage {
  target.cacheMiss += usage.cacheMiss
  target.cacheRead += usage.cacheRead
  target.cacheWrite += usage.cacheWrite
  target.cost += usage.cost
  target.output += usage.output
  return target
}

/** Converts a snapshot token breakdown into MessageUsage, or returns null when unavailable. */
function statsUsage(stats: SessionStats | null): MessageUsage | null {
  const tokens = stats?.tokens
  if (!tokens) return null
  const cacheMiss = finiteNumber(tokens.input)
  const cacheRead = finiteNumber(tokens.cacheRead)
  const cacheWrite = finiteNumber(tokens.cacheWrite)
  const output = finiteNumber(tokens.output)
  if (
    cacheMiss === undefined || cacheRead === undefined || cacheWrite === undefined
    || output === undefined
  ) return null
  return { cacheMiss, cacheRead, cacheWrite, cost: finiteNumber(stats?.cost) ?? 0, output }
}

/** Aggregates tool call metrics by tool name, sorted by call count. */
function summarizeTools(calls: AnalyzedToolCall[]): ToolSummary[] {
  const summaries = new Map<string, ToolSummary>()
  for (const call of calls) {
    const summary = summaries.get(call.name)
      ?? {
        name: call.name,
        count: 0,
        failed: 0,
        inputLength: 0,
        outputLength: 0,
        durationMs: 0,
        measuredDurationCount: 0,
      }
    summary.count += 1
    summary.failed += Number(call.isError)
    summary.inputLength += call.inputLength
    summary.outputLength += call.outputLength
    if (call.durationMs !== undefined) {
      summary.durationMs += call.durationMs
      summary.measuredDurationCount += 1
    }
    summaries.set(call.name, summary)
  }
  return [...summaries.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** Produces a short title from the user message text, truncating at 90 characters. */
function messageTitle(message: JsonObject): string {
  const content = message.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
    ? content
      .flatMap((part) =>
        isObject(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
      )
      .join(' ')
    : ''
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 90 ? `${normalized.slice(0, 89)}…` : normalized || 'Untitled request'
}

function median(sortedValues: number[]): number {
  if (sortedValues.length === 0) return 0
  const middle = Math.floor(sortedValues.length / 2)
  return sortedValues.length % 2 === 1
    ? sortedValues[middle]
    : (sortedValues[middle - 1] + sortedValues[middle]) / 2
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
