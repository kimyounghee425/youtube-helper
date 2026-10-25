import { useEffect, useState, type FormEvent } from 'react';
import { API_KEY_STORAGE } from '../ai';

export function ApiKeySettings() {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    let changed = false;
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && API_KEY_STORAGE in changes) {
        changed = true;
        setSaved(Boolean(changes[API_KEY_STORAGE].newValue));
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    void chrome.storage.session.get(API_KEY_STORAGE).then(
      (data) => {
        if (!disposed && !changed) setSaved(Boolean(data[API_KEY_STORAGE]));
      },
      () => {
        if (!disposed) setError('키 상태를 읽지 못했어요. 패널을 다시 열어 주세요.');
      },
    );
    return () => {
      disposed = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const key = value.trim();
    if (!key || /\s/.test(key)) {
      setError('공백 없는 API 키를 입력해 주세요.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await chrome.storage.session.set({ [API_KEY_STORAGE]: key });
      setValue('');
      setSaved(true);
    } catch {
      setError('키를 보관하지 못했어요. 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError('');
    try {
      await chrome.storage.session.remove(API_KEY_STORAGE);
      setValue('');
      setSaved(false);
    } catch {
      setError('키를 삭제하지 못했어요. 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="key-settings">
      <summary>API 키 {saved ? '설정됨' : '입력 필요'}</summary>
      <form onSubmit={save}>
        <label htmlFor="api-key">내 OpenAI API 키</label>
        <input
          id="api-key"
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          maxLength={512}
          disabled={busy}
        />
        <div className="actions">
          <button type="submit" disabled={busy || !value.trim()}>
            {saved ? '키 교체' : '키 저장'}
          </button>
          {saved && (
            <button type="button" disabled={busy} onClick={() => void remove()}>
              키 삭제
            </button>
          )}
        </div>
      </form>
      <p className="muted">
        브라우저를 종료하면 키가 지워져요. 호출 비용은 본인 API 계정에 청구돼요.
      </p>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
