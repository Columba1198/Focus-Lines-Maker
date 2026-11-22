// エラー表示用のモーダル。操作が不要なお知らせはtoast.jsを使う。
// <dialog>を使い、フォーカスの閉じ込め・Escキー・背景はブラウザに任せている。

let dialog = null;
let titleEl = null;
let messageEl = null;
let okButton = null;
// 表示中に来たメッセージは、閉じたあとに順番に表示する
let queue = Promise.resolve();

function ensureDialog() {
    if (dialog) return;

    dialog = document.createElement('dialog');
    dialog.className = 'modal';
    dialog.setAttribute('aria-labelledby', 'modal-title');
    dialog.setAttribute('aria-describedby', 'modal-message');

    const content = document.createElement('div');
    content.className = 'modal-content';

    titleEl = document.createElement('h2');
    titleEl.className = 'modal-title';
    titleEl.id = 'modal-title';

    messageEl = document.createElement('p');
    messageEl.className = 'modal-message';
    messageEl.id = 'modal-message';

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    okButton = document.createElement('button');
    okButton.type = 'button';
    okButton.className = 'button primary button-inline';
    okButton.textContent = 'OK';
    okButton.addEventListener('click', () => dialog.close());

    actions.append(okButton);
    content.append(titleEl, messageEl, actions);
    dialog.append(content);

    // dialog自身へのクリックは背景のクリック
    // 押し始めも背景の場合に限り、文字を選択して背景で離したときに閉じないように
    let pressStartedOnBackdrop = false;
    dialog.addEventListener('pointerdown', (e) => {
        pressStartedOnBackdrop = e.target === dialog;
    });
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog && pressStartedOnBackdrop) dialog.close();
        pressStartedOnBackdrop = false;
    });

    document.body.append(dialog);
}

/**
 * @param {string} message プレーンテキストとして表示する（改行はそのまま）
 * @param {{ title?: string }} [options]
 * @returns {Promise<void>} 閉じたときに解決する
 */
export function showMessage(message, { title = 'エラー' } = {}) {
    queue = queue.then(() => openDialog(message, title));
    return queue;
}

function openDialog(message, title) {
    // <dialog>に対応していないブラウザではalertで代用
    if (typeof HTMLDialogElement !== 'function') {
        window.alert(message);
        return Promise.resolve();
    }

    ensureDialog();
    titleEl.textContent = title;
    messageEl.textContent = message;

    return new Promise((resolve) => {
        dialog.addEventListener('close', () => resolve(), { once: true });
        dialog.showModal();
        okButton.focus();
    });
}
