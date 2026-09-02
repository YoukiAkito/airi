import type { SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { providerIndexTtsVllm } from './index'

const noopValidatorContext = ({ t }: { t: (input: string) => string }) => t('key')

describe('index-tts-vllm provider definition', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function jsonResponse(body: unknown, ok = true, status = 200) {
    return {
      ok,
      status,
      statusText: ok ? 'OK' : 'Error',
      json: async () => body,
    } as Response
  }

  async function speechProvider(config: Record<string, unknown>) {
    const provider = await providerIndexTtsVllm.createProvider(config as never)
    return provider as unknown as SpeechProviderWithExtraOptions<string, Record<string, unknown>>
  }

  describe('speech() options', () => {
    it('builds v2 request with response_format, speed and default lang', async () => {
      const provider = await speechProvider({ baseUrl: '', model: 'IndexTeam/IndexTTS-2.5' })

      const opts = provider.speech('IndexTeam/IndexTTS-2.5', {})

      expect(opts.baseURL).toBe('http://localhost:8092/v1/')
      expect(opts.model).toBe('IndexTeam/IndexTTS-2.5')
      expect(opts.response_format).toBe('wav')
      expect(opts.speed).toBe(1)
      expect(opts.extra_params).toEqual({ lang: 'zh' })
    })

    it('merges per-request options into extra_params', async () => {
      const provider = await speechProvider({ baseUrl: '', model: 'IndexTeam/IndexTTS-2.5' })

      const opts = provider.speech('IndexTeam/IndexTTS-2.5', {
        lang: 'ja',
        speed: 1.5,
        textNormalization: false,
        emoText: '开心',
      })

      expect(opts.speed).toBe(1.5)
      expect(opts.extra_params).toEqual({
        lang: 'ja',
        text_normalization: false,
        emo_text: '开心',
      })
    })

    it('prefers explicit baseUrl from config', async () => {
      const provider = await speechProvider({
        baseUrl: 'http://10.0.0.8:8092/v1/',
        model: 'IndexTeam/IndexTTS-2.5',
      })

      const opts = provider.speech('IndexTeam/IndexTTS-2.5', {})

      expect(opts.baseURL).toBe('http://10.0.0.8:8092/v1/')
    })
  })

  describe('extraMethods.listVoices', () => {
    it('parses the OpenAI-style data array payload', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        object: 'list',
        data: [
          { name: 'demo_boy', path: '/data/voices/demo_boy.wav' },
          { name: 'demo_girl', path: '/data/voices/demo_girl.wav' },
        ],
      }))

      const voices = await providerIndexTtsVllm.extraMethods!.listVoices!(
        { baseUrl: '', model: 'IndexTeam/IndexTTS-2.5' } as never,
        null as never,
      )

      expect(voices.map(v => v.id)).toEqual(['demo_boy', 'demo_girl'])
      expect(voices[0]).toMatchObject({ id: 'demo_boy', provider: 'index-tts-vllm' })
      expect(fetchMock).toHaveBeenCalledWith('http://localhost:8092/v1/audio/voices')
    })

    it('parses the legacy voices array payload', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ voices: ['demo_voice', '内置音色'] }))

      const voices = await providerIndexTtsVllm.extraMethods!.listVoices!(
        { baseUrl: '', model: 'IndexTeam/IndexTTS-2.5' } as never,
        null as never,
      )

      expect(voices).toHaveLength(2)
      expect(voices[0]).toMatchObject({ id: 'demo_voice', provider: 'index-tts-vllm' })
    })

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}, false, 500))

      await expect(providerIndexTtsVllm.extraMethods!.listVoices!(
        { baseUrl: '', model: 'IndexTeam/IndexTTS-2.5' } as never,
        null as never,
      )).rejects.toThrow('Failed to fetch voices')
    })
  })

  describe('extraMethods.createVoice / deleteVoice', () => {
    it('posts a multipart form without Authorization header', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}))

      const file = new File(['audio-bytes'], 'my_voice.wav', { type: 'audio/wav' })
      const created = await providerIndexTtsVllm.extraMethods!.createVoice!(
        { baseUrl: '', model: 'IndexTeam/IndexTTS-2.5' } as never,
        null as never,
        { file, name: 'my_voice', speakerDescription: 'demo voice', consent: true },
      )

      expect(created).toMatchObject({ id: 'my_voice', name: 'my_voice' })

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('http://localhost:8092/v1/audio/voices')
      expect(init.method).toBe('POST')
      expect(new Headers(init.headers).get('Authorization')).toBeNull()

      const form = init.body as FormData
      const entries: Record<string, unknown> = {}
      form.forEach((value, key) => {
        entries[key] = value
      })
      expect(entries.audio_sample).toBe(file)
      expect(entries.consent).toBe('true')
      expect(entries.name).toBe('my_voice')
      expect(entries.speaker_description).toBe('demo voice')
    })

    it('defaults name from the file name and sends consent false', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}))

      const file = new File(['audio-bytes'], 'speaker_a.wav', { type: 'audio/wav' })
      const created = await providerIndexTtsVllm.extraMethods!.createVoice!(
        { baseUrl: '', model: 'IndexTeam/IndexTTS-2.5' } as never,
        null as never,
        { file, consent: false },
      )

      expect(created.id).toBe('speaker_a')

      const form = (fetchMock.mock.calls[0][1] as RequestInit).body as FormData
      expect(form.get('name')).toBe('speaker_a')
      expect(form.get('consent')).toBe('false')
    })

    it('sanitizes a non-ASCII file name to the allowed voice-name charset', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}))

      const file = new File(['audio-bytes'], '训练片段1.wav', { type: 'audio/wav' })
      const created = await providerIndexTtsVllm.extraMethods!.createVoice!(
        { baseUrl: '', model: 'IndexTeam/IndexTTS-2.5' } as never,
        null as never,
        { file, consent: true },
      )

      const form = (fetchMock.mock.calls[0][1] as RequestInit).body as FormData
      const sentName = form.get('name') as string
      expect(sentName).toMatch(/^[\w-]+$/)
      expect(sentName).not.toMatch(/[\u4E00-\u9FFF]/)
      expect(created.id).toBe(sentName)
      expect(created.name).toBe(sentName)
    })

    it('falls back to a generated name when sanitizing leaves an empty string', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}))

      const file = new File(['audio-bytes'], '我的声音.wav', { type: 'audio/wav' })
      const created = await providerIndexTtsVllm.extraMethods!.createVoice!(
        { baseUrl: '', model: 'IndexTeam/IndexTTS-2.5' } as never,
        null as never,
        { file, consent: true },
      )

      const form = (fetchMock.mock.calls[0][1] as RequestInit).body as FormData
      const sentName = form.get('name') as string
      expect(sentName).toMatch(/^voice-\d+$/)
      expect(created.id).toBe(sentName)
    })

    it('appends the server detail to the error message on a 400 response', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ detail: 'name must match [A-Za-z0-9_-]+' }, false, 400),
      )

      const attempt = providerIndexTtsVllm.extraMethods!.createVoice!(
        { baseUrl: '', model: 'IndexTeam/IndexTTS-2.5' } as never,
        null as never,
        { file: new File(['audio-bytes'], 'voice.wav', { type: 'audio/wav' }), name: 'voice', consent: true },
      )

      await expect(attempt).rejects.toThrow('Failed to create voice: HTTP 400')
      await expect(attempt).rejects.toThrow('name must match [A-Za-z0-9_-]+')
    })

    it('appends the server detail to the error message on delete failure', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ detail: 'voice not found' }, false, 404))

      const attempt = providerIndexTtsVllm.extraMethods!.deleteVoice!(
        { baseUrl: '', model: 'IndexTeam/IndexTTS-2.5' } as never,
        null as never,
        'missing-voice',
      )

      await expect(attempt).rejects.toThrow('Failed to delete voice: HTTP 404')
      await expect(attempt).rejects.toThrow('voice not found')
    })

    it('deletes with an encoded voice id', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}))

      await providerIndexTtsVllm.extraMethods!.deleteVoice!(
        { baseUrl: '', model: 'IndexTeam/IndexTTS-2.5' } as never,
        null as never,
        'my voice/中日',
      )

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe(`http://localhost:8092/v1/audio/voices/${encodeURIComponent('my voice/中日')}`)
      expect(init.method).toBe('DELETE')
    })
  })

  describe('extraMethods.listModels', () => {
    it('discovers models from GET /v1/models', async () => {
      fetchMock.mockResolvedValue(jsonResponse({
        data: [
          { id: 'IndexTeam/IndexTTS-2.5' },
          { id: 'my-custom-tts' },
          { id: 'IndexTTS-2' },
        ],
      }))

      const models = await providerIndexTtsVllm.extraMethods!.listModels!(
        { baseUrl: '', model: 'IndexTeam/IndexTTS-2.5' } as never,
        null as never,
      )

      expect(models.map(m => m.id)).toEqual(['IndexTeam/IndexTTS-2.5', 'my-custom-tts', 'IndexTTS-2'])
      expect(models.every(m => m.deprecated === false)).toBe(true)
      expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8092/v1/models')
    })

    it('falls back to the default 2.5 model name when the server is unreachable', async () => {
      fetchMock.mockRejectedValue(new TypeError('network down'))

      const models = await providerIndexTtsVllm.extraMethods!.listModels!(
        { baseUrl: '', model: 'IndexTeam/IndexTTS-2.5' } as never,
        null as never,
      )

      expect(models.map(m => m.id)).toEqual(['IndexTeam/IndexTTS-2.5'])
      expect(models[0].deprecated).toBe(false)
    })

    it('falls back when the response carries no model data', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: [] }))

      const models = await providerIndexTtsVllm.extraMethods!.listModels!(
        { baseUrl: '', model: 'IndexTeam/IndexTTS-2.5' } as never,
        null as never,
      )

      expect(models).toHaveLength(1)
      expect(models[0].id).toBe('IndexTeam/IndexTTS-2.5')
    })
  })

  describe('config schema', () => {
    it('defaults to IndexTTS-2.5 and the vLLM-Omni base URL', async () => {
      const config = await providerIndexTtsVllm.createProviderConfig(noopValidatorContext as never)
      const parsed = z.parse(config, {})

      expect(parsed.baseUrl).toBe('http://localhost:8092/v1/')
      expect(parsed.model).toBe('IndexTeam/IndexTTS-2.5')
    })
  })
})
