import {
  MESSAGE_TYPE,
  type BackgroundRequestMessage,
  type CaptureResponse,
  type ContentRequestMessage,
  type DownloadResponse,
  type StatusResponse
} from './messages';

const CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND =
  chrome.tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND ?? 2;
const CAPTURE_VISIBLE_TAB_WINDOW_MS = 1_000;
const CAPTURE_VISIBLE_TAB_BASE_BACKOFF_MS = Math.ceil(1000 / CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND);
const CAPTURE_VISIBLE_TAB_MAX_RETRIES = 1;
const CAPTURE_VISIBLE_TAB_SAFETY_BUFFER_MS = 34;
const ACTION_DEFAULT_TITLE = 'Start DOM Capture';
const ACTION_CAPTURE_TITLE = 'DOM Shot: キャプチャ中';
const ACTION_CAPTURE_BADGE_TEXT = 'CAP';
const ACTION_CAPTURE_BADGE_COLOR = '#2563eb';

let captureQueue: Promise<void> = Promise.resolve();
let recentCaptureCallStartedAts: number[] = [];
const invokedTabIds = new Set<number>();

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function pruneRecentCaptureCalls(now = Date.now()): void {
  recentCaptureCallStartedAts = recentCaptureCallStartedAts.filter(
    (startedAt) => now - startedAt < CAPTURE_VISIBLE_TAB_WINDOW_MS
  );
}

async function waitForCaptureBudget(): Promise<void> {
  while (true) {
    const now = Date.now();
    pruneRecentCaptureCalls(now);

    if (recentCaptureCallStartedAts.length < CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND) {
      return;
    }

    const oldestStartedAt = recentCaptureCallStartedAts[0];
    const waitMs = Math.max(
      1,
      oldestStartedAt + CAPTURE_VISIBLE_TAB_WINDOW_MS - now + CAPTURE_VISIBLE_TAB_SAFETY_BUFFER_MS
    );
    await wait(waitMs);
  }
}

async function setCaptureBadge(tabId: number | undefined): Promise<void> {
  if (typeof tabId !== 'number') {
    return;
  }

  await chrome.action.setBadgeBackgroundColor({ tabId, color: ACTION_CAPTURE_BADGE_COLOR });
  await chrome.action.setBadgeText({ tabId, text: ACTION_CAPTURE_BADGE_TEXT });
  await chrome.action.setTitle({ tabId, title: ACTION_CAPTURE_TITLE });
}

async function clearCaptureBadge(tabId: number | undefined): Promise<void> {
  if (typeof tabId !== 'number') {
    return;
  }

  await chrome.action.setBadgeText({ tabId, text: '' });
  await chrome.action.setTitle({ tabId, title: ACTION_DEFAULT_TITLE });
}

function isCaptureQuotaError(error: unknown): boolean {
  const message = toErrorMessage(error);
  return message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
}

function isActiveTabNotInEffectError(error: unknown): boolean {
  const message = toErrorMessage(error);
  return message.includes("The 'activeTab' permission is not in effect");
}

function isFileUrl(url: string | undefined): boolean {
  return typeof url === 'string' && url.startsWith('file://');
}

function isInvokedTab(tabId: number | undefined): boolean {
  return typeof tabId === 'number' && invokedTabIds.has(tabId);
}

function isAllowedFileSchemeAccess(): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.extension.isAllowedFileSchemeAccess((isAllowed) => resolve(isAllowed));
  });
}

async function toCaptureFailureMessage(
  error: unknown,
  sender: chrome.runtime.MessageSender
): Promise<string> {
  const tabId = sender.tab?.id;
  const pageUrl = sender.url ?? sender.tab?.url;

  if (isActiveTabNotInEffectError(error)) {
    if (isFileUrl(pageUrl)) {
      const fileAccessAllowed = await isAllowedFileSchemeAccess();
      if (!fileAccessAllowed) {
        return 'file:// ページを撮影するには、拡張の詳細画面で「ファイルの URL へのアクセスを許可する」を有効にしてください。';
      }
    }

    if (!isInvokedTab(tabId)) {
      return 'このタブで拡張が起動されていません。拡張アイコンを押して選択モードを開始してから、もう一度実行してください。';
    }

    return 'このタブでの一時権限が失効しました。ページを開いたまま拡張アイコンを押し直して、再度キャプチャしてください。';
  }

  return toErrorMessage(error);
}

async function captureVisibleTabWithRetry(windowId: number | undefined): Promise<string> {
  for (let attempt = 0; attempt <= CAPTURE_VISIBLE_TAB_MAX_RETRIES; attempt += 1) {
    try {
      await waitForCaptureBudget();
      const startedAt = Date.now();
      pruneRecentCaptureCalls(startedAt);
      recentCaptureCallStartedAts.push(startedAt);

      const dataUrl =
        typeof windowId === 'number'
          ? await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
        : await chrome.tabs.captureVisibleTab({ format: 'png' });

      return dataUrl;
    } catch (error) {
      if (!isCaptureQuotaError(error) || attempt === CAPTURE_VISIBLE_TAB_MAX_RETRIES) {
        throw error;
      }

      await wait(Math.max(CAPTURE_VISIBLE_TAB_BASE_BACKOFF_MS, CAPTURE_VISIBLE_TAB_SAFETY_BUFFER_MS));
    }
  }

  throw new Error('Visible tab capture failed.');
}

async function queueVisibleCapture(windowId: number | undefined): Promise<string> {
  const task = captureQueue.then(async () => captureVisibleTabWithRetry(windowId));

  captureQueue = task.then(
    () => undefined,
    () => undefined
  );

  return task;
}

function sanitizeFilename(filename: string): string {
  const sanitized = filename
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();

  return sanitized.length > 0 ? sanitized : 'dom-shot.png';
}

async function sendMessageToTab<TResponse>(tabId: number, message: ContentRequestMessage): Promise<TResponse> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<TResponse>;
}

async function ensureContentScriptInjected(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
}

async function startInspectMode(tabId: number): Promise<void> {
  try {
    await sendMessageToTab(tabId, { type: MESSAGE_TYPE.START_INSPECT_MODE });
  } catch {
    await ensureContentScriptInjected(tabId);
    await sendMessageToTab(tabId, { type: MESSAGE_TYPE.START_INSPECT_MODE });
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) {
    return;
  }

  invokedTabIds.add(tab.id);
  await clearCaptureBadge(tab.id);

  try {
    await startInspectMode(tab.id);
  } catch (error) {
    console.error('[dom-shot] failed to start inspect mode:', toErrorMessage(error));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  invokedTabIds.delete(tabId);
});

chrome.runtime.onMessage.addListener(
  (
    message: BackgroundRequestMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: CaptureResponse | DownloadResponse | StatusResponse) => void
  ) => {
    if (message.type === MESSAGE_TYPE.CAPTURE_SESSION_STARTED) {
      void (async () => {
        await setCaptureBadge(sender.tab?.id);
        sendResponse({ ok: true });
      })();

      return true;
    }

    if (message.type === MESSAGE_TYPE.CAPTURE_SESSION_FINISHED) {
      void (async () => {
        await clearCaptureBadge(sender.tab?.id);
        sendResponse({ ok: true });
      })();

      return true;
    }

    if (message.type === MESSAGE_TYPE.REQUEST_VISIBLE_CAPTURE) {
      void (async () => {
        try {
          const windowId = sender.tab?.windowId;
          const dataUrl = await queueVisibleCapture(windowId);
          sendResponse({ ok: true, dataUrl });
        } catch (error) {
          const message = await toCaptureFailureMessage(error, sender);
          sendResponse({ ok: false, error: message });
        }
      })();

      return true;
    }

    if (message.type === MESSAGE_TYPE.DOWNLOAD_IMAGE) {
      void (async () => {
        try {
          const downloadId = await chrome.downloads.download({
            url: message.url,
            filename: sanitizeFilename(message.filename),
            saveAs: false,
            conflictAction: 'uniquify'
          });

          if (typeof downloadId !== 'number') {
            throw new Error('Download failed.');
          }

          sendResponse({ ok: true, downloadId });
        } catch (error) {
          sendResponse({ ok: false, error: toErrorMessage(error) });
        }
      })();

      return true;
    }

    return false;
  }
);
