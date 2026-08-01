# Second Brain

GitHub 이슈와 에이전트 작업에서 재사용할 가치가 있는 결정·실패·검증 결과를 안전하게 축적하고,
다음 작업에 필요한 맥락만 MCP로 제공하는 개인 지식 시스템입니다.

> 원본 대화, 비밀값, 전체 로그를 자동 저장하지 않습니다. 저장 후보는 중요도와 근거를 검토한 뒤에만
> Memory Inbox에 제안(`proposed`)으로 기록됩니다.

## 주요 기능

- GitHub Issue와 댓글의 증분 동기화 및 정합성 검사
- 작업별 Context Pack 조회와 메모리 검색
- 결정·실패·에이전트 실행 결과의 근거 기반 기록
- 중요도 기반 자동 메모리 캡처: 점수 4 미만은 DB에 쓰지 않고 폐기
- 제안된 메모리를 검토하는 Memory Inbox와 로컬 검증 대시보드
- Codex·Claude Code 등 로컬 MCP 호스트용 stdio MCP 서버
- PostgreSQL Row-Level Security(RLS), JWT 권한, 멱등성 키 기반의 쓰기 보호

## 빠른 시작

요구 사항: Node.js 22 이상, PostgreSQL 또는 Supabase 프로젝트.

```powershell
npm install
Copy-Item .env.example .env
```

`.env`에 데이터베이스와 JWT 검증 값을 채운 뒤 API를 실행합니다.

```powershell
npm run dev
```

기본 주소는 `http://127.0.0.1:3000`입니다. 로컬 검증 대시보드는
`http://127.0.0.1:3000/verification`에서 열 수 있습니다.

## 검증

```powershell
npm run check            # TypeScript 타입 검사
npm run test             # 단위·계약 테스트
npm run validate:schema  # SQL 마이그레이션과 스키마 문서 정합성 검사
npm run verify           # 위 검증 전체 실행
```

`TEST_DATABASE_URL`을 설정하면 PostgreSQL 통합 테스트도 실행됩니다. 값이 없으면 해당 통합 테스트만
건너뜁니다.

## 구조

NestJS의 모듈 경계를 따르되 Fastify의 가벼운 함수형 등록 방식을 사용합니다. `app.ts`는 조립 지점이며,
각 기능 모듈이 자신의 컨트롤러와 서비스를 등록합니다.

```text
src/
  app.ts                         # Fastify 조립 지점
  index.ts                       # 프로세스 시작점
  common/                        # 인증, DB, 오류, 보안, 멱등성 등 공통 관심사
  modules/
    github-sync/                 # GitHub 동기화
    memories/                    # 메모리 조회·기록·캡처
    agent-runs/                  # 에이전트 작업 결과
    verification/                # 검증 대시보드와 Inbox 프록시
    mcp/                         # 로컬 MCP 서버와 API 클라이언트
    checkpoint/                  # Codex 작업 체크포인트 Hook
  integration/                   # 외부 DB 통합 테스트
```

내부 TypeScript import는 Node.js 표준 package imports를 사용해 `#app/...` 절대 경로로 통일합니다.

## 메모리 생명주기

| 상태 | 의미 | 다음 작업의 Context Pack 포함 |
| --- | --- | --- |
| `proposed` | 자동 캡처 또는 에이전트가 제안한 항목 | 아니요. Inbox에서만 검토 |
| `confirmed` | 사용자가 명시적으로 확정한 내용 | 예 |
| `verified` | 테스트 또는 실제 실행으로 검증된 내용 | 예 |

자동 중요도 캡처는 결정·실패 후보를 평가합니다. 점수 4 이상인 항목만 `proposed`로 저장하며,
중요도 점수만으로 `confirmed`나 `verified`로 승격하지 않습니다.

## MCP 사용

MCP 서버는 로컬 stdio 전송을 사용하며, 데이터베이스에 직접 연결하지 않습니다. 모든 도구 호출은
Second Brain HTTP API로 전달되고, 최소 권한 JWT로 인증됩니다.

```powershell
$env:SECOND_BRAIN_API_URL = "http://127.0.0.1:3000"
$env:SECOND_BRAIN_MCP_ACCESS_TOKEN = "<short-lived-mcp-jwt>"
npm run mcp
```

## 대시보드 토큰 자동 갱신

`/verification`의 Memory Inbox는 브라우저를 열 때 최근 10개를 즉시 불러옵니다. API 서버의 `.env`에 아래
서버 전용 값을 설정하면 대시보드가 `mcp_agent` 계정으로 짧은 Supabase access token을 자동 발급하고, 만료
60초 전까지 메모리에서 재사용합니다. 비밀번호와 access token은 브라우저나 MCP 클라이언트로 전달되지 않습니다.

```dotenv
SUPABASE_PUBLISHABLE_KEY=<publishable-key>
SECOND_BRAIN_DASHBOARD_MCP_AGENT_EMAIL=<mcp-agent-email>
SECOND_BRAIN_DASHBOARD_MCP_AGENT_PASSWORD=<mcp-agent-password>
```

이 계정에는 대시보드에 필요한 최소 권한(`memory:read`)만 부여하세요. 설정 후 API 서버를 다시 시작하면 됩니다.
기존 `SECOND_BRAIN_MCP_ACCESS_TOKEN`은 자동 로그인을 설정할 수 없는 경우의 대체 수단으로만 유지됩니다.

MCP 호스트 설정에는 API 서버의 `.env` 전체를 복사하지 마세요. `SECOND_BRAIN_API_URL`과 최소 권한의
`SECOND_BRAIN_MCP_ACCESS_TOKEN`만 별도의 사용자 환경에 설정해야 합니다. 현재 MCP 서버는 10개 도구를
제공하며, 조회·결정·실패·작업 완료·메모리 확정·대체·삭제와 자동 캡처를 지원합니다.

자세한 설정은 [로컬 MCP 서버 설정](docs/mcp-server.md)을 참고하세요.

## 보안 원칙

- 토큰, 비밀번호, `.env` 값, 원본 전체 로그는 메모리 후보에서 거부합니다.
- 쓰기 요청은 `X-Idempotency-Key`를 요구합니다.
- JWT의 `principal_type`, 권한, 접근 가능한 GitHub 저장소 범위를 검증합니다.
- PostgreSQL 요청은 RLS 컨텍스트에서 실행되어 테넌트 경계를 강제합니다.
- 메모리 삭제는 먼저 영향 범위를 미리 본 뒤, 짧은 수명의 preview token으로 실행합니다.

## 주요 API

- `GET /v1/health`
- GitHub checkpoint 조회 및 동기화 실행·heartbeat·item 처리·완료·reconcile
- Context Pack 조회, 메모리 검색·Inbox·상세 조회
- 결정·실패·자동 캡처 메모리 기록
- 에이전트 작업 완료 기록, 메모리 확정·대체·삭제

모든 공개 경로는 계약 테스트로 고정되어 있습니다. 상세 요청·응답 형식은 아래 문서를 참고하세요.

## 문서

- [아키텍처](docs/architecture.md)
- [메모리 모델](docs/memory-model.md)
- [자동 메모리 캡처](docs/automatic-memory-capture.md)
- [Context 및 MCP 계약](docs/context-contract.md)
- [수집 API 계약](docs/ingest-api-contract.md)
- [통합 계약](docs/integration-contracts.md)
- [데이터베이스 스키마](docs/db-schema.md)
- [운영 환경 설정](docs/operations.md)
- [배포 가이드](docs/deployment.md)
- [테스트 전략](docs/test-strategy.md)
