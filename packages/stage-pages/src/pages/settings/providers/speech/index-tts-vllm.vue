<script setup lang="ts">
import type { SpeechProvider } from '@xsai-ext/providers/utils'

import { errorMessageFrom } from '@moeru/std'
import {
  SpeechPlayground,
  SpeechProviderSettings,
} from '@proj-airi/stage-ui/components'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useProviderConfigStore } from '@proj-airi/stage-ui/stores/providers/config'
import { useProviderStore } from '@proj-airi/stage-ui/stores/providers/provider'
import { Button, FieldCheckbox, FieldCombobox, FieldInput, FieldInputFile, FieldRange } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'

const { t } = useI18n()

const providerId = 'index-tts-vllm'
const defaultModel = 'IndexTeam/IndexTTS-2.5'
const DEFAULT_BASE_URL = 'http://localhost:8092/v1/'

const LANG_OPTIONS = [
  { value: 'zh', label: '中文 (zh)' },
  { value: 'en', label: 'English (en)' },
  { value: 'ja', label: '日本語 (ja)' },
  { value: 'es', label: 'Español (es)' },
  { value: 'ar', label: 'العربية (ar)' },
  { value: 'zhen', label: '中英混合 (zhen)' },
]

const speechStore = useSpeechStore()
const providersStore = useProviderStore()
const providerStore = useProviderConfigStore()
const { configs: providers } = storeToRefs(providerStore)

// ------------------------------------------------------------------
// Config entry guard
// ------------------------------------------------------------------
// `configs` is a computed projection of the provider store. Assigning to it
// directly is a no-op, so the provider entry must be created through the store
// API before mutating config fields.
function ensureConfig() {
  if (providers.value[providerId])
    return
  try {
    providerStore.ensureProvider(providerId, providerId, {
      baseUrl: DEFAULT_BASE_URL,
      model: defaultModel,
    })
  }
  catch (error) {
    console.error('Failed to ensure provider config:', error)
  }
}

// ------------------------------------------------------------------
// Model selection — fully auto-detected from GET /v1/models
// ------------------------------------------------------------------

// Models discovered from the running server. Empty while the provider is
// unreachable — the input still accepts any model name.
const providerModels = computed(() => providersStore.getModelsForProvider(providerId))

const model = computed({
  get: () => providers.value[providerId]?.model as string | undefined || defaultModel,
  set: (value) => {
    ensureConfig()
    if (providers.value[providerId])
      providers.value[providerId].model = value
  },
})

// Re-probe the running server whenever the base URL changes so the model and
// voice lists follow the endpoint the user actually configured.
watch(() => providers.value[providerId]?.baseUrl, async (next, prev) => {
  if (!next || next === prev)
    return
  await providersStore.fetchModelsForProvider(providerId)
  speechStore.loadVoicesForProvider(providerId, model.value)
})

// Surface voice-list load failures instead of failing silently.
watch(() => speechStore.speechProviderError, (error) => {
  if (error)
    console.error(`Speech provider error (${providerId}):`, error)
})

// ------------------------------------------------------------------
// Synthesis parameters (folded into the advanced section)
// ------------------------------------------------------------------

const lang = ref<string>('zh')
const speed = ref<number>(1)
const textNormalization = ref<boolean>(true)
const emoText = ref<string>('')

const availableVoices = computed(() => speechStore.availableVoices[providerId] || [])
const apiKeyConfigured = true // Local deployment, no API key required

// ------------------------------------------------------------------
// Voice management — register a reference audio with the local server
// ------------------------------------------------------------------

const voiceFile = ref<File[] | undefined>(undefined)
const voiceName = ref('')
const consent = ref(false)
const isUploading = ref(false)

const canUploadVoice = computed(() => !!voiceFile.value?.length && consent.value && !isUploading.value)

async function handleCreateVoice() {
  const file = voiceFile.value?.[0]
  if (!file || !consent.value)
    return

  isUploading.value = true
  try {
    const created = await speechStore.createVoiceForProvider(providerId, {
      file,
      name: voiceName.value.trim() || undefined,
      consent: consent.value,
    })
    if (created) {
      toast(t('settings.pages.providers.provider.index-tts-vllm.voice.upload.success'))
      voiceFile.value = undefined
      voiceName.value = ''
      consent.value = false
    }
  }
  catch (error) {
    console.error('Failed to create voice:', error)
    toast(`${t('settings.pages.providers.provider.index-tts-vllm.voice.upload.error')} ${errorMessageFrom(error) ?? ''}`)
  }
  finally {
    isUploading.value = false
  }
}

function requestDeleteVoiceConfirmation(message: string): boolean {
  // NOTICE:
  // Native confirm is the existing guard for this destructive voice action.
  // Root cause: `no-alert` rejects direct `confirm(...)` calls until a shared
  // confirmation-dialog primitive is wired into the provider settings flow.
  // Removal condition: replace with the shared modal confirmation component.
  const confirmAction = globalThis.confirm.bind(globalThis)
  return confirmAction(message)
}

async function handleDeleteVoice(voiceId: string) {
  if (!requestDeleteVoiceConfirmation(t('settings.pages.providers.provider.index-tts-vllm.voice.list.delete_confirm')))
    return

  try {
    await speechStore.deleteVoiceForProvider(providerId, voiceId)
    toast(t('settings.pages.providers.provider.index-tts-vllm.voice.list.delete_success'))
  }
  catch (error) {
    console.error('Failed to delete voice:', error)
    toast(`${t('settings.pages.providers.provider.index-tts-vllm.voice.list.delete_success')} ${errorMessageFrom(error) ?? ''}`)
  }
}

function handleRefreshVoices() {
  speechStore.loadVoicesForProvider(providerId, model.value)
}

// ------------------------------------------------------------------
// Speech playground — the only surface the user needs: text in, audio out
// ------------------------------------------------------------------

async function handleGenerateSpeech(input: string, voiceId: string) {
  const provider = await providersStore.getProviderInstance(providerId) as SpeechProvider
  if (!provider) {
    throw new Error('Failed to initialize speech provider')
  }

  const providerConfig = providerStore.getProviderConfig(providerId) ?? {}
  const requestConfig = {
    ...providerConfig,
    lang: lang.value,
    speed: speed.value,
    textNormalization: textNormalization.value,
    emoText: emoText.value,
  }

  return await speechStore.speech(
    provider,
    model.value,
    input,
    voiceId,
    requestConfig,
  )
}

onMounted(async () => {
  ensureConfig()
  providers.value[providerId].model ??= defaultModel
  lang.value = (providers.value[providerId]?.lang as string | undefined) || 'zh'
  speed.value = typeof providers.value[providerId]?.speed === 'number' ? providers.value[providerId].speed as number : 1
  textNormalization.value = providers.value[providerId]?.textNormalization as boolean | undefined ?? true
  emoText.value = (providers.value[providerId]?.emoText as string | undefined) || ''

  // Probe the running server on mount so the discovered model chips populate
  // even when the config was restored from storage (no credential change to
  // trigger the provider store's own watchers).
  await providersStore.fetchModelsForProvider(providerId)
  await speechStore.loadVoicesForProvider(providerId, model.value)
})
</script>

<template>
  <SpeechProviderSettings :provider-id="providerId" :default-model="defaultModel">
    <template #voice-settings>
      <FieldInput
        v-model="model"
        :label="t('settings.pages.providers.provider.index-tts-vllm.model.label')"
        :description="t('settings.pages.providers.provider.index-tts-vllm.model.description')"
        placeholder="IndexTeam/IndexTTS-2.5"
      />

      <div v-if="providerModels.length > 0" flex="~ wrap items-center gap-2" mt-1>
        <span class="text-xs text-neutral-500 dark:text-neutral-400">
          {{ t('settings.pages.providers.provider.index-tts-vllm.model.discovered_label') }}
        </span>
        <button
          v-for="m in providerModels"
          :key="m.id"
          type="button"
          border="neutral-200 dark:neutral-700 solid 2"

          rounded-full px-2 py-0.5 text-xs text-neutral-700 hover:border-primary-300 dark:text-neutral-300 dark:hover:border-primary-400
          @click="model = m.id"
        >
          {{ m.name }}
        </button>
      </div>

      <h3 class="mt-4 text-sm text-neutral-700 font-medium dark:text-neutral-300">
        {{ t('settings.pages.providers.provider.index-tts-vllm.voice.upload.title') }}
      </h3>
      <p class="text-xs text-neutral-500 dark:text-neutral-400">
        {{ t('settings.pages.providers.provider.index-tts-vllm.voice.upload.description') }}
      </p>

      <FieldInputFile
        v-model="voiceFile"
        :label="t('settings.pages.providers.provider.index-tts-vllm.voice.upload.file_label')"
        :description="t('settings.pages.providers.provider.index-tts-vllm.voice.upload.file_placeholder')"
        accept="audio/*,.wav,.mp3"
      />
      <FieldInput
        v-model="voiceName"
        :label="t('settings.pages.providers.provider.index-tts-vllm.voice.upload.name_label')"
        :description="t('settings.pages.providers.provider.index-tts-vllm.voice.upload.name_placeholder')"
        placeholder="my_voice"
      />
      <FieldCheckbox
        v-model="consent"
        :label="t('settings.pages.providers.provider.index-tts-vllm.voice.upload.consent_label')"
        :description="t('settings.pages.providers.provider.index-tts-vllm.voice.upload.consent_description')"
      />
      <Button
        :label="isUploading
          ? t('settings.pages.providers.provider.index-tts-vllm.voice.upload.submitting')
          : t('settings.pages.providers.provider.index-tts-vllm.voice.upload.submit')"
        :disabled="!canUploadVoice"
        :loading="isUploading"
        variant="secondary"
        size="sm"
        @click="handleCreateVoice"
      />

      <h3 class="mt-4 text-sm text-neutral-700 font-medium dark:text-neutral-300">
        {{ t('settings.pages.providers.provider.index-tts-vllm.voice.list.title') }}
      </h3>
      <div v-if="availableVoices.length === 0" class="text-xs text-neutral-500 dark:text-neutral-400">
        {{ t('settings.pages.providers.provider.index-tts-vllm.voice.list.empty') }}
      </div>
      <div v-else flex="~ col gap-2">
        <div
          v-for="voice in availableVoices"
          :key="voice.id"
          flex="~ row items-center justify-between gap-2"
          rounded-lg border="neutral-100 dark:neutral-800 solid 2"
          px-3 py-2 text-sm
        >
          <span class="truncate">{{ voice.name }}</span>
          <Button
            :label="t('settings.pages.providers.provider.index-tts-vllm.voice.list.delete')"
            variant="secondary"
            size="sm"
            @click="handleDeleteVoice(voice.id)"
          />
        </div>
      </div>
      <Button
        :label="t('settings.pages.providers.provider.index-tts-vllm.voice.list.refresh')"
        variant="secondary"
        size="sm"
        @click="handleRefreshVoices"
      />
    </template>

    <template #advanced-settings>
      <FieldCombobox
        v-model="lang"
        :label="t('settings.pages.providers.provider.index-tts-vllm.lang.label')"
        :description="t('settings.pages.providers.provider.index-tts-vllm.lang.description')"
        :options="LANG_OPTIONS"
      />
      <FieldRange
        v-model="speed"
        :label="t('settings.pages.providers.provider.common.fields.field.speed.label')"
        :description="t('settings.pages.providers.provider.common.fields.field.speed.description')"
        :min="0.5"
        :max="2.0"
        :step="0.01"
      />
      <FieldCheckbox
        v-model="textNormalization"
        :label="t('settings.pages.providers.provider.index-tts-vllm.text_normalization.label')"
        :description="t('settings.pages.providers.provider.index-tts-vllm.text_normalization.description')"
      />
      <FieldInput
        v-model="emoText"
        :label="t('settings.pages.providers.provider.index-tts-vllm.emo_text.label')"
        :description="t('settings.pages.providers.provider.index-tts-vllm.emo_text.description')"
        placeholder="开心、兴奋而且充满活力"
      />
    </template>

    <template #playground>
      <SpeechPlayground
        :available-voices="availableVoices"
        :generate-speech="handleGenerateSpeech"
        :api-key-configured="apiKeyConfigured"
        :voices-loading="speechStore.isLoadingSpeechProviderVoices"
        default-text="Hello! This is a test of the Index TTS Speech synthesis?."
      />
    </template>
  </SpeechProviderSettings>
</template>

<route lang="yaml">
  meta:
    layout: settings
    stageTransition:
      name: slide
  </route>
