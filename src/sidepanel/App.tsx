import { useEffect, useState } from 'react';
import { getVideoId, transcriptKey, type TranscriptState } from '../youtube';
import { ApiKeySettings } from './ApiKeySettings';
import { Chat } from './Chat';

type View = { tabId?: number; state?: TranscriptState; error?: string };

export function App() {
  const [view, setView] = useState<View>({});

  useEffect(() => {
    let version = 0;
    let disposed = false;
    let windowId: number | undefined;
    async function refresh(ensure = false) {
      const request = ++version;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (disposed || request !== version) return;
        windowId = tab?.windowId;
        const videoId = getVideoId(tab?.url);
        if (tab?.id === undefined || !videoId) {
          setView({});
          return;
        }
        const tabId = tab.id;
        setView((previous) =>
          previous.tabId === tabId && previous.state?.videoId === videoId
            ? previous
            : { tabId, state: { videoId, status: 'loading' } },
        );
        const saved = (await chrome.storage.session.get(transcriptKey(tabId)))[
          transcriptKey(tabId)
        ] as TranscriptState | undefined;
        if (disposed || request !== version) return;
        setView({
          tabId,
          state: saved?.videoId === videoId ? saved : { videoId, status: 'loading' },
        });
        if (ensure) {
          const response = await chrome.runtime.sendMessage({ type: 'ensure-transcript', tabId });
          if (!response?.ok && !disposed && request === version) {
            setView({ error: '자막 수집을 시작하지 못했어요. 확장을 새로고침해 주세요.' });
          }
        }
      } catch {
        if (!disposed && request === version)
          setView({ error: '수집 상태를 읽지 못했어요. 패널을 다시 열어 주세요.' });
      }
    }
    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
      if (windowId === undefined || info.windowId === windowId) void refresh(true);
    };
    const onUpdated = (_tabId: number, change: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (
        tab.active &&
        (windowId === undefined || tab.windowId === windowId) &&
        (change.url !== undefined || change.status)
      ) {
        void refresh(change.status !== 'loading');
      }
    };
    const onChanged = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session') void refresh();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.storage.onChanged.addListener(onChanged);
    void refresh(true);
    return () => {
      disposed = true;
      version += 1;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  async function retry() {
    const { tabId, state } = view;
    if (tabId === undefined || !state) return;
    setView({ tabId, state: { videoId: state.videoId, status: 'loading' } });
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'ensure-transcript',
        tabId,
        retry: true,
      });
      if (!response?.ok) throw new Error('수집 요청 실패');
    } catch {
      setView((current) =>
        current.tabId === tabId && current.state?.videoId === state.videoId
          ? {
              tabId,
              state: {
                videoId: state.videoId,
                status: 'error',
                message: '다시 시도하지 못했어요. 페이지와 확장을 새로고침해 주세요.',
              },
            }
          : current,
      );
    }
  }

  const state = view.state;
  return (
    <main className="app">
      <header className="appbar">
        <h1>Browser Companion</h1>
      </header>
      <section className="welcome" aria-labelledby="welcome-title">
        <ApiKeySettings />
        <h2 id="welcome-title">영상 자막</h2>
        <p>유튜브 영상에 들어가면 전체 자막을 자동으로 준비해요.</p>
        {view.error && (
          <p className="notice" role="alert">
            {view.error}
          </p>
        )}
        {!view.error && !state && <p role="status">유튜브 일반 영상 페이지를 열어 주세요.</p>}
        {state?.status === 'loading' && <p role="status">전체 자막을 가져오고 있어요.</p>}
        {state?.status === 'ready' && (
          <>
            <h3>{state.video.title}</h3>
            <p role="status">전체 자막 준비 완료</p>
            <dl className="video-info">
              <dt>영상 ID</dt>
              <dd>{state.videoId}</dd>
              <dt>자막 언어</dt>
              <dd>
                {state.language} ({state.automatic ? '자동 생성' : '제공 자막'})
              </dd>
              <dt>자막 개수</dt>
              <dd>{state.captions.length}개</dd>
            </dl>
            {view.tabId !== undefined && (
              <Chat key={`${view.tabId}:${state.videoId}`} tabId={view.tabId} transcript={state} />
            )}
          </>
        )}
        {(state?.status === 'error' || state?.status === 'unavailable') && (
          <>
            <div className="notice" role="alert">
              <strong>{state.status === 'unavailable' ? '자막 없음' : '자막 수집 실패'}</strong>
              <p>{state.message}</p>
            </div>
            <button className="retry-button" type="button" onClick={retry}>
              다시 시도
            </button>
          </>
        )}
      </section>
    </main>
  );
}
