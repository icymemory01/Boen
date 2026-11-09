import Phaser from 'phaser';
import { GAME_LANES, GAME_QUESTION_BONUS } from '@boen/shared';
import { getToken } from '@/services/auth';

export interface GameQuestion {
  id: string;
  stem: string;
  options: { key: string; text: string }[];
  correctKey: string;
  /** 一句话解析（服务端下发，答错时展示） */
  explain?: string;
  /** 课程知识图谱节点，局末用于回写熟练度 */
  kgNodeId?: number;
  kgTitle?: string;
}

/**
 * 上报给服务端的一条作答记录。
 * 只报「撞了哪扇门」，对错由服务端按出题账本核验——客户端说自己对不算。
 */
export interface GameAnswerRecord {
  questionId: string;
  chosenKey: string;
}

export interface GameStats {
  score: number;
  totalQuestions: number;
  correctQuestions: number;
  accuracyRate: number;
  maxCombo: number;
  durationMs: number;
  answers: GameAnswerRecord[];
  /** 本局限定题数（关卡 / 每日挑战），无尽模式为 undefined */
  limit?: number;
  /** 关卡模式是否过关 */
  passed?: boolean;
  /** 本局为何结束：生命耗尽 / 题数做完 / 未知（用于界面自证与排查） */
  endReason?: 'lives' | 'limit';
}

/** 单题作答反馈（用于答错时的教学提示） */
export interface GameFeedback {
  correct: boolean;
  chosenText: string;
  correctText: string;
  explain?: string;
  kgTitle?: string;
}

export interface GameEvents {
  onScoreChange?: (s: number) => void;
  onLivesChange?: (l: number) => void;
  onGameOver?: (stats: GameStats) => void;
  onStatsChange?: (stats: Pick<GameStats, 'totalQuestions' | 'correctQuestions' | 'accuracyRate'>) => void;
  onQuestionChange?: (q: GameQuestion | null) => void;
  onFeedback?: (f: GameFeedback | null) => void;
}

export type Subject = 'math' | 'chinese' | 'english' | 'science';

const LANES = GAME_LANES;
const INIT_LIVES = 3;
const BONUS = GAME_QUESTION_BONUS;
const INITIAL_SPEED = 120;
const MAX_SPEED = 240;
const SPEED_STEP = 8;
/** 答题后冻结时长（毫秒），留给学生看清正确答案与解析 */
const FEEDBACK_MS = 2000;
/** 题目池本地缓存的题数 */
const QUEUE_TARGET = 5;
/** 答错的题在本局最多再出现几次 */
const REPEAT_TIMES = 3;

const SUBJ: Record<Subject, { accent: number; strong: number; soft: number }> = {
  math:    { accent: 0x14b48a, strong: 0x0e9b76, soft: 0xd9f4ec },
  chinese: { accent: 0xff7a4d, strong: 0xe06530, soft: 0xffe5d7 },
  english: { accent: 0x6c5ce7, strong: 0x5a4bd1, soft: 0xe8e4ff },
  science: { accent: 0x3498db, strong: 0x2c7bc7, soft: 0xd4e6f1 },
};

export class RunnerScene extends Phaser.Scene {
  private player!: Phaser.GameObjects.Container;
  private lane = 1;
  private lanesX: number[] = [];
  private barriers: Phaser.GameObjects.Container[] = [];
  private score = 0;
  private totalQuestions = 0;
  private correctQuestions = 0;
  private lives = INIT_LIVES;
  private speed = INITIAL_SPEED;
  private over = false;
  private gameEvents: GameEvents = {};
  private subject: Subject = 'math';
  private grade: string | undefined;
  private subj!: { accent: number; strong: number; soft: number };
  private qQueue: GameQuestion[] = [];
  private currentQ: GameQuestion | null = null;
  private fetching = false;
  private fetchId = 0;   // 丢弃切换学科前的旧请求
  private panel!: Phaser.GameObjects.Container;
  private panelTxt!: Phaser.GameObjects.Text;
  private timer = 0;
  private keyA!: Phaser.Input.Keyboard.Key;
  private keyD!: Phaser.Input.Keyboard.Key;
  private keyLeft!: Phaser.Input.Keyboard.Key;
  private keyRight!: Phaser.Input.Keyboard.Key;
  private ground!: Phaser.GameObjects.TileSprite;
  private activeBarrierBatch = false;
  private fetchRetryCount = 0;
  private maxFetchRetries = 3;
  private fetchRetryTimerId: ReturnType<typeof setTimeout> | null = null;
  private touchAreaLeft!: Phaser.GameObjects.Zone;
  private touchAreaRight!: Phaser.GameObjects.Zone;

  /* ── 答题反馈状态 ── */
  private frozen = false;
  private freezeLeft = 0;
  private pendingGameOver = false;
  private combo = 0;
  private maxCombo = 0;
  private answers: GameAnswerRecord[] = [];
  private startedAt = 0;

  /* ── 关卡 / 每日挑战：限定题数 ── */
  private limit: number | undefined;
  private passTarget = 0;

  /** 一批门只能结算一次（防止同一道题被扣多条命） */
  private batchResolved = false;
  /** 本局结束原因 */
  private endReason: 'lives' | 'limit' | undefined;

  /* ── 本局出题调度 ──
   * 一局之内同一道题只出一次；答错的题进入「待复现」队列，
   * 之后按随机概率再次出现（最多 3 次，答对即撤），不做固定间隔。 */
  private shownStems = new Set<string>();
  private repeats = new Map<string, { q: GameQuestion; remaining: number; wait: number }>();

  /* ── 预置题目：每日挑战 / 关卡由服务端签发，题号必须与结算账本一致 ── */
  private preset: GameQuestion[] | null = null;
  private presetCursor = 0;

  /* ── 声音与朗读 ── */
  private voiceEnabled = false;
  private audioCtx: AudioContext | null = null;

  constructor() { super({ key: 'RunnerScene' }); }

  setGameEvents(e: GameEvents) { this.gameEvents = e; }

  setGrade(grade?: string) { this.grade = grade; }

  /** 限定本局题数（关卡 5 题 / 每日挑战 10 题）；不调用则为无尽模式 */
  setRunLimit(limit?: number, passTarget = 0) {
    // 只有 >= 2 题才有意义；传 0/1 会让「第一题答完就结束」，一律按无尽处理
    this.limit = typeof limit === 'number' && Number.isFinite(limit) && limit > 1 ? limit : undefined;
    this.passTarget = Number.isFinite(passTarget) ? passTarget : 0;
  }

  /** 是否朗读题干（低龄用户友好） */
  setVoiceEnabled(enabled: boolean) { this.voiceEnabled = enabled; }

  /** 使用服务端预先签发的题目集（每日挑战 / 关卡），不再自行拉题 */
  setPresetQuestions(questions: GameQuestion[] | null) {
    this.preset = questions && questions.length > 0 ? questions : null;
    this.presetCursor = 0;
    this.qQueue = [];
    void this.fetchQueue();
  }

  setSubject(s: Subject) {
    this.subject = s;
    this.subj = SUBJ[this.subject] || SUBJ.math;
    // 清空旧学科缓存的题目队列，并让在途请求失效
    this.qQueue = [];
    this.fetchId++;
    this.fetching = false;
    this.fetchRetryCount = 0;
    this.clearRetryTimer();
    void this.fetchQueue();
  }

  create() {
    this.subj = SUBJ[this.subject] || SUBJ.math;
    const W = this.scale.width;
    const H = this.scale.height;
    this.startedAt = Date.now();

    this.cameras.main.setBackgroundColor('#fbf6ee');

    // Background
    const g = this.add.graphics();
    g.fillStyle(0xfbf6ee, 1);
    g.fillRect(0, 0, W, H);
    g.lineStyle(1, 0xe0d5c4, 0.5);
    for (let i = 1; i < LANES; i++) g.lineBetween((W / LANES) * i, 0, (W / LANES) * i, H);
    g.generateTexture('bg', W, H);
    g.destroy();
    this.ground = this.add.tileSprite(W / 2, H / 2, W, H, 'bg');

    // Lanes
    for (let i = 0; i < LANES; i++) this.lanesX.push((W / LANES) * i + W / LANES / 2);

    // Player
    this.player = this.add.container(this.lanesX[this.lane]!, H - 90);
    const body = this.add.circle(0, 0, 18, this.subj.accent);
    body.setStrokeStyle(2, 0xffffff);
    this.player.add(body);
    const hl = this.add.circle(-4, -6, 6, 0xffffff, 0.3);
    this.player.add(hl);
    const glow = this.add.circle(0, 0, 26, this.subj.accent, 0.1);
    this.player.add(glow);
    this.tweens.add({ targets: glow, scale: 1.4, alpha: 0.03, duration: 900, yoyo: true, repeat: -1 });

    // Question panel
    this.panel = this.add.container(W / 2, 42).setDepth(10).setAlpha(0);
    const pb = this.add.rectangle(0, 0, W - 20, 44, 0xfffdf9, 0.92);
    pb.setStrokeStyle(1.5, this.subj.accent);
    this.panel.add(pb);
    this.panelTxt = this.add.text(0, 0, '', {
      fontSize: '12px', fontFamily: 'Nunito, sans-serif', color: '#2c2722',
      wordWrap: { width: W - 44 }, align: 'center',
    }).setOrigin(0.5);
    this.panel.add(this.panelTxt);

    // Keyboard
    const kb = this.input.keyboard!;
    this.keyA = kb.addKey(Phaser.Input.Keyboard.KeyCodes.A);
    this.keyD = kb.addKey(Phaser.Input.Keyboard.KeyCodes.D);
    this.keyLeft = kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT);
    this.keyRight = kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT);

    // 触摸/点击支持（移动端可用）：左半屏=左移，右半屏=右移
    this.touchAreaLeft = this.add.zone(0, 0, W / 2, H).setOrigin(0, 0).setDepth(0).setInteractive({ useHandCursor: false });
    this.touchAreaRight = this.add.zone(W / 2, 0, W / 2, H).setOrigin(0, 0).setDepth(0).setInteractive({ useHandCursor: false });
    this.touchAreaLeft.on('pointerdown', () => this.handleMove(-1));
    this.touchAreaRight.on('pointerdown', () => this.handleMove(1));

    void this.fetchQueue();
  }

  update(_t: number, delta: number) {
    if (this.over) return;
    const dt = delta / 1000;

    // 反馈冻结：画面静止、换道锁定（门不动，换道只会让人困惑）
    if (this.frozen) {
      this.freezeLeft -= delta;
      if (this.freezeLeft <= 0) this.endFeedback();
      return;
    }

    if (Phaser.Input.Keyboard.JustDown(this.keyA) || Phaser.Input.Keyboard.JustDown(this.keyLeft)) {
      this.handleMove(-1);
    }
    if (Phaser.Input.Keyboard.JustDown(this.keyD) || Phaser.Input.Keyboard.JustDown(this.keyRight)) {
      this.handleMove(1);
    }

    this.ground.tilePositionY -= this.speed * dt * 0.12;

    this.timer += delta;
    if (this.timer >= 800 && this.qQueue.length > 0 && !this.activeBarrierBatch) {
      this.timer = 0;
      this.spawn();
    }

    // 屏障下落 + 碰撞检测
    for (let i = this.barriers.length - 1; i >= 0; i--) {
      const b = this.barriers[i]!;
      if (!b.active) {
        this.barriers.splice(i, 1);
        continue;
      }
      b.y += this.speed * dt;
      if (!b.getData('hit') && b.y >= this.player.y - 40 && b.y <= this.player.y + 40) {
        if (b.getData('lane') === this.lane) {
          b.setData('hit', true);
          this.onCollide(b);
        }
      }
      // 移出屏幕后销毁；本批全消失则解锁下一题
      if (b.y > this.scale.height + 100) {
        b.destroy();
        this.barriers.splice(i, 1);
      }
    }
    if (this.barriers.length === 0) this.activeBarrierBatch = false;
  }

  private handleMove(dir: -1 | 1) {
    if (this.over || this.frozen) return;   // 冻结期间锁输入
    this.moveTo(Math.max(0, Math.min(LANES - 1, this.lane + dir)));
    this.playTick();
  }

  private moveTo(n: number) {
    this.lane = n;
    this.tweens.add({ targets: this.player, x: this.lanesX[n], duration: 70, ease: 'Power2' });
  }

  private spawn() {
    const q = this.pickNextQuestion();
    if (!q) return;
    this.currentQ = q;
    this.noteQuestionShown(q);
    this.batchResolved = false;
    this.activeBarrierBatch = true;
    this.gameEvents.onQuestionChange?.(q);
    this.panel.setAlpha(1);
    this.panelTxt.setText(q.stem);
    this.speak(q.stem);

    const W = this.scale.width;
    const lw = W / LANES;

    // 依据服务端下发的 correctKey 确定正确车道
    const correctLaneIndex = q.options.findIndex(o => o.key === q.correctKey);
    const okLane = correctLaneIndex >= 0 ? correctLaneIndex : 0;

    for (let lane = 0; lane < LANES; lane++) {
      const opt = q.options[lane];
      if (!opt) continue;
      this.barriers.push(this.makeB(this.lanesX[lane]!, -80, opt.text, opt.key, lane === okLane, lane, lw));
    }
  }

  /**
   * 一扇门（一个选项）。
   *
   * 几何按容器宽度算内边距，避免两个老问题：
   * - 文字起点若从容器中心开始，字母徽章右边会空出一大块；
   * - 换行宽度若大于「右侧剩余空间」，文字会冲出底板、压到隔壁跑道。
   * 结构：[ 徽章 ][ 文案（自动缩放） ][ ✓ ]
   */
  private makeB(x: number, y: number, label: string, optKey: string, ok: boolean, lane: number, lw: number): Phaser.GameObjects.Container {
    const c = this.add.container(x, y);
    // 两侧各留 6px，相邻两扇门之间不会贴在一起
    const dw = lw - 12;
    const dh = 54;
    const badgeX = -dw / 2 + 15;      // 字母徽章中心
    const textLeft = -dw / 2 + 30;    // 文案左边界（紧接徽章右侧）
    const markX = dw / 2 - 9;         // ✓ 中心
    const textWidth = markX - 7 - textLeft;  // 给 ✓ 留出 7px 间隙

    const bg = this.add.rectangle(0, 0, dw, dh, 0xfffdf9, 0.94);
    bg.setStrokeStyle(1.5, 0xe0d5c4);
    c.add(bg);

    const circle = this.add.circle(badgeX, 0, 9, this.subj.soft, 1);
    circle.setStrokeStyle(1, this.subj.accent);
    c.add(circle);
    const letter = this.add.text(badgeX, 0, optKey, {
      fontSize: '9px', fontFamily: 'Fredoka, sans-serif',
      color: `#${this.subj.strong.toString(16).padStart(6, '0')}`,
    }).setOrigin(0.5);
    c.add(letter);

    const txt = this.makeFittedText(label, textLeft, textWidth, dh - 12);
    c.add(txt);

    // ✓ 标记：默认隐藏，答错时用来指出正确答案（不只靠颜色，色盲也可辨）
    const mark = this.add.text(markX, 0, '✓', {
      fontSize: '13px', fontFamily: 'Fredoka, sans-serif', color: '#18a558', fontStyle: 'bold',
    }).setOrigin(0.5).setAlpha(0);
    c.add(mark);

    c.setAlpha(0);
    this.tweens.add({ targets: c, alpha: 1, duration: 200 });

    c.setData('ok', ok);
    c.setData('lane', lane);
    c.setData('key', optKey);
    c.setData('hit', false);
    c.setData('text', label);
    c.setData('bg', bg);
    c.setData('mark', mark);
    return c;
  }

  /**
   * 按可用宽高自动缩放字号的文本：
   * 短选项不留大空档，长选项自动缩字并换行，保证一定落在底板内。
   */
  private makeFittedText(text: string, x: number, maxWidth: number, maxHeight: number): Phaser.GameObjects.Text {
    let size = 12;
    const t = this.add.text(x, 0, text, {
      fontSize: `${size}px`,
      fontFamily: 'Nunito, "Microsoft YaHei", sans-serif',
      color: '#2c2722',
      align: 'left',
      wordWrap: { width: maxWidth, useAdvancedWrap: true },
    }).setOrigin(0, 0.5);

    while (size > 8 && (t.height > maxHeight || t.width > maxWidth + 2)) {
      size -= 1;
      t.setStyle({ fontSize: `${size}px` });
      t.setWordWrapWidth(maxWidth, true);
    }
    return t;
  }

  /** 撞到某扇门：结算本题 → 冻结展示（仅答错时揭示答案）→ 解冻继续 */
  private onCollide(b: Phaser.GameObjects.Container) {
    if (this.batchResolved) return;   // 同一批门只结算一次，杜绝一题扣多命
    this.batchResolved = true;

    const ok = !!b.getData('ok');
    const chosenText = String(b.getData('text') ?? '');
    const chosenKey = String(b.getData('key') ?? '');
    const q = this.currentQ;
    const correctText = q?.options.find(o => o.key === q.correctKey)?.text ?? '';

    // 只记录「撞了哪个选项」，对错由服务端核验
    if (q) {
      this.answers.push({ questionId: q.id, chosenKey });
      this.trackRepeat(q, ok);
    }

    this.totalQuestions++;
    if (ok) {
      this.score += BONUS;
      this.correctQuestions++;
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.speed = Math.min(MAX_SPEED, this.speed + SPEED_STEP);
      this.gameEvents.onScoreChange?.(this.score);
      this.playCorrect();
    } else {
      this.combo = 0;
      this.speed = Math.max(INITIAL_SPEED, this.speed - SPEED_STEP * 2);
      this.playWrong();
      // 清掉可能仍在跑的位移/闪烁补间，并吸附到逻辑车道
      this.tweens.killTweensOf(this.player);
      this.player.x = this.lanesX[this.lane]!;
      this.tweens.add({
        targets: this.player, alpha: 0.1, duration: 80, yoyo: true, repeat: 6, ease: 'Sine.easeInOut',
        onComplete: () => this.player.setAlpha(1),
      });
      this.hitFeedback();
      this.lives--;
      this.gameEvents.onLivesChange?.(this.lives);
    }
    this.emitStats();

    // 本批门全部停止碰撞；答错才揭示答案
    this.barriers.forEach((x) => x.setData('hit', true));
    if (!ok) this.revealAnswers(b);
    else this.fadeAllGates();

    this.frozen = true;
    this.freezeLeft = FEEDBACK_MS;
    this.gameEvents.onFeedback?.({
      correct: ok,
      chosenText,
      correctText,
      explain: q?.explain,
      kgTitle: q?.kgTitle,
    });

    // 生命耗尽 或 达到本局题数上限 → 结束
    if (this.lives <= 0) {
      this.pendingGameOver = true;
      this.endReason = 'lives';
    } else if (this.limit !== undefined && this.totalQuestions >= this.limit) {
      this.pendingGameOver = true;
      this.endReason = 'limit';
    }

    console.debug(`[game] 第 ${this.totalQuestions} 题 ${ok ? '答对' : '答错'}｜剩余生命 ${this.lives}` +
      `｜本局上限 ${this.limit ?? '∞'}｜结束标记 ${this.pendingGameOver}`);
  }

  /** 答错：高亮正确门 + ✓，标错所撞的门，压暗其余 */
  private revealAnswers(chosen: Phaser.GameObjects.Container) {
    for (const x of this.barriers) {
      if (!x.active) continue;
      const bg = x.getData('bg') as Phaser.GameObjects.Rectangle | undefined;
      const mark = x.getData('mark') as Phaser.GameObjects.Text | undefined;
      const isCorrect = !!x.getData('ok');
      if (isCorrect) {
        bg?.setFillStyle(0x18a558, 0.9);
        bg?.setStrokeStyle(2, 0x34d399);
        mark?.setAlpha(1);
        this.tweens.add({
          targets: x, scaleX: 1.04, scaleY: 1.04, duration: 260, yoyo: true, repeat: 3, ease: 'Sine.easeInOut',
          onComplete: () => x.setScale(1),
        });
      } else if (x === chosen) {
        bg?.setFillStyle(0xf2557a, 0.92);
        bg?.setStrokeStyle(2, 0xfb7185);
        mark?.setText('✗').setColor('#f2557a').setAlpha(1);
      } else {
        x.setAlpha(0.35);
      }
    }
  }

  /** 答对：不做「揭示答案」的动作，只让门轻微淡出，减少信息噪音 */
  private fadeAllGates() {
    for (const x of this.barriers) {
      if (!x.active) continue;
      this.tweens.add({ targets: x, alpha: 0.25, duration: 200 });
    }
  }

  /** 冻结结束：收起本批门，继续下一题 */
  private endFeedback() {
    this.frozen = false;
    this.freezeLeft = 0;
    this.gameEvents.onFeedback?.(null);

    this.barriers.forEach((x) => {
      if (!x.active) return;
      this.tweens.killTweensOf(x);
      this.tweens.add({
        targets: x, alpha: 0, duration: 180,
        onComplete: () => { try { x.destroy(); } catch { /* 已销毁 */ } },
      });
    });
    // 立刻解锁下一题：旧门只是淡出，不再阻塞出题节奏
    this.activeBarrierBatch = false;

    this.currentQ = null;
    this.gameEvents.onQuestionChange?.(null);
    this.panel.setAlpha(0);

    if (this.pendingGameOver) {
      this.doGameOver();
      return;
    }
    // 提前备题：本局还剩几道就只拉几道
    const remain = this.limit === undefined ? QUEUE_TARGET : Math.max(1, this.limit - this.totalQuestions);
    if (this.qQueue.length < Math.min(3, remain)) void this.fetchQueue();
  }

  private clearRetryTimer() {
    if (this.fetchRetryTimerId) {
      clearTimeout(this.fetchRetryTimerId);
      this.fetchRetryTimerId = null;
    }
  }

  private doGameOver() {
    if (this.over) return;
    // 自检：无尽模式（无题数上限）下生命还没耗尽就结束，说明状态机有问题
    if (this.lives > 0 && this.limit === undefined) {
      console.warn('[game] 异常结束：生命未耗尽却结束', {
        lives: this.lives, totalQuestions: this.totalQuestions, answers: this.answers.length,
      });
    }
    this.over = true;
    this.pendingGameOver = false;
    this.deathFeedback();
    this.clearRetryTimer();
    this.stopSpeaking();
    this.barriers.forEach(b => { if (b.active) b.destroy(); });
    this.barriers = [];
    this.activeBarrierBatch = false;
    this.player.setAlpha(0);
    this.gameEvents.onGameOver?.(this.getStats());
  }

  private getStats(): GameStats {
    const passed = this.limit === undefined
      ? undefined
      : this.lives > 0 && this.correctQuestions >= this.passTarget;
    return {
      score: this.score,
      totalQuestions: this.totalQuestions,
      correctQuestions: this.correctQuestions,
      accuracyRate: this.totalQuestions === 0 ? 0 : Math.round((this.correctQuestions / this.totalQuestions) * 100),
      maxCombo: this.maxCombo,
      durationMs: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
      answers: [...this.answers],
      limit: this.limit,
      passed,
      endReason: this.endReason,
    };
  }

  private emitStats() {
    this.gameEvents.onStatsChange?.({
      totalQuestions: this.totalQuestions,
      correctQuestions: this.correctQuestions,
      accuracyRate: this.totalQuestions === 0 ? 0 : Math.round((this.correctQuestions / this.totalQuestions) * 100),
    });
  }

  doRestart() {
    this.over = false;
    this.score = 0; this.totalQuestions = 0; this.correctQuestions = 0; this.lives = INIT_LIVES; this.speed = INITIAL_SPEED;
    this.lane = 1; this.timer = 0;
    this.combo = 0; this.maxCombo = 0; this.answers = []; this.startedAt = Date.now();
    this.shownStems.clear(); this.repeats.clear();
    this.frozen = false; this.freezeLeft = 0; this.pendingGameOver = false;
    this.endReason = undefined;
    this.batchResolved = false;
    this.currentQ = null; this.qQueue = []; this.fetching = false; this.activeBarrierBatch = false;
    this.fetchRetryCount = 0;
    this.fetchId++;
    this.presetCursor = 0;
    this.clearRetryTimer();
    this.stopSpeaking();
    void this.fetchQueue();

    this.barriers.forEach(b => { try { b.destroy(); } catch { console.warn('[game] barrier destroy failed during restart'); } });
    this.barriers = [];
    this.player.setAlpha(1); this.player.x = this.lanesX[this.lane]!; this.player.y = this.scale.height - 90;
    this.player.setScale(1);
    this.panel.setAlpha(0);
    this.cameras.main.resetFX();
    // 同步 Vue 覆盖层状态
    this.gameEvents.onScoreChange?.(0);
    this.gameEvents.onLivesChange?.(INIT_LIVES);
    this.gameEvents.onFeedback?.(null);
    this.gameEvents.onQuestionChange?.(null);
    this.emitStats();
  }

  /**
   * 拉取题目。fetchId 单调递增：
   * 只有最新一次请求有权修改 fetching 状态，旧请求（切换学科/重开）静默丢弃。
   */
  private async fetchQueue(): Promise<void> {
    if (this.fetching || this.qQueue.length >= QUEUE_TARGET) return;

    // 预置题集（每日挑战 / 关卡）：本地取题，保证题号与服务端账本一致
    if (this.preset) {
      const room = QUEUE_TARGET - this.qQueue.length;
      const take = Math.min(room, this.preset.length - this.presetCursor);
      if (take > 0) {
        this.qQueue.push(...this.preset.slice(this.presetCursor, this.presetCursor + take));
        this.presetCursor += take;
      }
      return;
    }

    const fetchId = ++this.fetchId;
    this.fetching = true;
    try {
      const need = QUEUE_TARGET - this.qQueue.length;
      const params = new URLSearchParams({ subject: this.subject, count: String(need) });
      if (this.grade) params.set('grade', this.grade);
      const token = getToken();
      const res = await fetch(`/api/game/questions?${params.toString()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (fetchId !== this.fetchId) return;   // 已被更新的请求取代
      if (!res.ok) {
        console.warn('[game] 批量获取题目失败:', res.status);
        this.scheduleRetry();
        return;
      }
      const data = await res.json() as { questions?: GameQuestion[] };
      if (fetchId !== this.fetchId) return;
      const questions = (data?.questions ?? []).filter(Boolean);
      if (questions.length > 0) {
        this.qQueue.push(...questions);
        this.fetchRetryCount = 0;
      } else {
        this.scheduleRetry();
      }
    } catch (e) {
      console.warn('[game] fetch err:', e);
      if (fetchId === this.fetchId) this.scheduleRetry();
    } finally {
      if (fetchId === this.fetchId) this.fetching = false;
    }
  }

  /** 指数退避重试（只由一个定时器承载，避免重复排程） */
  private scheduleRetry(): void {
    if (this.fetchRetryCount >= this.maxFetchRetries) return;
    this.fetchRetryCount++;
    const delay = Math.min(1000 * Math.pow(2, this.fetchRetryCount - 1), 6000);
    this.clearRetryTimer();
    this.fetchRetryTimerId = setTimeout(() => {
      this.fetchRetryTimerId = null;
      void this.fetchQueue();
    }, delay);
  }

  /* ══════════════════════════════════════════════════════════════
   * 出题调度：一局内不重复，错题随机复现
   * ══════════════════════════════════════════════════════════════ */

  /** 从待复现池里按「越久没出现权重越高」随机挑一道 */
  private pickRepeat(): GameQuestion | null {
    const pending = [...this.repeats.values()].filter((e) => e.remaining > 0);
    if (pending.length === 0) return null;
    const weight = (e: { wait: number }) => Math.min(8, e.wait + 1);
    const total = pending.reduce((s, e) => s + weight(e), 0);
    let r = Math.random() * total;
    for (const e of pending) {
      r -= weight(e);
      if (r <= 0) return e.q;
    }
    return pending[pending.length - 1]!.q;
  }

  /** 取一道本局没出现过的新题 */
  private takeFresh(): GameQuestion | null {
    while (this.qQueue.length > 0) {
      const q = this.qQueue.shift()!;
      if (this.shownStems.has(q.stem)) continue;
      return q;
    }
    return null;
  }

  /**
   * 决定下一道题：
   * - 有错题待复现时，以 40% 概率插入（纯随机，不排固定间隔）
   * - 否则取一道没出过的新题
   * - 题库被抽干时先补拉，仍不行就清空「已出」记录，从题库重新轮转
   */
  private pickNextQuestion(): GameQuestion | null {
    if (this.qQueue.length < 3) void this.fetchQueue();

    const hasFresh = this.qQueue.some((q) => !this.shownStems.has(q.stem));
    if (this.repeats.size > 0 && (!hasFresh || Math.random() < 0.4)) {
      const repeat = this.pickRepeat();
      if (repeat) return repeat;
    }

    const fresh = this.takeFresh();
    if (fresh) return fresh;

    // 题库被抽干：允许开启新一轮（题库足够大时几乎不会走到这里）
    this.shownStems.clear();
    void this.fetchQueue();
    return this.takeFresh();
  }

  /** 记录「这道题出现过了」并推进复现等待计数 */
  private noteQuestionShown(q: GameQuestion) {
    const repeat = this.repeats.get(q.id);
    if (repeat) {
      repeat.remaining -= 1;
      repeat.wait = 0;
      if (repeat.remaining <= 0) this.repeats.delete(q.id);
    } else {
      this.shownStems.add(q.stem);
    }
    for (const e of this.repeats.values()) e.wait += 1;
  }

  /** 答错的题进复现池（最多再出现 3 次）；复现时答对即撤 */
  private trackRepeat(q: GameQuestion, ok: boolean) {
    if (!ok) {
      const existing = this.repeats.get(q.id);
      this.repeats.set(q.id, {
        q,
        remaining: existing ? Math.max(existing.remaining, 1) : REPEAT_TIMES,
        wait: 0,
      });
    } else if (this.repeats.has(q.id)) {
      this.repeats.delete(q.id);
    }
  }

  /* ══════════════════════════════════════════════════════════════
   * 扣血 / 死亡特效：红色氛围灯 + 镜头晃动
   * ══════════════════════════════════════════════════════════════ */

  /** 扣一条命：红色闪屏 + 轻微晃动 + 红色氛围灯 */
  private hitFeedback() {
    const cam = this.cameras.main;
    cam.shake(280, 0.012);
    cam.flash(220, 214, 40, 60, false);
    this.redVeil(0.34, 3, 90);
  }

  /** 游戏结束：更强的震动与红色氛围灯 */
  private deathFeedback() {
    const cam = this.cameras.main;
    cam.shake(700, 0.03);
    cam.flash(420, 200, 30, 50, false);
    this.redVeil(0.58, 5, 110);
  }

  /** 全屏红色氛围灯（淡入淡出若干次后自毁） */
  private redVeil(peak: number, times: number, dur: number) {
    try {
      const { width, height } = this.scale;
      const veil = this.add.rectangle(0, 0, width, height, 0xd7263d)
        .setOrigin(0, 0).setDepth(60).setAlpha(0);
      this.tweens.add({
        targets: veil, alpha: peak, duration: dur, yoyo: true, repeat: Math.max(0, times - 1),
        ease: 'Sine.easeInOut',
        onComplete: () => { try { veil.destroy(); } catch { /* 已销毁 */ } },
      });
    } catch { /* 特效失败不影响游戏 */ }
  }

  /* ══════════════════════════════════════════════════════════════
   * 声音：用 WebAudio 现场合成，不引入任何音频资源文件
   * ══════════════════════════════════════════════════════════════ */

  /** 首次用户交互后才能创建 AudioContext（自动播放策略） */
  private ctx(): AudioContext | null {
    if (this.audioCtx) {
      if (this.audioCtx.state === 'suspended') void this.audioCtx.resume();
      return this.audioCtx;
    }
    try {
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.audioCtx = new Ctor();
      return this.audioCtx;
    } catch {
      return null;
    }
  }

  private tone(freq: number, durationMs: number, type: OscillatorType, gain = 0.05, delayMs = 0) {
    const ctx = this.ctx();
    if (!ctx) return;
    try {
      const start = ctx.currentTime + delayMs / 1000;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, start);
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(gain, start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, start + durationMs / 1000);
      osc.connect(g).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + durationMs / 1000 + 0.02);
    } catch { /* 音频失败不影响游戏 */ }
  }

  private playCorrect() {
    this.tone(660, 90, 'sine', 0.06);
    this.tone(880, 120, 'sine', 0.05, 90);
  }

  private playWrong() {
    this.tone(180, 220, 'sawtooth', 0.05);
    this.tone(140, 260, 'sawtooth', 0.04, 60);
  }

  private playTick() {
    this.tone(520, 40, 'square', 0.02);
  }

  /* ══════════════════════════════════════════════════════════════
   * 朗读题干（可选，面向低龄用户）
   * ══════════════════════════════════════════════════════════════ */

  private speak(text: string) {
    if (!this.voiceEnabled || !text) return;
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      synth.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = 'zh-CN';
      utter.rate = 1;
      utter.pitch = 1.05;
      synth.speak(utter);
    } catch { /* 不支持则静默 */ }
  }

  private stopSpeaking() {
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
  }
}
