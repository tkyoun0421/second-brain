export const verificationDashboardHtml = () => `<!doctype html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Second Brain · 검증 대시보드</title>
    <style>
      :root {
        color-scheme: light;
        --ink: #172033;
        --muted: #62708a;
        --line: #dce3ef;
        --surface: #ffffff;
        --canvas: #f5f7fb;
        --accent: #5155d9;
        --accent-soft: #eeefff;
        --good: #087a58;
        --good-soft: #e4f7ef;
        --warn: #a35b00;
        --warn-soft: #fff2df;
        --bad: #bd3046;
        --bad-soft: #ffecef;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      * { box-sizing: border-box; }
      body { margin: 0; background: var(--canvas); color: var(--ink); line-height: 1.5; }
      main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 64px; }
      .eyebrow { margin: 0 0 10px; color: var(--accent); font-weight: 750; font-size: .82rem; letter-spacing: .08em; text-transform: uppercase; }
      h1 { margin: 0; max-width: 760px; font-size: clamp(2rem, 5vw, 3.6rem); line-height: 1.08; letter-spacing: -.045em; }
      .lead { max-width: 750px; margin: 18px 0 0; color: var(--muted); font-size: 1.05rem; }
      .notice { display: flex; gap: 12px; align-items: flex-start; margin: 28px 0; padding: 16px 18px; border: 1px solid #f2d19c; background: var(--warn-soft); border-radius: 14px; color: #724200; }
      .notice strong { display: block; }
      .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 16px; }
      .card { grid-column: span 4; padding: 20px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); box-shadow: 0 2px 8px rgba(23,32,51,.03); }
      .card.wide { grid-column: span 8; }
      .card.full { grid-column: 1 / -1; }
      h2 { margin: 0 0 14px; font-size: 1.08rem; letter-spacing: -.015em; }
      .metric { margin: 0; font-size: 2.05rem; font-weight: 760; letter-spacing: -.04em; }
      .caption { margin: 4px 0 0; color: var(--muted); font-size: .9rem; }
      .pill { display: inline-flex; align-items: center; gap: 7px; padding: 5px 9px; border-radius: 999px; font-size: .8rem; font-weight: 720; }
      .pill::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
      .pass { color: var(--good); background: var(--good-soft); }
      .warn { color: var(--warn); background: var(--warn-soft); }
      .fail { color: var(--bad); background: var(--bad-soft); }
      .pending { color: var(--muted); background: #eef1f6; }
      .checks { display: grid; gap: 11px; margin: 0; padding: 0; list-style: none; }
      .checks li { display: flex; gap: 10px; align-items: flex-start; padding: 12px 0 0; border-top: 1px solid var(--line); }
      .checks li:first-child { padding-top: 0; border-top: 0; }
      .checkmark { display: grid; place-items: center; flex: 0 0 20px; width: 20px; height: 20px; margin-top: 2px; border-radius: 50%; background: var(--good-soft); color: var(--good); font-size: .75rem; font-weight: 800; }
      .checks strong, .checks span { display: block; }
      .checks span { margin-top: 2px; color: var(--muted); font-size: .86rem; }
      .runtime { display: flex; gap: 12px; align-items: center; min-height: 49px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: #fafbfe; }
      .runtime p { margin: 0; font-size: .92rem; }
      .runtime .pill { margin-left: auto; }
      .inbox-form { display: grid; grid-template-columns: 130px auto; justify-content: end; gap: 10px; align-items: end; }
      .field { display: grid; gap: 6px; color: var(--muted); font-size: .84rem; }
      .field input, .field select { width: 100%; min-height: 40px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px; background: white; color: var(--ink); font: inherit; }
      .inbox-form button { min-height: 40px; margin: 0; }
      .inbox-status { min-height: 24px; margin: 12px 0 0; color: var(--muted); font-size: .88rem; }
      .inbox-status.error { color: var(--bad); }
      .pagination { display: flex; justify-content: flex-end; align-items: center; gap: 10px; margin-top: 12px; }
      .pagination button { margin: 0; background: #e9ecf5; color: var(--ink); }
      .pagination button:disabled { cursor: not-allowed; opacity: .5; }
      .page-position { min-width: 82px; text-align: center; color: var(--muted); font-size: .9rem; font-variant-numeric: tabular-nums; }
      .controls { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 20px; }
      label { display: grid; grid-template-columns: 1fr auto; gap: 8px; color: var(--muted); font-size: .9rem; }
      output { color: var(--ink); font-variant-numeric: tabular-nums; font-weight: 750; }
      input[type="range"] { grid-column: 1 / -1; width: 100%; accent-color: var(--accent); }
      .result { display: grid; grid-template-columns: auto 1fr; gap: 16px; align-items: center; margin-top: 20px; padding: 16px; border-radius: 12px; background: var(--accent-soft); }
      .score { display: grid; place-items: center; width: 58px; height: 58px; border-radius: 12px; background: var(--surface); color: var(--accent); font-size: 1.5rem; font-weight: 800; }
      .result p { margin: 2px 0 0; color: var(--muted); font-size: .9rem; }
      textarea { width: 100%; min-height: 116px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; resize: vertical; color: var(--ink); font: inherit; line-height: 1.45; }
      button { appearance: none; margin-top: 10px; padding: 10px 13px; border: 0; border-radius: 9px; background: var(--accent); color: white; cursor: pointer; font: inherit; font-weight: 700; }
      button:hover { filter: brightness(.95); }
      .terminal { margin: 0; padding: 14px; overflow-x: auto; border-radius: 10px; background: #182237; color: #ecf2ff; font: .86rem/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      .table-wrap { overflow-x: auto; }
      table { width: 100%; border-collapse: collapse; min-width: 640px; font-size: .9rem; }
      th, td { padding: 12px 10px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
      th { color: var(--muted); font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; }
      td:last-child { color: var(--muted); }
      .small { margin: 14px 0 0; color: var(--muted); font-size: .83rem; }
      @media (max-width: 780px) {
        main { width: min(100% - 24px, 1120px); padding-top: 30px; }
        .card, .card.wide { grid-column: 1 / -1; }
        .controls { grid-template-columns: 1fr; }
        .inbox-form { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Second Brain · local verification</p>
      <h1>작업이 실제 규칙대로 움직이는지, 화면에서 확인하세요.</h1>
      <p class="lead">이 페이지는 자동 중요도 캡처, 체크포인트 훅, MCP 연결 계약과 데이터베이스 스키마 검증 상태를 한곳에 모읍니다. 점수와 메시지를 바꿔 보아도 데이터는 저장되지 않습니다.</p>

      <div class="notice" role="note">
        <span aria-hidden="true">!</span>
        <div><strong>실제 DB 통합 테스트 1건은 이번 로컬 실행에서 건너뛰었습니다.</strong><span><code>TEST_DATABASE_URL</code>을 설정한 뒤 전체 검증 명령을 실행하면 RLS를 포함한 저장 경로까지 확인할 수 있습니다.</span></div>
      </div>

      <section class="grid" aria-label="검증 요약">
        <article class="card">
          <h2>타입·단위 테스트</h2>
          <p class="metric">31 <span style="font-size:.95rem;font-weight:650;color:var(--muted)">/ 31 실행</span></p>
          <p class="caption"><span class="pill pass">통과</span> TypeScript 검사와 자동화 테스트</p>
        </article>
        <article class="card">
          <h2>데이터베이스 계약</h2>
          <p class="metric">17 <span style="font-size:.95rem;font-weight:650;color:var(--muted)">tables</span></p>
          <p class="caption"><span class="pill pass">통과</span> 테이블 17개 · 함수 10개 정적 검증</p>
        </article>
        <article class="card">
          <h2>실 DB 통합</h2>
          <p class="metric">1 <span style="font-size:.95rem;font-weight:650;color:var(--muted)">보류</span></p>
          <p class="caption"><span class="pill warn">환경 필요</span> <code>TEST_DATABASE_URL</code> 미설정</p>
        </article>

        <article class="card full">
          <h2>실행 중인 API</h2>
          <div class="runtime">
            <div>
              <p><strong id="health-title">상태를 확인하는 중…</strong></p>
              <p id="health-detail">현재 서버의 <code>/v1/health</code>에 요청합니다.</p>
            </div>
            <span id="health-pill" class="pill pending">확인 중</span>
          </div>
        </article>

        <article class="card full">
          <h2>Memory Inbox · 실제 저장된 제안</h2>
          <p class="caption">자동 캡처와 수동 제안으로 저장된 <code>proposed</code> 항목을 중요도 순서로 요약해 보여 줍니다. 서버 환경 변수의 읽기 전용 토큰으로 조회하며 토큰은 브라우저에 전달되지 않습니다.</p>
          <form id="inbox-form" class="inbox-form">
            <label class="field" for="inbox-limit">표시 개수
              <select id="inbox-limit"><option value="10">10개</option><option value="20">20개</option><option value="50">50개</option></select>
            </label>
            <button type="submit">Inbox 불러오기</button>
          </form>
          <p id="inbox-status" class="inbox-status" aria-live="polite">현재 Memory Inbox를 불러올 준비가 되었습니다.</p>
          <div class="table-wrap">
            <table aria-label="Memory Inbox 요약">
              <thead><tr><th>ID</th><th>종류</th><th>요약</th><th>중요도</th><th>범위</th><th>저장 시각</th></tr></thead>
              <tbody id="inbox-rows"><tr><td colspan="6">아직 불러온 데이터가 없습니다.</td></tr></tbody>
            </table>
          </div>
          <div class="pagination" aria-label="Memory Inbox 페이지">
            <button id="inbox-previous" type="button" disabled>이전</button>
            <span id="inbox-page" class="page-position">— / —</span>
            <button id="inbox-next" type="button" disabled>다음</button>
          </div>
        </article>

        <article class="card wide">
          <h2>자동 중요도 캡처 미리보기</h2>
          <p class="caption">공식 점수식: 재사용성 + 영향도 + 적용 범위 + 근거 − 노이즈. 4점 이상만 <code>proposed</code> Inbox 후보가 됩니다.</p>
          <div class="controls" style="margin-top:18px">
            <label>재사용성 <output for="reusability" id="reusability-output">3</output><input id="reusability" type="range" min="0" max="3" value="3" /></label>
            <label>영향도 <output for="impact" id="impact-output">3</output><input id="impact" type="range" min="0" max="3" value="3" /></label>
            <label>적용 범위 <output for="scope" id="scope-output">2</output><input id="scope" type="range" min="0" max="2" value="2" /></label>
            <label>근거 <output for="evidence" id="evidence-output">2</output><input id="evidence" type="range" min="0" max="2" value="2" /></label>
            <label>노이즈 감점 <output for="noise" id="noise-output">0</output><input id="noise" type="range" min="0" max="3" value="0" /></label>
          </div>
          <div id="capture-result" class="result" aria-live="polite">
            <div id="capture-score" class="score">10</div>
            <div><strong id="capture-title">저장 대상 · proposed Inbox</strong><p id="capture-detail">자동 캡처는 confirmed 또는 verified로 승격하지 않습니다.</p></div>
          </div>
        </article>

        <article class="card">
          <h2>체크포인트 훅</h2>
          <p class="caption">작업 완료·수정·검증처럼 중요한 문구에서 한 번만 메모리 점검을 요청합니다.</p>
          <textarea id="checkpoint-text" aria-label="최종 메시지 예시">Implemented and validated the memory capture endpoint.</textarea>
          <button id="checkpoint-button" type="button">점검 필요 여부 확인</button>
          <p id="checkpoint-result" class="small" aria-live="polite">위 예시는 점검을 요청합니다.</p>
        </article>

        <article class="card full">
          <h2>기능별 자동 검증 근거</h2>
          <div class="table-wrap">
            <table>
              <thead><tr><th>흐름</th><th>확인한 동작</th><th>근거</th></tr></thead>
              <tbody>
                <tr><td>중요도 필터</td><td>낮은 가치의 일회성 실패는 DB 쓰기 없이 폐기</td><td><code>memory-capture.test.ts</code> · <code>app.test.ts</code></td></tr>
                <tr><td>저장 상태</td><td>통과 후보는 항상 <code>proposed</code>; 자동 확정·검증 금지</td><td><code>memory-capture.test.ts</code></td></tr>
                <tr><td>중복 방지</td><td>관찰 시각이 달라도 같은 내용·범위는 같은 키</td><td><code>memory-capture.test.ts</code></td></tr>
                <tr><td>체크포인트</td><td>완료 시 한 번 요청하고 재귀 호출은 차단</td><td><code>checkpoint-hook.test.ts</code></td></tr>
                <tr><td>GitHub 동기화</td><td>Issue·댓글을 증분 반영하고 체크포인트를 전진</td><td><code>github-sync.test.ts</code></td></tr>
                <tr><td>MCP 경로</td><td>10개 도구 노출, 자동 캡처 도구가 API 후보를 전달</td><td><code>mcp-server.test.ts</code></td></tr>
                <tr><td>민감 정보 차단</td><td>중첩된 토큰도 DB 트랜잭션 전에 거부</td><td><code>sensitive.test.ts</code> · <code>app.test.ts</code></td></tr>
                <tr><td>스키마·보안</td><td>17개 테이블 RLS와 10개 DB 함수를 정적 계약으로 검사</td><td><code>validate:schema</code></td></tr>
              </tbody>
            </table>
          </div>
        </article>

        <article class="card full">
          <h2>다시 검증하기</h2>
          <pre class="terminal">npm run verify
# 실제 DB/RLS까지: TEST_DATABASE_URL=postgresql://... npm run verify</pre>
          <p class="small">이 화면의 테스트 요약은 이 변경을 검증한 최근 로컬 실행 결과입니다. 이후 코드를 바꿨다면 위 명령으로 새 결과를 확인하세요.</p>
        </article>
      </section>
    </main>
    <script>
      const value = (id) => Number(document.getElementById(id).value);
      const inputs = ["reusability", "impact", "scope", "evidence", "noise"];
      const renderCapture = () => {
        for (const id of inputs) document.getElementById(id + "-output").textContent = value(id);
        const score = Math.max(0, Math.min(10, value("reusability") + value("impact") + value("scope") + value("evidence") - value("noise")));
        const stored = score >= 4;
        document.getElementById("capture-score").textContent = score;
        document.getElementById("capture-title").textContent = stored ? "저장 대상 · proposed Inbox" : "폐기 · DB에 저장하지 않음";
        document.getElementById("capture-detail").textContent = stored
          ? "중요도는 높아도 자동으로 confirmed 또는 verified가 되지 않습니다."
          : "4점 미만 후보는 메모리나 보관함을 만들지 않습니다.";
        document.getElementById("capture-result").style.background = stored ? "var(--accent-soft)" : "var(--bad-soft)";
      };
      inputs.forEach((id) => document.getElementById(id).addEventListener("input", renderCapture));

      const checkpointSignals = /\\b(completed|implemented|fixed|resolved|decision|selected|deployed|validated|migration|committed|pushed|error|failure)\\b/i;
      document.getElementById("checkpoint-button").addEventListener("click", () => {
        const message = document.getElementById("checkpoint-text").value.trim();
        const requested = checkpointSignals.test(message);
        const output = document.getElementById("checkpoint-result");
        output.textContent = requested
          ? "점검 요청: 중요한 작업 신호가 있어 메모리 후보를 한 번 검토합니다."
          : "점검 생략: 현재 예시에는 완료·결정·해결 신호가 없습니다.";
        output.style.color = requested ? "var(--good)" : "var(--muted)";
      });

      const setHealth = (state, title, detail) => {
        const pill = document.getElementById("health-pill");
        pill.className = "pill " + state;
        pill.textContent = state === "pass" ? "정상" : "확인 실패";
        document.getElementById("health-title").textContent = title;
        document.getElementById("health-detail").textContent = detail;
      };
      fetch("/v1/health", { headers: { accept: "application/json" } })
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok || payload?.data?.status !== "ok") throw new Error("unexpected health response");
          setHealth("pass", "API가 응답합니다", "인증 없이 제공되는 health endpoint가 정상 상태를 반환했습니다.");
        })
        .catch(() => setHealth("fail", "API 상태를 확인할 수 없습니다", "서버 로그와 환경 설정을 확인한 뒤 페이지를 새로고침하세요."));

      const inboxState = { limit: 10, page: 0, cursors: [null], nextCursor: null, total: 0 };
      const inboxRows = document.getElementById("inbox-rows");
      const inboxStatus = document.getElementById("inbox-status");
      const inboxLimit = document.getElementById("inbox-limit");
      const inboxPrevious = document.getElementById("inbox-previous");
      const inboxNext = document.getElementById("inbox-next");
      const inboxPage = document.getElementById("inbox-page");

      const setInboxStatus = (message, error = false) => {
        inboxStatus.textContent = message;
        inboxStatus.className = "inbox-status" + (error ? " error" : "");
      };
      const preview = (value, max = 100) => value.length > max ? value.slice(0, max - 1) + "…" : value;
      const formatDate = (value) => {
        const date = new Date(value);
        return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
      };
      const addCell = (row, value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      };
      const resetInboxPage = () => {
        inboxState.page = 0;
        inboxState.cursors = [null];
        inboxState.nextCursor = null;
        inboxState.total = 0;
      };
      const renderInbox = (items) => {
        inboxRows.replaceChildren();
        if (items.length === 0) {
          const row = document.createElement("tr");
          const cell = document.createElement("td");
          cell.colSpan = 6;
          cell.textContent = "표시할 proposed 항목이 없습니다.";
          row.append(cell);
          inboxRows.append(row);
        }
        for (const item of items) {
          const row = document.createElement("tr");
          addCell(row, item.id);
          addCell(row, item.kind);
          addCell(row, preview(item.statement));
          addCell(row, item.importance?.score === undefined ? "—" : String(item.importance.score));
          addCell(row, preview(item.scope.type + ": " + item.scope.id, 42));
          addCell(row, formatDate(item.created_at));
          inboxRows.append(row);
        }
        const pageCount = Math.max(1, Math.ceil(inboxState.total / inboxState.limit));
        inboxPage.textContent = String(inboxState.page + 1) + " / " + String(pageCount);
        inboxPrevious.disabled = inboxState.page === 0;
        inboxNext.disabled = !inboxState.nextCursor;
      };
      const loadInbox = async () => {
        setInboxStatus("Memory Inbox를 불러오는 중…");
        inboxPrevious.disabled = true;
        inboxNext.disabled = true;
        const query = new URLSearchParams({ limit: String(inboxState.limit) });
        const cursor = inboxState.cursors[inboxState.page];
        if (cursor) query.set("cursor", cursor);
        try {
          const response = await fetch("/verification/memories/inbox?" + query.toString(), { headers: { accept: "application/json" } });
          const payload = await response.json().catch(() => null);
          if (!response.ok || !payload?.data) {
            throw new Error(payload?.error?.code || "REQUEST_FAILED");
          }
          const data = payload.data;
          inboxState.nextCursor = data.next_cursor || null;
          inboxState.total = Number(data.total_count || 0);
          renderInbox(Array.isArray(data.items) ? data.items : []);
          setInboxStatus("총 " + String(inboxState.total) + "개 proposed 항목을 중요도 순으로 표시합니다.");
        } catch (error) {
          inboxState.nextCursor = null;
          inboxPrevious.disabled = inboxState.page === 0;
          inboxNext.disabled = true;
          const code = error instanceof Error ? error.message : "REQUEST_FAILED";
          setInboxStatus(
            code === "DASHBOARD_TOKEN_NOT_CONFIGURED"
              ? "서버의 SECOND_BRAIN_MCP_ACCESS_TOKEN 환경 변수를 설정한 뒤 서버를 다시 시작하세요."
              : "Inbox를 불러오지 못했습니다 (" + code + ").",
            true,
          );
        }
      };
      document.getElementById("inbox-form").addEventListener("submit", (event) => {
        event.preventDefault();
        resetInboxPage();
        void loadInbox();
      });
      inboxLimit.addEventListener("change", () => {
        inboxState.limit = Number(inboxLimit.value);
        resetInboxPage();
        void loadInbox();
      });
      inboxPrevious.addEventListener("click", () => {
        if (inboxState.page === 0) return;
        inboxState.page -= 1;
        void loadInbox();
      });
      inboxNext.addEventListener("click", () => {
        if (!inboxState.nextCursor) return;
        inboxState.page += 1;
        inboxState.cursors[inboxState.page] = inboxState.nextCursor;
        void loadInbox();
      });
      renderCapture();
    </script>
  </body>
</html>`;
