import type { CommonRequestOptions } from '@xsai/shared'

import type { ModelInfo, ProviderVoiceCreateInput, VoiceInfo } from '../../types'

import { errorMessageFrom } from '@moeru/std'
import { z } from 'zod'

import { defineProvider } from '../registry'

/** IndexTTS-1.x custom server (Bilibili default port). */
const V1_DEFAULT_BASE_URL = 'http://localhost:11996/tts/'

/** IndexTTS-2 / 2.5 via vLLM-Omni (OpenAI-compatible). */
const V2_DEFAULT_BASE_URL = 'http://localhost:8092/v1/'

const DEFAULT_MODEL = 'IndexTeam/IndexTTS-2.5'

/**
 * Known deployment names, used only when the running server cannot be probed.
 * IndexTTS-1.x custom servers expose no model listing; vLLM-Omni serves an
 * OpenAI-compatible `GET /v1/models`, so live discovery is preferred.
 */
const FALLBACK_MODELS: ModelInfo[] = [
  {
    id: 'IndexTeam/IndexTTS-2.5',
    name: 'IndexTeam/IndexTTS-2.5',
    provider: 'index-tts-vllm',
    description: 'Default model for IndexTTS-2.5 vLLM-Omni deployment',
    contextLength: 0,
    deprecated: false,
  },
  {
    id: 'IndexTTS-2',
    name: 'IndexTTS-2',
    provider: 'index-tts-vllm',
    description: 'IndexTTS-2 via vLLM-Omni',
    contextLength: 0,
    deprecated: true,
  },
  {
    id: 'IndexTTS-1.5',
    name: 'IndexTTS-1.5',
    provider: 'index-tts-vllm',
    description: 'Legacy IndexTTS-1.5 custom server',
    contextLength: 0,
    deprecated: true,
  },
]

const MODEL_PROBE_TIMEOUT_MS = 3000

const indexTtsConfigSchema = z.object({
  baseUrl: z.string().default(V2_DEFAULT_BASE_URL),
  model: z.string().default(DEFAULT_MODEL),
  // Advanced synthesis parameters (written by the settings page).
  lang: z.string().optional(),
  speed: z.number().optional(),
  textNormalization: z.boolean().optional(),
  emoText: z.string().optional(),
})

type IndexTtsConfig = z.input<typeof indexTtsConfigSchema>

const isIndexTts2 = (model: string) => /IndexTTS-2/i.test(model)

function resolveBaseUrl(config: IndexTtsConfig, model?: string): string {
  const resolvedModel = model ?? config.model ?? DEFAULT_MODEL
  const fallback = isIndexTts2(resolvedModel) ? V2_DEFAULT_BASE_URL : V1_DEFAULT_BASE_URL
  const base = config.baseUrl?.trim() || fallback
  return base.endsWith('/') ? base : `${base}/`
}

function voicesUrl(config: IndexTtsConfig, model?: string) {
  return `${resolveBaseUrl(config, model)}audio/voices`
}

/**
 * Parses the `/audio/voices` response payload.
 *
 * - vLLM-Omni (IndexTTS-2/2.5) returns `{ voices: string[] }`.
 * - IndexTTS-1.x custom server returns a plain object keyed by voice name.
 */
function parseVoicesPayload(payload: unknown): VoiceInfo[] {
  if (payload && typeof payload === 'object' && Array.isArray((payload as { voices?: unknown[] }).voices)) {
    return (payload as { voices: string[] }).voices.map(name => ({
      id: name,
      name,
      provider: 'index-tts-vllm',
      languages: [{ code: 'zh', title: 'Chinese' }, { code: 'en', title: 'English' }],
    }))
  }

  if (payload && typeof payload === 'object') {
    return Object.keys(payload as Record<string, unknown>).map(name => ({
      id: name,
      name,
      provider: 'index-tts-vllm',
      languages: [{ code: 'zh', title: 'Chinese' }, { code: 'en', title: 'English' }],
    }))
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

export const providerIndexTtsVllm = defineProvider<IndexTtsConfig>({
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
        const opts: CommonRequestOptions & Partial<Record<string, unknown>> = {
          baseURL: resolveBaseUrl(config, resolvedModel),
          model: resolvedModel,
        }

        if (!isIndexTts2(resolvedModel))
          return opts

        const source = { ...config, ...providerConfig } as Record<string, unknown>
        const extra: CommonRequestOptions & Partial<Record<string, unknown>> = {
          ...opts,
          speed: typeof source.speed === 'number' ? source.speed : 1,
          response_format: 'wav',
        }
        if (typeof source.instructions === 'string' && source.instructions !== '')
          extra.instructions = source.instructions
        extra.extra_params = buildExtraParams(config, providerConfig)

        return extra
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
            const reason = 'Base URL is required. Default to http://localhost:8092/v1/ for IndexTTS-2/2.5.'
            return { errors: [{ error: new Error(reason) }], reason, reasonKey: '', valid: false }
          }

          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 5000)
          try {
            const response = await fetch(voicesUrl(config, config.model), { signal: controller.signal })
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
    listModels: async (config) => {
      // Prefer live discovery: vLLM-Omni exposes an OpenAI-compatible
      // `GET /v1/models`. A custom `--served-model-name` shows up there, which
      // the hard-coded catalogue cannot cover. IndexTTS-1.x custom servers do
      // not implement it and fall back to the known catalogue.
      const baseUrl = resolveBaseUrl(config, config.model)
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
              deprecated: model.id === 'IndexTTS-2' || /IndexTTS-1/i.test(model.id),
            }))
          if (discovered.length > 0)
            return discovered
        }
      }
      catch {
        // unreachable server or probe timeout: fall through to the catalogue
      }

      return FALLBACK_MODELS
    },
    listVoices: async (config, _provider, model) => {
      const response = await fetch(voicesUrl(config, model ?? config.model))
      if (!response.ok)
        throw new Error(`Failed to fetch voices: HTTP ${response.status} ${response.statusText}`)

      return parseVoicesPayload(await response.json())
    },
    createVoice: async (config, _provider, input: ProviderVoiceCreateInput) => {
      const baseUrl = resolveBaseUrl(config, config.model)

      const form = new FormData()
      form.append('audio_sample', input.file)
      form.append('consent', input.consent === false ? 'false' : 'true')

      const fileBaseName = input.file instanceof File ? input.file.name.replace(/\.[^.]+$/, '') : ''
      const name = input.name?.trim() || fileBaseName || 'voice'
      form.append('name', name)
      if (input.speakerDescription?.trim())
        form.append('speaker_description', input.speakerDescription.trim())

      const response = await fetch(`${baseUrl}audio/voices`, {
        method: 'POST',
        body: form,
      })
      if (!response.ok) {
        throw new Error(`Failed to create voice: HTTP ${response.status} ${response.statusText}`)
      }

      return {
        id: name,
        name,
        provider: 'index-tts-vllm',
        languages: [{ code: 'zh', title: 'Chinese' }, { code: 'en', title: 'English' }],
      }
    },
    deleteVoice: async (config, _provider, voiceId) => {
      const baseUrl = resolveBaseUrl(config, config.model)
      const response = await fetch(`${baseUrl}audio/voices/${encodeURIComponent(voiceId)}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        throw new Error(`Failed to delete voice: HTTP ${response.status} ${response.statusText}`)
      }
    },
  },
})
