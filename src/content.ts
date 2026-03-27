import {
  MESSAGE_TYPE,
  type CaptureResponse,
  type ContentRequestMessage,
  type DownloadImageMessage,
  type DownloadResponse,
  type RequestVisibleCaptureMessage,
  type StatusResponse
} from './messages';

declare global {
  interface Window {
    __domShotExtensionLoaded__?: boolean;
  }
}

type Mode = 'idle' | 'inspect' | 'capturing';

type VisibleRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type ScrollableAncestor = {
  node: HTMLElement;
  initialScrollLeft: number;
  initialScrollTop: number;
};

type CaptureMarkerState = {
  marker: HTMLDivElement;
  restorePosition: string;
  didSetRelative: boolean;
};

const UI_MARKER_ATTR = 'data-dom-shot-ui';
const UI_MARKER_VALUE = '1';
const HIGHLIGHT_BORDER = '#3b82f6';
const HIGHLIGHT_FILL = 'rgba(59, 130, 246, 0.18)';
const MAX_CANVAS_SIDE = 16_384;
const MAX_CANVAS_PIXELS = 120_000_000;
const OCCLUSION_SAMPLE_COUNT = 7;
const OCCLUSION_HIT_RATIO = 0.6;
const OCCLUSION_MAX_TRIM_PX = 220;

let mode: Mode = 'idle';
let highlightedElement: HTMLElement | null = null;
let lastMouseX = 0;
let lastMouseY = 0;
let toastTimerId: number | null = null;

const ui = createUi();

const onMouseMove = (event: MouseEvent): void => {
  if (mode !== 'inspect') {
    return;
  }

  lastMouseX = event.clientX;
  lastMouseY = event.clientY;

  const candidate = pickElementFromEvent(event);
  if (!candidate) {
    highlightedElement = null;
    hideHighlight();
    return;
  }

  highlightedElement = candidate;
  renderHighlight(candidate, event.clientX, event.clientY);
};

const onClickCapture = (event: MouseEvent): void => {
  if (mode !== 'inspect') {
    return;
  }

  const selected = highlightedElement;
  if (!selected) {
    showToast('要素が選択されていません。');
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  if (selected.tagName.toLowerCase() === 'iframe') {
    showToast('iframe要素は初版では対象外です。');
    return;
  }

  if (selected.getRootNode() instanceof ShadowRoot) {
    showToast('Shadow DOM要素は初版では対象外です。');
    return;
  }

  void runCapture(selected);
};

const onKeyDown = (event: KeyboardEvent): void => {
  if (mode !== 'inspect') {
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    stopInspectMode('選択モードを中止しました。');
  }
};

const onViewportChanged = (): void => {
  if (mode !== 'inspect' || !highlightedElement) {
    return;
  }

  renderHighlight(highlightedElement, lastMouseX, lastMouseY);
};

if (!window.__domShotExtensionLoaded__) {
  window.__domShotExtensionLoaded__ = true;
  init();
}

function init(): void {
  chrome.runtime.onMessage.addListener((message: ContentRequestMessage) => {
    if (message.type === MESSAGE_TYPE.START_INSPECT_MODE) {
      startInspectMode();
    }

    if (message.type === MESSAGE_TYPE.CANCEL_INSPECT_MODE) {
      stopInspectMode('選択モードを終了しました。');
    }

    return false;
  });
}

function createUi(): {
  overlay: HTMLDivElement;
  tooltip: HTMLDivElement;
  toast: HTMLDivElement;
} {
  const overlay = document.createElement('div');
  overlay.setAttribute(UI_MARKER_ATTR, UI_MARKER_VALUE);
  overlay.style.position = 'fixed';
  overlay.style.left = '0';
  overlay.style.top = '0';
  overlay.style.width = '0';
  overlay.style.height = '0';
  overlay.style.border = `2px solid ${HIGHLIGHT_BORDER}`;
  overlay.style.background = HIGHLIGHT_FILL;
  overlay.style.boxSizing = 'border-box';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '2147483646';
  overlay.style.display = 'none';

  const tooltip = document.createElement('div');
  tooltip.setAttribute(UI_MARKER_ATTR, UI_MARKER_VALUE);
  tooltip.style.position = 'fixed';
  tooltip.style.left = '0';
  tooltip.style.top = '0';
  tooltip.style.padding = '6px 10px';
  tooltip.style.borderRadius = '6px';
  tooltip.style.background = '#111827';
  tooltip.style.color = '#f9fafb';
  tooltip.style.fontSize = '12px';
  tooltip.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  tooltip.style.lineHeight = '1.3';
  tooltip.style.pointerEvents = 'none';
  tooltip.style.whiteSpace = 'nowrap';
  tooltip.style.zIndex = '2147483647';
  tooltip.style.display = 'none';

  const toast = document.createElement('div');
  toast.setAttribute(UI_MARKER_ATTR, UI_MARKER_VALUE);
  toast.style.position = 'fixed';
  toast.style.right = '16px';
  toast.style.bottom = '16px';
  toast.style.maxWidth = '420px';
  toast.style.padding = '10px 12px';
  toast.style.borderRadius = '8px';
  toast.style.background = '#111827';
  toast.style.color = '#f9fafb';
  toast.style.fontSize = '13px';
  toast.style.lineHeight = '1.4';
  toast.style.fontFamily = 'system-ui, -apple-system, Segoe UI, sans-serif';
  toast.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.25)';
  toast.style.zIndex = '2147483647';
  toast.style.display = 'none';

  document.documentElement.appendChild(overlay);
  document.documentElement.appendChild(tooltip);
  document.documentElement.appendChild(toast);

  return { overlay, tooltip, toast };
}

function startInspectMode(): void {
  if (mode === 'capturing') {
    showToast('キャプチャ処理中です。完了を待ってください。');
    return;
  }

  if (mode === 'inspect') {
    detachInspectListeners();
    hideHighlight();
  }

  mode = 'inspect';
  highlightedElement = null;
  attachInspectListeners();
  showToast('要素をクリックで確定 / Esc で中止');
}

function stopInspectMode(message?: string): void {
  if (mode !== 'inspect') {
    return;
  }

  detachInspectListeners();
  hideHighlight();
  highlightedElement = null;
  mode = 'idle';

  if (message) {
    showToast(message);
  }
}

function attachInspectListeners(): void {
  window.addEventListener('mousemove', onMouseMove, true);
  window.addEventListener('click', onClickCapture, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onViewportChanged, true);
  window.addEventListener('resize', onViewportChanged, true);
}

function detachInspectListeners(): void {
  window.removeEventListener('mousemove', onMouseMove, true);
  window.removeEventListener('click', onClickCapture, true);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('scroll', onViewportChanged, true);
  window.removeEventListener('resize', onViewportChanged, true);
}

function hideHighlight(): void {
  ui.overlay.style.display = 'none';
  ui.tooltip.style.display = 'none';
}

function renderHighlight(element: HTMLElement, mouseX: number, mouseY: number): void {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    hideHighlight();
    return;
  }

  ui.overlay.style.display = 'block';
  ui.overlay.style.left = `${rect.left}px`;
  ui.overlay.style.top = `${rect.top}px`;
  ui.overlay.style.width = `${rect.width}px`;
  ui.overlay.style.height = `${rect.height}px`;

  ui.tooltip.style.display = 'block';
  ui.tooltip.textContent = buildElementHintText(element, rect);

  const offset = 12;
  let tooltipLeft = mouseX + offset;
  let tooltipTop = mouseY + offset;

  const maxLeft = window.innerWidth - ui.tooltip.offsetWidth - 8;
  const maxTop = window.innerHeight - ui.tooltip.offsetHeight - 8;

  tooltipLeft = clamp(tooltipLeft, 8, Math.max(8, maxLeft));
  tooltipTop = clamp(tooltipTop, 8, Math.max(8, maxTop));

  ui.tooltip.style.left = `${tooltipLeft}px`;
  ui.tooltip.style.top = `${tooltipTop}px`;
}

function buildElementHintText(element: HTMLElement, rect: DOMRect): string {
  const tag = element.tagName.toLowerCase();
  const idPart = element.id ? `#${element.id}` : '';
  const classPart = element.classList.length > 0 ? `.${Array.from(element.classList).slice(0, 3).join('.')}` : '';
  const size = `${Math.round(rect.width)}x${Math.round(rect.height)}`;

  return `${tag}${idPart}${classPart}  ${size}`;
}

function pickElementFromEvent(event: MouseEvent): HTMLElement | null {
  const path = event.composedPath();
  for (const entry of path) {
    if (entry instanceof HTMLElement && !isUiNode(entry)) {
      return entry;
    }
  }

  return null;
}

function isUiNode(node: Element): boolean {
  return node.closest(`[${UI_MARKER_ATTR}="${UI_MARKER_VALUE}"]`) !== null;
}

function showToast(message: string, durationMs = 3_000): void {
  ui.toast.textContent = message;
  ui.toast.style.display = 'block';

  if (toastTimerId !== null) {
    window.clearTimeout(toastTimerId);
  }

  toastTimerId = window.setTimeout(() => {
    ui.toast.style.display = 'none';
    toastTimerId = null;
  }, durationMs);
}

function hideToast(): void {
  ui.toast.style.display = 'none';

  if (toastTimerId !== null) {
    window.clearTimeout(toastTimerId);
    toastTimerId = null;
  }
}

async function runCapture(selected: HTMLElement): Promise<void> {
  mode = 'capturing';
  detachInspectListeners();
  hideUiForCapture();

  try {
    await sendMessageToBackground<
      { type: typeof MESSAGE_TYPE.CAPTURE_SESSION_STARTED },
      StatusResponse
    >({ type: MESSAGE_TYPE.CAPTURE_SESSION_STARTED });

    const imageDataUrl = await captureElementImage(selected);
    const filename = buildDownloadFilename(selected);

    const response = await sendMessageToBackground<DownloadImageMessage, DownloadResponse>({
      type: MESSAGE_TYPE.DOWNLOAD_IMAGE,
      dataUrl: imageDataUrl,
      filename
    });

    if (!response.ok) {
      throw new Error(response.error);
    }

    showToast(`保存しました: ${filename}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showToast(`キャプチャ失敗: ${message}`, 8_000);
    console.error('[dom-shot] capture failed:', error);
  } finally {
    try {
      await sendMessageToBackground<
        { type: typeof MESSAGE_TYPE.CAPTURE_SESSION_FINISHED },
        StatusResponse
      >({ type: MESSAGE_TYPE.CAPTURE_SESSION_FINISHED });
    } catch {
      // Ignore teardown notification failures.
    }

    hideUiForCapture();
    highlightedElement = null;
    mode = 'idle';
  }
}

async function captureElementImage(element: HTMLElement): Promise<string> {
  if (!element.isConnected) {
    throw new Error('要素がDOMから削除されました。');
  }

  if (element.tagName.toLowerCase() === 'iframe') {
    throw new Error('iframe要素は初版では対象外です。');
  }

  if (element.getRootNode() instanceof ShadowRoot) {
    throw new Error('Shadow DOM要素は初版では対象外です。');
  }

  const initialWindowX = window.scrollX;
  const initialWindowY = window.scrollY;
  const initialElementScrollLeft = element.scrollLeft;
  const initialElementScrollTop = element.scrollTop;
  const scrollableAncestors = collectScrollableAncestors(element);
  const markerState = createCaptureMarker(element);
  const originalScrollBehavior = document.documentElement.style.scrollBehavior;

  try {
    document.documentElement.style.scrollBehavior = 'auto';

    const initialRect = element.getBoundingClientRect();
    if (initialRect.width <= 0 || initialRect.height <= 0) {
      throw new Error('可視サイズが 0 の要素はキャプチャできません。');
    }

    const outputWidth = Math.ceil(Math.max(element.scrollWidth, initialRect.width));
    const outputHeight = Math.ceil(Math.max(element.scrollHeight, initialRect.height));

    validateCanvasSize(outputWidth, outputHeight);

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 24;

    if (viewportWidth <= margin * 2 || viewportHeight <= margin * 2) {
      throw new Error('ビューポートが小さすぎるためキャプチャできません。');
    }

    const scrollableX = element.scrollWidth > element.clientWidth + 1;
    const scrollableY = element.scrollHeight > element.clientHeight + 1;

    const fallbackStepX = Math.max(1, viewportWidth - margin * 2);
    const fallbackStepY = Math.max(1, viewportHeight - margin * 2);
    const stepX = scrollableX ? Math.max(1, element.clientWidth || Math.round(initialRect.width)) : fallbackStepX;
    const stepY = scrollableY ? Math.max(1, element.clientHeight || Math.round(initialRect.height)) : fallbackStepY;

    const xOffsets = buildOffsets(outputWidth, stepX);
    let canvas: HTMLCanvasElement | null = null;
    let context: CanvasRenderingContext2D | null = null;
    let scaleX = 1;
    let scaleY = 1;
    let maxDrawnRight = 0;
    let maxDrawnBottom = 0;
    const yOverlap = Math.max(24, Math.floor(stepY * 0.12));

    for (const xOffset of xOffsets) {
      let requestYOffset = 0;
      let lastCoveredBottom = -1;
      let columnMaxDrawnBottom = 0;

      for (let iteration = 0; iteration < 180 && requestYOffset < outputHeight; iteration += 1) {
        moveCaptureMarkerToOffset(markerState, xOffset, requestYOffset);
        await waitForPaint();

        const currentRect = element.getBoundingClientRect();
        const visible = getRenderableVisibleRect(element, currentRect, viewportWidth, viewportHeight);
        if (visible.width <= 0 || visible.height <= 0) {
          throw new Error('要素がビューポート内に表示されません。');
        }

        const markerRect = markerState.marker.getBoundingClientRect();
        const localLeft = clamp(
          Math.round(xOffset - (markerRect.left - visible.left)),
          0,
          outputWidth
        );
        const localTop = clamp(
          Math.round(requestYOffset - (markerRect.top - visible.top)),
          0,
          outputHeight
        );

        const captureResponse = await sendMessageToBackground<
          RequestVisibleCaptureMessage,
          CaptureResponse
        >({ type: MESSAGE_TYPE.REQUEST_VISIBLE_CAPTURE });

        if (!captureResponse.ok) {
          throw new Error(captureResponse.error);
        }

        const image = await loadImage(captureResponse.dataUrl);

        if (!canvas || !context) {
          scaleX = image.naturalWidth / viewportWidth;
          scaleY = image.naturalHeight / viewportHeight;

          canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.ceil(outputWidth * scaleX));
          canvas.height = Math.max(1, Math.ceil(outputHeight * scaleY));

          context = canvas.getContext('2d');
          if (!context) {
            throw new Error('Canvasの初期化に失敗しました。');
          }
        }

        const sourceX = Math.max(0, Math.round(visible.left * scaleX));
        const sourceY = Math.max(0, Math.round(visible.top * scaleY));
        const sourceWidth = Math.max(1, Math.round(visible.width * scaleX));
        const sourceHeight = Math.max(1, Math.round(visible.height * scaleY));

        const destX = Math.max(0, Math.round(localLeft * scaleX));
        const destY = Math.max(0, Math.round(localTop * scaleY));

        const remainingWidth = canvas.width - destX;
        const remainingHeight = canvas.height - destY;
        if (remainingWidth <= 0 || remainingHeight <= 0) {
          continue;
        }

        const drawWidth = Math.min(sourceWidth, remainingWidth);
        const drawHeight = Math.min(sourceHeight, remainingHeight);
        const overlapHeight = Math.min(drawHeight, Math.max(0, columnMaxDrawnBottom - destY));
        const adjustedSourceY = sourceY + overlapHeight;
        const adjustedDestY = destY + overlapHeight;
        const adjustedDrawHeight = drawHeight - overlapHeight;

        if (adjustedDrawHeight > 0) {
          context.drawImage(
            image,
            sourceX,
            adjustedSourceY,
            drawWidth,
            adjustedDrawHeight,
            destX,
            adjustedDestY,
            drawWidth,
            adjustedDrawHeight
          );

          maxDrawnRight = Math.max(maxDrawnRight, destX + drawWidth);
          maxDrawnBottom = Math.max(maxDrawnBottom, adjustedDestY + adjustedDrawHeight);
          columnMaxDrawnBottom = Math.max(columnMaxDrawnBottom, adjustedDestY + adjustedDrawHeight);
        }

        const coveredBottom = localTop + visible.height;
        if (coveredBottom >= outputHeight - 1) {
          break;
        }

        const nextByCoverage = Math.max(requestYOffset + 1, Math.floor(coveredBottom - yOverlap));
        if (coveredBottom <= lastCoveredBottom + 1) {
          requestYOffset = Math.min(outputHeight - 1, requestYOffset + Math.max(1, Math.floor(stepY / 3)));
        } else {
          requestYOffset = Math.min(outputHeight - 1, nextByCoverage);
          lastCoveredBottom = coveredBottom;
        }
      }
    }

    if (!canvas) {
      throw new Error('キャプチャ画像を生成できませんでした。');
    }

    if (maxDrawnRight > 0 && maxDrawnBottom > 0) {
      const finalWidth = Math.min(canvas.width, maxDrawnRight);
      const finalHeight = Math.min(canvas.height, maxDrawnBottom);

      if (finalWidth !== canvas.width || finalHeight !== canvas.height) {
        const cropped = document.createElement('canvas');
        cropped.width = finalWidth;
        cropped.height = finalHeight;
        const croppedContext = cropped.getContext('2d');
        if (!croppedContext) {
          throw new Error('Canvasの切り抜きに失敗しました。');
        }

        croppedContext.drawImage(canvas, 0, 0, finalWidth, finalHeight, 0, 0, finalWidth, finalHeight);
        canvas = cropped;
      }
    }

    return canvas.toDataURL('image/png');
  } finally {
    removeCaptureMarker(element, markerState);

    for (const ancestor of scrollableAncestors) {
      ancestor.node.scrollLeft = ancestor.initialScrollLeft;
      ancestor.node.scrollTop = ancestor.initialScrollTop;
    }

    element.scrollLeft = initialElementScrollLeft;
    element.scrollTop = initialElementScrollTop;
    window.scrollTo({ left: initialWindowX, top: initialWindowY });
    document.documentElement.style.scrollBehavior = originalScrollBehavior;
  }
}

function collectScrollableAncestors(element: HTMLElement): ScrollableAncestor[] {
  const ancestors: ScrollableAncestor[] = [];
  let current = element.parentElement;

  while (current) {
    if (current !== document.body && current !== document.documentElement) {
      const canScrollX = canElementScrollInAxis(current, 'x');
      const canScrollY = canElementScrollInAxis(current, 'y');
      if (canScrollX || canScrollY) {
        ancestors.push({
          node: current,
          initialScrollLeft: current.scrollLeft,
          initialScrollTop: current.scrollTop
        });
      }
    }

    current = current.parentElement;
  }

  return ancestors;
}

function canElementScrollInAxis(element: HTMLElement, axis: 'x' | 'y'): boolean {
  if (axis === 'x') {
    return element.scrollWidth > element.clientWidth + 1;
  }

  return element.scrollHeight > element.clientHeight + 1;
}

function createCaptureMarker(element: HTMLElement): CaptureMarkerState {
  const marker = document.createElement('div');
  marker.setAttribute(UI_MARKER_ATTR, UI_MARKER_VALUE);
  marker.style.position = 'absolute';
  marker.style.left = '0';
  marker.style.top = '0';
  marker.style.width = '1px';
  marker.style.height = '1px';
  marker.style.opacity = '0';
  marker.style.pointerEvents = 'none';
  marker.style.zIndex = '-1';

  const computed = window.getComputedStyle(element);
  const restorePosition = element.style.position;
  let didSetRelative = false;
  if (computed.position === 'static') {
    element.style.position = 'relative';
    didSetRelative = true;
  }

  element.appendChild(marker);
  return { marker, restorePosition, didSetRelative };
}

function moveCaptureMarkerToOffset(markerState: CaptureMarkerState, xOffset: number, yOffset: number): void {
  markerState.marker.style.left = `${Math.round(xOffset)}px`;
  markerState.marker.style.top = `${Math.round(yOffset)}px`;
  markerState.marker.scrollIntoView({
    behavior: 'auto',
    block: 'center',
    inline: 'center'
  });
}

function removeCaptureMarker(element: HTMLElement, markerState: CaptureMarkerState): void {
  markerState.marker.remove();

  if (markerState.didSetRelative) {
    element.style.position = markerState.restorePosition;
  }
}

function hideUiForCapture(): void {
  hideHighlight();
  hideToast();
}

function buildOffsets(totalLength: number, step: number): number[] {
  if (totalLength <= step) {
    return [0];
  }

  const offsets: number[] = [];
  const maxOffset = Math.max(0, totalLength - step);

  for (let offset = 0; offset < maxOffset; offset += step) {
    offsets.push(offset);
  }

  if (offsets[offsets.length - 1] !== maxOffset) {
    offsets.push(maxOffset);
  }

  return offsets;
}

function validateCanvasSize(width: number, height: number): void {
  if (width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE || width * height > MAX_CANVAS_PIXELS) {
    throw new Error('要素が大きすぎるためキャプチャできません。');
  }
}

function getVisibleRect(rect: DOMRect, viewportWidth: number, viewportHeight: number): VisibleRect {
  const left = clamp(rect.left, 0, viewportWidth);
  const top = clamp(rect.top, 0, viewportHeight);
  const right = clamp(rect.right, 0, viewportWidth);
  const bottom = clamp(rect.bottom, 0, viewportHeight);

  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}

function getRenderableVisibleRect(
  element: HTMLElement,
  rect: DOMRect,
  viewportWidth: number,
  viewportHeight: number
): VisibleRect {
  const visible = getVisibleRect(rect, viewportWidth, viewportHeight);
  if (visible.width <= 0 || visible.height <= 0) {
    return visible;
  }

  let left = Math.floor(visible.left);
  let top = Math.floor(visible.top);
  let right = Math.ceil(visible.left + visible.width);
  let bottom = Math.ceil(visible.top + visible.height);

  top = trimHorizontalEdge(element, left, right, top, bottom, 1);
  bottom = trimHorizontalEdge(element, left, right, bottom - 1, top - 1, -1) + 1;
  left = trimVerticalEdge(element, top, bottom, left, right, 1);
  right = trimVerticalEdge(element, top, bottom, right - 1, left - 1, -1) + 1;

  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top)
  };
}

function trimHorizontalEdge(
  element: HTMLElement,
  left: number,
  right: number,
  startY: number,
  stopYExclusive: number,
  direction: 1 | -1
): number {
  const sampleCount = OCCLUSION_SAMPLE_COUNT;
  let y = startY;
  const maxPasses = OCCLUSION_MAX_TRIM_PX;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (direction === 1 ? y >= stopYExclusive : y < stopYExclusive) {
      break;
    }

    if (isHorizontalLineMostlyOnElement(element, left, right, y, sampleCount)) {
      break;
    }

    y += direction;
  }

  return y;
}

function trimVerticalEdge(
  element: HTMLElement,
  top: number,
  bottom: number,
  startX: number,
  stopXExclusive: number,
  direction: 1 | -1
): number {
  const sampleCount = OCCLUSION_SAMPLE_COUNT;
  let x = startX;
  const maxPasses = OCCLUSION_MAX_TRIM_PX;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (direction === 1 ? x >= stopXExclusive : x < stopXExclusive) {
      break;
    }

    if (isVerticalLineMostlyOnElement(element, top, bottom, x, sampleCount)) {
      break;
    }

    x += direction;
  }

  return x;
}

function isHorizontalLineMostlyOnElement(
  element: HTMLElement,
  left: number,
  right: number,
  y: number,
  sampleCount: number
): boolean {
  if (right - left <= 0) {
    return false;
  }

  let hitCount = 0;
  const needed = Math.ceil(sampleCount * OCCLUSION_HIT_RATIO);

  for (let i = 0; i < sampleCount; i += 1) {
    const ratio = (i + 0.5) / sampleCount;
    const x = left + Math.floor((right - left) * ratio);
    if (isPointOnElement(element, x, y)) {
      hitCount += 1;
      if (hitCount >= needed) {
        return true;
      }
    }
  }

  return false;
}

function isVerticalLineMostlyOnElement(
  element: HTMLElement,
  top: number,
  bottom: number,
  x: number,
  sampleCount: number
): boolean {
  if (bottom - top <= 0) {
    return false;
  }

  let hitCount = 0;
  const needed = Math.ceil(sampleCount * OCCLUSION_HIT_RATIO);

  for (let i = 0; i < sampleCount; i += 1) {
    const ratio = (i + 0.5) / sampleCount;
    const y = top + Math.floor((bottom - top) * ratio);
    if (isPointOnElement(element, x, y)) {
      hitCount += 1;
      if (hitCount >= needed) {
        return true;
      }
    }
  }

  return false;
}

function isPointOnElement(element: HTMLElement, x: number, y: number): boolean {
  const px = clamp(Math.floor(x), 0, Math.max(0, window.innerWidth - 1));
  const py = clamp(Math.floor(y), 0, Math.max(0, window.innerHeight - 1));
  const hit = document.elementFromPoint(px, py);
  if (!hit) {
    return false;
  }

  return hit === element || element.contains(hit);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function waitForPaint(): Promise<void> {
  await waitForAnimationFrame();
  await waitForAnimationFrame();
  await wait(30);
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('スクリーンショットの読み込みに失敗しました。'));
    image.src = dataUrl;
  });
}

function buildDownloadFilename(element: HTMLElement): string {
  const title = (document.title || 'page').trim() || 'page';
  const tag = element.tagName.toLowerCase();
  const now = new Date();
  const datePart = [
    now.getFullYear().toString(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('');
  const timePart = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join('');

  const raw = `${title}-${tag}-${datePart}-${timePart}.png`;
  return raw.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ');
}

async function sendMessageToBackground<TMessage, TResponse>(message: TMessage): Promise<TResponse> {
  return chrome.runtime.sendMessage(message) as Promise<TResponse>;
}
