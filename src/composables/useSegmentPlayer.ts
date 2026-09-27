import { onBeforeUnmount, ref, shallowRef } from 'vue';

export interface SpeakOptions {
  text: string;
  lang?: string;
  rate: number;
  onEnd?: () => void;
  onError?: () => void;
}

/**
 * 语音合成循环播放器。
 *
 * - 只保留一个全局实例，任何新的播放/停止都会先取消旧播放；
 * - 语速在当前一遍播放期间保持不变，下一遍起使用新语速；
 * - 一遍播完后由调用方决定回到起点重播还是停止。
 */
export function useSegmentPlayer() {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const speaking = ref(false);
  const unavailableReason = ref(supported ? '' : detectUnsupportedReason());

  const synth = supported ? window.speechSynthesis : undefined;
  const active = shallowRef<SpeakOptions | null>(null);
  let stopped = false;
  let chromePauseTimer = 0;

  function detectUnsupportedReason(): string {
    if (typeof window === 'undefined') return '当前环境没有语音合成能力';
    if (!('speechSynthesis' in window)) return '当前浏览器不支持语音合成（Speech Synthesis API 不可用）';
    if (!('SpeechSynthesisUtterance' in window)) return '当前浏览器无法创建语音播报对象';
    return '';
  }

  function clearChromePauseTimer() {
    if (chromePauseTimer) {
      window.clearInterval(chromePauseTimer);
      chromePauseTimer = 0;
    }
  }

  // 部分移动端浏览器（Chrome/Android）长文本约 15 秒会自动暂停，周期性 resume 规避。
  function startChromePauseGuard() {
    clearChromePauseTimer();
    if (navigator.userAgent.includes('Chrome')) {
      chromePauseTimer = window.setInterval(() => {
        if (!stopped && synth && synth.speaking) synth.resume();
      }, 9000);
    }
  }

  function finishStopped() {
    clearChromePauseTimer();
    active.value = null;
    speaking.value = false;
  }

  /** 取消正在进行的播放（包括其它实例发起的播放）。 */
  function stop() {
    stopped = true;
    clearChromePauseTimer();
    // 旧 utterance 的 end/error 回调通过 active 标识自行失效。
    synth?.cancel();
    finishStopped();
  }

  /** 播放一遍文本，结束/出错时通过回调通知；不会自动重复。 */
  function speakOnce(options: SpeakOptions) {
    if (!synth) {
      unavailableReason.value = detectUnsupportedReason();
      options.onError?.();
      return;
    }
    stop();
    stopped = false;
    active.value = options;
    speaking.value = true;

    // cancel 之后部分浏览器需要稍等再 speak，否则会吞掉第一句。
    window.setTimeout(() => {
      if (stopped || active.value !== options) return;
      const utterance = new SpeechSynthesisUtterance(options.text);
      utterance.lang = options.lang ?? 'en-US';
      utterance.rate = options.rate;
      utterance.onend = () => {
        if (active.value !== options || stopped) return;
        clearChromePauseTimer();
        speaking.value = false;
        active.value = null;
        options.onEnd?.();
      };
      utterance.onerror = () => {
        if (active.value !== options || stopped) return;
        clearChromePauseTimer();
        speaking.value = false;
        active.value = null;
        options.onError?.();
      };
      synth.speak(utterance);
      startChromePauseGuard();
    }, 60);
  }

  function isSpeaking() {
    return speaking.value;
  }

  onBeforeUnmount(stop);

  return { supported, speaking, unavailableReason, speakOnce, stop, isSpeaking };
}
