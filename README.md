# Second Brain

## Automatic importance capture (current)

At an agent task checkpoint, `brain_capture_auto_memory` scores decision and failure candidates.
Scores below 4 are discarded without a database write; scores 4 or above are saved as `proposed`
Inbox items. Importance never changes a memory to `confirmed` or `verified` automatically. See
[automatic memory capture](docs/automatic-memory-capture.md) for the current Korean operating guide.
This current-state section supersedes the older lifecycle note immediately below.

## 저장 구조: 자동 수집과 MCP 기록은 다릅니다

### 핵심 답변

이 프로젝트는 **대화 전체를 자동 저장하지 않습니다.** 현재 자동 저장되는 것은 GitHub Actions가 `study-repository`에서 동기화하는 Issue와 댓글뿐입니다. Codex와 나눈 대화, 브라우저에서 고른 값, 작업 중 만난 오류는 지금 자동으로 Second Brain에 들어가지 않습니다.

MCP를 연결한 뒤에도 모든 대화가 자동 저장되지는 않습니다. MCP 도구가 호출될 때만, 재사용 가치가 있는 내용을 구조화해서 저장합니다. 비밀번호, 토큰, `.env` 내용, 원본 로그 전체는 저장하지 않습니다.

| 대상 | 자동 저장 | 처리 방식 |
| --- | --- | --- |
| `study-repository` Issue·댓글 | 예 | GitHub Actions 정기 동기화 |
| 일반 대화와 임시 선택 | 아니요 | 저장하지 않음 |
| 재발 방지에 유용한 오류 | 아니요 | `brain_save_failure`를 명시적으로 호출 |
| 사용자가 확정한 기술 선택 | 아니요 | `brain_save_decision`을 명시적으로 호출 |
| 완료 작업의 요약과 검증 | 아니요 | `brain_finish_run`을 명시적으로 호출 |

### Hook은 어디에 쓰는가?

Supabase의 **Custom Access Token Hook**은 저장 Hook이 아닙니다. 이 Hook은 MCP와 GitHub Actions가 로그인할 때 `principal_type`, 권한, 접근 가능한 저장소 범위를 JWT에 넣는 **인증·권한 관리** 역할만 합니다.

결정·오류·작업 결과를 남기는 것은 MCP의 **작업 생명주기 Hook**으로 관리하는 편이 맞습니다. 즉, MCP 호스트 또는 에이전트가 아래 시점에 필요한 도구를 호출하는 방식입니다.

```text
작업 시작
  └─ brain_get_context: 이전에 확정·검증된 관련 기억만 조회

작업 중
  ├─ 사용자가 명확하게 결정함 → brain_save_decision
  ├─ 재발 방지에 유용한 오류와 해결책이 확인됨 → brain_save_failure
  └─ 단순 대화·임시 추측·비밀값 → 저장하지 않음

작업 종료
  └─ brain_finish_run: 변경 사항과 검증 결과, 기억 피드백 기록
```

이 작업 생명주기 Hook은 아직 연결하지 않았습니다. 다음 MCP 원격 연결 검증을 마친 뒤, “작업 시작 시 context 조회”와 “작업 종료 시 run 기록”부터 적용합니다. 오류와 결정은 무조건 자동 저장하지 않고, 사용자가 확정했거나 재발 방지에 도움이 되는지 확인한 경우에만 저장합니다.

### 기억의 상태

| 상태 | 의미 | 다음 작업의 기본 Context Pack 포함 |
| --- | --- | --- |
| `proposed` | AI의 추측 또는 검토가 필요한 제안 | 아니요. Memory Inbox에서만 조회 |
| `confirmed` | 사용자가 명시적으로 확정한 결정 | 예 |
| `verified` | 테스트 또는 실제 실행으로 확인된 결과 | 예 |

예를 들어 “Railway를 무료 운영 호스팅으로 사용한다”는 사용자가 확정하면 `confirmed` 결정으로 남길 수 있습니다. 반대로 단순한 제안은 `proposed`로 두거나 저장하지 않습니다. 오류도 원인·해결·검증 방법을 설명할 수 있을 때만 요약해 저장하며, 서버가 기억을 임의로 확정하지 않습니다.

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

Node.js 22 이상에서 의존성을 설치하고 `.env.example`을 API 서버 전용 환경 파일로 복사한 뒤 Supabase 및 PostgreSQL 값을 채웁니다. API는 기본적으로 `127.0.0.1`에만 바인딩됩니다. 컨테이너 배포는 `HOST=0.0.0.0`을 설정하고 관리형 HTTPS ingress 뒤에 둡니다. 실제 연결 절차는 [배포 가이드](docs/deployment.md)를 따릅니다.

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
