<script setup lang="ts">
/**
 * GuardianConsentCard —— 监护人同意（不满 14 周岁）
 *
 * 《个人信息保护法》第 31 条：处理不满 14 周岁未成年人个人信息，需取得监护人同意。
 * 小学 1–6 年级用户在这里完成一次同意，服务端记录版本与时间，聊天入口据此放行。
 */
import { computed, onMounted, ref } from 'vue';
import { ShieldCheck } from 'lucide-vue-next';
import { useAuthStore } from '@/stores/auth';
import { getToken } from '@/services/auth';
import { useToast } from '@/composables/useToast';

const authStore = useAuthStore();
const toast = useToast();

const grade = computed<string | undefined>(() => (authStore.userProfile?.grade as string | undefined) ?? undefined);
/** 只有小学 1–6 年级需要 */
const required = computed(() => {
  const n = Number(grade.value);
  return Number.isFinite(n) && n >= 1 && n <= 6;
});

const loading = ref(true);
const saving = ref(false);
const agreed = ref(false);
const agreedAt = ref<number | null>(null);
const consentVersion = ref('');
const guardianName = ref('');
const relationship = ref('家长');
const checked = ref(false);

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

async function load() {
  if (!required.value || !getToken()) { loading.value = false; return; }
  try {
    const res = await fetch('/api/consent/guardian', { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json() as { agreed?: boolean; version?: string; consent?: { agreedAt?: number; guardianName?: string; relationship?: string } | null };
      agreed.value = !!data.agreed;
      consentVersion.value = data.version ?? '';
      agreedAt.value = data.consent?.agreedAt ?? null;
      guardianName.value = data.consent?.guardianName ?? '';
      relationship.value = data.consent?.relationship || '家长';
    }
  } catch { /* 忽略 */ } finally {
    loading.value = false;
  }
}

async function submit() {
  if (!checked.value) { toast.error('请先勾选同意'); return; }
  saving.value = true;
  try {
    const res = await fetch('/api/consent/guardian', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ guardianName: guardianName.value.trim(), relationship: relationship.value.trim() }),
    });
    if (!res.ok) { toast.error('提交失败，请稍后再试'); return; }
    agreed.value = true;
    checked.value = false;
    await load();
    toast.success('已记录监护人同意');
  } catch {
    toast.error('网络异常，请稍后再试');
  } finally {
    saving.value = false;
  }
}

async function revoke() {
  saving.value = true;
  try {
    await fetch('/api/consent/guardian', { method: 'DELETE', headers: authHeaders() });
    agreed.value = false;
    await load();
    toast.info('已撤回同意');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-if="required && !loading" class="clay mb-4 bg-white/80 p-5">
    <div class="mb-3 flex items-center gap-2">
      <ShieldCheck class="h-4 w-4" :style="{ color: 'var(--accent-strong)' }" />
      <h3 class="font-display text-sm font-bold" style="color: var(--ink)">家长同意</h3>
      <span v-if="agreed" class="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[10px] font-semibold"
            :style="{ color: 'var(--accent-strong)' }">已完成</span>
    </div>

    <p class="mb-3 text-xs leading-relaxed" style="color: var(--ink-soft)">
      你当前登记为小学年级。按《个人信息保护法》，未满 14 周岁的同学使用本产品前，
      需要家长或监护人同意我们处理你的学习信息（答题记录、掌握度画像等）。
      这些信息只用于生成学习建议，不会对外提供。
    </p>

    <div v-if="!agreed" class="flex flex-col gap-3">
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input
          v-model="guardianName"
          maxlength="40"
          placeholder="监护人姓名（选填）"
          class="rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-xs outline-none focus:border-[var(--accent)]"
        />
        <select
          v-model="relationship"
          class="rounded-xl border border-[var(--line)] bg-white px-3 py-2 text-xs outline-none focus:border-[var(--accent)]"
        >
          <option value="家长">家长</option>
          <option value="父亲">父亲</option>
          <option value="母亲">母亲</option>
          <option value="其他监护人">其他监护人</option>
        </select>
      </div>

      <label class="flex items-start gap-2 text-xs leading-relaxed" style="color: var(--ink-soft)">
        <input v-model="checked" type="checkbox" class="mt-0.5 h-3.5 w-3.5 accent-[var(--accent)]" />
        <span>我是该学生的家长或监护人，已阅读并同意上述处理说明。</span>
      </label>

      <button
        :disabled="saving || !checked"
        class="rounded-xl px-4 py-2 text-xs font-semibold text-white transition-opacity disabled:opacity-50"
        :style="{ background: 'var(--accent)' }"
        @click="submit"
      >
        {{ saving ? '提交中…' : '提交监护人同意' }}
      </button>
      <p v-if="consentVersion" class="text-[10px]" style="color: var(--ink-soft)">条款版本：{{ consentVersion }}</p>
    </div>

    <div v-else class="flex flex-col gap-2">
      <p class="text-xs" style="color: var(--ink-soft)">
        已记录监护人同意<span v-if="agreedAt">（{{ new Date(agreedAt * 1000).toLocaleString('zh-CN') }}）</span>。
        家长可随时撤回，撤回后将暂停使用。
      </p>
      <button
        :disabled="saving"
        class="self-start rounded-xl border border-[var(--line)] px-4 py-1.5 text-xs font-semibold transition-colors hover:border-[var(--danger)] disabled:opacity-50"
        style="color: var(--ink-soft)"
        @click="revoke"
      >
        撤回同意
      </button>
    </div>
  </div>
</template>
