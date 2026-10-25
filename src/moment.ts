export interface VideoMoment {
  videoId: string;
  time: number;
  image: string;
}

// 페이지에 복사되는 함수라 외부 변수와 API 키를 참조하지 않는다.
export function captureMoment(videoId: string): VideoMoment | { error: string } {
  if (
    location.origin !== 'https://www.youtube.com' ||
    location.pathname !== '/watch' ||
    new URL(location.href).searchParams.get('v') !== videoId
  )
    return { error: '영상이 바뀌었어요. 현재 영상에서 다시 질문해 주세요.' };
  const player = document.querySelector('#movie_player');
  if (
    !player ||
    player.classList.contains('ad-showing') ||
    player.classList.contains('ad-interrupting')
  )
    return { error: '영상이 준비되지 않았거나 광고 중이에요. 본 영상에서 다시 질문해 주세요.' };
  try {
    const response = Reflect.get(player, 'getPlayerResponse')?.call(player);
    if (response?.videoDetails?.videoId !== videoId)
      return { error: '새 영상이 아직 준비되지 않았어요. 잠시 후 다시 질문해 주세요.' };
    const video = player.querySelector('video');
    if (
      !video ||
      video.readyState < 2 ||
      video.seeking ||
      !video.videoWidth ||
      !video.videoHeight ||
      !Number.isFinite(video.duration) ||
      video.duration <= 0 ||
      !Number.isFinite(video.currentTime) ||
      video.currentTime < 0 ||
      video.currentTime > video.duration
    )
      return {
        error: '현재 화면을 읽을 수 없어요. 영상 로딩이나 탐색이 끝난 뒤 다시 질문해 주세요.',
      };
    const time = video.currentTime;
    const canvas = document.createElement('canvas');
    // 슬라이드 글자를 보존하되 4K 프레임 전송량은 줄인다.
    const scale = Math.min(1, 1920 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return { error: '영상 화면을 캡처하지 못했어요. 다시 시도해 주세요.' };
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return { videoId, time, image: canvas.toDataURL('image/jpeg', 0.85) };
  } catch {
    return {
      error: '이 영상의 프레임을 읽지 못했어요. 페이지를 새로고침한 뒤 다시 시도해 주세요.',
    };
  }
}

export async function readMoment(tabId: number, videoId: string): Promise<VideoMoment> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: captureMoment,
    args: [videoId],
  });
  const result = injection?.result;
  if (result && 'error' in result) throw new Error(result.error);
  if (
    !result ||
    result.videoId !== videoId ||
    !Number.isFinite(result.time) ||
    result.time < 0 ||
    typeof result.image !== 'string' ||
    result.image.length > 8_000_000 ||
    !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(result.image)
  )
    throw new Error('영상 시점과 프레임을 읽지 못했어요. 다시 질문해 주세요.');
  return result;
}

export function formatTime(time: number): string {
  const seconds = Math.floor(time);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
