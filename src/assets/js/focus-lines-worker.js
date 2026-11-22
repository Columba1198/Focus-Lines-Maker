/** @type {OffscreenCanvas} プレビュー用（表示サイズに合わせて縮小） */
let canvas = null;
/** @type {OffscreenCanvasRenderingContext2D} */
let ctx = null;
/** @type {ImageBitmap} 元の解像度の画像 */
let currentImage = null;
/** @type {ImageBitmap} プレビュー用に縮小した画像（描画時に作成） */
let previewImage = null;
// 直前のプレビューの描画パラメーター。保存時はこれで元の解像度に描き直す
let lastDrawParams = null;
// 開発用：この面積を超えるキャンバスを確保失敗として扱う
let simulatedCanvasLimit = null;

// 元の解像度で確保できないときに順に試すキャンバスの上限
// （iOS 18以降：8192×8192、iOS 17以前：4096×4096。超えても例外は出ず、何も描かれない）
const CANVAS_FALLBACK_LIMITS = [
    { maxSide: 8192, maxArea: 8192 * 8192 },
    { maxSide: 4096, maxArea: 4096 * 4096 },
];

// awaitを含む処理があっても、メッセージを届いた順に1つずつ処理する
let messageQueue = Promise.resolve();
self.addEventListener('message', (e) => {
    messageQueue = messageQueue
        .then(() => handleMessage(e.data))
        .catch((err) => console.error('Worker message handling failed:', err));
});

async function handleMessage(data) {
    switch (data.type) {
        case 'init':
            canvas = data.canvas;
            ctx = canvas.getContext('2d');
            simulatedCanvasLimit = data.simulatedCanvasLimit ?? null;
            break;

        case 'setImage':
            invalidatePreviewImage();
            if (currentImage) currentImage.close();
            currentImage = data.image;
            break;

        case 'resize':
            invalidatePreviewImage();
            canvas.width = data.width;
            canvas.height = data.height;
            break;

        case 'draw':
            try {
                lastDrawParams = data.params;
                await ensurePreviewImage();
                if (currentImage && ctx) {
                    renderScene(ctx, canvas.width, canvas.height, previewImage, data.params);
                }
            } catch (err) {
                console.error('Drawing failed:', err);
            } finally {
                self.postMessage({ type: 'drawDone' });
            }
            break;

        case 'download': {
            // blobがnullなら、メイン側で保存失敗として扱う
            let result = { blob: null };
            try {
                result = await renderForDownload(data.mimeType);
            } catch (err) {
                console.error('Rendering the image for download failed:', err);
            }
            self.postMessage({ type: 'downloadReady', ...result });
            break;
        }
    }
}

function invalidatePreviewImage() {
    if (previewImage && previewImage !== currentImage) previewImage.close();
    previewImage = null;
}

// 描画のたびに大きな画像を縮小しないよう、縮小画像を一度だけ作っておく
async function ensurePreviewImage() {
    if (previewImage || !currentImage) return;
    const { width, height } = canvas;
    if (width === currentImage.width && height === currentImage.height) {
        previewImage = currentImage;
        return;
    }
    try {
        previewImage = await createImageBitmap(currentImage, {
            resizeWidth: width,
            resizeHeight: height,
            resizeQuality: 'high',
        });
    } catch (err) {
        console.warn('Creating the preview image failed:', err);
        previewImage = currentImage;
    }
}

function renderScene(targetCtx, w, h, image, params) {
    targetCtx.clearRect(0, 0, w, h);
    targetCtx.imageSmoothingQuality = 'high';
    targetCtx.drawImage(image, 0, 0, w, h);
    drawFocusLines(targetCtx, params, w, h);
}

// 直前のプレビューを、元の解像度（無理なら端末が許す最大の大きさ）で描き直す
async function renderForDownload(mimeType) {
    if (!currentImage || !lastDrawParams) return { blob: null };
    const fullWidth = currentImage.width;
    const fullHeight = currentImage.height;

    for (const size of getCandidateSizes(fullWidth, fullHeight)) {
        const target = createVerifiedCanvas(size.width, size.height);
        if (!target) continue;
        try {
            renderScene(target.ctx, size.width, size.height, currentImage, lastDrawParams);
            const blob = await target.canvas.convertToBlob({ type: mimeType });
            if (blob && blob.size > 0) {
                return {
                    blob,
                    width: size.width,
                    height: size.height,
                    downscaled: size.width !== fullWidth || size.height !== fullHeight,
                };
            }
        } catch (err) {
            console.warn(`Rendering at ${size.width}x${size.height} failed:`, err);
        } finally {
            // iOSはメモリが足りなくなるとタブごと落ちるので、すぐに解放
            target.canvas.width = 0;
            target.canvas.height = 0;
        }
    }
    return { blob: null };
}

function getCandidateSizes(width, height) {
    const sizes = [{ width, height }];
    for (const { maxSide, maxArea } of CANVAS_FALLBACK_LIMITS) {
        const scale = Math.min(1, maxSide / width, maxSide / height, Math.sqrt(maxArea / (width * height)));
        const size = {
            width: Math.max(1, Math.floor(width * scale)),
            height: Math.max(1, Math.floor(height * scale)),
        };
        const last = sizes[sizes.length - 1];
        if (size.width < last.width || size.height < last.height) sizes.push(size);
    }
    return sizes;
}

// iOSのSafariなどは、上限を超えたキャンバスでも例外を出さず、何も描かないだけになる
// 右下の1ピクセルを塗って読み戻し、実際に使えるかを確かめる
function createVerifiedCanvas(width, height) {
    if (simulatedCanvasLimit !== null && width * height > simulatedCanvasLimit) return null;
    let offscreen = null;
    try {
        offscreen = new OffscreenCanvas(width, height);
        const offscreenCtx = offscreen.getContext('2d');
        if (!offscreenCtx) throw new Error('2D context is unavailable');
        offscreenCtx.fillStyle = '#ff0000';
        offscreenCtx.fillRect(width - 1, height - 1, 1, 1);
        const [r, g, b, a] = offscreenCtx.getImageData(width - 1, height - 1, 1, 1).data;
        // Safariのプライベートブラウズなどは、フィンガープリント対策で読み戻し値にノイズを加えるので幅を持たせる
        if (r >= 200 && g <= 55 && b <= 55 && a >= 200) {
            return { canvas: offscreen, ctx: offscreenCtx };
        }
        console.warn(`Canvas of ${width}x${height} could not be used (read back ${r},${g},${b},${a})`);
    } catch (err) {
        console.warn(`Canvas of ${width}x${height} could not be allocated:`, err);
    }
    if (offscreen) {
        offscreen.width = 0;
        offscreen.height = 0;
    }
    return null;
}

const RANDOM_CHANNEL = { ANGLE: 0, LENGTH: 1, WIDTH: 2, GAP: 3, GROUP: 4 };

// (seed, 番号, 用途) から決まる [0, 1) の乱数
// 順番に取り出す乱数と違い、途中の分岐で消費数が変わっても値がずれないので、
// プレビューと元の解像度で必ず同じ線になる
function hashRandom(seed, index, channel) {
    let h = fmix32((seed ^ Math.imul(index, 0x9E3779B1)) >>> 0);
    h = fmix32((h ^ Math.imul(channel + 1, 0x85EBCA77)) >>> 0);
    return h / 4294967296;
}

// MurmurHash3 の最終処理（fmix32）
function fmix32(h) {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85EBCA6B);
    h ^= h >>> 13;
    h = Math.imul(h, 0xC2B2AE35);
    h ^= h >>> 16;
    return h >>> 0;
}

function drawFocusLines(ctx, params, w, h) {
    const { lineColor, lineType, randomAmount, isCircle, seed } = params;
    let { lineCount, lineThickness } = params;

    const focusRect = {
        x: params.focusRect.x * w,
        y: params.focusRect.y * h,
        width: params.focusRect.width * w,
        height: params.focusRect.height * h,
    };

    if (lineType === 'manga') {
        lineCount *= 2;
        lineThickness *= 0.75;
    }

    const focusCenter = {
        x: focusRect.x + focusRect.width / 2,
        y: focusRect.y + focusRect.height / 2,
    };

    const referenceSize = (1920 + 1080) / 2;
    const imageAverageSize = (w + h) / 2;
    const sizeCorrectionFactor = imageAverageSize / referenceSize;
    lineThickness *= sizeCorrectionFactor;

    ctx.fillStyle = lineColor;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = Math.max(1, lineThickness * 0.08);

    const drawLoop = (callback) => {
        if (lineType === 'manga') {
            let i = 0;
            let group = 0;
            while (i < lineCount) {
                const baseGapSize = 5;
                const gapVariation = (hashRandom(seed, group, RANDOM_CHANNEL.GAP) - 0.5) * baseGapSize * 2 * randomAmount;
                const gapSize = Math.round(Math.max(1, baseGapSize + gapVariation));
                i += gapSize;

                if (i >= lineCount) break;

                const baseGroupSize = 5;
                const groupVariation = (hashRandom(seed, group, RANDOM_CHANNEL.GROUP) - 0.5) * baseGroupSize * 2 * randomAmount;
                const groupSize = Math.round(Math.max(1, baseGroupSize + groupVariation));
                group++;

                for (let j = 0; j < groupSize && i < lineCount; j++, i++) {
                    callback(i, lineCount, randomAmount);
                }
            }
        } else {
            for (let i = 0; i < lineCount; i++) {
                callback(i, lineCount, randomAmount);
            }
        }
    };

    drawLoop((i, count, random) => {
        let angleOffset = 0;
        if (random > 0) {
            angleOffset = (hashRandom(seed, i, RANDOM_CHANNEL.ANGLE) - 0.5) * random;
        }
        const angle = ((i + angleOffset) / count) * 2 * Math.PI;

        const buffer = Math.max(w, h);
        const outerBounds = { x: -buffer, y: -buffer, width: w + buffer * 2, height: h + buffer * 2 };
        const outerPoint = getIntersectionWithRect(focusCenter, angle, outerBounds);
        if (!outerPoint) return;

        let innerPoint = isCircle ? getIntersectionWithEllipse(focusCenter, angle, focusRect) : getIntersectionWithRect(focusCenter, angle, focusRect);
        if (!innerPoint) return;

        if (random > 0) {
            const dx = innerPoint.x - focusCenter.x;
            const dy = innerPoint.y - focusCenter.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 0) {
                const imageEdgePoint = getIntersectionWithRect(focusCenter, angle, { x: 0, y: 0, width: w, height: h });
                const visibleLength = imageEdgePoint
                    ? Math.max(0, Math.hypot(imageEdgePoint.x - focusCenter.x, imageEdgePoint.y - focusCenter.y) - dist)
                    : dist;
                // 外側への揺れは見えている長さが基準（小さいフォーカスエリアでも揺れが目立つように）
                // 内側への食い込みはフォーカスエリアの大きさが基準（線が中心を越えないように）
                const r = hashRandom(seed, i, RANDOM_CHANNEL.LENGTH) * 2 - 1;
                const offset = (random / 2) * r * (r >= 0 ? visibleLength : dist);
                const newDist = dist + offset;
                innerPoint.x = focusCenter.x + (dx / dist) * newDist;
                innerPoint.y = focusCenter.y + (dy / dist) * newDist;
            }
        }

        if (lineType === 'halo') {
            ctx.beginPath();
            ctx.moveTo(innerPoint.x, innerPoint.y);
            ctx.lineTo(outerPoint.x, outerPoint.y);
            ctx.stroke();
        } else {
            const distance = Math.sqrt(Math.pow(outerPoint.x - innerPoint.x, 2) + Math.pow(outerPoint.y - innerPoint.y, 2));
            let baseWidth = (distance / imageAverageSize) * lineThickness;

            if (random > 0) {
                baseWidth *= 1 + random * (hashRandom(seed, i, RANDOM_CHANNEL.WIDTH) * 2 - 1);
                baseWidth = Math.max(0, baseWidth);
            }

            const perpAngle = angle + Math.PI / 2;
            const dx = Math.cos(perpAngle) * baseWidth / 2;
            const dy = Math.sin(perpAngle) * baseWidth / 2;

            ctx.beginPath();
            ctx.moveTo(innerPoint.x, innerPoint.y);
            ctx.lineTo(outerPoint.x + dx, outerPoint.y + dy);
            ctx.lineTo(outerPoint.x - dx, outerPoint.y - dy);
            ctx.closePath();
            ctx.fill();
        }
    });
}

// --- ヘルパー関数群 ---
function getIntersectionWithRect(origin, angle, rect) {
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const dist = Math.max(rect.width, rect.height) * 2;
    const ray = { x1: origin.x, y1: origin.y, x2: origin.x + cos * dist, y2: origin.y + sin * dist };
    const lines = [{ x1: rect.x, y1: rect.y, x2: rect.x + rect.width, y2: rect.y }, { x1: rect.x + rect.width, y1: rect.y, x2: rect.x + rect.width, y2: rect.y + rect.height }, { x1: rect.x, y1: rect.y + rect.height, x2: rect.x + rect.width, y2: rect.y + rect.height }, { x1: rect.x, y1: rect.y, x2: rect.x, y2: rect.y + rect.height }];
    let closestIntersect = null, minDistSq = Infinity;
    for (const line of lines) {
        const den = (ray.x1 - ray.x2) * (line.y1 - line.y2) - (ray.y1 - ray.y2) * (line.x1 - line.x2);
        if (den === 0) continue;
        const t = ((ray.x1 - line.x1) * (line.y1 - line.y2) - (ray.y1 - line.y1) * (line.x1 - line.x2)) / den;
        const u = -((ray.x1 - ray.x2) * (ray.y1 - line.y1) - (ray.y1 - ray.y2) * (ray.x1 - line.x1)) / den;
        if (t > 0 && t < 1 && u > 0 && u < 1) {
            const pt = { x: ray.x1 + t * (ray.x2 - ray.x1), y: ray.y1 + t * (ray.y2 - ray.y1) };
            const dSq = Math.pow(pt.x - origin.x, 2) + Math.pow(pt.y - origin.y, 2);
            if (dSq < minDistSq) { minDistSq = dSq; closestIntersect = pt; }
        }
    }
    return closestIntersect;
}

function getIntersectionWithEllipse(origin, angle, rect) {
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const rx = rect.width / 2, ry = rect.height / 2;
    if (rx <= 0 || ry <= 0) return null;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const A = (cos * cos) / (rx * rx) + (sin * sin) / (ry * ry);
    const B = 2 * ((origin.x - center.x) * cos / (rx * rx) + (origin.y - center.y) * sin / (ry * ry));
    const C = ((origin.x - center.x) ** 2) / (rx * rx) + ((origin.y - center.y) ** 2) / (ry * ry) - 1;
    const discriminant = B * B - 4 * A * C;
    if (discriminant < 0) return null;
    const t = (-B + Math.sqrt(discriminant)) / (2 * A);
    return { x: origin.x + t * cos, y: origin.y + t * sin };
}
