<script setup lang="ts">
import BbiSelect from '@/components/BbiSelect.vue';
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { LATENT_API_MODEL, testLatentApiConnection } from '@/backends/latentApi';
// latentApi.ts 只 type-import settings,反向值依赖不成环
import {
  LATENT_API_ORIENTATION_LOCKS,
  LATENT_API_SAMPLERS,
  LATENT_API_SCHEDULERS,
  LATENT_API_STEPS,
  settings,
  type LatentApiSampler,
  type LatentApiScheduler,
} from '@/state/settings';
import { computed, ref } from 'vue';

/**
 * 「Latent 原生 API」渠道面板。与旧 Latent 页签(NaiPanel target="latent")完全分开:
 * 那边是 NAI 协议的 latent,这边是 latent.moe 自己的 /api/generate。
 */
const showKey = ref(false);
const testing = ref(false);

const inUse = computed(() => settings.defaultBackend === 'latentapi');
const conn = computed(() => settings.latentApi);

const SAMPLER_OPTIONS = LATENT_API_SAMPLERS.map(value => ({ value, label: value }));
const SCHEDULER_OPTIONS = LATENT_API_SCHEDULERS.map(value => ({ value, label: value }));

/** BbiSelect 按 string 收发;写入前对一遍名单,下拉本就只发合法值,这层只为搭桥。 */
const samplerSel = computed<string>({
  get: () => conn.value.sampler,
  set: v => {
    if ((LATENT_API_SAMPLERS as readonly string[]).includes(v)) conn.value.sampler = v as LatentApiSampler;
  },
});
const schedulerSel = computed<string>({
  get: () => conn.value.scheduler,
  set: v => {
    if ((LATENT_API_SCHEDULERS as readonly string[]).includes(v)) conn.value.scheduler = v as LatentApiScheduler;
  },
});

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '操作已取消';
  return error instanceof Error ? error.message : String(error);
}

async function onTestConnection(): Promise<void> {
  if (testing.value) return;
  testing.value = true;
  try {
    const result = await testLatentApiConnection(conn.value);
    toastr.success(result.message, 'Latent 原生 API');
  } catch (error) {
    toastr.error(errorMessage(error), 'Latent 原生 API 连接失败');
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <div class="panel">
    <p class="bbi-page-intro">
      latent.moe 自己的生图接口(模型 {{ LATENT_API_MODEL }})。与上面的「Latent」页签是两条渠道:
      那边走 NAI 协议,这边走站点原生 API,提示词按 Scene / Char / Description 打包。
    </p>

    <div class="bbi-sections">
      <Collapsible title="配置" :open="true">
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">站点地址</span>
          </div>
          <input class="bbi-input" type="text" v-model="conn.url" placeholder="https://latent.moe" spellcheck="false" />
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">API Key</span>
          </div>
          <div class="key-row">
            <input
              class="bbi-input"
              :type="showKey ? 'text' : 'password'"
              v-model="conn.key"
              placeholder="lat_sk_..."
              spellcheck="false"
            />
            <button class="bbi-btn" type="button" :title="showKey ? '隐藏' : '显示'" @click="showKey = !showKey">
              <Icon :name="showKey ? 'eye-off' : 'eye'" />
            </button>
          </div>
        </div>

        <div class="conn-actions">
          <span v-if="inUse" class="conn-inuse"><Icon name="check" :size="13" /> 当前出图渠道</span>
          <button
            v-else
            class="bbi-btn conn-use"
            type="button"
            title="tag 书写规范会切到 Latent 原生 API"
            @click="settings.defaultBackend = 'latentapi'"
          >
            使用此渠道出图
          </button>
          <button class="bbi-btn" type="button" :disabled="testing" @click="onTestConnection">
            <Icon name="plug" />
            {{ testing ? '连接中…' : '测试连接' }}
          </button>
        </div>
        <p class="bbi-field-hint warn-note">
          站点不允许浏览器直接调用,请求一律经酒馆转发:需要在酒馆的 config.yaml 里设
          <code>enableCorsProxy: true</code> 并重启酒馆。Key 只经过你自己的酒馆服务器。
        </p>
      </Collapsible>

      <Collapsible title="出图参数" :open="true">
        <div class="bbi-select-row">
          <span class="bbi-field-label">画幅方向</span>
          <div class="bbi-segmented" role="tablist" aria-label="Latent 原生 API 画幅方向">
            <button
              v-for="opt in LATENT_API_ORIENTATION_LOCKS"
              :key="opt.value"
              class="bbi-seg"
              :class="{ 'is-on': conn.orientationLock === opt.value }"
              type="button"
              role="tab"
              :aria-selected="conn.orientationLock === opt.value"
              @click="conn.orientationLock = opt.value"
            >
              {{ opt.label }}
            </button>
          </div>
        </div>
        <p class="bbi-field-hint">
          站点只有三档:竖 920×1536、横 1536×920、方 1024×1024。「自动」按每张图 tag 里记的方向出;
          锁定后每张图都按该方向出,自动 tag 也按这个画幅构图。
        </p>

        <div class="be-grid">
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">采样器</span></div>
            <BbiSelect class="be-select" v-model="samplerSel" :options="SAMPLER_OPTIONS" aria-label="采样器" />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">调度器</span></div>
            <BbiSelect class="be-select" v-model="schedulerSel" :options="SCHEDULER_OPTIONS" aria-label="调度器" />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">步数</span></div>
            <input
              class="bbi-input"
              type="number"
              v-model.number="conn.steps"
              :min="LATENT_API_STEPS.min"
              :max="LATENT_API_STEPS.max"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head"><span class="bbi-field-label">种子</span></div>
            <input class="bbi-input" type="number" v-model.number="conn.seed" min="0" />
          </div>
        </div>
        <p class="bbi-field-hint">步数 {{ LATENT_API_STEPS.min }}–{{ LATENT_API_STEPS.max }}(Turbo 版);种子 0 = 每张随机。</p>
      </Collapsible>

      <Collapsible title="提示词" :open="false">
        <div class="bbi-field">
          <div class="bbi-field-head"><span class="bbi-field-label">正向前缀</span></div>
          <input
            class="bbi-input"
            type="text"
            v-model="conn.positivePrefix"
            placeholder="masterpiece, best quality, score_7"
            spellcheck="false"
          />
          <p class="bbi-field-hint">
            拼在 Scene 最前面。分级标签(safe / sensitive / nsfw / explicit)不要写在这里:它由每张图的 Scene 自己写,
            前缀里固定写 safe 会和 nsfw / explicit 打架。
          </p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head"><span class="bbi-field-label">负面提示词</span></div>
          <textarea class="bbi-input" rows="3" v-model="conn.negativePrompt" spellcheck="false" />
          <p class="bbi-field-hint">站点不会自动加默认负面词,这里留空就真的什么都不排除。</p>
        </div>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">生成自然语言</span>
          <input v-model="conn.naturalLanguage" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">
          开:自动 tag 额外写一段英文 Description;关:只写 tag。整串提示词上限 2000 字符,超了出图时会报错,
          不会偷偷截断。
        </p>
      </Collapsible>
    </div>
  </div>
</template>

<style scoped>
.be-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0 12px;
}
@media (max-width: 640px) {
  .be-grid {
    grid-template-columns: 1fr;
  }
}
.be-select {
  width: 100%;
}
.key-row {
  display: flex;
  gap: 8px;
}
.key-row .bbi-input {
  flex: 1 1 auto;
  min-width: 0;
}
.conn-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-top: 12px;
}
.conn-use,
.conn-inuse {
  margin-right: auto;
}
.conn-inuse {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--bbi-accent);
}
.warn-note {
  margin-top: 6px;
  border-left: 2px solid var(--bbi-accent);
  padding-left: 8px;
}
</style>