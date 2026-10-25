export interface Caption {
  start: number;
  duration: number;
  text: string;
}

export interface VideoSnapshot {
  id: string;
  title: string;
  duration: number;
}

export type VideoCapture =
  | { status: 'error'; message: string }
  | {
      status: 'captured';
      video: VideoSnapshot;
      captions:
        | { status: 'ok'; language: string; automatic: boolean; data: unknown }
        | { status: 'unavailable' | 'error'; message: string };
    };

export function getVideoId(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const id = parsed.searchParams.get('v');
    return parsed.origin === 'https://www.youtube.com' &&
      parsed.pathname === '/watch' &&
      id !== null &&
      /^[\w-]{11}$/.test(id)
      ? id
      : null;
  } catch {
    return null;
  }
}

// executeScript는 함수만 복사하므로 페이지에서 쓰는 코드는 이 함수 안에 둔다.
export async function captureVideo(expectedId: string): Promise<VideoCapture> {
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const error = (message: string): VideoCapture => ({ status: 'error', message });
  const isCurrentVideo = () =>
    location.origin === 'https://www.youtube.com' &&
    location.pathname === '/watch' &&
    new URL(location.href).searchParams.get('v') === expectedId;

  if (!isCurrentVideo()) return error('영상이 바뀌었어요. 현재 영상에서 다시 확인해 주세요.');

  // shortcut: 유튜브의 비공식 플레이어 데이터에 의존한다. 구조 변경 시 추출 방식을 재검증한다.
  let response: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!isCurrentVideo()) return error('영상이 바뀌었어요.');
    const player = document.querySelector('#movie_player');
    const getPlayerResponse: unknown = player && Reflect.get(player, 'getPlayerResponse');
    try {
      response =
        typeof getPlayerResponse === 'function' ? getPlayerResponse.call(player) : undefined;
    } catch {
      response = undefined;
    }
    if (
      record(response) &&
      record(response.videoDetails) &&
      response.videoDetails.videoId === expectedId
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (
    !record(response) ||
    !record(response.videoDetails) ||
    response.videoDetails.videoId !== expectedId
  ) {
    return error('영상 정보를 읽지 못했어요. 페이지 로딩 후 다시 시도해 주세요.');
  }
  const details = response.videoDetails;
  if (details.isLive === true)
    return error('실시간 방송은 지원하지 않아요. 일반 영상을 열어 주세요.');
  const duration = Number(details.lengthSeconds);
  if (typeof details.title !== 'string' || !Number.isFinite(duration) || duration <= 0) {
    return error('영상 정보를 읽지 못했어요. 페이지 로딩 후 다시 시도해 주세요.');
  }
  const video: VideoSnapshot = { id: expectedId, title: details.title, duration };
  const failure = (status: 'unavailable' | 'error', message: string): VideoCapture => ({
    status: 'captured',
    video,
    captions: { status, message },
  });

  if (response.captions === undefined) {
    return failure(
      'unavailable',
      '플레이어가 제공하는 자막이 없어요. 자막이 있는 다른 영상을 열어 주세요.',
    );
  }
  const captions = response.captions;
  const renderer = record(captions) ? captions.playerCaptionsTracklistRenderer : undefined;
  const tracks = record(renderer) ? renderer.captionTracks : undefined;
  if (!Array.isArray(tracks)) {
    return failure(
      'error',
      '자막 목록 형식을 읽지 못했어요. 페이지를 새로고침한 뒤 다시 확인해 주세요.',
    );
  }
  if (tracks.length === 0) {
    return failure(
      'unavailable',
      '플레이어가 제공하는 자막이 없어요. 자막이 있는 다른 영상을 열어 주세요.',
    );
  }
  const validTracks = tracks.filter(
    (track): track is Record<string, unknown> =>
      record(track) && typeof track.baseUrl === 'string' && typeof track.languageCode === 'string',
  );
  // PoC에서는 한국어를 우선하고 영어와 첫 제공 언어 순으로 선택한다.
  const track =
    validTracks.find((item) => item.languageCode === 'ko' && item.kind !== 'asr') ??
    validTracks.find((item) => item.languageCode === 'ko') ??
    validTracks.find((item) => item.languageCode === 'en' && item.kind !== 'asr') ??
    validTracks.find((item) => item.languageCode === 'en') ??
    validTracks[0];
  if (!track || typeof track.baseUrl !== 'string' || typeof track.languageCode !== 'string') {
    return failure(
      'error',
      '자막 주소를 읽지 못했어요. 페이지를 새로고침한 뒤 다시 확인해 주세요.',
    );
  }

  try {
    const url = new URL(track.baseUrl);
    if (url.origin !== 'https://www.youtube.com' || url.pathname !== '/api/timedtext') {
      return failure(
        'error',
        '지원하지 않는 자막 주소예요. 이 영상의 추출 방식은 추가 확인이 필요해요.',
      );
    }
    url.searchParams.set('fmt', 'json3');
    const result = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    if (!isCurrentVideo()) return error('영상이 바뀌었어요. 현재 영상에서 다시 확인해 주세요.');
    if (!result.ok) {
      return failure(
        'error',
        `자막 요청 실패 (HTTP ${result.status}). 잠시 후 다시 확인해 주세요.`,
      );
    }
    const body = await result.text();
    if (!body.trim()) {
      return failure(
        'error',
        '자막 목록은 있지만 본문 응답이 비어 있어요. 유튜브에서 스크립트가 열리는지 확인한 뒤 다시 시도해 주세요.',
      );
    }
    const data: unknown = JSON.parse(body);
    return {
      status: 'captured',
      video,
      captions: {
        status: 'ok',
        language: track.languageCode,
        automatic: track.kind === 'asr',
        data,
      },
    };
  } catch (cause) {
    const message =
      cause instanceof Error && cause.name === 'TimeoutError'
        ? '자막 요청 시간이 초과됐어요. 잠시 후 다시 확인해 주세요.'
        : '자막 응답을 읽지 못했어요. 네트워크와 유튜브 스크립트 표시를 확인한 뒤 다시 시도해 주세요.';
    return failure('error', message);
  }
}

export function parseCaptions(data: unknown): Caption[] {
  if (
    typeof data !== 'object' ||
    data === null ||
    !('events' in data) ||
    !Array.isArray(data.events)
  ) {
    throw new Error('자막 응답 형식을 읽지 못했어요. 이 영상의 추출 방식은 추가 확인이 필요해요.');
  }
  const captions: Caption[] = [];
  for (const event of data.events) {
    if (typeof event !== 'object' || event === null)
      throw new Error('자막 구간 형식이 올바르지 않아요.');
    if (event.segs === undefined) continue;
    if (!Array.isArray(event.segs)) throw new Error('자막 텍스트 형식이 올바르지 않아요.');
    const text = event.segs
      .map((segment: unknown) => {
        if (
          typeof segment !== 'object' ||
          segment === null ||
          !('utf8' in segment) ||
          typeof segment.utf8 !== 'string'
        ) {
          throw new Error('자막 텍스트 형식이 올바르지 않아요.');
        }
        return segment.utf8;
      })
      .join('')
      .trim();
    if (!text) continue;
    if (
      typeof event.tStartMs !== 'number' ||
      !Number.isFinite(event.tStartMs) ||
      event.tStartMs < 0 ||
      typeof event.dDurationMs !== 'number' ||
      !Number.isFinite(event.dDurationMs) ||
      event.dDurationMs < 0
    ) {
      throw new Error('자막의 시간 정보를 읽지 못했어요.');
    }
    captions.push({ start: event.tStartMs / 1000, duration: event.dDurationMs / 1000, text });
  }
  if (captions.length === 0) throw new Error('자막 응답에 읽을 수 있는 문장이 없어요.');
  return captions.sort((a, b) => a.start - b.start);
}

export type TranscriptState =
  | { videoId: string; status: 'loading' }
  | { videoId: string; status: 'error' | 'unavailable'; message: string }
  | {
      videoId: string;
      status: 'ready';
      video: VideoSnapshot;
      language: string;
      automatic: boolean;
      captions: Caption[];
    };

export function transcriptKey(tabId: number): string {
  return `transcript:${tabId}`;
}
