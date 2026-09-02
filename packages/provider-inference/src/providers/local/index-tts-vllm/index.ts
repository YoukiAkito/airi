import type { CommonRequestOptions } from '@xsai/shared'

import type { ModelInfo, ProviderVoiceCreateInput, VoiceInfo } from '../../types'

import { errorMessageFrom } from '@moeru/std'
import { z } from 'zod'

import { defineProvider } from '../../registry'

/** IndexTTS-2.5 via vLLM-Omni (OpenAI-compatible). */
const DEFAULT_BASE_URL = 'http://localhost:8092/v1/'

const DEFAULT_MODEL = 'IndexTeam/IndexTTS-2.5'

const MODEL_PROBE_TIMEOUT_MS = 3000

const indexTtsConfigSchema = z.object({
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  model: z.string().default(DEFAULT_MODEL),
  // Advanced synthesis parameters (written by the settings page).
  lang: z.string().optional(),
  speed: z.number().optional(),
  textNormalization: z.boolean().optional(),
  emoText: z.string().optional(),
})

type IndexTtsConfig = z.input<typeof indexTtsConfigSchema>

function resolveBaseUrl(config: IndexTtsConfig): string {
  const base = config.baseUrl?.trim() || DEFAULT_BASE_URL
  return base.endsWith('/') ? base : `${base}/`
}

function voicesUrl(config: IndexTtsConfig) {
  return `${resolveBaseUrl(config)}audio/voices`
}

/**
 * Parses the vLLM-Omni `/audio/voices` response payload.
 *
 * The vLLM-Omni deployment used for IndexTTS-2.5 returns an OpenAI-style
 * list object `{ object: 'list', data: [{ name, path, ... }] }`; older
 * builds returned `{ voices: string[] }`. Both shapes are accepted.
 */
function parseVoicesPayload(payload: unknown): VoiceInfo[] {
  if (payload && typeof payload === 'object') {
    const obj = payload as { data?: unknown[], voices?: unknown[] }

    if (Array.isArray(obj.data)) {
      return obj.data
        .filter((entry): entry is { name: string } => (
          typeof entry === 'object'
          && entry !== null
          && typeof (entry as { name?: unknown }).name === 'string'
        ))
        .map(entry => ({
          id: entry.name,
          name: entry.name,
          provider: 'index-tts-vllm',
          languages: [{ code: 'zh', title: 'Chinese' }, { code: 'en', title: 'English' }],
        }))
    }

    if (Array.isArray(obj.voices)) {
      return (obj.voices as string[]).map(name => ({
        id: name,
        name,
        provider: 'index-tts-vllm',
        languages: [{ code: 'zh', title: 'Chinese' }, { code: 'en', title: 'English' }],
      }))
    }
  }

  return []
}

/**
 * Builds the `extra_params` object consumed by the vLLM-Omni `/v1/audio/speech`
 * endpoint. Per-request options win over persisted config values.
 */
function buildExtraParams(config: IndexTtsConfig, providerConfig: Record<string, unknown>): Record<string, unknown> {
  const source = { ...config, ...providerConfig }

  const params: Record<string, unknown> = {
    lang: source.lang ?? 'zh',
  }

  if (source.textNormalization !== undefined)
    params.text_normalization = source.textNormalization
  if (source.emoText !== undefined && source.emoText !== '')
    params.emo_text = source.emoText

  return params
}

const VOICE_NAME_MAX_LENGTH = 64

/**
 * Keeps only characters allowed by the vLLM-Omni voice-name regex
 * `[A-Za-z0-9_-]`, truncating to a sane upper bound. Returns an empty string
 * when nothing survives the filter (callers fall back to a generated name).
 */
function sanitizeVoiceName(candidate: string): string {
  return candidate.replace(/[^\w-]/g, '').slice(0, VOICE_NAME_MAX_LENGTH)
}

/** Reads the `{ detail }` string out of an error response body, if any. */
async function readErrorDetail(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null)
  const detail = (payload as { detail?: unknown } | null)?.detail
  return typeof detail === 'string' && detail !== '' ? detail : ''
}

export const providerIndexTtsVllm = defineProvider<IndexTtsConfig, 'index-tts-vllm'>({
  id: 'index-tts-vllm',
  name: 'Index-TTS by Bilibili',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.index-tts-vllm.title'),
  description: 'index-tts.github.io',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.index-tts-vllm.description'),
  tasks: ['text-to-speech'],
  iconColor: 'i-lobe-icons:bilibiliindex',
  createProviderConfig: () => indexTtsConfigSchema,
  createProvider(config) {
    return {
      speech: (model?: string, providerConfig: Record<string, unknown> = {}): CommonRequestOptions & Partial<Record<string, unknown>> => {
        const resolvedModel = model ?? config.model ?? DEFAULT_MODEL
        const source = { ...config, ...providerConfig } as Record<string, unknown>

        const opts: CommonRequestOptions & Partial<Record<string, unknown>> = {
          baseURL: resolveBaseUrl(config),
          model: resolvedModel,
          speed: typeof source.speed === 'number' ? source.speed : 1,
          response_format: 'wav',
        }
        if (typeof source.instructions === 'string' && source.instructions !== '')
          opts.instructions = source.instructions
        opts.extra_params = buildExtraParams(config, providerConfig)

        return opts
      },
    }
  },
  validationRequiredWhen: config => Boolean(config.baseUrl?.trim()),
  validators: {
    validateConfig: [
      ({ t }) => ({
        id: 'index-tts-vllm:check-config',
        name: t('settings.pages.providers.catalog.edit.validators.openai-compatible.check-config.title'),
        validator: async (config) => {
          const baseUrl = config.baseUrl?.trim() ?? ''
          if (!baseUrl) {
            const reason = 'Base URL is required. Default to http://localhost:8092/v1/ for IndexTTS-2.5.'
            return { errors: [{ error: new Error(reason) }], reason, reasonKey: '', valid: false }
          }

          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 5000)
          try {
            const response = await fetch(voicesUrl(config), { signal: controller.signal })
            if (!response.ok) {
              const reason = `IndexTTS unreachable: HTTP ${response.status} ${response.statusText}`
              return { errors: [{ error: new Error(reason) }], reason, reasonKey: '', valid: false }
            }
          }
          catch (error) {
            const reason = `IndexTTS connection failed: ${errorMessageFrom(error) ?? 'Unknown error'}`
            return { errors: [{ error }], reason, reasonKey: '', valid: false }
          }
          finally {
            clearTimeout(timeout)
          }

          return { errors: [], reason: '', reasonKey: '', valid: true }
        },
      }),
    ],
  },
  extraMethods: {
    // The deployed model name is fully auto-detected from the running server
    // (vLLM-Omni `GET /v1/models`). A custom `--served-model-name` from an
    // integration bundle shows up here. Only falls back to the default 2.5
    // name when the server is unreachable, so a stale entry never blocks the
    // user from typing the real name manually.
    listModels: async (config): Promise<ModelInfo[]> => {
      const baseUrl = resolveBaseUrl(config)
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), MODEL_PROBE_TIMEOUT_MS)
        const response = await fetch(`${baseUrl}models`, { signal: controller.signal })
        clearTimeout(timeout)

        if (response.ok) {
          const payload = await response.json() as { data?: Array<{ id?: string }> }
          const discovered = (payload.data ?? [])
            .filter((model): model is { id: string } => typeof model.id === 'string' && model.id !== '')
            .map(model => ({
              id: model.id,
              name: model.id,
              provider: 'index-tts-vllm' as const,
              contextLength: 0,
              deprecated: false,
            }))
          if (discovered.length > 0)
            return discovered
        }
      }
      catch {
        // unreachable server or probe timeout: degrade to the default name
      }

      return [{
        id: DEFAULT_MODEL,
        name: DEFAULT_MODEL,
        provider: 'index-tts-vllm',
        description: 'Default model name when the server cannot be probed',
        contextLength: 0,
        deprecated: false,
      }]
    },
    listVoices: async (config) => {
      const response = await fetch(voicesUrl(config))
      if (!response.ok) {
        const detail = await readErrorDetail(response)
        throw new Error(`Failed to fetch voices: HTTP ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`)
      }

      return parseVoicesPayload(await response.json())
    },
    createVoice: async (config, _provider, input: ProviderVoiceCreateInput) => {
      const baseUrl = resolveBaseUrl(config)

      const form = new FormData()
      form.append('audio_sample', input.file)
      form.append('consent', input.consent === false ? 'false' : 'true')

      const fileBaseName = input.file instanceof File ? input.file.name.replace(/\.[^.]+$/, '') : ''
      const name = sanitizeVoiceName(input.name?.trim() || fileBaseName) || `voice-${Date.now()}`
      form.append('name', name)
      if (input.speakerDescription?.trim())
        form.append('speaker_description', input.speakerDescription.trim())

      const response = await fetch(`${baseUrl}audio/voices`, {
        method: 'POST',
        body: form,
      })
      if (!response.ok) {
        const detail = await readErrorDetail(response)
        throw new Error(`Failed to create voice: HTTP ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`)
      }

      return {
        id: name,
        name,
        provider: 'index-tts-vllm',
        languages: [{ code: 'zh', title: 'Chinese' }, { code: 'en', title: 'English' }],
      }
    },
    deleteVoice: async (config, _provider, voiceId) => {
      const baseUrl = resolveBaseUrl(config)
      const response = await fetch(`${baseUrl}audio/voices/${encodeURIComponent(voiceId)}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        const detail = await readErrorDetail(response)
        throw new Error(`Failed to delete voice: HTTP ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`)
      }
    },
  },
})
