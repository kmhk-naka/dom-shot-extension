export const MESSAGE_TYPE = {
  START_INSPECT_MODE: 'START_INSPECT_MODE',
  CANCEL_INSPECT_MODE: 'CANCEL_INSPECT_MODE',
  CAPTURE_SESSION_STARTED: 'CAPTURE_SESSION_STARTED',
  CAPTURE_SESSION_FINISHED: 'CAPTURE_SESSION_FINISHED',
  REQUEST_VISIBLE_CAPTURE: 'REQUEST_VISIBLE_CAPTURE',
  DOWNLOAD_IMAGE: 'DOWNLOAD_IMAGE'
} as const;

export type StartInspectModeMessage = {
  type: typeof MESSAGE_TYPE.START_INSPECT_MODE;
};

export type CancelInspectModeMessage = {
  type: typeof MESSAGE_TYPE.CANCEL_INSPECT_MODE;
};

export type CaptureSessionStartedMessage = {
  type: typeof MESSAGE_TYPE.CAPTURE_SESSION_STARTED;
};

export type CaptureSessionFinishedMessage = {
  type: typeof MESSAGE_TYPE.CAPTURE_SESSION_FINISHED;
};

export type RequestVisibleCaptureMessage = {
  type: typeof MESSAGE_TYPE.REQUEST_VISIBLE_CAPTURE;
};

export type DownloadImageMessage = {
  type: typeof MESSAGE_TYPE.DOWNLOAD_IMAGE;
  url: string;
  filename: string;
};

export type BackgroundRequestMessage =
  | CaptureSessionStartedMessage
  | CaptureSessionFinishedMessage
  | RequestVisibleCaptureMessage
  | DownloadImageMessage;

export type ContentRequestMessage =
  | StartInspectModeMessage
  | CancelInspectModeMessage;

export type CaptureResponse =
  | {
      ok: true;
      dataUrl: string;
    }
  | {
      ok: false;
      error: string;
    };

export type DownloadResponse =
  | {
      ok: true;
      downloadId: number;
    }
  | {
      ok: false;
      error: string;
    };

export type StatusResponse = {
  ok: true;
};
