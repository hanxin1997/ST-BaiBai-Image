<script setup lang="ts">
import BbiCombo from '@/components/BbiCombo.vue';
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import {
  fetchImgRouterModels,
  testImgRouterConnection,
  type ImgRouterModel,
} from '@/backends/imgRouter';
import { settings } from '@/state/settings';
import { computed, ref } from 'vue';

const showKey = ref(false);
const testing = ref(false);
const fetching = ref(false);
const fetchError = ref('');
/** 拉到的模型列表(面板本地态,不进 settings:随时可重拉,存下来只会变味) */
const models = ref<ImgRouterModel[] | null>(null);
const fetchMode = ref<'browser' | 'server' | null>(null);

const inUse = computed(() => settings.defaultBackend === 'imgrouter');
const conn = computed(() => settings.imgrouter);

/** 候选用裸 id:BbiCombo 的值就是输入框文本,若填显示名会把它当模型名发出去。 */
const modelOptions = computed(() => (models.value ?? []).map(m => m.id));

/** 当前所填 id 在列表里的元数据;友好名与归属渠道只在提示行展示,不进输入框。 */
const currentModel = computed(() => {
  const id = conn.value.model.trim();
  if (!id) return null;
  return (models.value ?? []).find(m => m.id === id) ?? null;
});

const modelHint = computed(() => {
  const id = conn.value.model.trim();
  if (!id) return '留空 = 由 ImgRouter 按渠道回落各自的默认模型。';
  const found = currentModel.value;
  if (!found) {
    return models.value
      ? `「${id}」不在拉取到的列表里。ImgRouter 会把它静默换成目标渠道的默认模型,不会报错。`
      : '未拉取模型列表,无法核对该 id。';
  }
  const parts = [found.display, found.ownedBy].filter(Boolean);
  return parts.length ? `${parts.join(' · ')}` : `已选 ${id}`;
});

const fetchStatus = computed(() => {
  if (fetchError.value) return `拉取失败:${fetchError.value}`;
  if (fetchMode.value === 'server') {
    return 'ST 后端转发:只拿得到模型 id,渠道归属与显示名缺失(ImgRouter 补上 CORS 响应头后可直连)';
  }
  return '';
});

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '操作已取消';
  return error instanceof Error ? error.message : String(error);
}

async function onFetchModels(): Promise<void> {
  if (fetching.value) return;
  fetching.value = true;
  fetchError.value = '';
  try {
    const list = await fetchImgRouterModels(conn.value);
    models.value = list.models;
    fetchMode.value = list.mode;
    toastr.success(`已拉取 ${list.models.length} 个模型`, '柏宝绘');
  } catch (error) {
    fetchError.value = errorMessage(error);
    toastr.error(fetchError.value, '拉取模型失败');
  } finally {
    fetching.value = false;
  }
}

async function onTestConnection(): Promise<void> {
  if (testing.value) return;
  testing.value = true;
  try {
    const result = await testImgRouterConnection(conn.value);
    toastr.success(result.message, '柏宝绘');
  } catch (error) {
    toastr.error(errorMessage(error), 'ImgRouter 连接失败');
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <div class="panel">
    <p class="bbi-page-intro">
      ImgRouter 图像生成网关,走其 /v1/images/generations 接口。一个访问令牌后面可挂多个上游渠道
      (火山引擎 / Gitee / ModelScope / HuggingFace),由 ImgRouter 决定发给谁。
    </p>

    <div class="bbi-sections">
      <Collapsible title="配置" :open="true">
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">服务地址</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="conn.url"
            placeholder="http://127.0.0.1:10001"
            spellcheck="false"
          />
          <p class="bbi-field-hint">
            填 API 端口(默认 10001),不是管理界面的 5854。纯域名会自动补 /v1。
          </p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">访问令牌</span>
          </div>
          <div class="key-row">
            <input
              class="bbi-input"
              :type="showKey ? 'text' : 'password'"
              v-model="conn.key"
              placeholder="sk-..."
              spellcheck="false"
            />
            <button
              class="bbi-btn"
              type="button"
              :title="showKey ? '隐藏' : '显示'"
              @click="showKey = !showKey"
            >
              <Icon :name="showKey ? 'eye-off' : 'eye'" />
            </button>
          </div>
          <p class="bbi-field-hint">
            ImgRouter 管理界面「访问令牌」页创建的 token,不是上游渠道的真实 Key。
          </p>
        </div>

        <div class="conn-actions">
          <span v-if="inUse" class="conn-inuse"><Icon name="check" :size="13" /> 当前出图渠道</span>
          <button
            v-else
            class="bbi-btn conn-use"
            type="button"
            title="tag 书写规范会切到 ImgRouter"
            @click="settings.defaultBackend = 'imgrouter'"
          >
            使用此渠道出图
          </button>
          <button class="bbi-btn" type="button" :disabled="testing" @click="onTestConnection">
            <Icon name="plug" />
            {{ testing ? '连接中…' : '测试连接' }}
          </button>
        </div>
        <p class="bbi-field-hint conn-note">
          「测试连接」只验证地址可达 —— ImgRouter 的模型列表接口不校验令牌,令牌对不对要等第一次出图才知道。
        </p>
      </Collapsible>

      <Collapsible title="默认参数" :open="true">
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">模型</span>
            <button class="bbi-btn bbi-btn-sm" type="button" :disabled="fetching" @click="onFetchModels">
              <Icon name="refresh" :size="13" />
              {{ fetching ? '拉取中…' : '获取模型' }}
            </button>
          </div>
          <BbiCombo
            v-model="conn.model"
            :options="modelOptions"
            placeholder="留空 = 渠道默认模型"
            aria-label="ImgRouter 模型"
          />
          <p class="bbi-field-hint">{{ modelHint }}</p>
          <p v-if="fetchStatus" class="bbi-field-hint fetch-status">{{ fetchStatus }}</p>
          <p class="bbi-field-hint warn-note">
            列表是全渠道并集。选了不属于你令牌所勾选渠道的模型,ImgRouter 会静默换成该渠道的默认模型
            并照常出图 —— 出来的不是你选的那个,却不会有任何报错。
          </p>
        </div>

        <div class="be-grid">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">竖屏尺寸</span>
            </div>
            <input class="bbi-input" type="text" v-model="conn.portraitSize" placeholder="832×1216" spellcheck="false" />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">横屏尺寸</span>
            </div>
            <input class="bbi-input" type="text" v-model="conn.landscapeSize" placeholder="1216×832" spellcheck="false" />
          </div>
        </div>
        <p class="bbi-field-hint">
          按画面判定的横竖各用一格,发出去会转成 832x1216 这种写法。填错或留空则不发尺寸,由 ImgRouter 用自己的默认值。
        </p>
      </Collapsible>

      <Collapsible title="提示词" :open="false">
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">正面质量词</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="conn.qualityTags"
            placeholder="masterpiece, best quality, ..."
            spellcheck="false"
          />
          <p class="bbi-field-hint">生成时自动拼到正向提示词最前面。</p>
        </div>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">生成自然语言</span>
          <input v-model="conn.naturalLanguage" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">
          开启后自动 tag 会额外产出连贯短句(与 ComfyUI 的 Flux/SD3.5 预设同一套规范)。
          Seedream / Z-Image / FLUX / Qwen-Image 这类模型吃自然语言,建议开。
        </p>

        <p class="bbi-field-hint warn-note">
          ImgRouter 协议没有负面提示词,也没有随机种子:这两项在本渠道一律不发送,历史里的种子恒记 0。
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
/* 左侧「使用此渠道 / 当前出图渠道」与右侧测试连接分据两端 */
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
.conn-note {
  margin-top: 6px;
}
.bbi-field-head .bbi-btn-sm {
  margin-left: auto;
}
.fetch-status {
  opacity: 0.85;
}
/* 静默回落 / 无负面无种子这两条是本渠道最容易踩的坑,给一条竖线拉出层次 */
.warn-note {
  border-left: 2px solid var(--bbi-accent);
  padding-left: 8px;
}
</style>
