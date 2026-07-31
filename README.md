# Second Brain

GitHub에 기록한 학습 내용과 AI와 함께 작업하며 생긴 결정, 선호, 실패 및 해결 경험을 모아 다음 작업에 다시 사용하는 개인 지식 시스템입니다.

현재 Node.js·TypeScript 기반의 데이터 스키마, 수집·기억 API, 로컬 MCP 서버와 GitHub Issue 동기화 workflow까지 구현되어 있습니다. 실제 Supabase 프로젝트와 JWT 발급은 별도 환경 설정이 필요한 다음 단계입니다.

## 핵심 방향

- GitHub Issues는 학습 기록의 원본으로 유지합니다.
- PostgreSQL은 통합 검색과 AI 기억을 위한 저장소로 사용합니다.
- GitHub Actions가 Issue 변경 내용을 6시간마다 동기화하고 주 1회 정합성을 점검합니다.
- Codex와 Claude Code는 같은 로컬 MCP 서버를 통해 기억을 읽고 기록합니다.
- AI가 추측한 내용과 사용자가 확정한 내용을 구분합니다.
- 첫 번째 버전은 유료 인프라와 별도 AI API 호출 없이 운영합니다.

## 기본 흐름

```text
GitHub Issues ── GitHub Actions ──┐
                                  ├─ 수집 API ── 원본 저장소 ── 기억 저장소
Codex·Claude ── 로컬 MCP 서버 ────┘                         │
       ▲                                                    │
       └──────────── 작업별 Context Pack ───────────────────┘
```

## 설계 문서

- [전체 아키텍처](docs/architecture.md)
- [기억 모델](docs/memory-model.md)
- [Context 및 MCP 계약](docs/context-contract.md)
- [기억 운영 정책](docs/memory-policy.md)
- [무료 MVP 로드맵](docs/mvp-roadmap.md)
- [데이터베이스 스키마](docs/db-schema.md)
- [수집 API 및 인증 계약](docs/ingest-api-contract.md)
- [GitHub 동기화 및 MCP 통합 계약](docs/integration-contracts.md)
- [로컬 MCP 서버 설정](docs/mcp-server.md)
- [운영 환경 설정](docs/operations.md)
- [테스트 전략](docs/test-strategy.md)

## 실행 가능한 API 범위

현재 구현된 `/v1` endpoint는 다음과 같습니다.

- `GET /v1/health`
- GitHub checkpoint 조회, sync 시작·heartbeat·item 수집·완료
- Context Pack 조회, memory 검색·상세 조회
- decision·failure memory 생성
- agent run 완료 기록, memory 확인·대체
- memory forget 영향 범위 미리 보기 및 실행

모든 쓰기 요청은 `X-Idempotency-Key`를 요구하고, 서버는 Supabase JWT의 `principal_type`, `permissions`, `repository_ids` claim을 검사합니다. PostgreSQL 요청은 `authenticated` 역할과 `auth.uid()` 컨텍스트로 실행되어 RLS가 tenant 경계를 강제합니다.

로컬 MCP 서버는 표준 입출력으로 9개 도구(`brain_get_context`, 검색·상세 조회, decision·failure·run 저장, confirm·supersede·forget)를 제공합니다. MCP는 DB에 직접 연결하지 않고 HTTP API만 호출합니다.

## 로컬 실행과 검증

Node.js 22 이상에서 의존성을 설치하고 `.env.example`을 API 서버 전용 환경 파일로 복사한 뒤 Supabase 및 PostgreSQL 값을 채웁니다. API는 현재 `127.0.0.1`에만 바인딩됩니다.

```powershell
npm install
npm run dev
```

기본 검사 명령은 다음과 같습니다.

```powershell
npm run check
npm run test
npm run validate:schema
```

`TEST_DATABASE_URL`을 설정하면 `npm run test`가 실제 PostgreSQL 통합 테스트까지 실행합니다. 값이 없으면 해당 테스트만 건너뜁니다.

MCP 호스트에는 API 서버의 `.env`를 복사하지 말고, 별도의 사용자 전용 환경에서 `SECOND_BRAIN_API_URL`과 최소 권한 `SECOND_BRAIN_MCP_ACCESS_TOKEN`만 설정합니다. 구체적인 변수, JWT claim 및 호스트 설정은 [운영 환경 설정](docs/operations.md)과 [로컬 MCP 서버 설정](docs/mcp-server.md)을 따릅니다.

## 현재 확정하지 않은 것

- 실제 Supabase 프로젝트와 JWT claim 발급 방식
- GitHub Actions용 `github_sync` JWT credential 발급 방식
- MCP가 다른 장비의 API에 연결할 때의 HTTPS·네트워크 경로
- 임베딩 모델
- 관리 화면
- 자율 실행 정책의 세부 권한

이 항목들은 MVP 구현을 시작할 때 필요한 범위만 선택합니다.
