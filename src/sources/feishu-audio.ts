/** Transcribes Feishu voice messages into trigger text so a spoken message is routed and answered like a typed one. */
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { KV } from '../kv.ts'
import type { Trigger } from '../core/index.ts'
import { SOURCE } from './feishu-trigger.ts'
import type { FeishuConfig } from './feishu.ts'
import type { SourceContext } from './host.ts'

/** Voice messages longer than this are kept as-is; a spoken command is short, and a long recording is a file, not a command. */
export const MAX_AUDIO_SECONDS = 300
/** Prefix that marks trigger text as a machine transcript of a voice message, so readers may expect recognition errors. */
export const TRANSCRIPT_PREFIX = '[语音转写] '
/** Fallbacks keep the raw message body, which carries the `file_key`, so the failure remains diagnosable from the Trigger alone. */
export const AUDIO_FAILED = '[语音消息，转写失败] '
export const AUDIO_SILENT = '[语音消息，未识别到文字] '
export const AUDIO_TOO_LONG = '[语音消息过长，未转写] '
const fileKey = z.string().regex(/^file_[a-zA-Z0-9_-]+$/)
const messageId = z.string().regex(/^om_[a-zA-Z0-9_-]+$/)
/** Retains transcripts for recent voice messages so re-reads (backfill, polling) never run recognition twice per message. */
const TRANSCRIPT_LIMIT = 1000

/** Parses the `{file_key, duration}` body of a Feishu `audio` message; returns undefined for anything else. */
export function feishuAudioBody(text: string): { fileKey: string; duration: number } | undefined {
  const rendered = /<audio\b[^>]*\bkey="(file_[a-zA-Z0-9_-]+)"[^>]*\bduration="(\d+)s"/.exec(text)
  if (rendered) return { fileKey: rendered[1]!, duration: Number(rendered[2]) * 1000 }
  let body: unknown
  try { body = JSON.parse(text) } catch { return undefined }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  const { file_key: key, duration } = body as { file_key?: unknown; duration?: unknown }
  const parsed = fileKey.safeParse(key)
  if (!parsed.success || typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return undefined
  return { fileKey: parsed.data, duration }
}

/** Applies a cached or fresh transcript, or a labeled fallback, to a voice Trigger without mutating the original. */
function rewrite(trigger: Trigger, text: string): Trigger { return { ...trigger, text } }

/**
 * Rewrites a voice-message Trigger's text to its transcript when the Source sets `asrCommand`; returns the Trigger
 * unchanged for every other message, while the command is unset, or when the body carries no file. Recognition
 * failures keep the raw body behind `AUDIO_FAILED` instead of throwing, so one bad clip never stops the event loop.
 */
export async function transcribeFeishuAudio(ctx: SourceContext, trigger: Trigger, signal?: AbortSignal): Promise<Trigger> {
  if (trigger.meta.msgType !== 'audio') return trigger
  const command = ctx.config<FeishuConfig>(SOURCE)?.asrCommand
  if (!command) return trigger
  const body = feishuAudioBody(trigger.text)
  const id = messageId.safeParse(String(trigger.meta.messageId ?? ''))
  if (!body || !id.success) return trigger
  const cached = ctx.state.get(KV.feishu.transcripts)?.[id.data]
  if (cached) return rewrite(trigger, TRANSCRIPT_PREFIX + cached)
  if (body.duration > MAX_AUDIO_SECONDS * 1000) return rewrite(trigger, AUDIO_TOO_LONG + trigger.text)
  const commands = ctx.commands.withSignal(signal)
  let directory: string | undefined
  try {
    directory = await mkdtemp(join(tmpdir(), 'feishu-audio-'))
    const download = z.object({ saved_path: z.string() }).parse(await commands.lark(
      ['im', '+messages-resources-download', '--message-id', id.data, '--file-key', body.fileKey, '--type', 'file', '--output', './voice'], directory))
    const path = await realpath(download.saved_path)
    if (dirname(path) !== await realpath(directory)) throw new Error('Audio download returned a path outside its temporary directory')
    const file = await stat(path)
    if (!file.isFile() || file.size === 0 || file.size > 50 * 1024 * 1024) throw new Error('The downloaded audio is empty, oversized, or not a regular file')
    const transcript = (await commands.run(command, [path], directory)).split(/\s+/).join(' ').trim()
    if (!transcript) return rewrite(trigger, AUDIO_SILENT + trigger.text)
    remember(ctx, id.data, transcript)
    return rewrite(trigger, TRANSCRIPT_PREFIX + transcript)
  } catch (error) {
    if (signal?.aborted) throw error
    return rewrite(trigger, AUDIO_FAILED + trigger.text)
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}

/** Stores a transcript by message ID, evicting the oldest entries beyond `TRANSCRIPT_LIMIT`. */
function remember(ctx: SourceContext, message: string, transcript: string): void {
  const saved = { ...(ctx.state.get(KV.feishu.transcripts) ?? {}), [message]: transcript }
  const entries = Object.entries(saved)
  ctx.state.set(KV.feishu.transcripts, Object.fromEntries(entries.length > TRANSCRIPT_LIMIT ? entries.slice(-TRANSCRIPT_LIMIT) : entries))
}
