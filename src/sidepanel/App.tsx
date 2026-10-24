export function App() {
  return (
    <main className="app">
      <header className="appbar">
        <h1>Browser Companion</h1>
      </header>
      <section className="welcome" aria-labelledby="welcome-title">
        <h2 id="welcome-title">보고 있는 페이지에서 대화를 이어가세요</h2>
        <p>화면을 함께 보며 질문하고, 읽던 내용과 대화를 다시 이어가는 도우미를 준비하고 있어요.</p>
        <p className="notice">아직 페이지 읽기와 대화 기능은 사용할 수 없어요.</p>
      </section>
    </main>
  );
}
