import {
  MESSAGE_TYPE,
  type BackgroundRequestMessage,
  type CaptureResponse,
  type ContentRequestMessage,
  type DownloadResponse
} from './messages';

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
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

  try {
    await startInspectMode(tab.id);
  } catch (error) {
    console.error('[dom-shot] failed to start inspect mode:', toErrorMessage(error));
  }
});

chrome.runtime.onMessage.addListener(
  (
    message: BackgroundRequestMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: CaptureResponse | DownloadResponse) => void
  ) => {
    if (message.type === MESSAGE_TYPE.REQUEST_VISIBLE_CAPTURE) {
      void (async () => {
        try {
          const windowId = sender.tab?.windowId;
          const dataUrl =
            typeof windowId === 'number'
              ? await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
              : await chrome.tabs.captureVisibleTab({ format: 'png' });
          sendResponse({ ok: true, dataUrl });
        } catch (error) {
          sendResponse({ ok: false, error: toErrorMessage(error) });
        }
      })();

      return true;
    }

    if (message.type === MESSAGE_TYPE.DOWNLOAD_IMAGE) {
      void (async () => {
        try {
          const downloadId = await chrome.downloads.download({
            url: message.dataUrl,
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
