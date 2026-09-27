import { reactive } from 'vue';

export interface LoopSource {
  getText: () => string;
  getRate: () => number;
}

export const player = reactive({
  looping: false,
  pass: 0,
  reason: ''
});

const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

let loopToken = 0;
let loopTimer = 0;
let voicesSeen = false;

export function refreshSpeechReason(): string {
  if (!supported) {
    player.reason = '当前浏览器不支持语音合成，请改用最新版 Chrome、Edge 或 Safari';
    return player.reason;
  }
  const voices = window.speechSynthesis.getVoices();
  if (voices.length) {
    voicesSeen = true;
    player.reason = voices.some((voice) => voice.lang.toLowerCase().startsWith('en'))
      ? ''
      : '设备中没有英语语音包，请在系统语音设置中安装英文语音';
  } else {
    // Before the first voice list arrives there is a grace period: some browsers
    // only populate getVoices() after a user gesture, so stay quiet until then.
    player.reason = voicesSeen ? '语音服务暂不可用，请检查网络或系统语音设置后重试' : '';
  }
  return player.reason;
}

export function watchVoices() {
  if (!supported) return;
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener('voiceschanged', refreshSpeechReason);
}

export function stopAllPlayback() {
  loopToken += 1;
  window.clearTimeout(loopTimer);
  if (supported) window.speechSynthesis.cancel();
  player.looping = false;
  player.pass = 0;
}

export function startSegmentLoop(source: LoopSource, onFail: (reason: string) => void) {
  stopAllPlayback();
  const reason = refreshSpeechReason();
  if (reason) {
    onFail(reason);
    return;
  }
  if (!source.getText().trim()) {
    onFail('当前区间没有可播放的内容');
    return;
  }
  const token = ++loopToken;
  player.looping = true;
  player.pass = 0;

  const speakPass = () => {
    if (token !== loopToken) return;
    const passage = source.getText().trim();
    if (!passage) {
      stopAllPlayback();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(passage);
    utterance.lang = 'en-US';
    // The rate is read at the start of every pass, so a rate change only takes
    // effect on the next loop while the current pass keeps its original speed.
    utterance.rate = source.getRate();
    let settled = false;
    utterance.onend = () => {
      settled = true;
      if (token !== loopToken) return;
      player.pass += 1;
      loopTimer = window.setTimeout(speakPass, 400);
    };
    utterance.onerror = (event) => {
      settled = true;
      if (token !== loopToken || event.error === 'canceled' || event.error === 'interrupted') return;
      stopAllPlayback();
      onFail(`语音播放中断：${event.error}`);
    };
    window.speechSynthesis.speak(utterance);
    window.setTimeout(() => {
      if (!settled && token === loopToken && !window.speechSynthesis.speaking && !window.speechSynthesis.pending) {
        stopAllPlayback();
        player.reason = '语音引擎未响应，请检查设备语音设置或网络连接';
        onFail(player.reason);
      }
    }, 1500);
  };

  // A short delay after cancel() avoids dropped utterances in Chromium.
  loopTimer = window.setTimeout(speakPass, 60);
}

export function playOnce(text: string, rate: number, onFail: (reason: string) => void) {
  stopAllPlayback();
  const reason = refreshSpeechReason();
  if (reason) {
    onFail(reason);
    return;
  }
  if (!text.trim()) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = rate;
  utterance.onerror = (event) => {
    if (event.error !== 'canceled' && event.error !== 'interrupted') onFail(`语音播放失败：${event.error}`);
  };
  window.setTimeout(() => window.speechSynthesis.speak(utterance), 60);
}
