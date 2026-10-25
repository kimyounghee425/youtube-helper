import {
  captureVideo,
  getVideoId,
  parseCaptions,
  transcriptKey,
  type TranscriptState,
} from '../youtube';

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error: unknown) => console.error('사이드패널 열기 설정 실패', error));

const jobs = new Map<number, { videoId: string }>();

async function clearTranscript(tabId: number) {
  jobs.delete(tabId);
  await chrome.storage.session.remove(transcriptKey(tabId));
}

async function collect(tab: chrome.tabs.Tab, retry = false) {
  const tabId = tab.id;
  if (tabId === undefined) return;
  const videoId = getVideoId(tab.url);
  if (!videoId) return clearTranscript(tabId);
  if (jobs.get(tabId)?.videoId === videoId) return;

  const job = { videoId };
  jobs.set(tabId, job);
  const key = transcriptKey(tabId);
  try {
    const saved = (await chrome.storage.session.get(key))[key] as TranscriptState | undefined;
    if (jobs.get(tabId) !== job) return;
    if (!retry && saved?.videoId === videoId && saved.status !== 'loading') return;
    await chrome.storage.session.set({ [key]: { videoId, status: 'loading' } });
    if (jobs.get(tabId) !== job) return;
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: captureVideo,
      args: [videoId],
    });
    const current = await chrome.tabs.get(tabId);
    if (jobs.get(tabId) !== job || getVideoId(current.url) !== videoId) return;
    const result = injection?.result;
    let state: TranscriptState;
    if (!result)
      throw new Error('페이지 응답이 없어요. 페이지를 새로고침한 뒤 다시 시도해 주세요.');
    if (result.status === 'error') {
      state = { videoId, status: 'error', message: result.message };
    } else if (result.captions.status !== 'ok') {
      state = { videoId, ...result.captions };
    } else {
      state = {
        videoId,
        status: 'ready',
        video: result.video,
        language: result.captions.language,
        automatic: result.captions.automatic,
        captions: parseCaptions(result.captions.data),
      };
    }
    await chrome.storage.session.set({ [key]: state });
  } catch (cause) {
    if (jobs.get(tabId) !== job) return;
    const state: TranscriptState = {
      videoId,
      status: 'error',
      message:
        cause instanceof Error ? cause.message : '자막을 가져오지 못했어요. 다시 시도해 주세요.',
    };
    await chrome.storage.session.set({ [key]: state });
  } finally {
    if (jobs.get(tabId) === job) jobs.delete(tabId);
  }
}

const reportFailure = (cause: unknown) => console.error('자막 수집 상태 처리 실패', cause);

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === 'loading') {
    void clearTranscript(tabId).catch(reportFailure);
  } else if (change.url !== undefined || change.status === 'complete') {
    void collect(tab).catch(reportFailure);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void clearTranscript(tabId).catch(reportFailure);
});

async function collectOpenVideos() {
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/watch*' });
  await Promise.all(tabs.filter((tab) => tab.status === 'complete').map((tab) => collect(tab)));
}
chrome.runtime.onInstalled.addListener(() => {
  void collectOpenVideos().catch(reportFailure);
});
chrome.runtime.onStartup.addListener(() => {
  void collectOpenVideos().catch(reportFailure);
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (
    sender.id !== chrome.runtime.id ||
    typeof message !== 'object' ||
    message === null ||
    !('type' in message) ||
    message.type !== 'ensure-transcript' ||
    !('tabId' in message) ||
    typeof message.tabId !== 'number' ||
    !Number.isInteger(message.tabId)
  )
    return;
  const retry = 'retry' in message && message.retry === true;
  void chrome.tabs
    .get(message.tabId)
    .then((tab) => collect(tab, retry))
    .then(
      () => sendResponse({ ok: true }),
      () => sendResponse({ ok: false }),
    );
  return true;
});
