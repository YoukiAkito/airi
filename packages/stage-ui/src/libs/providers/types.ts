import type { ProviderDefinition as CoreProviderDefinition } from '@proj-airi/provider-inference'

import type { ProviderViews } from './views'

export type ProviderInstance
  = | ChatProvider
    | ChatProviderWithExtraOptions
    | EmbedProvider
    | EmbedProviderWithExtraOptions
    | SpeechProvider
    | SpeechProviderWithExtraOptions
    | TranscriptionProvider
    | TranscriptionProviderWithExtraOptions
    | ModelProvider
    | ModelProviderWithExtraOptions

/** Validation lifecycle for one serializable provider configuration. */
export type ProviderValidationStatus = 'unconfigured' | 'validating' | 'configured' | 'invalid' | 'bypassed'
export type ProviderConfiguredBy = 'user' | 'authentication'

/** Serializable configuration for one provider instance. */
export interface InferenceServiceProvider {
  /** Stable provider instance id. */
  id: string
  /** Provider definition id from the built-in provider registry. */
  definitionId: string
  /** Provider-specific configuration values. */
  config: Record<string, unknown>
  /** Current validation state for this provider configuration. */
  status: ProviderValidationStatus
  /** Lifecycle owner that creates and revokes this provider configuration. */
  configuredBy: ProviderConfiguredBy
}

export function isModelProvider(providerInstance: ProviderInstance): providerInstance is ModelProvider | ModelProviderWithExtraOptions {
  if ('model' in providerInstance && typeof providerInstance.model === 'function') {
    return true
  }

  return false
}

export interface ProviderOnboardingField {
  key: string
  type: 'text' | 'password'
  label: string
  description?: string
  placeholder?: string
  required?: boolean
  defaultValue?: string
}

/** Inputs available while a Provider builds its configuration schema. */
export interface ProviderConfigContext<TConfig> {
  /** Cancels runtime discovery that contributes schema metadata. */
  abortSignal?: AbortSignal
  /** Current draft values. Providers can use them to resolve dependent fields. */
  config?: Partial<TConfig>
  /** Translates labels and descriptions for the active interface locale. */
  t: ComposerTranslation
}

export interface ProviderExtraMethods<TConfig> {
  listModels?: (config: TConfig, provider: ProviderInstance, contextOptions?: { t: (input: string) => string }) => Promise<ModelInfo[]>
  /**
   * Returns the voice catalogue. `model` lets providers whose voices vary by
   * model variant (Volcengine streaming TTS 1.0 vs 2.0 differ in catalogue)
   * narrow the result. Providers with a single catalogue ignore it.
   */
  listVoices?: (config: TConfig, provider: ProviderInstance, model?: string) => Promise<VoiceInfo[]>
  /**
   * Creates a custom voice (e.g. uploading a reference audio) on providers that
   * persist named voices server-side (IndexTTS-2/2.5 vLLM-Omni voice storage).
   */
  createVoice?: (config: TConfig, provider: ProviderInstance, input: ProviderVoiceCreateInput) => Promise<VoiceInfo>
  /** Deletes a previously created custom voice by id. */
  deleteVoice?: (config: TConfig, provider: ProviderInstance, voiceId: string) => Promise<void>
  loadModel?: (config: TConfig, provider: ProviderInstance, hooks?: { onProgress?: (progress: ProgressInfo) => Promise<void> | void }) => Promise<void>
}

/**
 * Input for creating a custom voice via `ProviderExtraMethods.createVoice`.
 */
export interface ProviderVoiceCreateInput {
  file: File | Blob
  name?: string
  speakerDescription?: string
  consent?: boolean
}

export interface ProviderValidationResult {
  errors: Array<{ error: unknown, errorKey?: string }>
  reason: string
  reasonKey: string
  valid: boolean
}

/**
 * Stage-ui extends portable definitions with Vue-owned views.
 *
 * The core provider contract remains runtime-neutral.
 */
export interface ProviderDefinition<TConfig = Record<string, unknown>, TId extends string = string> extends CoreProviderDefinition<TConfig, TId> {
  /** Optional stage-ui views for this Provider. */
  views?: ProviderViews
}

export {
  CHAT_COMPLETIONS_VALIDATOR_ID,
  isModelProvider,
  ProviderValidationCheck,
} from '@proj-airi/provider-inference'

export type {
  ChatReasoningCapability,
  ChatReasoningMode,
  ChatRequestOptions,
  InferenceServiceProvider,
  ModelInfo,
  ProviderConfigContext,
  ProviderConfiguredBy,
  ProviderConfigValidator,
  ProviderExtraMethods,
  ProviderInstance,
  ProviderModelCatalog,
  ProviderOnboardingField,
  ProviderRuntimeValidator,
  ProviderTranslator,
  ProviderValidationResult,
  ProviderValidationStatus,
  ProviderValidatorSchedule,
  VoiceInfo,
} from '@proj-airi/provider-inference'
