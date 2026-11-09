import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Commands } from '../src/infra/commands.ts'
import { KV } from '../src/kv.ts'
import type { Trigger } from '../src/core/index.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { AUDIO_FAILED, AUDIO_SILENT, AUDIO_TOO_LONG, feishuAudioBody, transcribeFeishuAudio, TRANSCRIPT_PREFIX } from '../src/sources/feishu-audio.ts'
import { feishuTrigger } from '../src/sources/feishu-trigger.ts'
import type { SourceContext } from '../src/sources/host.ts'

const body = JSON.stringify({ file_key: 'file_v3_00179_sample', duration: 7000 })
const trigger: Trigger = { id: 't', source: 'feishu', threads: [], actor: { source: 'feishu', id: 'ou_user' }, human: true,
  at: '2026-11-09T13:36:19.000Z', text: body, meta: { chatId: 'oc_chat', messageId: 'om_voice', msgType: 'audio' } }
const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
let state: Map<string, unknown>
let asrCommand = '/bin/asr-whisper'
const context = { commands, config: () => ({ asrCommand }),
  state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => {
    if (value === undefined) state.delete(key); else state.set(key, value) } } } as unknown as SourceContext
let lark: MockInstance<Commands['lark']>
let run: MockInstance<Commands['run']>

beforeEach(() => {
  state = new Map()
  asrCommand = '/bin/asr-whisper'
  lark = vi.spyOn(Commands.prototype, 'lark').mockImplementation(async (args, cwd) => {
    expect(args).toEqual(['im', '+messages-resources-download', '--message-id', 'om_voice', '--file-key', 'file_v3_00179_sample', '--type', 'file', '--output', './voice'])
    const saved_path = join(cwd!, 'voice.ogg')
    await writeFile(saved_path, 'ogg-bytes')
    return { saved_path }
  })
  run = vi.spyOn(Commands.prototype, 'run').mockResolvedValue('  你好，帮我看看 PR  \n合并它\n')
})
afterEach(() => vi.restoreAllMocks())

it('recognizes the audio body in rendered and JSON shape among message contents', () => {
  expect(feishuAudioBody(body)).toEqual({ fileKey: 'file_v3_00179_sample', duration: 7000 })
  expect(feishuAudioBody('<audio key="file_v3_00179_sample" duration="7s"/>')).toEqual({ fileKey: 'file_v3_00179_sample', duration: 7000 })
  for (const text of ['plain text', '', '[1,2]', 'null', '{"image_key":"img_v3_x"}', '{"file_key":"file_v3_x","file_name":"a.pdf"}',
    '{"file_key":"bad key","duration":7000}', '<audio key="img_v3_x" duration="7s"/>', '<image key="file_v3_x" duration="7s"/>',
    '{"file_key":"file_v3_x","duration":"7"}']) {
    expect(feishuAudioBody(text)).toBeUndefined()
  }
})
it('carries the message type into Trigger meta so voice detection survives every read path', () => {
  const made = feishuTrigger({ message_id: 'om_voice', chat_id: 'oc_chat', chat_type: 'p2p', sender_id: 'ou_user', sender_type: 'user',
    content: body, msg_type: 'audio', create_time: '1794231379000', mentions: [] }, 'cli_bot', 'app_bot')
  expect(made?.meta).toMatchObject({ msgType: 'audio', messageId: 'om_voice' })
  expect(made?.text).toBe(body)
})
it('transcribes a voice message, records the transcript, and calls the command on the downloaded file', async () => {
  const result = await transcribeFeishuAudio(context, trigger)
  expect(result).not.toBe(trigger)
  expect(result.text).toBe(`${TRANSCRIPT_PREFIX}你好，帮我看看 PR 合并它`)
  expect(result.meta).toEqual(trigger.meta)
  expect(state.get(KV.feishu.transcripts)).toEqual({ om_voice: '你好，帮我看看 PR 合并它' })
  expect(run.mock.calls[0]![0]).toBe('/bin/asr-whisper')
  expect(run.mock.calls[0]![1][0]).toContain('voice.ogg')
})
it('reuses a stored transcript instead of downloading and transcribing again', async () => {
  state.set(KV.feishu.transcripts, { om_voice: '上次已转写' })
  expect((await transcribeFeishuAudio(context, trigger)).text).toBe(`${TRANSCRIPT_PREFIX}上次已转写`)
  expect(lark).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})
it('passes through non-audio triggers, an unset command, and unparseable bodies untouched', async () => {
  const asText = { ...trigger, meta: { ...trigger.meta, msgType: 'text' } }
  expect(await transcribeFeishuAudio(context, asText)).toBe(asText)
  asrCommand = ''
  expect(await transcribeFeishuAudio(context, trigger)).toBe(trigger)
  asrCommand = '/bin/asr-whisper'
  const typed = { ...trigger, text: '普通文字' }
  expect(await transcribeFeishuAudio(context, typed)).toBe(typed)
  const noMessage = { ...trigger, meta: { chatId: 'oc_chat' } }
  expect(await transcribeFeishuAudio(context, noMessage)).toBe(noMessage)
  expect(lark).not.toHaveBeenCalled()
})
it('labels failed, silent, and too-long recordings without caching the failure', async () => {
  run.mockRejectedValue(new Error('asr exited with code 1'))
  expect((await transcribeFeishuAudio(context, trigger)).text).toBe(`${AUDIO_FAILED}${body}`)
  expect(state.get(KV.feishu.transcripts)).toBeUndefined()
  run.mockResolvedValue('   \n ')
  expect((await transcribeFeishuAudio(context, trigger)).text).toBe(`${AUDIO_SILENT}${body}`)
  const long = { ...trigger, text: JSON.stringify({ file_key: 'file_v3_00179_sample', duration: 301_000 }) }
  expect((await transcribeFeishuAudio(context, long)).text).toBe(`${AUDIO_TOO_LONG}${long.text}`)
  expect(run).toHaveBeenCalledTimes(2)
})
it('rejects an audio download that escapes the temporary directory', async () => {
  lark.mockImplementation(async (_args, cwd) => ({ saved_path: join(cwd ?? '.', '..', 'elsewhere.ogg') }))
  expect((await transcribeFeishuAudio(context, trigger)).text).toBe(`${AUDIO_FAILED}${body}`)
  expect(run).not.toHaveBeenCalled()
})
