// 画面下に出すトースト。操作が不要なお知らせ用（エラーはmodal.jsを使う）。

const DEFAULT_DURATION = 5000;
const MAX_TOASTS = 3;

let container = null;

function ensureContainer() {
    if (container) return container;
    container = document.createElement('div');
    container.className = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    document.body.append(container);
    return container;
}

// スクリーンリーダーは、すでにあるライブリージョンの変化しか読み上げないため、先に作っておく
if (document.body) {
    ensureContainer();
} else {
    document.addEventListener('DOMContentLoaded', ensureContainer, { once: true });
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * @param {string} message プレーンテキストとして表示する（改行はそのまま）
 * @param {{ duration?: number }} [options] 消えるまでの時間（ミリ秒）
 */
export function showToast(message, { duration = DEFAULT_DURATION } = {}) {
    const root = ensureContainer();

    const toast = document.createElement('div');
    toast.className = 'toast';

    const text = document.createElement('p');
    text.className = 'toast-message';
    text.textContent = message;

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'toast-close';
    closeButton.setAttribute('aria-label', '閉じる');
    closeButton.textContent = '×';

    toast.append(text, closeButton);
    root.append(toast);

    while (root.children.length > MAX_TOASTS) {
        root.firstElementChild.remove();
    }

    let remaining = duration;
    let timerId = null;
    let startedAt = 0;
    let running = false;
    let dismissed = false;
    let hovered = false;
    let focused = false;

    const dismiss = () => {
        if (dismissed) return;
        dismissed = true;
        clearTimeout(timerId);
        if (prefersReducedMotion()) {
            toast.remove();
            return;
        }
        toast.classList.add('is-leaving');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
        // animationendが発火しなかった場合の保険
        setTimeout(() => toast.remove(), 400);
    };

    const startTimer = () => {
        if (dismissed || running) return;
        running = true;
        startedAt = Date.now();
        timerId = setTimeout(dismiss, remaining);
    };

    const pauseTimer = () => {
        if (!running) return;
        running = false;
        clearTimeout(timerId);
        remaining = Math.max(0, remaining - (Date.now() - startedAt));
    };

    const updateTimer = () => (hovered || focused ? pauseTimer() : startTimer());
    toast.addEventListener('mouseenter', () => { hovered = true; updateTimer(); });
    toast.addEventListener('mouseleave', () => { hovered = false; updateTimer(); });
    toast.addEventListener('focusin', () => { focused = true; updateTimer(); });
    toast.addEventListener('focusout', () => { focused = false; updateTimer(); });
    closeButton.addEventListener('click', dismiss);

    startTimer();
}
