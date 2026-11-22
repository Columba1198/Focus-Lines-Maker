import { showMessage } from './modal.js';
import { showToast } from './toast.js';

document.addEventListener('DOMContentLoaded', () => {
    console.log('%cv( ･ω･ )ｨｪｨ', 'font-size: 1rem;');
    
    // --- Colorisの初期化と設定 ---
    try {
        Coloris({
            alpha: true,
            swatches: [
                '#000000',
                '#ffffff',
                '#dc143c',
                '#ffe224',
                '#2dc73f',
                '#48cae4'
            ]
        });
    } catch (e) {
        console.error('Coloris initialization failed:', e);
    }

    // --- Web Worker の初期化 ---
    const worker = new Worker(new URL('./focus-lines-worker.js', import.meta.url), { type: 'module' });

    // --- DOM要素の取得 ---
    const selectImageBtn = document.getElementById('select-image-btn');
    const imageLoader = document.getElementById('image-loader');
    const canvas = document.getElementById('canvas');
    const offscreen = canvas.transferControlToOffscreen();
    // 開発用：?simulateCanvasLimit=16777216 を付けると、それを超えるキャンバスを確保失敗として扱う（古いiOSの再現）
    const simulatedCanvasLimit = Number(new URLSearchParams(location.search).get('simulateCanvasLimit')) || null;
    worker.postMessage({ type: 'init', canvas: offscreen, simulatedCanvasLimit }, [offscreen]);
    const uploadPrompt = document.getElementById('upload-prompt');
    const canvasContainer = document.getElementById('canvas-container');
    const workspace = document.querySelector('.workspace');
    const downloadBtn = document.getElementById('download-btn');
    const resetBtn = document.getElementById('reset-btn');
    const changeImageBtn = document.getElementById('change-image-btn');

    // --- 設定項目の取得 ---
    const focusArea = document.getElementById('focus-area');
    const guideH = document.getElementById('guide-line-h');
    const guideV = document.getElementById('guide-line-v');
    const focusShapeSelect = document.getElementById('focus-shape');
    const lineTypeSelect = document.getElementById('line-type');
    const lineColorInput = document.getElementById('line-color');
    const lineCountInput = document.getElementById('line-count');
    const lineThicknessInput = document.getElementById('line-thickness');
    const randomnessInput = document.getElementById('randomness');

    // --- 初期値と状態管理 ---
    const defaultSettings = {
        focusShape: 'rectangle',
        lineType: 'normal',
        lineColor: '#000000',
        lineCount: '150',
        lineThickness: '50',
        randomness: '0.5'
    };
    // style.cssの#focus-areaと値を揃えること
    const defaultFocusRect = { left: 0.15, top: 0.15, width: 0.7, height: 0.7 };
    let originalFileName = '';
    let originalFileType = 'image/png';
    // 画像本体はワーカーが持つ
    let imageSize = null;
    // 保存時もこのシードで描き直し、プレビューと同じ配置にする
    let currentSeed = 0;
    let focusState = {
        isDragging: false, isResizing: false,
        dragStartX: 0, dragStartY: 0,
        resizeDirection: null,
        parentWidth: 0, parentHeight: 0,
        areaWidth: 0, areaHeight: 0,
        activePointerId: null
    };
    let moveRafId = null;

    // --- Worker 描画スロットリング ---
    let workerBusy = false;
    let drawPending = false;
    worker.addEventListener('message', (e) => {
        if (e.data.type === 'drawDone') {
            workerBusy = false;
            flushPendingDraw();
        }
    });

    // --- イベントリスナーの設定 ---
    if (selectImageBtn) {
        selectImageBtn.addEventListener('click', (e) => {
            e.preventDefault();
            imageLoader.click();
        });
    }
    imageLoader.addEventListener('change', handleImageUpload);
    downloadBtn.addEventListener('click', downloadImage);
    resetBtn.addEventListener('click', resetSettings);
    changeImageBtn.addEventListener('click', () => imageLoader.click());

    // 配置を保つ設定
    [focusShapeSelect, lineTypeSelect, lineColorInput, lineThicknessInput, randomnessInput].forEach(el => {
        el.addEventListener('input', () => postDrawMessage({ reseed: false }));
    });
    // 本数を変えると全線の角度が変わるので、配置を作り直す
    lineCountInput.addEventListener('input', () => postDrawMessage());

    focusArea.addEventListener('pointerdown', handleInteractionStart);
    document.addEventListener('pointermove', handleInteractionMove);
    document.addEventListener('pointerup', handleInteractionEnd);
    // pointerupが届かない場合でも必ずドラッグを解除する
    document.addEventListener('pointercancel', handleInteractionEnd);
    focusArea.addEventListener('lostpointercapture', handleInteractionEnd);
    window.addEventListener('blur', () => handleInteractionEnd());
    canvasContainer.addEventListener('dragstart', (e) => e.preventDefault());

    workspace.addEventListener('dragenter', handleDragEnter, false);
    workspace.addEventListener('dragover', handleDragOver, false);
    workspace.addEventListener('dragleave', handleDragLeave, false);
    workspace.addEventListener('drop', handleDrop, false);

    let resizeTimer;
    let lastWindowWidth = window.innerWidth;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            const currentWindowWidth = window.innerWidth;
            if (currentWindowWidth !== lastWindowWidth) {
                lastWindowWidth = currentWindowWidth;
                if (imageSize) {
                    const focusRatios = getFocusAreaRatios();
                    setupCanvas();
                    setFocusAreaRatios(focusRatios);
                    postDrawMessage({ reseed: false });
                }
            }
        }, 250);
    });

    // --- 主要な関数 ---
    function handleDragEnter(e) {
        e.preventDefault();
        e.stopPropagation();
        workspace.classList.add('drag-over');
    }

    function handleDragOver(e) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
    }

    function handleDragLeave(e) {
        e.preventDefault();
        e.stopPropagation();
        workspace.classList.remove('drag-over');
    }

    function handleDrop(e) {
        e.preventDefault();
        e.stopPropagation();
        workspace.classList.remove('drag-over');

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            loadImageFile(files[0]);
        }
    }

    function handleImageUpload(e) {
        const files = e.target.files;
        if (files.length > 0) {
            loadImageFile(files[0]);
        }
        // Chrome・Safariは同じファイルを選び直すとchangeを発火しないため、選択を空にしておく
        e.target.value = '';
    }

    async function loadImageFile(file) {
        const extension = (/\.([^.]+)$/.exec(file.name)?.[1] ?? '').toLowerCase();
        const isSvg = file.type === 'image/svg+xml' || extension === 'svg';
        // WindowsではHEICのMIMEタイプが空になることがあるため、拡張子でも判定する
        const isHeic = /^image\/hei[cf]/.test(file.type) || extension === 'heic' || extension === 'heif';

        // 主要なブラウザのcreateImageBitmapはSVGを読み込めない
        if (isSvg) {
            showMessage('SVG形式の画像には対応していません。JPEG・PNG・WebPなどの画像を選んでください。', { title: 'エラー' });
            return;
        }
        if (!file.type.startsWith('image/') && !isHeic) {
            showMessage('画像ファイルを選択してください。', { title: 'エラー' });
            return;
        }

        originalFileName = file.name;
        originalFileType = file.type;

        try {
            const imageBitmap = await createImageBitmap(file);
            imageSize = { width: imageBitmap.width, height: imageBitmap.height };
            // 所有権をワーカーに移す（古い画像はワーカー側で解放する）
            worker.postMessage({ type: 'setImage', image: imageBitmap }, [imageBitmap]);

            uploadPrompt.classList.add('hidden');
            canvasContainer.classList.remove('hidden');
            workspace.classList.add('image-loaded');
            downloadBtn.disabled = false;
            resetBtn.disabled = false;
            changeImageBtn.disabled = false;

            setupCanvas();
            setFocusAreaRatios(defaultFocusRect);
            postDrawMessage();
        } catch (e) {
            console.error('Image loading failed:', e);
            // HEICはSafari以外では読み込めない
            const message = isHeic
                ? 'このブラウザでは、HEIC形式の画像を読み込めません。JPEGなどに変換してからアップロードしてください。'
                : '画像を読み込めませんでした。対応していない形式か、ファイルが壊れている可能性があります。JPEG・PNG・WebPなどの画像を選んでください。';
            showMessage(message, { title: 'エラー' });
        }
    }

    function setupCanvas() {
        const workspace = document.querySelector('.workspace');
        const maxW = workspace.clientWidth - 20;
        const maxH = workspace.clientHeight - 20;
        const scale = Math.min(maxW / imageSize.width, maxH / imageSize.height, 2);
        const displayWidth = imageSize.width * scale;
        const displayHeight = imageSize.height * scale;
        canvas.style.width = `${displayWidth}px`;
        canvas.style.height = `${displayHeight}px`;
        // プレビューは表示に必要な解像度で描く（保存時に元の解像度で描き直す）
        const dpr = window.devicePixelRatio || 1;
        const previewScale = Math.min(1, (displayWidth * dpr) / imageSize.width);
        const previewWidth = Math.max(1, Math.round(imageSize.width * previewScale));
        const previewHeight = Math.max(1, Math.round(imageSize.height * previewScale));
        worker.postMessage({ type: 'resize', width: previewWidth, height: previewHeight });
        focusArea.classList.toggle('circle', focusShapeSelect.value === 'circle');
    }

    function getFocusAreaRatios() {
        const cw = canvasContainer.clientWidth;
        const ch = canvasContainer.clientHeight;
        if (cw === 0 || ch === 0) return { ...defaultFocusRect };
        return {
            left: focusArea.offsetLeft / cw,
            top: focusArea.offsetTop / ch,
            width: focusArea.offsetWidth / cw,
            height: focusArea.offsetHeight / ch,
        };
    }

    // %で指定し、キャンバスの表示サイズが変わっても位置と大きさの比率を保つ
    function setFocusAreaRatios(ratios) {
        focusArea.style.left = `${ratios.left * 100}%`;
        focusArea.style.top = `${ratios.top * 100}%`;
        focusArea.style.width = `${ratios.width * 100}%`;
        focusArea.style.height = `${ratios.height * 100}%`;
    }

    function postDrawMessage({ reseed = true } = {}) {
        if (!imageSize) return;
        if (reseed) currentSeed = Math.floor(Math.random() * 4294967296);

        if (workerBusy) {
            drawPending = true;
            return;
        }
        sendDrawMessage();
    }

    function flushPendingDraw() {
        if (!drawPending) return;
        drawPending = false;
        sendDrawMessage();
    }

    function sendDrawMessage() {
        workerBusy = true;

        // 画像に対する比率で送り、どの解像度でも同じ位置に描けるようにする
        const ratios = getFocusAreaRatios();
        const focusRect = { x: ratios.left, y: ratios.top, width: ratios.width, height: ratios.height };

        worker.postMessage({
            type: 'draw',
            params: {
                seed: currentSeed,
                focusRect,
                lineCount: parseInt(lineCountInput.value),
                lineThickness: parseFloat(lineThicknessInput.value),
                lineColor: lineColorInput.value,
                lineType: lineTypeSelect.value,
                randomAmount: parseFloat(randomnessInput.value),
                isCircle: focusShapeSelect.value === 'circle',
            }
        });
    }

    function resetSettings() {
        focusShapeSelect.value = defaultSettings.focusShape;
        lineTypeSelect.value = defaultSettings.lineType;
        lineColorInput.value = defaultSettings.lineColor;
        lineColorInput.dispatchEvent(new Event('input', { bubbles: true }));
        lineCountInput.value = defaultSettings.lineCount;
        lineThicknessInput.value = defaultSettings.lineThickness;
        randomnessInput.value = defaultSettings.randomness;

        document.querySelectorAll('input[type="range"]').forEach(el => {
            el.dispatchEvent(new Event('input'));
        });

        setFocusAreaRatios(defaultFocusRect);
        focusArea.classList.toggle('circle', defaultSettings.focusShape === 'circle');

        postDrawMessage();
    }

    function downloadImage() {
        const originalText = downloadBtn.textContent;
        downloadBtn.textContent = '保存中……';
        downloadBtn.disabled = true;

        const isJpeg = originalFileType === 'image/jpeg';
        const fileExtension = isJpeg ? 'jpg' : 'png';
        const mimeType = isJpeg ? 'image/jpeg' : 'image/png';

        const handleDownload = (e) => {
            if (e.data.type !== 'downloadReady') return;
            worker.removeEventListener('message', handleDownload);

            const blob = e.data.blob;
            if (!blob) {
                console.error('WorkerからBlobの生成に失敗しました。');
                showMessage('画像の保存に失敗しました。', { title: 'エラー' });
                downloadBtn.textContent = originalText;
                downloadBtn.disabled = false;
                return;
            }

            try {
                const baseName = originalFileName.includes('.')
                    ? originalFileName.substring(0, originalFileName.lastIndexOf('.'))
                    : originalFileName;

                const newFileName = `${baseName}-focus.${fileExtension}`;
                const link = document.createElement('a');
                link.download = newFileName;
                const url = URL.createObjectURL(blob);
                link.href = url;
                link.click();
                // click() の直後に解放すると、ブラウザによってはダウンロードが中断される
                setTimeout(() => URL.revokeObjectURL(url), 40000);
                if (e.data.downscaled) {
                    console.info(`Saved at a reduced size: ${e.data.width}x${e.data.height}`);
                    showToast('お使いの端末の制限により、画像サイズを小さくして保存しました。');
                }
            } catch (e) {
                console.error('画像のダウンロードに失敗しました。', e);
                showMessage('画像の保存に失敗しました。', { title: 'エラー' });
            } finally {
                downloadBtn.textContent = originalText;
                downloadBtn.disabled = false;
            }
        };

        worker.addEventListener('message', handleDownload);
        // 保留中の描画を先に送り、最新の設定で保存する（ワーカーはメッセージを順に処理する）
        flushPendingDraw();
        worker.postMessage({ type: 'download', mimeType });
    }

    // --- フォーカスエリアの操作ロジック ---
    function handleInteractionStart(e) {
        if (e.button !== 0 || !e.isPrimary) return;
        if (focusState.activePointerId !== null) return;
        e.preventDefault();
        e.stopPropagation();
        focusState.activePointerId = e.pointerId;
        focusArea.setPointerCapture(e.pointerId);
        focusState.dragStartX = e.clientX;
        focusState.dragStartY = e.clientY;
        focusState.startLeft = focusArea.offsetLeft;
        focusState.startTop = focusArea.offsetTop;
        focusState.startWidth = focusArea.offsetWidth;
        focusState.startHeight = focusArea.offsetHeight;
        focusState.parentWidth = canvasContainer.clientWidth;
        focusState.parentHeight = canvasContainer.clientHeight;
        focusState.areaWidth = focusState.startWidth;
        focusState.areaHeight = focusState.startHeight;
        if (e.target.classList.contains('resize-handle')) {
            focusState.isResizing = true;
            focusState.resizeDirection = e.target.dataset.direction;
        } else {
            focusState.isDragging = true;
        }
    }

    function handleInteractionMove(e) {
        if (!focusState.isDragging && !focusState.isResizing) return;
        if (e.pointerId !== focusState.activePointerId) return;
        if (e.pointerType === 'mouse' && (e.buttons & 1) === 0) {
            handleInteractionEnd();
            return;
        }
        focusState.lastMoveCoords = { x: e.clientX, y: e.clientY };
        focusState.lastMoveShiftKey = e.shiftKey;

        if (moveRafId) return;
        moveRafId = requestAnimationFrame(() => {
            moveRafId = null;
            applyInteractionMove();
        });
    }

    function applyInteractionMove() {
        const coords = focusState.lastMoveCoords;
        if (!coords) return;
        const dx = coords.x - focusState.dragStartX;
        const dy = coords.y - focusState.dragStartY;
        const parentWidth = focusState.parentWidth;
        const parentHeight = focusState.parentHeight;

        if (focusState.isDragging) {
            let newLeft = focusState.startLeft + dx;
            let newTop = focusState.startTop + dy;
            newLeft = Math.max(0, Math.min(newLeft, parentWidth - focusState.areaWidth));
            newTop = Math.max(0, Math.min(newTop, parentHeight - focusState.areaHeight));
            focusArea.style.left = `${newLeft}px`;
            focusArea.style.top = `${newTop}px`;
            checkCentering(newLeft, newTop, focusState.areaWidth, focusState.areaHeight, parentWidth, parentHeight);
        } else if (focusState.isResizing) {
            let cursorStyle = 'default';
            switch (focusState.resizeDirection) {
                case 'nw':
                case 'se':
                    cursorStyle = 'nwse-resize';
                    break;
                case 'ne':
                case 'sw':
                    cursorStyle = 'nesw-resize';
                    break;
            }
            document.body.style.cursor = cursorStyle;
            focusArea.style.cursor = cursorStyle;

            let newLeft = focusState.startLeft, newTop = focusState.startTop;
            let newWidth = focusState.startWidth, newHeight = focusState.startHeight;

            if (focusState.resizeDirection.includes('e')) newWidth = focusState.startWidth + dx;
            if (focusState.resizeDirection.includes('w')) {
                newWidth = focusState.startWidth - dx;
                newLeft = focusState.startLeft + dx;
            }
            if (focusState.resizeDirection.includes('s')) newHeight = focusState.startHeight + dy;
            if (focusState.resizeDirection.includes('n')) {
                newHeight = focusState.startHeight - dy;
                newTop = focusState.startTop + dy;
            }

            if (focusState.lastMoveShiftKey && focusState.startHeight > 0) {
                const originalAspectRatio = focusState.startWidth / focusState.startHeight;
                const newAspectRatio = Math.abs(newWidth) / Math.abs(newHeight);
                if (newAspectRatio > originalAspectRatio) {
                    newHeight = newWidth / originalAspectRatio;
                } else {
                    newWidth = newHeight * originalAspectRatio;
                }
                if (focusState.resizeDirection.includes('n')) {
                    newTop = focusState.startTop + focusState.startHeight - newHeight;
                }
                if (focusState.resizeDirection.includes('w')) {
                    newLeft = focusState.startLeft + focusState.startWidth - newWidth;
                }
            }

            if (newLeft < 0) {
                newWidth += newLeft;
                newLeft = 0;
            }
            if (newTop < 0) {
                newHeight += newTop;
                newTop = 0;
            }
            if (newLeft + newWidth > parentWidth) {
                newWidth = parentWidth - newLeft;
            }
            if (newTop + newHeight > parentHeight) {
                newHeight = parentHeight - newTop;
            }

            const keepAspectRatio = focusState.lastMoveShiftKey && focusState.startHeight > 0;
            if (keepAspectRatio) {
                // 画像の端で片方の辺だけ縮んだ場合に、もう片方も縮めて縦横比を保つ（掴んだハンドルの対辺は固定）
                const originalAspectRatio = focusState.startWidth / focusState.startHeight;
                const fittedWidth = Math.min(newWidth, newHeight * originalAspectRatio);
                const fittedHeight = fittedWidth / originalAspectRatio;
                if (focusState.resizeDirection.includes('w')) {
                    newLeft = focusState.startLeft + focusState.startWidth - fittedWidth;
                }
                if (focusState.resizeDirection.includes('n')) {
                    newTop = focusState.startTop + focusState.startHeight - fittedHeight;
                }
                newWidth = fittedWidth;
                newHeight = fittedHeight;
            }

            // 縦横比の固定中は、片方の辺だけを更新しない
            const sizeIsValid = !keepAspectRatio || (newWidth > 20 && newHeight > 20);
            if (sizeIsValid && newWidth > 20) {
                focusArea.style.left = `${newLeft}px`;
                focusArea.style.width = `${newWidth}px`;
                focusState.areaWidth = newWidth;
            }
            if (sizeIsValid && newHeight > 20) {
                focusArea.style.top = `${newTop}px`;
                focusArea.style.height = `${newHeight}px`;
                focusState.areaHeight = newHeight;
            }
            checkCentering(newLeft, newTop, focusState.areaWidth, focusState.areaHeight, parentWidth, parentHeight);
        }
    }

    function handleInteractionEnd(e) {
        if (e && e.pointerId !== undefined && e.pointerId !== focusState.activePointerId) return;
        const pointerId = focusState.activePointerId;
        focusState.activePointerId = null;
        if (pointerId !== null && focusArea.hasPointerCapture(pointerId)) {
            focusArea.releasePointerCapture(pointerId);
        }
        if (focusState.isDragging || focusState.isResizing) {
            if (moveRafId) {
                cancelAnimationFrame(moveRafId);
                moveRafId = null;
                applyInteractionMove();
            }
            postDrawMessage({ reseed: false });
        }
        focusState.isDragging = false;
        focusState.isResizing = false;
        focusState.lastMoveCoords = null;
        document.body.style.cursor = '';
        focusArea.style.cursor = '';
        focusArea.classList.remove('centered');
        guideH.style.display = 'none';
        guideV.style.display = 'none';
    }

    function checkCentering(areaLeft, areaTop, areaWidth, areaHeight, parentWidth, parentHeight) {
        const areaCenterX = areaLeft + areaWidth / 2;
        const areaCenterY = areaTop + areaHeight / 2;
        const parentCenterX = parentWidth / 2;
        const parentCenterY = parentHeight / 2;
        const snapThreshold = 5;
        const isHorizontallyCentered = Math.abs(parentCenterX - areaCenterX) < snapThreshold;
        const isVerticallyCentered = Math.abs(parentCenterY - areaCenterY) < snapThreshold;

        if (focusState.isResizing) {
            guideV.style.display = 'none';
            guideH.style.display = 'none';
        } else {
            guideV.style.display = isHorizontallyCentered ? 'block' : 'none';
            guideH.style.display = isVerticallyCentered ? 'block' : 'none';
        }

        if (isHorizontallyCentered) {
            guideV.style.left = `${parentCenterX}px`;
            if (focusState.isDragging) focusArea.style.left = `${parentCenterX - areaWidth / 2}px`;
        }
        if (isVerticallyCentered) {
            guideH.style.top = `${parentCenterY}px`;
            if (focusState.isDragging) focusArea.style.top = `${parentCenterY - areaHeight / 2}px`;
        }
    }

    focusShapeSelect.addEventListener('change', (e) => {
        focusArea.classList.toggle('circle', e.target.value === 'circle');
    });
});