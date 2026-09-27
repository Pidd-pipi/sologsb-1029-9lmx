<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { courseForLesson, exportRecords, lessonById, persist, saveAttempt, setDownloaded, state, updateTokenClassification } from './store';
import type { ErrorCategory, Lesson, PracticeAttempt, PracticeView, SentenceAttempt, SentencePlayback } from './types';
import { compareSentence, scoreAttempt, segmentText } from './utils';
import { useSegmentPlayer } from './composables/useSegmentPlayer';

const DEFAULT_RATE = 0.72;
const RATE_STEP = 0.05;
const RATE_MIN = 0.5;
const RATE_MAX = 1.2;

const view = ref<PracticeView>(state.activeLessonId ? 'practice' : 'library');
const online = ref(navigator.onLine);
const toast = ref('');
const resultAttemptId = ref('');
const selectedResultSentence = ref(0);
const resultStart = ref(0);
const resultEnd = ref(0);
// 练习页按句记忆的语速与起止词（同时写入本地进度，刷新/旋转后恢复）。
const practiceStart = ref(0);
const practiceEnd = ref(0);
const practiceRate = ref(DEFAULT_RATE);
// 当前循环是否在播放；true 时一遍播完会回到起点再来一遍。
const looping = ref(false);
const teacherAttemptId = ref(state.attempts[0]?.id ?? '');
const teacherDraft = ref(state.attempts[0]?.teacherFeedback ?? '');
let toastTimer = 0;
// 当前这一遍使用的语速：调速时不打断当前一遍，下一遍才按新速度。
let currentPassRate = DEFAULT_RATE;

const {
  supported: speechSupported,
  speaking: speechActive,
  unavailableReason,
  speakOnce,
  stop: stopSpeech
} = useSegmentPlayer();

const activeLesson = computed(() => lessonById(state.activeLessonId));
const activeCourse = computed(() => activeLesson.value ? courseForLesson(activeLesson.value.id) : undefined);
const currentSentence = computed(() => {
  const lesson = activeLesson.value;
  if (!lesson) return undefined;
  return lesson.sentences.find((sentence) => sentence.id === state.activeSentenceId) ?? lesson.sentences[0];
});
const activeProgress = computed(() => activeLesson.value ? state.progress[activeLesson.value.id] : undefined);
const currentAnswer = ref('');
const currentIndex = computed(() => {
  if (!activeLesson.value || !currentSentence.value) return 0;
  return activeLesson.value.sentences.findIndex((item) => item.id === currentSentence.value?.id);
});
const lessonCompletion = computed(() => {
  if (!activeLesson.value || !activeProgress.value) return 0;
  const answered = activeLesson.value.sentences.filter((sentence) => (activeProgress.value?.answers[sentence.id] ?? '').trim()).length;
  return Math.round((answered / activeLesson.value.sentences.length) * 100);
});
const resultAttempt = computed(() => state.attempts.find((attempt) => attempt.id === resultAttemptId.value));
const resultSentence = computed(() => resultAttempt.value?.sentenceAttempts[selectedResultSentence.value]);
const teacherAttempt = computed(() => state.attempts.find((attempt) => attempt.id === teacherAttemptId.value));
const totalWords = computed(() => state.attempts.flatMap((attempt) => attempt.sentenceAttempts).flatMap((item) => item.tokens).length);
const correctedWords = computed(() => state.attempts.flatMap((attempt) => attempt.sentenceAttempts).flatMap((item) => item.tokens).filter((token) => !token.correct && token.category !== 'unclassified').length);

const practiceTokens = computed(() => segmentText(currentSentence.value?.text ?? ''));
const rangeLow = computed(() => Math.min(practiceStart.value, practiceEnd.value));
const rangeHigh = computed(() => Math.max(practiceStart.value, practiceEnd.value));
const rangePreview = computed(() => practiceTokens.value.slice(rangeLow.value, rangeHigh.value + 1).map((token) => token.display).join(' '));
const rateHint = computed(() => {
  if (!speechSupported) return unavailableReason.value || '语音播放不可用';
  if (looping.value && Math.abs(currentPassRate - practiceRate.value) > 0.001) return '当前一遍继续原速，下一遍按新速度';
  if (looping.value) return '到结束词自动回到起点，点停止结束';
  return '语速和起止词会按句记住';
});

const categoryOptions: Array<{ value: ErrorCategory; label: string }> = [
  { value: 'unclassified', label: '未分类' },
  { value: 'spelling', label: '拼写错误' },
  { value: 'omitted', label: '漏词' },
  { value: 'extra', label: '多词' },
  { value: 'punctuation', label: '标点' },
  { value: 'grammar', label: '语法' }
];

function clampRate(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RATE;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, Number(value.toFixed(2))));
}

function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isFinite(value)) return length - 1;
  return Math.min(length - 1, Math.max(0, Math.round(value)));
}

function defaultPlayback(length: number): SentencePlayback {
  return { rate: DEFAULT_RATE, start: 0, end: Math.max(0, length - 1) };
}

// 切句时停止旧播放，并恢复该句上次保存的语速与起止词（保持暂停）。
watch(currentSentence, (sentence) => {
  stopLoop();
  const tokens = segmentText(sentence?.text ?? '');
  const saved = sentence ? activeProgress.value?.playback?.[sentence.id] : undefined;
  const config = saved ?? defaultPlayback(tokens.length);
  currentAnswer.value = sentence && activeProgress.value ? activeProgress.value.answers[sentence.id] ?? '' : '';
  practiceRate.value = clampRate(config.rate);
  practiceStart.value = clampIndex(config.start, tokens.length);
  practiceEnd.value = clampIndex(config.end, tokens.length);
}, { immediate: true });

watch(currentAnswer, (value) => {
  const lesson = activeLesson.value;
  const sentence = currentSentence.value;
  if (!lesson || !sentence) return;
  const progress = state.progress[lesson.id] ?? { answers: {}, activeSentenceId: sentence.id, updatedAt: new Date().toISOString(), playback: {} };
  progress.answers[sentence.id] = value;
  progress.activeSentenceId = sentence.id;
  progress.updatedAt = new Date().toISOString();
  state.progress[lesson.id] = progress;
});

// 语速与起止词变化时写回该句配置，旋转或刷新后可以恢复（仍保持暂停）。
watch([practiceRate, practiceStart, practiceEnd], () => {
  const lesson = activeLesson.value;
  const sentence = currentSentence.value;
  if (!lesson || !sentence) return;
  const progress = state.progress[lesson.id] ?? { answers: {}, activeSentenceId: sentence.id, updatedAt: new Date().toISOString(), playback: {} };
  if (!progress.playback) progress.playback = {};
  progress.playback[sentence.id] = { rate: practiceRate.value, start: practiceStart.value, end: practiceEnd.value };
  state.progress[lesson.id] = progress;
});

// 播放中调整起止词：结束旧播放，下一次播放使用新区间；调速不在这里停止。
watch([practiceStart, practiceEnd], () => {
  if (looping.value) stopLoop();
});

watch(activeLesson, (lesson) => {
  if (!lesson) return;
  state.activeLessonId = lesson.id;
  state.activeSentenceId = currentSentence.value?.id ?? lesson.sentences[0].id;
  const progress = state.progress[lesson.id] ?? { answers: {}, activeSentenceId: lesson.sentences[0].id, updatedAt: new Date().toISOString(), playback: {} };
  if (!progress.playback) progress.playback = {};
  if (!lesson.sentences.some((sentence) => sentence.id === progress.activeSentenceId)) progress.activeSentenceId = lesson.sentences[0].id;
  state.progress[lesson.id] = progress;
  state.activeSentenceId = progress.activeSentenceId;
  currentAnswer.value = progress.answers[state.activeSentenceId] ?? '';
});

// 提交、返回课程库或转入后台都会离开播放语境，统一停止旧播放。
watch(view, () => {
  stopSpeech();
  looping.value = false;
});

watch(teacherAttemptId, (id) => {
  teacherDraft.value = state.attempts.find((attempt) => attempt.id === id)?.teacherFeedback ?? '';
});

function notify(message: string) {
  toast.value = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toast.value = ''; }, 2400);
}

function startLesson(lesson: Lesson) {
  const progress = state.progress[lesson.id] ?? { answers: {}, activeSentenceId: lesson.sentences[0].id, updatedAt: new Date().toISOString(), playback: {} };
  if (!progress.playback) progress.playback = {};
  state.progress[lesson.id] = progress;
  state.activeLessonId = lesson.id;
  state.activeSentenceId = progress.activeSentenceId || lesson.sentences[0].id;
  currentAnswer.value = progress.answers[state.activeSentenceId] ?? '';
  view.value = 'practice';
  persist();
}

function goToSentence(index: number) {
  const lesson = activeLesson.value;
  if (!lesson || !lesson.sentences[index]) return;
  const target = lesson.sentences[index];
  state.activeSentenceId = target.id;
  const progress = state.progress[lesson.id];
  if (progress) {
    progress.activeSentenceId = target.id;
    progress.updatedAt = new Date().toISOString();
  }
  currentAnswer.value = progress?.answers[target.id] ?? '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function segmentSpeechText(start: number, end: number, source: string): string {
  const tokens = segmentText(source);
  const lo = clampIndex(Math.min(start, end), tokens.length);
  const hi = clampIndex(Math.max(start, end), tokens.length);
  return tokens.slice(lo, hi + 1).map((token) => token.display).join(' ');
}

function runPass() {
  const text = rangePreview.value;
  // 只在每一遍开始时取语速：当前一遍不被调速打断。
  currentPassRate = practiceRate.value;
  speakOnce({
    text,
    rate: currentPassRate,
    onEnd: () => {
      // 到结束词：循环仍开着就回到起点按（可能更新过的）语速再来一遍。
      if (looping.value) runPass();
    },
    onError: () => {
      looping.value = false;
      notify('语音播放被中断，可能缺少语音包，请重新播放');
    }
  });
}

function startLoop() {
  if (!speechSupported) {
    notify(unavailableReason.value || '当前设备无法使用语音播放');
    return;
  }
  if (!rangePreview.value.trim()) {
    notify('所选区间没有可播放的词');
    return;
  }
  looping.value = true;
  runPass();
}

function stopLoop() {
  looping.value = false;
  stopSpeech();
}

function toggleLoop() {
  if (looping.value) stopLoop();
  else startLoop();
}

function changeRate(delta: number) {
  practiceRate.value = clampRate(practiceRate.value + delta);
}

function resetRange() {
  const tokens = practiceTokens.value;
  practiceStart.value = 0;
  practiceEnd.value = Math.max(0, tokens.length - 1);
}

// 完整听写：整句只播一遍，速度沿用该句记住的语速。
function playFullOnce() {
  if (!speechSupported) {
    notify(unavailableReason.value || '当前设备无法使用语音播放');
    return;
  }
  looping.value = false;
  speakOnce({
    text: currentSentence.value?.text ?? '',
    rate: practiceRate.value,
    onError: () => notify('整句播放失败，设备可能缺少语音包')
  });
}

function submitLesson() {
  const lesson = activeLesson.value;
  const course = activeCourse.value;
  if (!lesson || !course) return;
  stopLoop();
  const progress = state.progress[lesson.id];
  const answeredCount = lesson.sentences.filter((sentence) => (progress?.answers[sentence.id] ?? '').trim()).length;
  if (!answeredCount) {
    notify('请至少输入一句话再提交');
    return;
  }
  if (answeredCount < lesson.sentences.length && !window.confirm(`还有 ${lesson.sentences.length - answeredCount} 句未作答，仍然提交吗？`)) return;
  const sentenceAttempts = lesson.sentences.map((sentence) => {
    const source = sentence.text;
    const answer = progress?.answers[sentence.id] ?? '';
    const tokens = compareSentence(source, answer);
    const correct = tokens.filter((token) => token.correct).length;
    return { sentenceId: sentence.id, source, answer, tokens, score: tokens.length ? Math.round((correct / tokens.length) * 100) : 0 };
  });
  const attempt: PracticeAttempt = {
    id: `attempt-${Date.now()}`,
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    courseTitle: course.title,
    submittedAt: new Date().toISOString(),
    score: scoreAttempt(sentenceAttempts),
    sentenceAttempts,
    teacherFeedback: ''
  };
  saveAttempt(attempt);
  resultAttemptId.value = attempt.id;
  selectedResultSentence.value = 0;
  syncResultSegment();
  view.value = 'result';
  persist();
  notify('已提交，逐词结果已生成');
}

function syncResultSegment() {
  const tokenCount = segmentText(resultSentence.value?.source ?? '').length;
  resultStart.value = 0;
  resultEnd.value = Math.max(0, tokenCount - 1);
}

// 结果页比对结果里“多词”会占用序列位置，错误词要映射回源句中的词序。
function sourceIndexOf(attempt: SentenceAttempt, tokenIndex: number): number {
  let position = 0;
  for (let i = 0; i < tokenIndex && i < attempt.tokens.length; i += 1) {
    if (attempt.tokens[i].expected) position += 1;
  }
  return position;
}

// 结果页：单击单词/错误词只播一遍，不做循环。
function replayWord(text: string) {
  if (!speechSupported) {
    notify(unavailableReason.value || '当前设备无法使用语音播放');
    return;
  }
  speakOnce({
    text,
    rate: 0.75,
    onError: () => notify('该词播放失败，设备可能缺少语音包')
  });
}

function replayResultSegment() {
  const sentence = resultSentence.value;
  if (!sentence) return;
  if (!speechSupported) {
    notify(unavailableReason.value || '当前设备无法使用语音播放');
    return;
  }
  speakOnce({
    text: segmentSpeechText(resultStart.value, resultEnd.value, sentence.source),
    rate: 0.72,
    onError: () => notify('片段播放失败，设备可能缺少语音包')
  });
}

// 结果页错误词/所选区间一键带回练习页同一区间（练习页保持暂停）。
function bringToPractice(sentenceId: string, start: number, end: number) {
  const attempt = resultAttempt.value;
  const lesson = attempt ? lessonById(attempt.lessonId) : undefined;
  const sentence = lesson?.sentences.find((item) => item.id === sentenceId);
  if (!attempt || !lesson || !sentence) {
    notify('课程内容已变化，无法回到该句练习');
    return;
  }
  stopSpeech();
  const tokens = segmentText(sentence.text);
  const lo = clampIndex(Math.min(start, end), tokens.length);
  const hi = clampIndex(Math.max(start, end), tokens.length);
  const progress = state.progress[lesson.id] ?? { answers: {}, activeSentenceId: sentence.id, updatedAt: new Date().toISOString(), playback: {} };
  if (!progress.playback) progress.playback = {};
  const previous = progress.playback[sentence.id] ?? defaultPlayback(tokens.length);
  progress.playback[sentence.id] = { rate: clampRate(previous.rate), start: lo, end: hi };
  progress.activeSentenceId = sentence.id;
  progress.updatedAt = new Date().toISOString();
  state.progress[lesson.id] = progress;
  state.activeLessonId = lesson.id;
  state.activeSentenceId = sentence.id;
  currentAnswer.value = progress.answers[sentence.id] ?? '';
  practiceRate.value = clampRate(previous.rate);
  practiceStart.value = lo;
  practiceEnd.value = hi;
  looping.value = false;
  view.value = 'practice';
  persist();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  notify('已带入同一区间，按播放即可反复重听');
}

function selectResultSentence(index: number) {
  stopSpeech();
  selectedResultSentence.value = index;
  syncResultSegment();
}

function saveClassification(attemptId: string, sentenceId: string, tokenIndex: number, category: ErrorCategory, reason: string) {
  updateTokenClassification(attemptId, sentenceId, tokenIndex, { category, reason });
  persist();
}

function saveTeacherFeedback() {
  const attempt = teacherAttempt.value;
  if (!attempt) return;
  attempt.teacherFeedback = teacherDraft.value.trim();
  persist();
  notify('教师反馈已保存');
}

function toggleTheme() {
  state.theme = state.theme === 'light' ? 'dark' : 'light';
}

function changeFont(delta: number) {
  state.fontScale = Math.min(1.25, Math.max(0.85, Number((state.fontScale + delta).toFixed(2))));
}

function downloadRecords() {
  const blob = new Blob([exportRecords()], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `echo-step-records-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  notify('练习记录已导出');
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function refreshVoiceAvailability() {
  if (!speechSupported) return;
  const voices = window.speechSynthesis.getVoices();
  unavailableReason.value = voices.length === 0 ? '没有检测到可用语音包，设备可能未安装 TTS 语音' : '';
}

function onConnectionChange() {
  online.value = navigator.onLine;
  persist();
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    stopLoop();
    persist();
  }
}

// 旋转时停止旧播放；配置已持久化，回来后仍处于暂停并可恢复语速/起止词。
const orientationMedia = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(orientation: portrait)')
  : undefined;
function onOrientationChange() {
  stopLoop();
}

onMounted(() => {
  window.addEventListener('online', onConnectionChange);
  window.addEventListener('offline', onConnectionChange);
  window.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', stopLoop);
  window.addEventListener('orientationchange', onOrientationChange);
  orientationMedia?.addEventListener?.('change', onOrientationChange);
  if (speechSupported) {
    refreshVoiceAvailability();
    window.speechSynthesis.onvoiceschanged = refreshVoiceAvailability;
    window.setTimeout(refreshVoiceAvailability, 600);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('online', onConnectionChange);
  window.removeEventListener('offline', onConnectionChange);
  window.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('pagehide', stopLoop);
  window.removeEventListener('orientationchange', onOrientationChange);
  orientationMedia?.removeEventListener?.('change', onOrientationChange);
  if (speechSupported) window.speechSynthesis.onvoiceschanged = null;
  stopLoop();
  persist();
});
</script>

<template>
  <var-app>
    <div class="app-shell" :data-theme="state.theme" :style="{ '--font-scale': state.fontScale }">
      <div v-if="view === 'library'" class="page">
        <header class="topbar">
          <div class="brand">
            <div class="brand-mark">E</div>
            <div><h1>EchoStep</h1><p>移动端语言听写</p></div>
          </div>
          <div class="icon-row">
            <button class="icon-button" :aria-label="state.theme === 'light' ? '切换到深色模式' : '切换到浅色模式'" @click="toggleTheme">{{ state.theme === 'light' ? '◐' : '☀' }}</button>
            <button class="icon-button" aria-label="减小字号" @click="changeFont(-0.05)">A−</button>
            <button class="icon-button" aria-label="增大字号" @click="changeFont(0.05)">A＋</button>
          </div>
        </header>

        <section class="hero">
          <h2>今天也把声音变成文字</h2>
          <p>下载课程后可离线作答，答案和当前位置会自动恢复。</p>
          <div class="hero-stats">
            <div class="hero-stat"><strong>{{ state.attempts.length }}</strong><span>练习记录</span></div>
            <div class="hero-stat"><strong>{{ correctedWords }}</strong><span>已分类错误</span></div>
            <div class="hero-stat"><strong>{{ totalWords }}</strong><span>累计词数</span></div>
          </div>
        </section>

        <div class="offline-banner" :class="{ online }">
          <span>{{ online ? '● 在线 · 数据已保存到本机' : '● 离线模式 · 可继续已下载课程' }}</span>
          <span>{{ online ? '本地优先存储' : '恢复网络后继续保存' }}</span>
        </div>

        <div class="section-head">
          <h3>课程库</h3>
          <div class="segmented">
            <button :class="{ active: state.role === 'learner' }" @click="state.role = 'learner'; view = 'library'">学习</button>
            <button :class="{ active: state.role === 'teacher' }" @click="state.role = 'teacher'; view = 'teacher'">教师</button>
          </div>
        </div>

        <article v-for="course in state.courses" :key="course.id" class="course-card">
          <div class="course-title">
            <div><h3>{{ course.title }}</h3><p>{{ course.description }}</p></div>
            <span class="level-badge">{{ course.level }}</span>
          </div>
          <div v-for="lesson in course.lessons" :key="lesson.id" class="lesson-row">
            <div><h4>{{ lesson.title }}</h4><p>{{ lesson.subtitle }} · {{ lesson.sentences.length }} 句 · 约 {{ lesson.estimatedMinutes }} 分钟</p></div>
            <div class="lesson-actions">
              <var-switch :model-value="lesson.downloaded" @update:model-value="setDownloaded(lesson.id, $event as boolean)" />
              <var-button type="primary" size="small" @click="startLesson(lesson)">{{ lesson.downloaded ? '继续' : '开始' }}</var-button>
            </div>
          </div>
        </article>

        <div class="section-head"><h3>最近练习</h3><span>{{ state.attempts.length }} 条记录</span></div>
        <article v-if="state.attempts.length" class="panel">
          <div v-for="attempt in state.attempts.slice(0, 4)" :key="attempt.id" class="history-card">
            <div class="history-top"><strong>{{ attempt.lessonTitle }}</strong><span class="history-score">{{ attempt.score }} 分</span></div>
            <p>{{ formatDate(attempt.submittedAt) }} · {{ attempt.teacherFeedback || '暂无教师反馈' }}</p>
          </div>
          <var-button block type="primary" variant="outline" @click="downloadRecords">导出全部练习记录</var-button>
        </article>
        <div v-else class="empty-state"><strong>还没有练习记录</strong>完成一次听写后，可在这里复核和导出。</div>
      </div>

      <div v-else-if="view === 'practice' && activeLesson" class="page">
        <header class="practice-header">
          <div class="practice-nav">
            <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
            <div><h2>{{ activeLesson.title }}</h2></div>
            <span class="status-chip">{{ online ? '在线' : '离线' }}</span>
          </div>
          <div class="progress-line">
            <div class="sentence-count"><span>第 {{ currentIndex + 1 }} / {{ activeLesson.sentences.length }} 句</span><span>{{ lessonCompletion }}% 已填写</span></div>
            <var-progress :value="lessonCompletion" color="#1769e0" />
          </div>
        </header>

        <section class="audio-card">
          <div class="audio-meta">
            <button class="play-button" :class="{ looping }" :aria-label="looping ? '停止循环播放' : '循环播放所选片段'" :disabled="!speechSupported" @click="toggleLoop">{{ looping ? '■' : '▶' }}</button>
            <div>
              <strong>{{ looping ? '正在循环播放' : speechActive ? '正在播放' : '片段循环' }}</strong>
              <p>{{ looping ? '到结束词自动回到起点，点左侧停止结束。' : '先反复听一小段，再回到整句听写。' }}</p>
            </div>
          </div>
          <div class="loop-panel">
            <div class="rate-row">
              <span class="loop-label">语速</span>
              <button class="step-button" aria-label="减慢语速" :disabled="!speechSupported" @click="changeRate(-RATE_STEP)">−</button>
              <strong class="rate-value">{{ practiceRate.toFixed(2) }}×</strong>
              <button class="step-button" aria-label="加快语速" :disabled="!speechSupported" @click="changeRate(RATE_STEP)">＋</button>
              <span class="loop-hint">{{ rateHint }}</span>
            </div>
            <div class="range-row">
              <label>起点词
                <select v-model.number="practiceStart" aria-label="片段起点词">
                  <option v-for="token in practiceTokens" :key="`ps-${token.index}`" :value="token.index">{{ token.index + 1 }} · {{ token.display }}</option>
                </select>
              </label>
              <label>结束词
                <select v-model.number="practiceEnd" aria-label="片段结束词">
                  <option v-for="token in practiceTokens" :key="`pe-${token.index}`" :value="token.index">{{ token.index + 1 }} · {{ token.display }}</option>
                </select>
              </label>
              <button class="ghost-button" @click="resetRange">整句</button>
            </div>
            <p class="range-preview">“{{ rangePreview }}”</p>
          </div>
        </section>

        <div class="dictation-label"><strong>输入听到的内容</strong><span>答案在本机自动保存</span></div>
        <textarea v-model="currentAnswer" class="answer-box" :aria-label="`第 ${currentIndex + 1} 句听写答案`" placeholder="Type what you hear..." @keydown.ctrl.enter="submitLesson" @keydown.meta.enter="submitLesson"></textarea>
        <div class="practice-actions">
          <var-button block type="default" variant="outline" :disabled="!speechSupported" @click="playFullOnce">整句听一遍</var-button>
          <var-button block type="primary" @click="submitLesson">提交本次听写</var-button>
        </div>

        <div class="sentence-picker" aria-label="句子导航">
          <button v-for="(sentence, index) in activeLesson.sentences" :key="sentence.id" class="sentence-dot" :class="{ active: sentence.id === currentSentence?.id, done: !!activeProgress?.answers[sentence.id] }" :aria-label="`跳到第 ${index + 1} 句`" @click="goToSentence(index)">{{ index + 1 }}</button>
        </div>

        <section v-if="currentSentence" class="panel">
          <div class="detail-head"><div><h3>场景提示</h3><p>{{ currentSentence.translation }}</p></div></div>
          <div class="feedback-card">{{ currentSentence.note }}</div>
        </section>
      </div>

      <div v-else-if="view === 'result' && resultAttempt" class="page">
        <header class="topbar">
          <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
          <span class="status-chip">提交于 {{ formatDate(resultAttempt.submittedAt) }}</span>
          <button class="icon-button" @click="downloadRecords">导出</button>
        </header>

        <section class="panel result-score">
          <div class="score-ring" :style="{ '--score': `${resultAttempt.score}%` }"><strong>{{ resultAttempt.score }}</strong></div>
          <h2>{{ resultAttempt.score >= 90 ? '几乎完美' : resultAttempt.score >= 70 ? '继续打磨细节' : '再听一遍会更好' }}</h2>
          <p>{{ resultAttempt.lessonTitle }} · 点击单词可重听，错误词还能带入练习页同一区间反复听。</p>
        </section>

        <div class="sentence-picker">
          <button v-for="(attempt, index) in resultAttempt.sentenceAttempts" :key="attempt.sentenceId" class="sentence-dot" :class="{ active: index === selectedResultSentence }" @click="selectResultSentence(index)">{{ index + 1 }}</button>
        </div>

        <section v-if="resultSentence" class="panel token-panel">
          <div class="detail-head">
            <div><h3>第 {{ selectedResultSentence + 1 }} 句逐词结果</h3><p>{{ resultSentence.source }}</p></div>
            <span class="history-score">{{ resultSentence.score }}%</span>
          </div>
          <div class="word-list">
            <button v-for="token in resultSentence.tokens" :key="`${token.index}-${token.expected}-${token.actual}`" class="word-chip" :class="{ wrong: !token.correct }" :disabled="!speechSupported" :title="token.correct ? '点击重听' : `你的答案：${token.actual || '未输入'}`" @click="replayWord(token.expected || token.actual)">
              {{ token.expected || `[+${token.actual}]` }}<small v-if="!token.correct">{{ token.actual || '漏词' }}</small>
            </button>
          </div>

          <div v-if="resultSentence.tokens.some((token) => !token.correct)" style="margin-top: 18px">
            <div class="dictation-label"><strong>片段重听</strong><span>选择起止词后播放</span></div>
            <p v-if="!speechSupported" class="speech-warning">{{ unavailableReason || '语音播放不可用' }}</p>
            <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; align-items: center">
              <select v-model.number="resultStart" aria-label="片段起点"><option v-for="token in segmentText(resultSentence.source)" :key="`s-${token.index}`" :value="token.index">{{ token.index + 1 }} · {{ token.display }}</option></select>
              <select v-model.number="resultEnd" aria-label="片段终点"><option v-for="token in segmentText(resultSentence.source)" :key="`e-${token.index}`" :value="token.index">{{ token.index + 1 }} · {{ token.display }}</option></select>
              <var-button type="primary" size="small" :disabled="!speechSupported" @click="replayResultSegment">播放片段</var-button>
            </div>
            <var-button block size="small" variant="outline" style="margin-top: 9px" @click="bringToPractice(resultSentence.sentenceId, resultStart, resultEnd)">把这一区间带入练习页反复听</var-button>
          </div>

          <div v-if="resultSentence.tokens.some((token) => !token.correct)" style="margin-top: 18px">
            <div class="dictation-label"><strong>错误分类与原因</strong><span>会被写入本地记录</span></div>
            <div v-for="token in resultSentence.tokens.filter((item) => !item.correct)" :key="`edit-${token.index}`" class="feedback-card">
              <div class="error-head">
                <strong>{{ token.expected || `多出的词：${token.actual}` }}</strong>
                <button v-if="token.expected" class="mini-button" @click="bringToPractice(resultSentence.sentenceId, sourceIndexOf(resultSentence, token.index), sourceIndexOf(resultSentence, token.index))">带入练习重听</button>
              </div>
              <div style="display: grid; grid-template-columns: 120px 1fr; gap: 8px; margin-top: 9px">
                <select :value="token.category" @change="saveClassification(resultAttempt.id, resultSentence.sentenceId, token.index, ($event.target as HTMLSelectElement).value as ErrorCategory, token.reason)">
                  <option v-for="option in categoryOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
                <input :value="token.reason" placeholder="记录原因，如连读、词尾未听清" @change="saveClassification(resultAttempt.id, resultSentence.sentenceId, token.index, token.category, ($event.target as HTMLInputElement).value)" />
              </div>
            </div>
          </div>
        </section>

        <section v-if="resultAttempt.teacherFeedback" class="panel"><div class="feedback-card"><strong>教师反馈</strong><p>{{ resultAttempt.teacherFeedback }}</p></div></section>
        <var-button block type="primary" @click="startLesson(activeLesson!)">返回本次课程</var-button>
        <var-button block type="default" variant="outline" style="margin-top: 10px" @click="downloadRecords">导出练习记录</var-button>
      </div>

      <div v-else-if="view === 'teacher'" class="page">
        <header class="topbar">
          <button class="back-button" aria-label="返回课程库" @click="view = 'library'">‹</button>
          <div class="brand"><div class="brand-mark">T</div><div><h1>教师复核</h1><p>查看作答并写入反馈</p></div></div>
        </header>

        <div v-if="state.attempts.length" class="panel">
          <div class="dictation-label"><strong>选择一次作答</strong><span>{{ state.attempts.length }} 条</span></div>
          <var-select v-model="teacherAttemptId" placeholder="选择作答">
            <var-option v-for="attempt in state.attempts" :key="attempt.id" :label="`${attempt.lessonTitle} · ${attempt.score} 分 · ${formatDate(attempt.submittedAt)}`" :value="attempt.id" />
          </var-select>
          <template v-if="teacherAttempt">
            <div class="feedback-card"><strong>{{ teacherAttempt.courseTitle }}</strong><p>{{ teacherAttempt.lessonTitle }} · 总分 {{ teacherAttempt.score }}，完成 {{ teacherAttempt.sentenceAttempts.length }} 句。</p></div>
            <div class="teacher-editor">
              <textarea v-model="teacherDraft" placeholder="给学生一条具体、可执行的反馈..." aria-label="教师反馈"></textarea>
              <var-button block type="primary" style="margin-top: 10px" @click="saveTeacherFeedback">保存反馈</var-button>
            </div>
          </template>
        </div>
        <div v-else class="empty-state"><strong>暂无学生作答</strong>学习端提交听写后，这里会出现练习记录。</div>
      </div>

      <div v-if="toast" style="position: fixed; z-index: 30; left: 50%; bottom: 28px; transform: translateX(-50%); padding: 11px 16px; border-radius: 12px; background: #17233d; color: white; font-size: .78rem; box-shadow: 0 10px 30px rgb(0 0 0 / .2)">{{ toast }}</div>
    </div>
  </var-app>
</template>
