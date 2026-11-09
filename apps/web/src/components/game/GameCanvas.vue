<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import Phaser from 'phaser';
import {
  RunnerScene,
  type Subject,
  type GameQuestion,
  type GameStats,
  type GameFeedback,
} from '@/game/RunnerScene';

const props = defineProps<{
  subject: Subject;
  grade?: string;
  /** 本局限定题数（关卡 5 / 每日挑战 10）；不传为无尽模式 */
  limit?: number;
  /** 过关所需正确数 */
  passTarget?: number;
  /** 服务端预先签发的题目集（每日挑战 / 关卡），传入后不再自行拉题 */
  preset?: GameQuestion[];
}>();

const emit = defineEmits<{
  (e: 'gameOver', stats: GameStats): void;
}>();

const canvasContainer = ref<HTMLDivElement>();
let game: Phaser.Game | null = null;
let scene: RunnerScene | null = null;

const score = ref(0);
const lives = ref(3);
const isRunning = ref(false);
const isLoading = ref(true);
const totalQuestions = ref(0);
const correctQuestions = ref(0);
const accuracyRate = ref(0);
const showGameOver = ref(false);
const currentQuestion = ref<GameQuestion | null>(null);
const feedback = ref<GameFeedback | null>(null);
const gameOverStats = ref<GameStats | null>(null);

/** 掉心动画：失血时抖动 + 红光辉 + 浮出「−1」 */
const heartHit = ref(false);
const heartDelta = ref<number | null>(null);
let heartTimer: ReturnType<typeof setTimeout> | null = null;
watch(lives, (now, prev) => {
  if (now >= prev) return;
  heartDelta.value = prev - now;
  heartHit.value = false;
  requestAnimationFrame(() => { heartHit.value = true; });
  if (heartTimer) clearTimeout(heartTimer);
  heartTimer = setTimeout(() => { heartHit.value = false; heartDelta.value = null; }, 1100);
});

/** 朗读题干开关（低龄用户友好），本地记忆 */
const VOICE_KEY = 'boen_game_voice';
const voiceOn = ref(localStorage.getItem(VOICE_KEY) === '1');

function toggleVoice() {
  voiceOn.value = !voiceOn.value;
  localStorage.setItem(VOICE_KEY, voiceOn.value ? '1' : '0');
  scene?.setVoiceEnabled(voiceOn.value);
}

/**
 * 按容器实际尺寸决定逻辑分辨率（竖屏 2:3），
 * 不再固定 480×720 导致桌面端大面积留白；后续缩放交给 Scale.FIT。
 */
function measureCanvas(): { width: number; height: number } {
  const rect = canvasContainer.value?.getBoundingClientRect();
  const height = Math.max(360, Math.round(rect?.height || 720));
  const width = Math.round(height * (2 / 3));
  return { width: Math.max(320, Math.min(560, width)), height };
}

function restart() {
  if (!scene) return;
  scene.doRestart();
  isRunning.value = true;
  showGameOver.value = false;
  isLoading.value = false;
  score.value = 0;
  lives.value = 3;
  totalQuestions.value = 0;
  correctQuestions.value = 0;
  accuracyRate.value = 0;
  currentQuestion.value = null;
  feedback.value = null;
  gameOverStats.value = null;
}

onMounted(() => {
  if (!canvasContainer.value) return;
  const size = measureCanvas();

  game = new Phaser.Game({
    type: Phaser.AUTO,
    width: size.width,
    height: size.height,
    parent: canvasContainer.value,
    backgroundColor: '#fbf6ee',
    scene: [RunnerScene],
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  });

  game.events.on('ready', () => {
    scene = game!.scene.getScene('RunnerScene') as unknown as RunnerScene;
    scene.setGrade(props.grade);
    scene.setRunLimit(props.limit, props.passTarget ?? 0);
    scene.setVoiceEnabled(voiceOn.value);
    scene.setSubject(props.subject);
    scene.setPresetQuestions(props.preset ?? null);
    scene.setGameEvents({
      onScoreChange: (s) => { score.value = s; },
      onLivesChange: (l) => { lives.value = l; },
      onStatsChange: (stats) => {
        totalQuestions.value = stats.totalQuestions;
        correctQuestions.value = stats.correctQuestions;
        accuracyRate.value = stats.accuracyRate;
        if (isLoading.value) isLoading.value = false;
      },
      onQuestionChange: (q) => {
        currentQuestion.value = q;
        if (q && isLoading.value) isLoading.value = false;
      },
      onFeedback: (f) => {
        feedback.value = f;
        if (f) isLoading.value = false;
      },
      onGameOver: (stats) => {
        isRunning.value = false;
        showGameOver.value = true;
        isLoading.value = false;
        feedback.value = null;
        gameOverStats.value = stats;
        totalQuestions.value = stats.totalQuestions;
        correctQuestions.value = stats.correctQuestions;
        accuracyRate.value = stats.accuracyRate;
        emit('gameOver', stats);
      },
    });
    isRunning.value = true;
  });
});

watch(() => props.subject, (sub) => {
  if (scene) {
    isLoading.value = true;
    currentQuestion.value = null;
    feedback.value = null;
    scene.setGrade(props.grade);
    scene.setRunLimit(props.limit, props.passTarget ?? 0);
    scene.setSubject(sub);
    scene.setPresetQuestions(props.preset ?? null);
    scene.doRestart();
  }
});

watch(() => props.grade, (g) => {
  if (scene) scene.setGrade(g);
});

onUnmounted(() => {
  if (game) { game.destroy(true); game = null; }
  scene = null;
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
});
</script>

<template>
  <div class="game-wrapper relative h-full w-full overflow-hidden" style="background: var(--paper);">
    <!-- Phaser 画布（铺满容器） -->
    <div ref="canvasContainer" class="h-full w-full" />

    <!-- 加载遮罩 -->
    <Transition name="fade">
      <div
        v-if="isLoading && !showGameOver"
        class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[var(--paper)]/60 backdrop-blur-[2px]"
      >
        <div class="flex flex-col items-center gap-3">
          <div class="h-8 w-8 animate-spin rounded-full border-3 border-[var(--accent)] border-t-transparent" />
          <p class="text-sm font-medium" style="color: var(--ink-soft)">题目加载中…</p>
        </div>
      </div>
    </Transition>

    <!-- 顶部 HUD 覆盖层 -->
    <div class="absolute left-0 right-0 top-0 z-10 flex items-center justify-between px-3 pt-2">
      <div class="pointer-events-none clay-sm flex items-center gap-1.5 bg-white/80 px-3 py-1 shadow-sm">
        <span class="text-xs font-bold text-[var(--ink-soft)]">🏆</span>
        <span class="text-sm font-bold" style="font-family: var(--font-display); color: var(--accent-strong)">{{ score }}</span>
        <span v-if="limit" class="text-[10px] font-semibold text-[var(--ink-soft)]">
          {{ totalQuestions }}/{{ limit }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <button
          class="clay-sm bg-white/80 px-2 py-1 text-xs shadow-sm transition-colors hover:bg-white"
          :title="voiceOn ? '关闭朗读' : '朗读题干'"
          @click="toggleVoice"
        >
          {{ voiceOn ? '🔊' : '🔇' }}
        </button>
        <div
          class="pointer-events-none clay-sm relative flex items-center gap-1 bg-white/80 px-2.5 py-1 shadow-sm"
          :class="{ 'heart-hit': heartHit }"
        >
          <span class="text-sm leading-none">{{ heartHit ? '💔' : '❤️' }}</span>
          <span class="text-sm font-bold leading-none" style="font-family: var(--font-display)">{{ lives }}</span>
          <span class="text-[10px] leading-none text-[var(--ink-soft)]">/ 3</span>
          <Transition name="fade">
            <span v-if="heartDelta" class="heart-delta">−{{ heartDelta }}</span>
          </Transition>
        </div>
      </div>
    </div>

    <!-- 答题反馈：答错时指出正确答案并给一句解析 -->
    <Transition name="fade">
      <div
        v-if="feedback"
        class="pointer-events-none absolute inset-x-3 top-16 z-20 mx-auto max-w-sm rounded-2xl px-4 py-3 text-center shadow-lg backdrop-blur"
        :style="{
          background: feedback.correct ? 'rgba(24,165,88,0.94)' : 'rgba(242,85,122,0.95)',
          color: '#fff',
        }"
      >
        <div class="flex items-center justify-center gap-2">
          <span class="text-lg">{{ feedback.correct ? '✓' : '✗' }}</span>
          <span class="text-sm font-bold">
            {{ feedback.correct ? '答对了！' : '答错了' }}
          </span>
          <span v-if="feedback.kgTitle" class="rounded-full bg-white/25 px-2 py-0.5 text-[10px]">
            {{ feedback.kgTitle }}
          </span>
        </div>
        <p v-if="!feedback.correct" class="mt-1 text-xs leading-snug">
          正确答案：<strong>{{ feedback.correctText }}</strong>
        </p>
        <p v-if="feedback.explain" class="mt-1 text-[11px] leading-snug opacity-90">
          {{ feedback.explain }}
        </p>
      </div>
    </Transition>

    <!-- 当前题目提示（底部） -->
    <Transition name="fade">
      <div
        v-if="currentQuestion"
        class="pointer-events-none absolute bottom-12 left-1/2 z-10 max-w-[90%] -translate-x-1/2 rounded-xl bg-white/85 px-4 py-2 text-center shadow-md backdrop-blur"
      >
        <p class="text-xs leading-snug font-medium" style="color: var(--ink)">{{ currentQuestion.stem }}</p>
      </div>
    </Transition>

    <!-- 键盘提示 -->
    <div class="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full bg-white/70 px-3 py-1 text-[10px] shadow-sm backdrop-blur" style="color: var(--ink-soft)">
      ← A / D →
    </div>

    <!-- 游戏结束弹窗 -->
    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="showGameOver"
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
        >
          <div class="clay modal-pop relative mx-4 w-full max-w-xs overflow-hidden bg-white p-6 text-center">
            <div class="modal-strip" />
            <div class="mb-1 text-4xl">
              {{ gameOverStats?.limit !== undefined ? (gameOverStats?.passed ? '🏅' : '🎮') : '🎮' }}
            </div>
            <h2 class="mb-1 text-xl font-bold text-[var(--ink)]" style="font-family: var(--font-display)">
              {{ gameOverStats?.limit !== undefined
                ? (gameOverStats?.passed ? '过关！' : '本关未通过')
                : '游戏结束' }}
            </h2>
            <p class="mb-4 text-3xl font-bold" style="font-family: var(--font-display); color: var(--accent-strong)">{{ score }} 分</p>
            <p class="-mt-3 mb-3 text-[11px] text-[var(--ink-soft)]">
              {{ gameOverStats?.endReason === 'lives'
                ? `3 条命用完（答错 3 题）`
                : gameOverStats?.endReason === 'limit'
                  ? `本局 ${gameOverStats?.limit} 题已全部完成`
                  : '本局已结束' }}
            </p>

            <div class="mb-4 grid grid-cols-3 gap-2 rounded-xl bg-[var(--accent-soft)]/50 p-3">
              <div class="text-center">
                <div class="text-xs text-[var(--ink-soft)]">总题数</div>
                <div class="text-lg font-bold text-[var(--accent-strong)]">{{ totalQuestions }}</div>
              </div>
              <div class="text-center">
                <div class="text-xs text-[var(--ink-soft)]">正确</div>
                <div class="text-lg font-bold text-[var(--accent-strong)]">{{ correctQuestions }}</div>
              </div>
              <div class="text-center">
                <div class="text-xs text-[var(--ink-soft)]">正确率</div>
                <div class="text-lg font-bold text-[var(--accent-strong)]">{{ accuracyRate }}%</div>
              </div>
            </div>

            <p v-if="gameOverStats && gameOverStats.maxCombo >= 3" class="mb-3 text-xs font-semibold" style="color: var(--accent-strong)">
              🔥 最高连击 {{ gameOverStats.maxCombo }} 题
            </p>

            <slot name="result" />

            <button
              class="btn-accent w-full rounded-[18px] px-6 py-3 text-base font-semibold text-white"
              @click="restart"
            >
              🔄 再来一次
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.game-wrapper canvas { display: block; }
.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
@keyframes spin {
  to { transform: rotate(360deg); }
}
.animate-spin { animation: spin 0.8s linear infinite; }

/* 掉心：抖动 + 红色辉光 + 浮出的 −1 */
.heart-hit {
  animation: heartShake 0.5s ease-in-out 2;
  box-shadow: 0 0 0 2px rgba(215, 38, 61, 0.55), 0 0 16px rgba(215, 38, 61, 0.6);
}
@keyframes heartShake {
  0%, 100% { transform: translateX(0) scale(1); }
  20% { transform: translateX(-3px) scale(1.14); }
  40% { transform: translateX(3px) scale(1.14); }
  60% { transform: translateX(-2px) scale(1.07); }
  80% { transform: translateX(2px) scale(1.07); }
}
.heart-delta {
  position: absolute;
  right: -7px;
  top: -15px;
  font-size: 12px;
  font-weight: 700;
  color: #d7263d;
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.9);
}

/* 死亡弹窗：弹出动画 + 顶部红色条 */
.modal-pop { animation: modalPop 0.32s cubic-bezier(0.2, 0.9, 0.3, 1.2) both; }
@keyframes modalPop {
  from { transform: scale(0.86); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
.modal-strip {
  position: absolute;
  inset: 0 0 auto 0;
  height: 6px;
  background: linear-gradient(90deg, #d7263d, #ff7a4d);
}
</style>
