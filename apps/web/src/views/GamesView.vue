<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { GAME_DAILY_SIZE, GAME_STAGE_PASS, GAME_STAGE_SIZE, GAME_SUBJECT_META, GAME_SUBJECTS } from '@boen/shared';
import GameCanvas from '@/components/game/GameCanvas.vue';
import type { GameStats, GameQuestion, Subject } from '@/game/RunnerScene';
import { useAuthStore } from '@/stores/auth';
import {
  finishGame,
  fetchGameStats,
  fetchLeaderboard,
  fetchDailyChallenge,
  fetchStage,
  type GameMode,
  type FinishResult,
  type LeaderboardRow,
  type GameStatsSummary,
  type StageProgress,
} from '@/services/game';

const authStore = useAuthStore();
/** 出题 / 画像都按年级分层，未设置时后端退化为通用难度 */
const grade = computed<string | undefined>(() => (authStore.userProfile?.grade as string | undefined) ?? undefined);

/** 高中不设科学学科（与聊天端一致） */
const subjects = computed(() => GAME_SUBJECTS.filter((s) => !(grade.value === 'high' && s === 'science')));

const MODES: { value: GameMode; label: string; hint: string }[] = [
  { value: 'endless', label: '无尽跑酷', hint: '撞对加分，3 条命用完为止' },
  { value: 'daily', label: '每日挑战', hint: `每天 ${GAME_DAILY_SIZE} 题，题集当天固定` },
  { value: 'stage', label: '关卡', hint: `每关 ${GAME_STAGE_SIZE} 题，答对 ${GAME_STAGE_PASS} 题过关` },
];
const selectedMode = ref<GameMode>('endless');

const playing = ref(false);
const loadingRun = ref(false);
const activeSubject = ref<Subject>('math');
const preset = ref<GameQuestion[] | null>(null);
const limit = ref<number | undefined>(undefined);
const passTarget = ref(0);
const stageNo = ref<number | undefined>(undefined);

const submitting = ref(false);
const finishResult = ref<FinishResult | null>(null);

const myStats = ref<GameStatsSummary | null>(null);
const stages = ref<Record<string, StageProgress>>({});
const board = ref<LeaderboardRow[]>([]);
const boardLoading = ref(false);
const toast = ref('');

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(msg: string) {
  toast.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = ''; }, 2600);
}

async function loadSidePanels() {
  if (!authStore.authenticated) return;
  boardLoading.value = true;
  try {
    const [statsRes, rows] = await Promise.all([fetchGameStats(), fetchLeaderboard(undefined, 'week')]);
    if (statsRes) {
      myStats.value = statsRes.stats;
      stages.value = statsRes.stages ?? {};
    }
    board.value = rows.slice(0, 5);
  } finally {
    boardLoading.value = false;
  }
}

onMounted(loadSidePanels);
watch(() => authStore.authenticated, loadSidePanels);

/** 点学科卡片：按当前模式开局 */
async function start(subject: Subject) {
  if (loadingRun.value) return;
  activeSubject.value = subject;
  finishResult.value = null;
  preset.value = null;
  limit.value = undefined;
  passTarget.value = 0;
  stageNo.value = undefined;

  if (selectedMode.value === 'endless') {
    playing.value = true;
    return;
  }

  loadingRun.value = true;
  try {
    if (selectedMode.value === 'daily') {
      const res = await fetchDailyChallenge(subject, grade.value);
      if (!res || res.questions.length === 0) { showToast('挑战加载失败，请稍后再试'); return; }
      if (res.state.completed) showToast('今天的挑战已完成，再打一次不计入成绩哦');
      preset.value = res.questions;
      limit.value = res.questions.length;
      passTarget.value = 0;
    } else {
      const res = await fetchStage(subject, grade.value);
      if (!res || res.questions.length === 0) { showToast('关卡加载失败，请稍后再试'); return; }
      preset.value = res.questions;
      limit.value = res.questions.length;
      passTarget.value = GAME_STAGE_PASS;
      stageNo.value = res.progress.stage;
    }
    playing.value = true;
  } finally {
    loadingRun.value = false;
  }
}

async function onGameOver(stats: GameStats): Promise<void> {
  finishResult.value = null;
  if (stats.answers.length === 0) return;

  submitting.value = true;
  try {
    finishResult.value = await finishGame({
      subject: activeSubject.value,
      grade: grade.value,
      mode: selectedMode.value,
      stage: stageNo.value,
      durationMs: stats.durationMs,
      answers: stats.answers,
    });
    if (finishResult.value) {
      myStats.value = finishResult.value.stats;
      void loadSidePanels();
    } else {
      showToast('成绩未能保存（可能未登录）');
    }
  } finally {
    submitting.value = false;
  }
}

function backToMenu(): void {
  playing.value = false;
  preset.value = null;
  limit.value = undefined;
  finishResult.value = null;
  stageNo.value = undefined;
  void loadSidePanels();
}

const stageLabel = (s: Subject): string => {
  const p = stages.value[s];
  return p && p.stage > 1 ? `第 ${p.stage} 关` : '第 1 关';
};
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 顶部栏 -->
    <div class="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
      <div class="flex items-center gap-2">
        <span class="text-xl">🏃</span>
        <h1 class="text-lg font-bold" style="font-family: var(--font-display)">知识跑酷</h1>
        <span v-if="grade" class="rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-semibold text-[var(--ink-soft)]">
          {{ grade === 'high' ? '高中' : grade === 'college' ? '大学' : `${grade} 年级` }}
        </span>
      </div>
      <button
        v-if="playing"
        class="clay-sm px-3 py-1.5 text-xs font-semibold bg-white/60 text-[var(--ink-soft)] transition-colors hover:bg-white/90"
        @click="backToMenu"
      >
        ← 返回
      </button>
    </div>

    <!-- 轻提示（每日挑战已完成 / 结算失败等） -->
    <Transition name="fade">
      <div
        v-if="toast"
        class="pointer-events-none absolute inset-x-4 top-16 z-40 mx-auto max-w-sm rounded-xl bg-black/75 px-4 py-2 text-center text-xs text-white shadow-lg"
      >
        {{ toast }}
      </div>
    </Transition>

    <div class="flex-1 overflow-hidden">
      <!-- ═══ 开局菜单 ═══ -->
      <div v-if="!playing" class="flex h-full flex-col items-center justify-center gap-5 overflow-y-auto px-4 py-6">
        <div class="text-center">
          <div class="mb-2 text-5xl">🏃‍♂️</div>
          <h2 class="mb-1 text-xl font-bold text-[var(--ink)]" style="font-family: var(--font-display)">选择玩法与学科</h2>
          <p class="text-xs text-[var(--ink-soft)]">题目会按你的年级和薄弱知识点出</p>
        </div>

        <!-- 模式切换 -->
        <div class="clay-sm flex w-full max-w-sm gap-1 bg-white/60 p-1">
          <button
            v-for="m in MODES"
            :key="m.value"
            class="flex-1 rounded-xl px-2 py-1.5 text-xs font-semibold transition-all"
            :class="selectedMode === m.value
              ? 'bg-[var(--accent)] text-white shadow-sm'
              : 'text-[var(--ink-soft)] hover:bg-white/80'"
            @click="selectedMode = m.value"
          >
            {{ m.label }}
          </button>
        </div>
        <p class="-mt-3 text-center text-[11px] text-[var(--ink-soft)]">
          {{ MODES.find((m) => m.value === selectedMode)?.hint }}
        </p>

        <div class="grid w-full max-w-sm grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            v-for="sub in subjects"
            :key="sub"
            class="clay group flex flex-col items-center gap-2 bg-white/70 px-4 py-5 text-center transition-all duration-300 hover:-translate-y-1 hover:bg-white disabled:opacity-60"
            :disabled="loadingRun"
            :style="{
              '--accent': GAME_SUBJECT_META[sub].accent,
              '--accent-soft': GAME_SUBJECT_META[sub].accentSoft,
              '--accent-strong': GAME_SUBJECT_META[sub].accentStrong,
            }"
            @click="start(sub)"
          >
            <span class="text-3xl transition-transform duration-300 group-hover:scale-110">{{ GAME_SUBJECT_META[sub].emoji }}</span>
            <span class="text-base font-bold" style="font-family: var(--font-display); color: var(--accent-strong)">{{ GAME_SUBJECT_META[sub].label }}</span>
            <span class="text-xs text-[var(--ink-soft)]">
              {{ selectedMode === 'stage' ? stageLabel(sub) : GAME_SUBJECT_META[sub].desc }}
            </span>
            <div
              class="mt-1 h-1 w-12 rounded-full transition-all duration-300 group-hover:w-20"
              :style="{ background: 'var(--accent)' }"
            />
          </button>
        </div>

        <!-- 个人最佳 + 本周榜 -->
        <div v-if="authStore.authenticated" class="grid w-full max-w-sm grid-cols-1 gap-3 sm:grid-cols-2">
          <div class="clay-sm flex flex-col gap-1 bg-white/60 px-4 py-3">
            <span class="text-[11px] font-semibold text-[var(--ink-soft)]">我的最佳</span>
            <span class="text-lg font-bold" style="font-family: var(--font-display); color: var(--accent-strong)">
              {{ myStats?.bestScore ?? 0 }} <span class="text-xs font-normal">分</span>
            </span>
            <span class="text-[10px] text-[var(--ink-soft)]">
              共 {{ myStats?.games ?? 0 }} 局 · 总正确率 {{ myStats?.accuracy ?? 0 }}%
            </span>
          </div>

          <div class="clay-sm flex flex-col gap-1 bg-white/60 px-4 py-3">
            <span class="text-[11px] font-semibold text-[var(--ink-soft)]">本周榜</span>
            <div v-if="boardLoading" class="text-[10px] text-[var(--ink-soft)]">加载中…</div>
            <div v-else-if="board.length === 0" class="text-[10px] text-[var(--ink-soft)]">还没有人上榜，来抢第一</div>
            <ol v-else class="flex flex-col gap-0.5">
              <li
                v-for="row in board"
                :key="row.rank"
                class="flex items-center justify-between text-[11px]"
                :class="row.isMe ? 'font-bold text-[var(--accent-strong)]' : 'text-[var(--ink-soft)]'"
              >
                <span>{{ row.rank }}. {{ row.handle }}{{ row.isMe ? '（我）' : '' }}</span>
                <span>{{ row.correct }} 题</span>
              </li>
            </ol>
          </div>
        </div>

        <div class="clay-sm max-w-xs bg-white/60 px-4 py-3 text-center">
          <p class="text-xs leading-relaxed text-[var(--ink-soft)]">
            <strong>A/D</strong> 或 <strong>←/→</strong> 切换跑道，移动端点半屏<br>
            撞上正确答案加分，答错扣 1 条命（共 3 条），并告诉你正确答案与解析
          </p>
        </div>
      </div>

      <!-- ═══ 游戏画布 ═══ -->
      <GameCanvas
        v-else
        :key="`${activeSubject}-${selectedMode}-${stageNo ?? 0}-${preset?.length ?? 0}`"
        :subject="activeSubject"
        :grade="grade"
        :limit="limit"
        :pass-target="passTarget"
        :preset="preset ?? undefined"
        @game-over="onGameOver"
      >
        <template #result>
          <div v-if="submitting" class="mb-3 text-xs text-[var(--ink-soft)]">结算中…</div>
          <div v-else-if="finishResult" class="mb-3 flex flex-col gap-1 rounded-xl bg-[var(--accent-soft)]/50 px-3 py-2">
            <p v-if="finishResult.stage" class="text-xs font-semibold" :style="{ color: finishResult.stage.passed ? 'var(--accent-strong)' : '#c2410c' }">
              {{ finishResult.stage.passed
                ? `🎉 过关！解锁第 ${finishResult.stage.nextStage} 关`
                : `差一点：答对 ${finishResult.stage.need} 题才能过关` }}
            </p>
            <p v-if="finishResult.points > 0" class="text-xs font-semibold" style="color: var(--accent-strong)">
              ✨ 获得 {{ finishResult.points }} 星月积分
              <span v-if="finishResult.capped" class="font-normal">（今日上限已到）</span>
            </p>
            <p v-else class="text-xs text-[var(--ink-soft)]">今日积分已达上限，明天再来～</p>
            <p v-if="finishResult.isBest" class="text-[11px] font-semibold" style="color: var(--accent-strong)">🏅 新的个人最佳！</p>
            <p v-if="finishResult.proficiencyUpdated > 0" class="text-[10px] text-[var(--ink-soft)]">
              已记录 {{ finishResult.proficiencyUpdated }} 个知识点的掌握情况
            </p>
            <p v-if="finishResult.mistakesCreated > 0" class="text-[10px] text-[var(--ink-soft)]">
              答错的 {{ finishResult.mistakesCreated }} 题已加入错题本
            </p>
            <p v-if="finishResult.unverified > 0" class="text-[10px] text-[#c2410c]">
              有 {{ finishResult.unverified }} 题未能核验，未计入成绩
            </p>
          </div>
        </template>
      </GameCanvas>
    </div>
  </div>
</template>
