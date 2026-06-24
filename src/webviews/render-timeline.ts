import type { ChatDetailEvent, ChatDetailReport } from '../chat-detail.js'
import { chatField, countLabel, escapeHtml, formatDuration, formatNumber, formatTimestamp, sum } from './render-primitives.js'

interface TimelinePresentation {
  event: ChatDetailEvent
  relation: string
  cumulativeTokens?: number
  cumulativeTokensPartial?: boolean
}

interface TimelineChain {
  title: string
  timestamp?: string
  events: TimelinePresentation[]
}

interface TimelineTreeNode {
  presentation: TimelinePresentation
  children: TimelineTreeNode[]
}

/** Renders the timeline as collapsible per-input action chains with a nested tool/result tree. */
export function renderTimelineChains(detail: ChatDetailReport): string {
  const chains = timelineChains(detail)
  if (chains.length === 0) return ''
  return `<div class="timeline-chains">${chains
    .map((chain) => {
      const tokens = sum(
        chain.events.map(({ event }) => (event.kind === 'model_request' ? (event.usage?.totalTokens ?? 0) : 0)),
      )
      const toolCalls = chain.events.filter(({ event }) => event.kind === 'tool_call').length
      const subagents = chain.events.filter(({ event }) => isSubagentEvent(event)).length
      const root = chain.events[0]
      const rootIsChainStart = root && isChainStartEvent(root.event)
      const summary = [
        countLabel(chain.events.length, 'event'),
        tokens > 0 ? `${formatNumber(tokens)} request tokens` : '',
        toolCalls > 0 ? countLabel(toolCalls, 'tool') : '',
        subagents > 0 ? countLabel(subagents, 'subagent') : '',
        rootIsChainStart ? timelineContentState(root.event) : '',
      ]
        .filter(Boolean)
        .map(escapeHtml)
        .join(' &middot; ')
      const nodes = timelineTree(rootIsChainStart ? chain.events.slice(1) : chain.events)
      return `<details class="timeline-chain" open>
      <summary class="timeline-chain-header">
        <div class="timeline-chain-title">${escapeHtml(chain.title)}</div>
        <div class="timeline-chain-meta"><span>${summary}</span><time class="timeline-timestamp" datetime="${escapeHtml(chain.timestamp ?? '')}">${escapeHtml(formatTimestamp(chain.timestamp))}</time></div>
      </summary>
      <div class="timeline-chain-body">
        ${rootIsChainStart ? renderTimelineRootDetails(root) : ''}
        ${nodes.length > 0 ? `<div class="timeline-tree-children">${nodes.map(renderTimelineTreeNode).join('')}</div>` : ''}
      </div>
    </details>`
    })
    .join('')}</div>`
}

/** Reads a finite numeric field from an event's provider-specific `details` bag. */
export function detailNumber(event: ChatDetailEvent, key: string): number | undefined {
  const value = event.details?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function timelineChains(detail: ChatDetailReport): TimelineChain[] {
  const events = detail.timeline
  if (events.length === 0) return []
  const hasUserInputs = events.some((event) => event.kind === 'user_message')
  const chains: TimelineChain[] = []
  let current: TimelineChain | undefined
  let userInput = 0
  let turn = 0
  let cumulativeTokens = 0
  const cumulativeTokensPartial = (detail.summary?.omittedTimelineEvents ?? 0) > 0

  for (const event of events) {
    const startsUserChain = event.kind === 'user_message'
    const startsTurnChain = !hasUserInputs && event.kind === 'turn'
    if (!current || startsUserChain || startsTurnChain) {
      if (startsUserChain) userInput += 1
      if (startsTurnChain) turn += 1
      current = {
        title: startsUserChain
          ? detail.metadata?.kind === 'subagent'
            ? `Subagent input ${userInput}`
            : `User input ${userInput}`
          : startsTurnChain
            ? `Agent turn ${turn}`
            : detail.metadata?.kind === 'subagent'
              ? 'Subagent run'
              : 'Session setup',
        timestamp: event.timestamp,
        events: [],
      }
      chains.push(current)
    }

    if (event.kind === 'model_request' && event.usage) {
      cumulativeTokens += event.usage.totalTokens
    }
    current.events.push({
      event,
      relation: eventRelation(event),
      cumulativeTokens: event.kind === 'model_request' && event.usage ? cumulativeTokens : undefined,
      cumulativeTokensPartial: event.kind === 'model_request' && event.usage ? cumulativeTokensPartial : undefined,
    })
  }
  return chains
}

function timelineTree(events: TimelinePresentation[]): TimelineTreeNode[] {
  const roots: TimelineTreeNode[] = []
  const calls = new Map<string, TimelineTreeNode>()
  const nodes = new Map<string, TimelineTreeNode>()
  for (const presentation of events) {
    const node = { presentation, children: [] }
    const { event } = presentation
    if (event.parentId) {
      const parent = nodes.get(event.parentId)
      if (parent) {
        parent.children.push(node)
        if (event.id) nodes.set(event.id, node)
        if (event.kind === 'tool_call' && event.toolCallId) calls.set(event.toolCallId, node)
        continue
      }
    }
    if (event.kind === 'tool_result' && event.toolCallId) {
      const call = calls.get(event.toolCallId)
      if (call) {
        presentation.relation = isSubagentResult(event)
          ? 'Result returned by delegated agent'
          : 'Result of preceding tool call'
        call.children.push(node)
        continue
      }
    }
    roots.push(node)
    if (event.id) nodes.set(event.id, node)
    if (event.kind === 'tool_call' && event.toolCallId) calls.set(event.toolCallId, node)
  }
  return roots
}

function isChainStartEvent(event: ChatDetailEvent): boolean {
  return event.kind === 'user_message' || event.kind === 'turn' || event.kind === 'session'
}

function eventRelation(event: ChatDetailEvent): string {
  if (event.kind === 'user_message') return 'Starts this action chain'
  if (event.kind === 'assistant_message') return 'Agent response'
  if (event.kind === 'model_request') return 'Model inference for the current step'
  if (event.kind === 'reasoning') return 'Agent reasoning step'
  if (event.kind === 'turn') return 'Agent turn boundary'
  if (event.kind === 'tool_call') {
    return isSubagentEvent(event) ? 'Agent delegates work to a subagent' : 'Agent invokes a tool'
  }
  if (event.kind === 'tool_result') return 'Tool returns control to the agent'
  if (event.kind === 'session') return 'Session lifecycle'
  return 'Observed event'
}

function renderTimelineRootDetails(presentation: TimelinePresentation): string {
  const { event } = presentation
  const identity = eventIdentity(event)
  const fields = timelineEventDetailFields(presentation)
  const content = renderEventContent(event)
  if (!identity && fields.length === 0 && !content) return ''
  return `<div class="timeline-root-details">
    <div class="timeline-event-relation">${timelineInlineSummary(presentation)}</div>
    ${identity}
    ${fields.length > 0 ? `<div class="detail-fields">${fields.join('')}</div>` : ''}
    ${content}
  </div>`
}

function renderTimelineTreeNode(node: TimelineTreeNode): string {
  const { event } = node.presentation
  const subject = event.toolName ?? event.model ?? event.role ?? ''
  const title = subject
    ? `${escapeHtml(eventTitle(event))} &middot; ${escapeHtml(subject)}`
    : escapeHtml(eventTitle(event))
  const inlineSummary = timelineInlineSummary(node.presentation)
  if (!isExpandableTimelineNode(node)) {
    return `<div class="timeline-tree-node timeline-tree-leaf ${escapeHtml(eventVisualKind(event))}">
      <div class="timeline-node-row">
        <span class="timeline-event-marker" aria-hidden="true"></span>
        <span class="timeline-node-title">${title}</span>
        <time class="timeline-node-meta" datetime="${escapeHtml(event.timestamp ?? '')}">${escapeHtml(formatTimestamp(event.timestamp))}</time>
        <span class="timeline-event-relation">${inlineSummary}</span>
      </div>
    </div>`
  }
  return `<details class="timeline-tree-node ${escapeHtml(eventVisualKind(event))}"${node.children.length > 0 ? ' open' : ''}>
    <summary class="timeline-node-summary">
      <span class="timeline-event-marker" aria-hidden="true"></span>
      <span class="timeline-node-title">${title}</span>
      <time class="timeline-node-meta" datetime="${escapeHtml(event.timestamp ?? '')}">${escapeHtml(formatTimestamp(event.timestamp))}</time>
      <span class="timeline-event-relation">${inlineSummary}</span>
    </summary>
    <div class="timeline-node-body">
      ${isSubagentEvent(event) || isSubagentResult(event) ? '<span class="timeline-badge">Subagent</span>' : ''}
      ${eventIdentity(event)}
      <div class="detail-fields">${timelineEventDetailFields(node.presentation).join('')}</div>
      ${renderEventContent(event)}
      ${node.children.length > 0 ? `<div class="timeline-tree-children">${node.children.map(renderTimelineTreeNode).join('')}</div>` : ''}
    </div>
  </details>`
}

function isExpandableTimelineNode(node: TimelineTreeNode): boolean {
  if (node.children.length > 0) return true
  const { event } = node.presentation
  return Boolean(
    event.usage ||
    event.durationMs !== undefined ||
    event.timeToFirstTokenMs !== undefined ||
    event.turnId ||
    event.requestId ||
    event.content?.text !== undefined ||
    isSubagentEvent(event) ||
    isSubagentResult(event) ||
    eventDetailFields(event).length > 0,
  )
}

function timelineInlineSummary(presentation: TimelinePresentation): string {
  const { event, relation, cumulativeTokens, cumulativeTokensPartial } = presentation
  const facts = [
    relation,
    event.kind === 'model_request' && event.usage
      ? `Request tokens ${formatNumber(event.usage.totalTokens)}`
      : event.usage
        ? `${formatNumber(event.usage.totalTokens)} tokens`
        : '',
    cumulativeTokens !== undefined
      ? `${cumulativeTokensPartial ? 'Visible cumulative tokens' : 'Cumulative tokens'} ${formatNumber(cumulativeTokens)}`
      : '',
    event.durationMs !== undefined ? formatDuration(event.durationMs) : '',
    event.timeToFirstTokenMs !== undefined ? `TTFT ${formatDuration(event.timeToFirstTokenMs)}` : '',
    event.success !== undefined ? (event.success ? 'Succeeded' : 'Failed') : '',
    detailNumber(event, 'exitCode') !== undefined ? `Exit ${formatNumber(detailNumber(event, 'exitCode')!)}` : '',
    detailNumber(event, 'originalTokenCount') !== undefined
      ? `${formatNumber(detailNumber(event, 'originalTokenCount')!)} output tokens`
      : '',
    detailString(event, 'subagentType') ?? detailString(event, 'agentType') ?? '',
    detailNumber(event, 'totalTokens') !== undefined
      ? `${formatNumber(detailNumber(event, 'totalTokens')!)} agent tokens`
      : '',
    timelineContentState(event),
  ]
  return facts.filter(Boolean).map(escapeHtml).join(' &middot; ')
}

function timelineContentState(event: ChatDetailEvent): string {
  if (!event.content) return 'No content captured'
  if (event.content.text !== undefined) {
    return event.content.truncated
      ? `${formatNumber(event.content.emittedChars)} of ${formatNumber(event.content.originalChars)} chars shown`
      : `${formatNumber(event.content.emittedChars)} chars shown`
  }
  return event.content.originalChars > 0
    ? `${formatNumber(event.content.originalChars)} chars hidden`
    : 'Content hidden'
}

function timelineEventDetailFields(presentation: TimelinePresentation): string[] {
  const { event, cumulativeTokens, cumulativeTokensPartial } = presentation
  const usageFields =
    event.kind === 'model_request' && event.usage
      ? [
          chatField('Request tokens', formatNumber(event.usage.totalTokens), true),
          cumulativeTokens !== undefined
            ? chatField(
                cumulativeTokensPartial ? 'Visible cumulative tokens' : 'Cumulative tokens',
                formatNumber(cumulativeTokens),
                true,
              )
            : '',
        ]
      : event.usage
        ? [
            chatField('Input', formatNumber(event.usage.inputTokens), true),
            chatField('Cached', formatNumber(event.usage.cachedInputTokens), true),
            chatField('Output', formatNumber(event.usage.outputTokens), true),
            chatField('Total', formatNumber(event.usage.totalTokens), true),
          ]
        : []
  return [
    ...usageFields,
    event.durationMs !== undefined ? chatField('Duration', formatDuration(event.durationMs)) : '',
    event.timeToFirstTokenMs !== undefined ? chatField('TTFT', formatDuration(event.timeToFirstTokenMs)) : '',
    event.success !== undefined ? chatField('Result', event.success ? 'Succeeded' : 'Failed') : '',
    ...eventDetailFields(event),
  ].filter(Boolean)
}

function eventTitle(event: ChatDetailEvent): string {
  if (event.kind === 'user_message') return 'User input'
  if (event.kind === 'assistant_message') return 'Agent response'
  if (event.kind === 'model_request') return 'Model request'
  if (event.kind === 'tool_call') return isSubagentEvent(event) ? 'Delegate to agent' : 'Tool call'
  if (event.kind === 'tool_result') return isSubagentResult(event) ? 'Subagent result' : 'Tool result'
  if (event.kind === 'reasoning') return 'Reasoning'
  if (event.kind === 'turn') return 'Agent turn'
  if (event.kind === 'session') return 'Session'
  return event.kind.replaceAll('_', ' ')
}

function eventVisualKind(event: ChatDetailEvent): string {
  if (event.kind === 'user_message') return 'user'
  if (event.kind === 'tool_call') return isSubagentEvent(event) ? 'subagent' : 'tool'
  if (event.kind === 'tool_result') return isSubagentResult(event) ? 'subagent' : 'result'
  if (event.kind === 'reasoning') return 'reasoning'
  return 'agent'
}

function isSubagentEvent(event: ChatDetailEvent): boolean {
  if (event.kind !== 'tool_call') return false
  const name = event.toolName?.toLowerCase()
  return name === 'agent' || name === 'task' || name === 'spawn_agent' || name === 'delegate'
}

function isSubagentResult(event: ChatDetailEvent): boolean {
  return (
    event.kind === 'tool_result' &&
    (detailString(event, 'agentId') !== undefined || detailString(event, 'agentType') !== undefined)
  )
}

function eventDetailFields(event: ChatDetailEvent): string[] {
  const fields: string[] = []
  const subagentType = detailString(event, 'subagentType') ?? detailString(event, 'agentType')
  const subagentModel = detailString(event, 'subagentModel')
  const agentId = detailString(event, 'agentId')
  const status = detailString(event, 'status')
  const totalDurationMs = detailNumber(event, 'totalDurationMs')
  const totalTokens = detailNumber(event, 'totalTokens')
  const totalToolUseCount = detailNumber(event, 'totalToolUseCount')
  const argumentKeys = detailStrings(event, 'argumentKeys') ?? detailStrings(event, 'inputKeys')
  const resultKeys = detailStrings(event, 'resultKeys')
  const filePath = detailString(event, 'filePath')
  const exitCode = detailNumber(event, 'exitCode')
  const originalTokenCount = detailNumber(event, 'originalTokenCount')
  const chunkId = detailString(event, 'chunkId')
  const actionType = detailString(event, 'actionType')
  if (subagentType) fields.push(chatField('Agent type', subagentType))
  if (subagentModel) fields.push(chatField('Agent model', subagentModel))
  if (agentId) fields.push(chatField('Agent ID', agentId))
  if (status) fields.push(chatField('Agent status', status))
  if (totalDurationMs !== undefined) fields.push(chatField('Agent duration', formatDuration(totalDurationMs)))
  if (totalTokens !== undefined) fields.push(chatField('Agent tokens', formatNumber(totalTokens), true))
  if (totalToolUseCount !== undefined) fields.push(chatField('Agent tools', formatNumber(totalToolUseCount), true))
  if (argumentKeys?.length) fields.push(chatField('Argument fields', argumentKeys.join(', ')))
  if (resultKeys?.length) fields.push(chatField('Result fields', resultKeys.join(', ')))
  if (filePath) fields.push(chatField('File', filePath))
  if (exitCode !== undefined) fields.push(chatField('Exit code', formatNumber(exitCode), true))
  if (originalTokenCount !== undefined) {
    fields.push(chatField('Output tokens', formatNumber(originalTokenCount), true))
  }
  if (chunkId) fields.push(chatField('Chunk ID', chunkId))
  if (actionType) fields.push(chatField('Action type', actionType))
  return fields
}

function detailString(event: ChatDetailEvent, key: string): string | undefined {
  const value = event.details?.[key]
  return typeof value === 'string' && value ? value : undefined
}

function detailStrings(event: ChatDetailEvent, key: string): string[] | undefined {
  const value = event.details?.[key]
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function renderEventContent(event: ChatDetailEvent): string {
  if (event.content?.text === undefined || event.content.emittedChars === 0) return ''
  const labels: Partial<Record<ChatDetailEvent['kind'], string>> = {
    user_message: 'User message',
    assistant_message: 'Agent response',
    reasoning: 'Reasoning summary',
    tool_call: 'Arguments / command',
    tool_result: 'Output',
    attachment: 'Attachment',
  }
  const label = labels[event.kind] ?? 'Captured content'
  const text =
    event.kind === 'tool_call' || event.kind === 'tool_result' ? formatToolContent(event) : event.content.text
  return `<div class="captured-content">
    <div class="captured-content-label">${label}${event.content.truncated ? ' (truncated)' : ''}</div>
    <pre>${escapeHtml(text)}</pre>
  </div>`
}

function formatToolContent(event: ChatDetailEvent): string {
  const text = event.content?.text ?? ''
  if (event.kind !== 'tool_call') return text
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return text
    const value = parsed as Record<string, unknown>
    const command = value.cmd ?? value.command
    if (typeof command === 'string') return command
    return JSON.stringify(parsed, null, 2)
  } catch {
    return text
  }
}

function eventIdentity(event: ChatDetailEvent): string {
  const values = [
    event.turnId ? `turn ${event.turnId}` : '',
    event.requestId ? `request ${event.requestId}` : '',
    event.toolCallId ? `tool call ${event.toolCallId}` : '',
  ].filter(Boolean)
  return values.length > 0
    ? `<div class="detail-entry-description">${values.map(escapeHtml).join(' &middot; ')}</div>`
    : ''
}
