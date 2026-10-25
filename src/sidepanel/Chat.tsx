import { useEffect, useRef, useState, type FormEvent } from 'react';
import { API_KEY_STORAGE, askVideo, buildRequest, type Turn } from '../ai';
import { formatTime, readMoment } from '../moment';
import { getVideoId, type TranscriptState } from '../youtube';

type ReadyTranscript = Extract<TranscriptState, { status: 'ready' }>;

export function Chat({ tabId, transcript }: { tabId: number; transcript: ReadyTranscript }) {
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState<{ question: string; time?: number }>();
  const [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);

  function cancel(message: string) {
    if (!controller.current) return;
    controller.current.abort();
    controller.current = null;
    setPending(undefined);
    setError(message);
  }

  useEffect(() => {
    let windowId: number | undefined;
    void chrome.tabs.get(tabId).then(
      (tab) => {
        windowId = tab.windowId;
      },
      () => {},
    );
    const onUpdated = (id: number, change: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && (change.url !== undefined || change.status === 'loading'))
        cancel('영상이 바뀌어 요청을 중단했어요.');
    };
    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
      if (info.windowId === windowId && info.tabId !== tabId)
        cancel('탭이 바뀌어 요청을 중단했어요.');
    };
    const onRemoved = (id: number) => {
      if (id === tabId) cancel('영상 탭이 닫혔어요.');
    };
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && API_KEY_STORAGE in changes)
        cancel('API 키가 변경됐어요. 다시 질문해 주세요.');
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      controller.current?.abort();
      controller.current = null;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [tabId]);

  async function checkCurrent(signal: AbortSignal) {
    signal.throwIfAborted();
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    signal.throwIfAborted();
    if (tab?.id !== tabId || getVideoId(tab.url) !== transcript.videoId)
      throw new Error('현재 영상이 바뀌었어요. 새 영상에서 다시 질문해 주세요.');
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (controller.current || !draft.trim()) return;
    const request = new AbortController();
    controller.current = request;
    const question = draft.trim();
    setError('');
    setPending({ question });
    try {
      const data = await chrome.storage.session.get(API_KEY_STORAGE);
      const apiKey: unknown = data[API_KEY_STORAGE];
      if (typeof apiKey !== 'string' || !apiKey)
        throw new Error('위의 API 키 설정에서 본인 키를 입력해 주세요.');
      await checkCurrent(request.signal);
      const moment = await readMoment(tabId, transcript.videoId);
      await checkCurrent(request.signal);
      const body = buildRequest(transcript.video, transcript.captions, moment, question, turns);
      setPending({ question, time: moment.time });
      const answer = await askVideo(apiKey, body, request.signal);
      await checkCurrent(request.signal);
      setTurns((previous) => [...previous, { question, answer, time: moment.time }]);
      setDraft('');
    } catch (cause) {
      if (!request.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : '질문을 보내지 못했어요. 다시 시도해 주세요.',
        );
    } finally {
      if (controller.current === request) {
        controller.current = null;
        setPending(undefined);
      }
    }
  }

  return (
    <section className="chat" aria-labelledby="chat-title">
      <div className="chat-heading">
        <h2 id="chat-title">영상에 대해 질문하기</h2>
        {turns.length > 0 && (
          <button
            type="button"
            disabled={Boolean(pending)}
            onClick={() => {
              setTurns([]);
              setError('');
            }}
          >
            대화 비우기
          </button>
        )}
      </div>
      <p className="muted">
        영상 시작부터 질문 시점까지의 자막과 현재 영상 화면 한 장을 함께 보내요.
      </p>
      <div className="messages" role="log" aria-label="영상 문답" aria-live="polite">
        {turns.map((turn, index) => (
          <article className="turn" key={index}>
            <p className="question">
              <strong>나</strong> <span className="timestamp">{formatTime(turn.time)}</span>
              <br />
              {turn.question}
            </p>
            <p className="answer">
              <strong>GPT</strong>
              <br />
              {turn.answer}
            </p>
          </article>
        ))}
      </div>
      {pending && (
        <p role="status">
          {pending.time === undefined
            ? '질문 시점의 화면을 가져오고 있어요.'
            : `${formatTime(pending.time)} 화면을 참고해 답변하고 있어요.`}
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <form onSubmit={send}>
        <label htmlFor="question">궁금한 내용</label>
        <textarea
          id="question"
          rows={3}
          maxLength={4000}
          value={draft}
          disabled={Boolean(pending)}
          placeholder="방금 설명이 무슨 뜻이야?"
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="actions">
          <button type="submit" disabled={Boolean(pending) || !draft.trim()}>
            {error ? '다시 보내기' : '질문 보내기'}
          </button>
          {pending && (
            <button type="button" onClick={() => cancel('요청을 중단했어요. 질문은 남겨뒀어요.')}>
              중단
            </button>
          )}
        </div>
      </form>
      <p className="muted">
        다시 보내면 현재 시점의 화면을 새로 읽어요. 패널을 닫거나 다른 영상으로 이동하면 대화는
        사라져요.
      </p>
    </section>
  );
}
