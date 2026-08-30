<script setup lang="ts">
import type { SpeechProvider } from '@xsai-ext/providers/utils'

import {
  SpeechPlayground,
  SpeechProviderSettings,
} from '@proj-airi/stage-ui/components'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useProviderConfigStore } from '@proj-airi/stage-ui/stores/providers/config'
import { useProviderStore } from '@proj-airi/stage-ui/stores/providers/provider'
import { Button, Callout, FieldCheckbox, FieldCombobox, FieldInput, FieldInputFile, FieldRange, FieldTextArea } from '@proj-airi/ui'
import { errorMessageFrom } from '@moeru/std'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'

const { t } = useI18n()

const providerId = 'index-tts-vllm'
const defaultModel = 'IndexTeam/IndexTTS-2.5'

const V1_DEFAULT_BASE_URL = 'http://localhost:11996/tts/'
const V2_DEFAULT_BASE_URL = 'http://localhost:8092/v1/'

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

const isIndexTts2Model = (model: string) => /IndexTTS-2/i.test(model)

// ------------------------------------------------------------------
// Model selection
// ------------------------------------------------------------------

const providerModels = computed(() => providersStore.getModelsForProvider(providerId))
const modelOptions = computed(() => {
  const fallbackOptions = [
    { id: 'IndexTeam/IndexTTS-2.5', name: 'IndexTeam/IndexTTS-2.5' },
    { id: 'IndexTTS-2', name: 'IndexTTS-2 (deprecated)' },
    { id: 'IndexTTS-1.5', name: 'IndexTTS-1.5 (deprecated)' },
  ]

  return (providerModels.value.length > 0 ? providerModels.value : fallbackOptions).map(model => ({
    value: model.id,
    label: model.name,
  }))
})

const model = computed({
  get: () => providers.value[providerId]?.model as string | undefined || defaultModel,
  set: (value) => {
    if (!providers.value[providerId])
      providers.value[providerId] = {}

    providers.value[providerId].model = value
  },
})

const selectedModelIsDeprecated = computed(() => {
  const found = (providerModels.value.length > 0 ? providerModels.value : []).find(m => m.id === model.value)
  return found?.deprecated ?? false
})

// Auto-switch between known default base URLs when the model version changes,
// preserving any user-customized base URL.
watch(model, (newModel) => {
  const current = providers.value[providerId]?.baseUrl as string | undefined
  const isV2 = isIndexTts2Model(newModel)

  if (isV2 && current === V1_DEFAULT_BASE_URL) {
    providers.value[providerId].baseUrl = V2_DEFAULT_BASE_URL
  }
  else if (!isV2 && current === V2_DEFAULT_BASE_URL) {
    providers.value[providerId].baseUrl = V1_DEFAULT_BASE_URL
  }

  speechStore.loadVoicesForProvider(providerId, newModel)
})

// ------------------------------------------------------------------
// Advanced synthesis settings (IndexTTS-2/2.5)
// ------------------------------------------------------------------

const lang = ref<string>('zh')
const speed = ref<number>(1)
const textNormalization = ref<boolean>(true)
const emoText = ref<string>('')

// ------------------------------------------------------------------
// Voice management (upload reference audio + named voices)
// ------------------------------------------------------------------

const availableVoices = computed(() => speechStore.availableVoices[providerId] || [])
const apiKeyConfigured = true // Local deployment, no API key required

const voiceFile = ref<File[] | undefined>(undefined)
const voiceName = ref('')
const speakerDescription = ref('')
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
      speakerDescription: speakerDescription.value.trim() || undefined,
      consent: consent.value,
    })
    if (created) {
      toast(t('settings.pages.providers.provider.index-tts-vllm.voice.upload.success'))
      voiceFile.value = undefined
      voiceName.value = ''
      speakerDescription.value = ''
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

async function handleDeleteVoice(voiceId: string) {
  if (!window.confirm(t('settings.pages.providers.provider.index-tts-vllm.voice.list.delete_confirm')))
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
// Speech playground
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
  if (!providers.value[providerId])
    providers.value[providerId] = {}

  providers.value[providerId].model ??= defaultModel
  lang.value = (providers.value[providerId]?.lang as string | undefined) || 'zh'
  speed.value = typeof providers.value[providerId]?.speed === 'number' ? providers.value[providerId].speed as number : 1
  textNormalization.value = providers.value[providerId]?.textNormalization as boolean | undefined ?? true
  emoText.value = (providers.value[providerId]?.emoText as string | undefined) || ''

  await speechStore.loadVoicesForProvider(providerId, model.value)
})
</script>

<template>
  <SpeechProviderSettings :provider-id="providerId" :default-model="defaultModel">
    <template #voice-settings>
      <FieldCombobox
        v-model="model"
        :label="t('settings.pages.providers.provider.index-tts-vllm.model.label')"
        :description="t('settings.pages.providers.provider.index-tts-vllm.model.description')"
        :options="modelOptions"
        placeholder="IndexTeam/IndexTTS-2.5"
      />

      <Callout v-if="selectedModelIsDeprecated" theme="orange">
        {{ t('settings.pages.providers.provider.index-tts-vllm.model_deprecated_notice') }}
      </Callout>

      <h3 class="text-sm font-medium text-neutral-700 dark:text-neutral-300">
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
      <FieldTextArea
        v-model="speakerDescription"
        :label="t('settings.pages.providers.provider.index-tts-vllm.voice.upload.speaker_description_label')"
        :description="t('settings.pages.providers.provider.index-tts-vllm.voice.upload.speaker_description_placeholder')"
        :rows="2"
        placeholder="IndexTTS-2.5 demo voice"
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

      <h3 class="mt-4 text-sm font-medium text-neutral-700 dark:text-neutral-300">
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
