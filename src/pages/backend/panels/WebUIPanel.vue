<script setup lang="ts">
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { settings } from '@/state/settings';
import { ref } from 'vue';

// 占位状态,功能接入后移到 settings.webui
const hiresFix = ref(false);
</script>

<template>
  <div class="panel">
    <p class="bbi-page-intro">Stable Diffusion WebUI(A1111 / Forge / reForge),走其 /sdapi/v1 接口。</p>

    <div class="bbi-sections">
      <Collapsible title="配置" :open="false">
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">服务地址</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.webui.url"
            placeholder="http://127.0.0.1:7860"
            spellcheck="false"
          />
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">正面质量词</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.webui.qualityTags"
            placeholder="masterpiece, best quality, ..."
            spellcheck="false"
          />
          <p class="bbi-field-hint">生成时自动拼到正向提示词前面</p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">负面提示词</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.webui.negativePrompt"
            placeholder="lowres, bad anatomy, ..."
            spellcheck="false"
          />
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">分辨率</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.webui.resolution"
            placeholder="如 832×1216"
            spellcheck="false"
          />
        </div>

        <div class="conn-actions">
          <button class="bbi-btn" type="button" disabled title="功能开发中">
            <Icon name="plug" />
            测试连接
          </button>
        </div>
      </Collapsible>

      <Collapsible title="默认参数" :open="true">
        <div class="be-grid">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">模型(Checkpoint)</span>
            </div>
            <select class="bbi-input bbi-select" disabled>
              <option>(连接后自动拉取)</option>
            </select>
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">采样器</span>
            </div>
            <select class="bbi-input bbi-select" disabled>
              <option>(连接后自动拉取)</option>
            </select>
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">步数</span>
            </div>
            <input class="bbi-input" type="number" placeholder="28" disabled />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">CFG Scale</span>
            </div>
            <input class="bbi-input" type="number" placeholder="7" disabled />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">宽</span>
            </div>
            <input class="bbi-input" type="number" placeholder="832" disabled />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">高</span>
            </div>
            <input class="bbi-input" type="number" placeholder="1216" disabled />
          </div>
        </div>
        <label class="bbi-switch-row">
          <span class="bbi-field-label">Hires. fix(高清修复)</span>
          <input v-model="hiresFix" type="checkbox" class="bbi-checkbox" disabled />
        </label>
        <p class="bbi-field-hint">参数功能开发中,当前仅展示。</p>
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
.conn-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
