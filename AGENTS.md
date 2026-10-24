# Browser Companion

- 이 레포는 `../interview-helper`와 독립적이다. 원본 레포를 수정하지 않는다.
- 현재 범위는 Chrome 확장 사이드패널 기본 틀이다.
- 제품 목표와 미결정 사항은 README.md를 따른다.
- AI 호출 방식, ChatGPT 연결, 대화 저장 방식은 아직 결정하지 않았다.
- 기존 ChatGPT 대화·프로젝트 접근이 공식적으로 지원된다고 가정하지 않는다.
- 면접 기능, STT, PDF 처리, 결제, 공유 패키지는 필요가 확정될 때만 추가한다.
- 페이지 내용과 스크린샷은 사용자의 요청 없이 수집하거나 전송하지 않는다.
- API 키나 사용자 데이터, 환경 파일을 커밋하지 않는다.
- 라이브러리·SDK·API·CLI 관련 구현은 Context7에서 resolve-library-id 후 query-docs로 확인한다.
- 검증: `pnpm test`, `pnpm format:check`. 실제 Chrome 확인 여부는 별도로 보고한다.
