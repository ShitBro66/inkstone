import { parseFrontMatter } from '@shared/markdown-utils'
import type { Note } from '@shared/types'
import { api } from '../api'
import { t } from '../i18n'
import { findNoteByTitle, useNotes } from '../../store/notes'
import { decodeDataValue } from './data-attr'
import { parseWikiTarget, renderMarkdown } from './renderer'

interface ResolveOptions {
  currentContent: string
  strictLineBreaks?: boolean
  currentTitle: string
  isCurrent?: () => boolean
}

interface ResolveContext extends ResolveOptions {
  rendered: number
  totalChars: number
  fetchCache: Map<string, Promise<Note>>
  rootScope: EmbedScope
}

interface EmbedScope {
  content: string
  title: string
  identity: string
}

interface ResolvedEmbed {
  markdown: string
  label: string
  scope: EmbedScope
  signature: string
}

const MAX_DEPTH = 4
const MAX_EMBEDS = 24
const MAX_TOTAL_CHARS = 2_000_000


export async function resolveNoteEmbeds(root: HTMLElement, options: ResolveOptions): Promise<void> {
  const rootScope: EmbedScope = {
    content: options.currentContent,
    title: options.currentTitle,
    identity: `current:${normalize(options.currentTitle)}`,
  }
  const context: ResolveContext = {
    ...options,
    rendered: 0,
    totalChars: 0,
    fetchCache: new Map(),
    rootScope,
  }
  await resolveWithin(root, context, 0, new Set([`${rootScope.identity}##`]), rootScope)
}

async function resolveWithin(
  root: HTMLElement,
  context: ResolveContext,
  depth: number,
  ancestors: Set<string>,
  scope: EmbedScope,
): Promise<void> {
  const embeds = [...root.querySelectorAll<HTMLElement>('[data-embed-target]')].filter(
    (element) => !element.closest('.note-embed-body') || element.closest('.note-embed-body') === root,
  )
  for (const embed of embeds) {
    if (context.isCurrent && !context.isCurrent()) return
    if (++context.rendered > MAX_EMBEDS || depth >= MAX_DEPTH) {
      showError(embed, t("markdown.embed_nesting_limit_reached"))
      continue
    }

    const raw = decodeDataValue(embed.dataset.embedTarget)
    const target = parseWikiTarget(raw)
    const example = embed.closest<HTMLElement>('[data-markdown-example]')
    const exampleSource = decodeDataValue(example?.dataset.markdownExample)
    const targetScope = exampleSource
      ? {
          content: exampleSource,
          title: scope.title,
          identity: `${context.rootScope.identity}:example:${example?.dataset.markdownExampleId ?? 'local'}`,
        }
      : scope

    try {
      const resolved = await resolveTarget(target, context, targetScope)
      if (!resolved) {
        showError(embed, t("markdown.embedded_note_not_found"))
        continue
      }
      if (ancestors.has(resolved.signature)) {
        showError(embed, t("markdown.embed_nesting_limit_reached"))
        continue
      }
      context.totalChars += resolved.markdown.length
      if (context.totalChars > MAX_TOTAL_CHARS) {
        showError(embed, t("markdown.embedded_content_is_too_large"))
        continue
      }

      const body = embed.querySelector<HTMLElement>('.note-embed-body')
      const head = embed.querySelector<HTMLElement>('.note-embed-head')
      if (!body) continue
      const rendered = renderMarkdown(resolved.markdown, context.strictLineBreaks)
      body.innerHTML = rendered.html
      body.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox').forEach((input) => {
        input.disabled = true
        input.removeAttribute('data-task-line')
        input.setAttribute('aria-label', t("markdown.tasks_in_embedded_notes_are_read_only"))
      })
      body.removeAttribute('aria-busy')
      embed.classList.remove('loading', 'error')
      embed.classList.add('ready')
      if (head) {
        head.textContent = target.alias || resolved.label
        head.dataset.wikilink = target.raw
        head.setAttribute('role', 'link')
        head.setAttribute('tabindex', '0')
      }

      const nextAncestors = new Set(ancestors)
      nextAncestors.add(resolved.signature)
      await resolveWithin(body, context, depth + 1, nextAncestors, resolved.scope)
    } catch {
      showError(embed, t("markdown.could_not_load_embedded_content"))
    }
  }
}

async function resolveTarget(
  target: ReturnType<typeof parseWikiTarget>,
  context: ResolveContext,
  scope: EmbedScope,
): Promise<ResolvedEmbed | null> {
  let content: string
  let title: string
  let identity: string
  if (!target.noteTitle || normalize(target.noteTitle) === normalize(scope.title)) {
    content = scope.content
    title = scope.title || t("common.current_note")
    identity = scope.identity
  } else if (normalize(target.noteTitle) === normalize(context.rootScope.title)) {
    content = context.rootScope.content
    title = context.rootScope.title || t("common.current_note")
    identity = context.rootScope.identity
  } else {
    const summary = findNoteByTitle(target.noteTitle)
    if (!summary) return null
    title = summary.title
    identity = `note:${summary.id}`
    const local = useNotes.getState().contents[summary.id]
    if (local !== undefined) {
      content = local
    } else {
      let request = context.fetchCache.get(summary.id)
      if (!request) {
        request = api.notes.get(summary.id)
        context.fetchCache.set(summary.id, request)
      }
      content = (await request).content
    }
  }

  const body = parseFrontMatter(content).body
  const resolvedScope = { content, title, identity }
  const signature = `${identity}#${target.heading ?? ''}#${target.blockId ?? ''}`
  if (target.blockId) {
    const block = extractBlock(body, target.blockId)
    return block == null ? null : {
      markdown: block,
      label: `${title} › ^${target.blockId}`,
      scope: resolvedScope,
      signature,
    }
  }
  if (target.heading) {
    const section = extractHeadingSection(body, target.heading)
    return section == null ? null : {
      markdown: section,
      label: `${title} › ${target.heading}`,
      scope: resolvedScope,
      signature,
    }
  }
  return { markdown: body, label: title, scope: resolvedScope, signature }
}

export function extractHeadingSection(markdown: string, heading: string): string | null {
  const lines = markdown.split(/\r?\n/)
  const wanted = normalize(stripInlineMarkdown(heading))
  let fence: { char: string; length: number } | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const fenceMarker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fenceMarker) {
      if (!fence) fence = { char: fenceMarker[0]!, length: fenceMarker.length }
      else if (fenceMarker[0] === fence.char && fenceMarker.length >= fence.length) fence = null
      continue
    }
    if (fence) continue
    const match = /^[ \t]{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*(?:\{[^{}]+\})?$/.exec(line)
    if (!match || normalize(stripInlineMarkdown(match[2]!)) !== wanted) continue
    const level = match[1]!.length
    let end = lines.length
    let innerFence: { char: string; length: number } | null = null
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const candidate = lines[cursor]!
      const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(candidate)?.[1]
      if (marker) {
        if (!innerFence) innerFence = { char: marker[0]!, length: marker.length }
        else if (marker[0] === innerFence.char && marker.length >= innerFence.length) innerFence = null
        continue
      }
      if (innerFence) continue
      const next = /^[ \t]{0,3}(#{1,6})[ \t]+/.exec(candidate)
      if (next && next[1]!.length <= level) {
        end = cursor
        break
      }
    }
    return lines.slice(index, end).join('\n').trim()
  }
  return null
}

export function extractBlock(markdown: string, blockId: string): string | null {
  const safeId = blockId.replace(/[^A-Za-z0-9_-]/g, '')
  if (!safeId) return null
  const marker = new RegExp(`(?:^|\\s)\\^${escapeRegExp(safeId)}[ \\t]*$`)
  const lines = markdown.split(/\r?\n/)
  let fence: { char: string; length: number } | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const fenceMarker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (fenceMarker) {
      if (!fence) fence = { char: fenceMarker[0]!, length: fenceMarker.length }
      else if (fenceMarker[0] === fence.char && fenceMarker.length >= fence.length) fence = null
      continue
    }
    if (fence || !marker.test(line)) continue

    const cleaned = line.replace(marker, '').trimEnd()
    if (/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/.test(line)) return cleaned.trim()
    let start = index
    while (start > 0 && lines[start - 1]!.trim() && !/^ {0,3}#{1,6}\s/.test(lines[start - 1]!)) start--
    return [...lines.slice(start, index), cleaned].join('\n').trim()
  }
  return null
}

function showError(embed: HTMLElement, message: string): void {
  embed.classList.remove('loading', 'ready')
  embed.classList.add('error')
  const body = embed.querySelector<HTMLElement>('.note-embed-body')
  if (body) {
    body.textContent = message
    body.removeAttribute('aria-busy')
  }
}

function stripInlineMarkdown(value: string): string {
  return value
    .replace(/\{[^{}]+\}\s*$/, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_whole, target: string, alias?: string) => alias || target)
    .replace(/[*_~`=+]/g, '')
    .trim()
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
