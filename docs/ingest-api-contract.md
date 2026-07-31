# 수집 API 및 인증 경계 계약

## 문서 상태와 범위

이 문서는 Second Brain MVP의 HTTP API 경계를 정의합니다. 이름은 수집 API이지만, 로컬 MCP 서버가 DB에 직접 접근하지 않는다는 아키텍처 원칙에 따라 MCP가 사용하는 읽기와 쓰기 요청도 같은 API 경계를 통과합니다.

이 문서가 고정하는 것은 다음과 같습니다.

- HTTP endpoint와 JSON wire format
- 인증 주체와 endpoint별 최소 권한
- 요청 멱등성, 오류, 민감정보 검사 규칙
- endpoint별 트랜잭션 경계
- DB 스키마가 제공해야 할 데이터와 제약조건

이 문서는 구현 언어와 프레임워크를 고정하지 않습니다. 다만 모든 객체는 JSON Schema 또는 TypeScript의 discriminated union으로 손실 없이 표현할 수 있게 설계합니다.

MCP 도구의 사용자-facing 이름과 Context Pack 의미는 [Context 및 MCP 계약](./context-contract.md)을 따릅니다. 기억의 종류, 상태, 범위와 확정 정책은 [기억 모델](./memory-model.md)과 [기억 운영 정책](./memory-policy.md)을 따릅니다.

## 구현 전제

### 공통 원칙

- API base path는 `/v1`입니다.
- 전송 형식은 UTF-8 JSON이며 `Content-Type: application/json`을 사용합니다.
- 필드명은 `snake_case`입니다.
- 시각은 UTC RFC 3339 문자열로 주고받습니다.
- `request_id`는 UUID 문자열입니다. 업무 resource ID는 클라이언트가 해석하지 않는 opaque 문자열이며 DB가 `bigint`를 사용하면 10진 문자열로 직렬화합니다.
- GitHub의 database ID는 JavaScript 안전 정수 범위를 가정하지 않고 10진수 문자열로 전달합니다.
- GitHub Issue number, 배열 길이, revision처럼 범위가 제한된 값만 JSON 정수를 사용합니다.
- `null`은 계약에서 명시적으로 허용한 필드에만 사용합니다. 필드 누락과 `null`은 같은 뜻이 아닙니다.
- 저장 시각, 내용 해시, 감사 시각, 최종 인증 주체는 서버가 결정합니다. 클라이언트가 보낸 값을 신뢰하지 않습니다.
- 성공 응답에는 항상 `request_id`가 포함됩니다.
- API는 DB 테이블 이름, SQL 오류, 내부 credential 정보를 응답에 노출하지 않습니다.

### 요청 크기와 기본 제한

- 단일 JSON 요청 본문은 최대 4 MiB입니다.
- GitHub 수집 batch는 Issue, 댓글, tombstone을 합쳐 최대 100개 item입니다.
- 기억의 `statement`는 최대 2,000자, `rationale`은 최대 10,000자, `source_excerpt`는 최대 2,000자입니다.
- 태그는 기억당 최대 30개이며 태그 하나는 최대 100자입니다.
- 검색 `limit`은 기본 20, 최대 100입니다.
- 제한 초과는 일부를 잘라 저장하지 않고 요청 전체를 거부합니다.

정확한 수치는 운영 측정 후 하향 조정할 수 있지만, 기존 클라이언트를 깨뜨리는 상향 필수 조건으로 바꾸면 안 됩니다.

### 공통 요청 header

```http
Authorization: Bearer <credential>
Content-Type: application/json
Accept: application/json
X-Idempotency-Key: <required-for-state-changing-request>
X-Agent-Session-Id: <optional-observability-value>
```

- `Authorization`은 `/v1/health`를 제외한 모든 endpoint에 필수입니다.
- `X-Idempotency-Key`는 상태를 바꾸는 모든 `POST`에 필수입니다.
- `X-Agent-Session-Id`는 감사용 보조 정보이며 인증이나 권한 판단에 사용하지 않습니다.
- 클라이언트가 `principal_id`, role, permission을 header나 body에 넣어도 권한 판단에 사용하지 않습니다.

### 공통 성공 envelope

```json
{
  "request_id": "9a94573b-acde-4df1-8f46-c142f5bbd974",
  "data": {}
}
```

목록 응답은 `data.items`를 사용합니다. 페이지가 있는 경우 `data.next_cursor`를 추가하고 마지막 페이지는 `null`을 반환합니다.

## 인증과 권한 경계

### 인증 주체

API는 credential 형식이 JWT인지 opaque token인지와 무관하게 인증 완료 후 다음 내부 주체로 정규화해야 합니다.

```json
{
  "principal_id": "2a7e0df1-f5eb-4c94-bb44-84b7f918ac3a",
  "principal_type": "github_sync",
  "user_id": "8b79ee3a-62c1-4f97-93ee-02f3781d2af4",
  "permissions": [
    "github_source:write",
    "github_sync:checkpoint"
  ],
  "repository_ids": [
    "R_kgDOExample"
  ],
  "expires_at": "2026-08-01T00:00:00Z",
  "credential_id": "a450cc7a-094f-4ad1-b880-ef85371ebd17"
}
```

MVP에서 `user_id`는 `auth.users.id`이며 tenant 소유권의 기준입니다. `principal_id`, `credential_id`, permission과 repository 범위는 검증된 token claim과 API 실행 context의 논리 값입니다. 이를 위해 초기 DB에 별도 principal 또는 credential 테이블을 만들 필요는 없습니다.

`repository_ids`의 값은 Second Brain 내부 repository ID가 아니라 인증 시점에 허용된 안정적 GitHub node ID 목록입니다. API는 이를 내부 repository row와 매핑합니다.

MVP의 인증 주체는 다음 세 종류입니다.

| `principal_type` | 사용 위치 | 허용 목적 | 금지 사항 |
|---|---|---|---|
| `github_sync` | GitHub Actions | 허용된 저장소의 Issue·댓글 수집, sync checkpoint 관리 | 기억 읽기·생성·확정, 실행 기록, 다른 저장소 접근 |
| `mcp_agent` | 사용자의 로컬 MCP 프로세스 | Context 조회, 기억 검색, 제안 기억과 실행 기록 작성 | DB 직접 접근, GitHub checkpoint 변경, 근거 없는 확정·삭제 |
| `operator` | 사용자 승인 운영 절차 | credential 회수, 민감정보 삭제, 복구와 진단 | 일반 에이전트에 credential 위임 |

API 내부 런타임 주체는 외부 caller가 아닙니다. DB 연결에 높은 권한이 필요하더라도 그 credential은 API 서버 비밀 저장소에만 두며 저장소, GitHub Issue, `AGENTS.md`, `CLAUDE.md`, MCP 입력이나 클라이언트 환경 변수에 전달하지 않습니다.

### permission 목록

```text
github_source:write
github_sync:checkpoint
github_quarantine:retry
context:read
memory:read
memory:propose
memory:confirm
memory:supersede
memory:forget
memory:forget_sensitive
agent_run:write
operations:credential_revoke
```

권한은 허용 범위의 합이 아니라 교집합으로 평가합니다.

```text
허용 = endpoint permission
    AND principal user_id 소유권
    AND repository_ids 범위
    AND resource scope
    AND 상태 전이 정책
```

예를 들어 `memory:confirm`이 있어도 다른 사용자의 기억이나 허용되지 않은 repository 범위의 기억을 확정할 수 없습니다.

### 사용자 확정과 삭제 권한

- `mcp_agent`의 일반 쓰기 credential은 `memory:propose`와 `agent_run:write`만 갖는 것을 기본값으로 합니다.
- 사용자가 명시적으로 확정한 요청을 처리하는 MCP 세션에는 `memory:confirm` 또는 `memory:supersede` capability를 짧은 유효기간으로 부여할 수 있습니다.
- capability 구현 방식은 확정하지 않지만, API 요청에는 아래의 `confirmation` 근거가 반드시 있어야 합니다.
- API는 자연어가 정말 사용자 확정인지 완벽하게 판별할 수 없으므로 MCP 도구 선택, 짧은 capability, 감사 로그를 함께 사용합니다.
- 민감정보 탐지 후 자동 정리는 `memory:forget_sensitive`로 분리합니다. 이 권한은 임의 삭제에 사용할 수 없고 `reason_code: "sensitive_data"`인 경우에만 허용합니다.

```json
{
  "confirmation": {
    "origin": "explicit_user",
    "source": {
      "type": "user_message",
      "id": "codex-session-123:message-45"
    },
    "confirmed_at": "2026-07-31T12:30:00Z"
  }
}
```

사용자 메시지 전문은 저장하지 않습니다. `source_id`, 시각, 민감정보 검사를 통과한 짧은 excerpt만 근거로 보존할 수 있습니다.

`confirmation.origin`은 `explicit_user`, `agent_inference`, `verified_execution`, `policy_enforcement` 중 하나입니다. `policy_enforcement`는 민감정보 삭제에만, `verified_execution`은 통과한 test 또는 agent run 근거가 있을 때만 허용합니다.

### credential 보관과 수명

- GitHub Actions credential은 저장소별 또는 저장소 집합별 최소 범위로 발급합니다. 한 token이 모든 저장소에 접근하지 않게 합니다.
- 가능하면 실행 단위의 단기 credential을 사용하고, 장기 token을 쓰는 MVP에서는 GitHub encrypted secret에만 보관합니다.
- 로컬 MCP credential은 OS 보안 저장소 또는 사용자 전용 설정에 보관하고 프로젝트 파일에 쓰지 않습니다.
- DB 관리자 또는 Supabase `service_role` key를 GitHub Actions와 MCP에 주지 않습니다.
- credential 원문은 DB에 저장하지 않습니다. MVP는 Supabase Auth의 `auth.users`와 검증된 token claim을 사용합니다. 향후 장기 opaque token의 자체 발급·회수·사용 추적이 필요해질 때만 digest, 식별용 prefix, 만료와 회수 시각을 가진 credential 테이블을 후속 migration으로 추가합니다.
- credential 회수는 즉시 효력이 있어야 하며 감사 로그를 남깁니다.
- 인증 실패 응답은 token 존재 여부, 만료 여부, principal 존재 여부를 구분해 외부에 알려주지 않습니다.

### DB 접근 경계

- 외부 caller는 Supabase table REST endpoint를 직접 호출하지 않습니다.
- `anon` 역할은 Second Brain 업무 테이블을 읽거나 쓸 수 없습니다.
- API가 DB RPC 또는 stored procedure를 사용한다면 endpoint별 allowlist만 노출합니다.
- DB transaction에는 검증된 `principal_id`, `user_id`, repository 범위를 transaction-local context로 전달하고 DB 정책에서도 소유권과 범위를 재검사합니다.
- 높은 권한의 DB role이 RLS를 우회한다면, 해당 role은 raw SQL 조립 대신 입력이 고정된 allowlisted procedure만 호출해야 합니다.

## Endpoint 요약

| Method | Path | 목적 | 최소 permission |
|---|---|---|---|
| `GET` | `/v1/health` | process 생존 확인 | 없음 |
| `GET` | `/v1/github/repositories/{github_repository_id}/checkpoint` | 증분 조회 시작점 확인 | `github_sync:checkpoint` |
| `POST` | `/v1/github/sync-runs` | sync 실행 시작 | `github_sync:checkpoint` |
| `POST` | `/v1/github/sync-runs/{sync_run_id}/heartbeat` | 장시간 sync의 진행 상태 기록 | `github_sync:checkpoint` |
| `POST` | `/v1/github/sync-runs/{sync_run_id}/items` | Issue·댓글·tombstone batch 수집 | `github_source:write` |
| `POST` | `/v1/github/quarantine/{quarantine_id}/retry` | 수정된 영구 실패 항목 수동 재처리 | `github_quarantine:retry` |
| `POST` | `/v1/github/sync-runs/{sync_run_id}/complete` | sync 결과 확정과 checkpoint 전진 | `github_sync:checkpoint` |
| `POST` | `/v1/context/query` | 초기 Context Pack 조회 | `context:read` |
| `POST` | `/v1/memories/search` | 기억 검색 | `memory:read` |
| `GET` | `/v1/memories/{memory_id}` | 기억과 근거 상세 조회 | `memory:read` |
| `POST` | `/v1/memories/decisions` | 결정 기억 생성 | `memory:propose` 또는 `memory:confirm` |
| `POST` | `/v1/memories/failures` | 실패 기억 생성 | `memory:propose` 또는 `memory:confirm` |
| `POST` | `/v1/agent-runs/finish` | 작업 실행 결과 기록 | `agent_run:write` |
| `POST` | `/v1/memories/{memory_id}/confirm` | 제안 기억 확정 | `memory:confirm` |
| `POST` | `/v1/memories/{memory_id}/supersede` | 기존 기억의 확정 교체 또는 proposed successor 생성 | `memory:supersede` 또는 `memory:propose` |
| `POST` | `/v1/memories/{memory_id}/forget-preview` | 삭제 범위 확인과 단기 실행 token 발급 | `memory:forget` 또는 `memory:forget_sensitive` |
| `POST` | `/v1/memories/{memory_id}/forget` | 기억과 연결 데이터 삭제 | `memory:forget` 또는 `memory:forget_sensitive` |

MCP의 `brain_save_decision`, `brain_save_failure`, `brain_finish_run`, `brain_confirm_memory`, `brain_supersede_memory`는 각각 같은 의미의 API endpoint 하나에 대응합니다. `brain_forget`만 안전을 위해 preview와 execute 두 phase를 사용하며, preview를 삭제 성공으로 보고하면 안 됩니다. 그 밖에 MCP가 API 호출 여러 개를 조합해 하나의 쓰기 성공처럼 보고하면 안 됩니다.

## 운영 endpoint

### `GET /v1/health`

인증 없이 process 생존만 확인합니다. DB 이름, 배포 버전, 환경 변수와 credential 상태는 노출하지 않습니다.

응답 `200`:

```json
{
  "request_id": "e03dc985-a5fe-49a4-aeac-7d859f04dbcf",
  "data": {
    "status": "ok"
  }
}
```

DB 연결까지 확인하는 readiness endpoint가 필요하면 operator 전용 별도 endpoint로 추가합니다.

## GitHub 동기화 endpoint

### `GET /v1/github/repositories/{github_repository_id}/checkpoint`

`github_repository_id`는 GitHub node ID입니다. principal의 repository 범위에 없으면 존재 여부를 감추기 위해 `404 NOT_FOUND`를 반환합니다.

응답 `200`:

```json
{
  "request_id": "b894af6a-4424-450e-bb00-f8ea6b89b453",
  "data": {
    "github_repository_id": "R_kgDOExample",
    "last_successful_observed_through": "2026-07-31T00:00:00Z",
    "recommended_query_from": "2026-07-30T23:45:00Z",
    "overlap_seconds": 900,
    "checkpoint_version": 14
  }
}
```

첫 sync이면 세 시각 필드는 `null`일 수 있습니다. 기본 overlap은 15분이며 설정 가능 범위는 5분 이상 6시간 이하입니다. 실제 GitHub 조회 범위는 caller가 결정하지만 누락 방지를 위해 `recommended_query_from`보다 이후 시각으로 좁히면 안 됩니다.

`checkpoint_version`은 compare-and-set용 논리 revision입니다. 초기 DB에서는 `last_successful_sync_run_id` 또는 현재 cursor state에서 안정적으로 만들 수 있으므로 별도 version column을 필수로 요구하지 않습니다.

### `POST /v1/github/sync-runs`

GitHub 조회를 시작하기 전에 실행 row를 생성합니다.

요청:

```json
{
  "repository": {
    "github_id": "123456789012345678",
    "node_id": "R_kgDOExample",
    "full_name": "owner/repository",
    "html_url": "https://github.com/owner/repository",
    "visibility": "private"
  },
  "mode": "incremental",
  "query_from": "2026-07-30T23:45:00Z",
  "client_run_id": "github-actions:987654321:1"
}
```

`mode`은 `incremental`, `reconcile`, `manual` 중 하나입니다. `client_run_id`는 GitHub Actions run ID와 attempt처럼 caller 실행을 추적할 수 있는 값이며, 멱등성 키를 대신하지 않습니다.

응답 `201`:

```json
{
  "request_id": "e19552e8-6fca-48a6-a721-5d2b5cf02a69",
  "data": {
    "sync_run_id": "3ba10f36-e5d8-4bf7-bb90-1c01555679a3",
    "status": "running",
    "repository_id": "42ea9de7-e910-4056-ae92-3fdde4d02230",
    "checkpoint_version": 14,
    "started_at": "2026-07-31T12:00:00Z"
  }
}
```

동일 repository에는 활성 sync를 하나만 허용합니다. 이미 실행 중이면 새 요청은 기존 실행 ID와 함께 `status: "skipped_concurrent"`를 반환하거나 `409 CONFLICT`로 거부하며 새 checkpoint 경쟁자를 만들지 않습니다. GitHub workflow에서도 repository별 concurrency 제한을 둡니다.

### `POST /v1/github/sync-runs/{sync_run_id}/heartbeat`

장시간 pagination이나 rate-limit 대기 중 실행이 사라진 것으로 오인하지 않도록 비영속 진행 정보를 갱신합니다.

요청:

```json
{
  "stream": "issues",
  "pages_completed": 3,
  "items_accepted": 140,
  "observed_through": "2026-07-31T11:45:00Z"
}
```

응답 `200`:

```json
{
  "request_id": "f1e6b586-1f38-4247-9eb9-930b9e4abc85",
  "data": {
    "sync_run_id": "3ba10f36-e5d8-4bf7-bb90-1c01555679a3",
    "status": "running",
    "heartbeat_at": "2026-07-31T12:02:00Z"
  }
}
```

heartbeat는 `sync_runs.updated_at`과 안전한 progress count만 갱신합니다. 성공 checkpoint를 전진시키거나 source 수집 성공을 대신하지 않습니다.

### `POST /v1/github/sync-runs/{sync_run_id}/items`

Issue, 댓글, tombstone을 항목 단위로 원본 및 snapshot에 수집합니다. `sync_run_id`가 가리키는 repository가 모든 항목의 범위가 됩니다.

요청:

```json
{
  "items": [
    {
      "idempotency_key": "gh:R_kgDOExample:issue:42:sha256:5fa4",
      "resource_type": "issue",
      "operation": "upsert",
      "issue": {
        "github_id": "987654321012345678",
        "node_id": "I_kwDOExample",
        "number": 42,
        "title": "PostgreSQL 검색 정리",
        "body": "Issue 본문",
        "state": "open",
        "state_reason": null,
        "author_login": "octocat",
        "locked": false,
        "html_url": "https://github.com/owner/repository/issues/42",
        "created_at": "2026-07-01T03:00:00Z",
        "updated_at": "2026-07-31T11:50:00Z",
        "closed_at": null,
        "labels": [
          {
            "github_id": "1234567",
            "name": "database",
            "color": "0052cc"
          }
        ]
      },
      "observed_at": "2026-07-31T12:01:00Z"
    },
    {
      "idempotency_key": "gh:R_kgDOExample:comment:222222222222222222:sha256:8bb1",
      "resource_type": "issue_comment",
      "operation": "upsert",
      "issue_number": 42,
      "comment": {
        "github_id": "222222222222222222",
        "node_id": "IC_kwDOExample",
        "author_login": "octocat",
        "body": "댓글 본문",
        "html_url": "https://github.com/owner/repository/issues/42#issuecomment-222222222222222222",
        "created_at": "2026-07-30T02:00:00Z",
        "updated_at": "2026-07-30T02:10:00Z"
      },
      "observed_at": "2026-07-31T12:01:00Z"
    },
    {
      "idempotency_key": "gh:R_kgDOExample:comment:111111111111111111:tombstone:sha256:3a77",
      "resource_type": "issue_comment",
      "operation": "tombstone",
      "github_id": "111111111111111111",
      "deleted_at": "2026-07-31T11:00:00Z"
    }
  ]
}
```

규칙:

- 각 item은 고유한 `idempotency_key`를 가져야 합니다. batch envelope의 `X-Idempotency-Key`는 전달 시도 자체를 식별하고, item key는 부분 재시도에서도 그대로 유지합니다.
- `resource_type`과 payload는 discriminated union입니다. `issue`에는 `issue`, `issue_comment` upsert에는 `issue_number`와 `comment`, tombstone에는 `github_id`와 `deleted_at`이 필요합니다.
- 클라이언트는 신뢰할 `content_hash` 필드로 hash를 주장하지 않습니다. 서버가 [GitHub 동기화 및 로컬 MCP 통합 계약](./integration-contracts.md)의 canonicalization 규칙으로 의미 있는 원본 필드를 정규화한 뒤 SHA-256을 계산합니다. caller가 item key에 hash suffix를 사용했다면 서버 계산과 다를 때 `INVALID_ARGUMENT`으로 quarantine합니다.
- 같은 source object의 같은 hash가 이미 있으면 새 snapshot을 만들지 않습니다.
- Issue 식별자는 `(repository_id, issue.number)`이며 GitHub ID와 node ID도 일치해야 합니다. 기존 행과 충돌하면 item 오류 `CONFLICT`와 `reason: "source_identity"`입니다.
- Issue와 comment는 독립 stream으로 처리합니다. 요청에 comment가 없다는 이유로 기존 comment를 삭제하면 안 됩니다.
- tombstone은 완전한 `reconcile`에서 삭제가 확인됐거나 [통합 계약](./integration-contracts.md)의 연속 누락 규칙을 충족한 source에만 보냅니다.
- 명시적 tombstone은 sync run의 repository에 속한다고 확인된 source에만 적용합니다.
- `observed_at`은 source 조회 시각이며 미래로 과도하게 치우친 값은 거부합니다.
- GitHub 원본 복제본은 이 API 외의 endpoint로 수정하지 않습니다.

응답 `200`:

```json
{
  "request_id": "3c496a88-dd02-4efb-919c-bc42010b8276",
  "data": {
    "sync_run_id": "3ba10f36-e5d8-4bf7-bb90-1c01555679a3",
    "counts": {
      "accepted": 2,
      "duplicate": 0,
      "retryable_error": 0,
      "quarantined_permanent": 1
    },
    "items": [
      {
        "idempotency_key": "gh:R_kgDOExample:issue:42:sha256:5fa4",
        "status": "accepted",
        "effect": "snapshot_created",
        "source_object_id": "6faf473d-d865-42e5-bbc0-cb90d7bf4866",
        "snapshot_id": "a1eae18e-ae04-4a21-8d24-5ac60fb9e0f3",
        "content_hash": "sha256:5fa4..."
      },
      {
        "idempotency_key": "gh:R_kgDOExample:comment:222222222222222222:sha256:8bb1",
        "status": "accepted",
        "effect": "unchanged",
        "source_object_id": "89ae1952-e3fb-4b86-8890-ff54b86b98c3",
        "snapshot_id": null,
        "content_hash": "sha256:8bb1..."
      },
      {
        "idempotency_key": "gh:R_kgDOExample:comment:111111111111111111:tombstone:sha256:3a77",
        "status": "quarantined_permanent",
        "effect": "none",
        "error": {
          "code": "CONFLICT",
          "reason": "source_identity",
          "retryable": false
        },
        "quarantine_id": "7312"
      }
    ],
    "has_failures": true
  }
}
```

item `status`는 다음 네 값입니다.

```text
accepted
duplicate
retryable_error
quarantined_permanent
```

`effect`는 `source_created`, `snapshot_created`, `unchanged`, `tombstone_applied`, `none` 중 하나입니다. 같은 item key 재생은 `duplicate`이며 최초 결과를 함께 반환합니다.

각 item은 독립 transaction입니다. 한 item의 실패가 다른 item을 rollback하지 않습니다. batch-level JSON parse, 인증 또는 크기 오류만 요청 전체를 거부합니다. caller는 `retryable_error` item만 같은 item key로 재전송하고, 영구 입력 오류는 무한 재시도하지 않습니다.

영구 실패의 quarantine에는 repository, resource type, 외부 ID, payload hash, 오류 code와 민감정보가 없는 pointer만 저장합니다. Issue·댓글 본문이나 탐지된 민감정보 원문은 quarantine에도 저장하지 않습니다. MVP의 `quarantine_id`는 해당 실패 `audit_events.id`를 opaque 문자열로 노출하고 별도 quarantine 테이블을 요구하지 않습니다.

### `POST /v1/github/quarantine/{quarantine_id}/retry`

사용자 또는 운영자가 원본 GitHub 내용을 수정한 뒤 영구 실패 항목을 명시적으로 다시 처리합니다.

요청:

```json
{
  "item": {
    "idempotency_key": "gh:R_kgDOExample:comment:111111111111111111:tombstone:sha256:4c90",
    "resource_type": "issue_comment",
    "operation": "tombstone",
    "github_id": "111111111111111111",
    "deleted_at": "2026-07-31T11:00:00Z"
  }
}
```

응답은 source batch의 item 결과 한 개와 같은 구조입니다. 성공하면 기존 quarantine ID를 참조하는 해소 감사 event를 추가합니다. 본문이 저장되지 않으므로 API가 과거 payload를 자체 재생하지 않으며, caller가 수정된 item 전체를 다시 제공해야 합니다.

### `POST /v1/github/sync-runs/{sync_run_id}/complete`

요청:

```json
{
  "status": "completed",
  "observed_through": "2026-07-31T12:00:00Z",
  "expected_checkpoint_version": 14,
  "summary": {
    "issues_seen": 12,
    "issue_snapshots_created": 2,
    "comments_seen": 38,
    "comment_snapshots_created": 4
  }
}
```

실패 종료 요청:

```json
{
  "status": "failed",
  "error": {
    "code": "GITHUB_RATE_LIMITED",
    "message": "GitHub 조회가 완료되지 않았습니다."
  }
}
```

규칙:

- `status`는 `completed`, `completed_with_errors`, `failed`, `cancelled` 중 하나입니다.
- `completed`와 `completed_with_errors`일 때 `observed_through`와 `expected_checkpoint_version`이 필요합니다.
- 모든 조회 페이지와 재시도 가능한 item 처리가 끝난 뒤에만 완료 상태를 보냅니다.
- `completed_with_errors`는 `quarantined_permanent` item만 남고 `retryable_error`가 없을 때 허용합니다. 영구 오류 한 건 때문에 정상 변경의 checkpoint를 영원히 막지 않습니다.
- `completed`와 `completed_with_errors`는 compare-and-set 검증 후 checkpoint를 전진시킵니다.
- `failed`는 sync 실행 이력만 닫고 checkpoint를 전진시키지 않습니다.
- `cancelled`도 checkpoint를 전진시키지 않습니다.
- 현재 checkpoint version이 다르면 `409 CONFLICT`와 `reason: "checkpoint_revision"`입니다. caller는 최신 checkpoint를 다시 조회하고 새 sync를 시작합니다.
- API는 caller가 보낸 `summary`와 실제 해당 sync run에 기록된 수를 대조합니다. 불일치는 `409 CONFLICT`와 `reason: "sync_summary"`입니다.

응답 `200`:

```json
{
  "request_id": "335d74e6-a1fb-4028-a0e0-77e7a2bd0da8",
  "data": {
    "sync_run_id": "3ba10f36-e5d8-4bf7-bb90-1c01555679a3",
    "status": "completed",
    "finished_at": "2026-07-31T12:04:00Z",
    "checkpoint": {
      "last_successful_observed_through": "2026-07-31T12:00:00Z",
      "checkpoint_version": 15
    }
  }
}
```

## MCP 읽기 endpoint

읽기 endpoint도 principal의 `user_id`와 repository 범위를 적용합니다. 범위 밖 resource는 `403` 대신 `404`로 응답하여 존재 여부를 노출하지 않습니다.

### `POST /v1/context/query`

요청:

```json
{
  "repository": {
    "github_repository_id": "R_kgDOExample",
    "full_name": "owner/repository"
  },
  "task": "DB 스키마를 설계한다.",
  "paths": [
    "supabase/migrations"
  ],
  "tags": [
    "postgresql"
  ],
  "limits": {
    "max_memories": 20,
    "max_per_kind": 5,
    "max_estimated_tokens": 3000
  }
}
```

응답 `200`:

```json
{
  "request_id": "d346e1d8-2d7b-4b21-8ea0-c3e160594a68",
  "data": {
    "repository": {
      "id": "42ea9de7-e910-4056-ae92-3fdde4d02230",
      "github_repository_id": "R_kgDOExample",
      "name": "owner/repository"
    },
    "task": "DB 스키마를 설계한다.",
    "constraints": [],
    "decisions": [],
    "preferences": [],
    "related_learning": [],
    "past_failures": [],
    "procedures": [],
    "conflicts": [],
    "sources": [],
    "has_more": false
  }
}
```

각 기억 요약 항목에는 최소 `id`, `kind`, `statement`, `status`, `scope`, `source_refs`가 들어갑니다. `proposed`, `superseded`, `deprecated`, `deleted`는 기본 Context Pack에서 제외합니다.

### `POST /v1/memories/search`

요청:

```json
{
  "query": "PostgreSQL 검색",
  "kinds": [
    "learning",
    "decision",
    "failure"
  ],
  "scopes": [
    {
      "type": "repository",
      "id": "42ea9de7-e910-4056-ae92-3fdde4d02230"
    }
  ],
  "statuses": [
    "confirmed",
    "verified"
  ],
  "tags": ["postgresql"],
  "limit": 20,
  "cursor": null
}
```

응답 `200`:

```json
{
  "request_id": "82c6f862-d34c-4df4-8a41-ad910896039f",
  "data": {
    "items": [
      {
        "id": "1caf9c00-15ba-4a74-9a5b-d3a4cf7c30b5",
        "kind": "decision",
        "statement": "MVP 검색은 PostgreSQL 문자열 검색을 사용한다.",
        "status": "confirmed",
        "scope": {
          "type": "repository",
          "id": "42ea9de7-e910-4056-ae92-3fdde4d02230"
        },
        "source_refs": [
          {
            "source_type": "document",
            "source_id": "docs/architecture.md"
          }
        ]
      }
    ],
    "next_cursor": null
  }
}
```

`tags`를 주면 하나 이상이 일치하는 기억만 반환합니다. 검색 정렬 규칙은 `context-contract.md`를 따릅니다. API가 반환하는 cursor는 opaque 문자열이며 클라이언트가 해석하지 않습니다.

### `GET /v1/memories/{memory_id}`

응답 `200`:

```json
{
  "request_id": "6cb3143d-87af-4b8d-9e68-b4e1a470f8c0",
  "data": {
    "memory": {
      "id": "1caf9c00-15ba-4a74-9a5b-d3a4cf7c30b5",
      "kind": "decision",
      "statement": "MVP 검색은 PostgreSQL 문자열 검색을 사용한다.",
      "rationale": "무료 범위와 운영 단순성을 우선한다.",
      "status": "confirmed",
      "confidence": 1,
      "scope": {
        "type": "repository",
        "id": "42ea9de7-e910-4056-ae92-3fdde4d02230"
      },
      "valid_from": "2026-07-31T12:30:00Z",
      "valid_until": null,
      "tags": [
        "postgresql"
      ],
      "revision": 1,
      "created_at": "2026-07-31T12:30:00Z",
      "updated_at": "2026-07-31T12:30:00Z"
    },
    "sources": [
      {
        "source_type": "document",
        "source_id": "docs/architecture.md",
        "source_uri": null,
        "source_excerpt": "PostgreSQL 구조화 필터와 문자열 검색"
      }
    ],
    "supersedes": null,
    "superseded_by": null,
    "usage_summary": {
      "last_used_at": null,
      "helpful": 0,
      "irrelevant": 0,
      "outdated": 0,
      "incorrect": 0,
      "conflicting": 0
    }
  }
}
```

## MCP 쓰기 endpoint

### 공통 기억 입력

기억 생성 endpoint는 다음 공통 구조를 사용합니다.

```json
{
  "statement": "짧고 독립적인 기억 문장",
  "rationale": "근거와 상세 설명",
  "scope": {
    "type": "repository",
    "id": "42ea9de7-e910-4056-ae92-3fdde4d02230"
  },
  "status": "proposed",
  "confidence": 0.8,
  "sources": [
    {
      "source_type": "user_message",
      "source_id": "codex-session-123:message-45",
      "source_uri": null,
      "source_excerpt": "이 프로젝트에서는 pnpm을 사용해."
    }
  ],
  "valid_from": "2026-07-31T12:30:00Z",
  "valid_until": null,
  "tags": [
    "package-manager"
  ]
}
```

`scope.type`은 `global`, `organization`, `repository`, `project`, `path`, `task` 중 하나입니다. `scope.id`는 API가 확인 가능한 내부 scope ID 또는 정규화된 scope key입니다. `path`는 repository 기준 상대 경로이며 `..`, drive letter, 절대 경로를 허용하지 않습니다.

`source_type`은 다음 값 중 하나입니다.

```text
github_issue
github_comment
user_message
test_result
document
agent_run
policy_event
```

초기 DB의 `source_type`에는 `document`와 `policy_event`를 `manual` source record로 매핑하고 원래 wire type은 snapshot metadata에 보존합니다. `agent_run` 근거는 가능한 경우 `memory_evidence.agent_run_id`로 직접 연결합니다.

활성 기억에는 source가 하나 이상 필요합니다. `confirmed` 상태에는 `confirmation.origin: "explicit_user"`가 추가로 필요하고 `memory:confirm` permission이 있어야 합니다. `verified`는 검증 결과가 `passed`이고 `test_result` 또는 검증된 `agent_run` 근거가 함께 제공될 때만 생성 또는 전이할 수 있습니다.

### `POST /v1/memories/decisions`

요청:

```json
{
  "statement": "이 저장소에서는 pnpm을 사용한다.",
  "rationale": "사용자가 패키지 관리자를 명시적으로 선택했다.",
  "scope": {
    "type": "repository",
    "id": "42ea9de7-e910-4056-ae92-3fdde4d02230"
  },
  "status": "confirmed",
  "confidence": 1,
  "decision": {
    "alternatives": [
      "npm",
      "yarn"
    ],
    "decided_at": "2026-07-31T12:30:00Z"
  },
  "sources": [
    {
      "source_type": "user_message",
      "source_id": "codex-session-123:message-45",
      "source_uri": null,
      "source_excerpt": "좋아, pnpm으로 가자."
    }
  ],
  "confirmation": {
    "origin": "explicit_user",
    "source": {
      "type": "user_message",
      "id": "codex-session-123:message-45"
    },
    "confirmed_at": "2026-07-31T12:30:00Z"
  },
  "valid_from": "2026-07-31T12:30:00Z",
  "valid_until": null,
  "tags": [
    "package-manager"
  ]
}
```

응답 `201`:

```json
{
  "request_id": "ae02a628-00a3-4ccd-8638-c12183931a92",
  "data": {
    "memory": {
      "id": "6e5239f4-e4e6-4c58-8d7e-ebc3adebcba4",
      "kind": "decision",
      "status": "confirmed",
      "revision": 1,
      "created_at": "2026-07-31T12:30:01Z",
      "confirmed_at": "2026-07-31T12:30:01Z"
    }
  }
}
```

사용자가 확정하지 않은 AI 제안은 `status: "proposed"`만 허용하며 `confirmation.origin: "agent_inference"`와 추론 source를 보냅니다.

### `POST /v1/memories/failures`

요청:

```json
{
  "statement": "Windows에서 잘못된 pnpm store 경로 때문에 install이 실패할 수 있다.",
  "rationale": "store 경로를 교정한 뒤 install이 성공했다.",
  "scope": {
    "type": "repository",
    "id": "42ea9de7-e910-4056-ae92-3fdde4d02230"
  },
  "status": "proposed",
  "confidence": 0.8,
  "failure": {
    "resolution_status": "resolved",
    "symptom": "pnpm install이 store 위치 오류로 실패함",
    "environment": "Windows, pnpm",
    "attempts": [
      "기존 설정으로 재시도"
    ],
    "cause_or_hypothesis": "설정된 store 경로가 현재 환경과 맞지 않음",
    "resolution": "유효한 store 경로로 설정을 교정함",
    "verification": [
      "pnpm install 성공"
    ]
  },
  "sources": [
    {
      "source_type": "agent_run",
      "source_id": "83a05887-55ad-45e9-98d8-b4d94dac2187",
      "source_uri": null,
      "source_excerpt": "store 경로 수정 후 pnpm install 성공"
    }
  ],
  "valid_from": "2026-07-31T12:30:00Z",
  "valid_until": null,
  "tags": [
    "pnpm",
    "windows"
  ]
}
```

`failure.resolution_status`는 `observed`, `investigating`, `hypothesis`, `resolved`, `verified`, `recurring` 중 하나입니다. `verified`에는 `passed` 검증 결과와 `test_result` 또는 검증된 `agent_run` source가 필요합니다. 기억 자체의 `status`와 실패 해결 상태를 혼동하지 않습니다. 원인이나 해결법이 `hypothesis`이면 기억 status도 `proposed`만 허용합니다.

응답 형식은 decision 생성 응답과 같고 `kind`가 `failure`입니다.

### `POST /v1/agent-runs/finish`

요청:

```json
{
  "session_id": "codex-session-123",
  "agent": "codex",
  "repository_id": "42ea9de7-e910-4056-ae92-3fdde4d02230",
  "goal": "DB 스키마 초안을 작성한다.",
  "started_at": "2026-07-31T11:00:00Z",
  "finished_at": "2026-07-31T12:00:00Z",
  "result": "succeeded",
  "changed_files": [
    {
      "path": "supabase/migrations/202607310001_initial.sql",
      "operation": "created"
    }
  ],
  "commands_or_actions": [
    {
      "kind": "command",
      "summary": "migration lint 실행"
    }
  ],
  "verification": [
    {
      "kind": "test",
      "name": "migration lint",
      "status": "passed",
      "summary": "오류 없음"
    }
  ],
  "used_memories": [
    {
      "memory_id": "1caf9c00-15ba-4a74-9a5b-d3a4cf7c30b5",
      "rating": "helpful"
    }
  ],
  "created_memory_ids": [],
  "failure_ids": []
}
```

`result`는 `succeeded`, `partial`, `failed`, `cancelled` 중 하나입니다. MCP의 `success`, `partial`, `failed`, `aborted`는 API에서 각각 `succeeded`, `partial`, `failed`, `cancelled`로 정규화합니다. `changed_files.path`는 repository 상대 경로만 허용합니다. `commands_or_actions`에는 command 원문, 환경 변수, token, 전체 stack trace를 넣지 않고 재현에 필요한 민감정보 제거 요약만 넣습니다.

응답 `201`:

```json
{
  "request_id": "f385c020-2752-4764-a126-a5be1656299e",
  "data": {
    "agent_run_id": "83a05887-55ad-45e9-98d8-b4d94dac2187",
    "session_id": "codex-session-123",
    "result": "succeeded",
    "created_at": "2026-07-31T12:00:01Z"
  }
}
```

같은 session 안에서도 논리 작업이 여러 번 끝날 수 있으므로 `session_id`만으로 중복을 판정하지 않습니다. 같은 멱등성 key의 재시도는 최초 결과를 반환하고, 같은 key에 다른 내용이 오면 `409 IDEMPOTENCY_CONFLICT`입니다.

### `POST /v1/memories/{memory_id}/confirm`

요청:

```json
{
  "expected_revision": 1,
  "confirmation": {
    "origin": "explicit_user",
    "source": {
      "type": "user_message",
      "id": "codex-session-123:message-52"
    },
    "confirmed_at": "2026-07-31T12:40:00Z"
  }
}
```

규칙:

- 현재 상태가 `proposed`일 때만 `confirmed`로 전이합니다.
- `expected_revision`이 다르면 `409 CONFLICT`와 `reason: "memory_revision"`입니다.
- proposed 기억에 `supersedes_id`가 있으면 predecessor도 잠그고, 신규 기억의 확정과 predecessor의 `superseded` 전이를 한 transaction에서 수행합니다.
- predecessor가 이미 `superseded`, `deprecated`, `deleted`이거나 revision 조건이 더 이상 맞지 않으면 둘 다 변경하지 않고 `409 INVALID_STATE_TRANSITION`입니다.
- 이미 같은 근거로 확정된 기억에 같은 멱등성 요청이 오면 최초 응답을 반환합니다.
- `superseded`, `deprecated`, `deleted` 기억은 확정할 수 없습니다.

응답 `200`:

```json
{
  "request_id": "014f37b9-594b-440c-a3ed-44155137514a",
  "data": {
    "memory_id": "6e5239f4-e4e6-4c58-8d7e-ebc3adebcba4",
    "status": "confirmed",
    "revision": 2,
    "confirmed_at": "2026-07-31T12:40:01Z"
  }
}
```

### `POST /v1/memories/{memory_id}/supersede`

기존 기억을 덮어쓰지 않습니다. 사용자 명시적 교체와 AI 제안 교체는 서로 다른 상태 전이를 사용합니다.

요청:

```json
{
  "expected_revision": 2,
  "status_intent": "confirmed",
  "replacement": {
    "kind": "decision",
    "statement": "이 저장소에서는 npm을 사용한다.",
    "rationale": "사용자가 패키지 관리자 결정을 변경했다.",
    "scope": {
      "type": "repository",
      "id": "42ea9de7-e910-4056-ae92-3fdde4d02230"
    },
    "confidence": 1,
    "sources": [
      {
        "source_type": "user_message",
        "source_id": "codex-session-123:message-60",
        "source_uri": null,
        "source_excerpt": "앞으로 npm으로 바꿔."
      }
    ],
    "valid_from": "2026-07-31T13:00:00Z",
    "valid_until": null,
    "tags": [
      "package-manager"
    ]
  },
  "confirmation": {
    "origin": "explicit_user",
    "source": {
      "type": "user_message",
      "id": "codex-session-123:message-60"
    },
    "confirmed_at": "2026-07-31T13:00:00Z"
  }
}
```

규칙:

- `status_intent: "confirmed"`에는 `memory:supersede`와 `confirmation.origin: "explicit_user"`가 필요합니다. 신규 기억을 `confirmed`로 만들고 기존 기억을 `superseded`로 바꾸는 작업을 하나의 transaction에서 수행합니다.
- `status_intent: "proposed"`는 `confirmation.origin: "agent_inference"`인 AI 제안이며 `memory:propose`로 호출할 수 있습니다. 신규 기억만 `proposed` successor로 만들고 기존 기억은 `confirmed` 또는 `verified` 활성 상태로 유지합니다.
- proposed successor는 기본 Context Pack에 나오지 않습니다. 사용자가 그 기억을 confirm할 때 신규 기억의 `confirmed` 전이와 기존 기억의 `superseded` 전이를 하나의 transaction에서 수행합니다.
- 초기 DB 제약에 맞춰 기존 기억과 신규 기억은 같은 owner, `kind`, `scope_id`를 가져야 합니다. 범위나 kind를 바꾸려면 별도 신규 기억으로 저장하고 기존 기억을 자동 비활성화하지 않습니다.
- 두 모드 모두 신규 기억의 `supersedes_id`를 기존 ID로 설정합니다.
- 이미 다른 기억으로 대체됐으면 `409 INVALID_STATE_TRANSITION`과 기존 `superseded_by` ID를 권한 범위 안에서만 반환합니다.

응답 `201`:

```json
{
  "request_id": "8909d8bc-e915-4cd0-b2ab-4c38f713d54a",
  "data": {
    "superseded": {
      "memory_id": "6e5239f4-e4e6-4c58-8d7e-ebc3adebcba4",
      "status": "superseded",
      "revision": 3
    },
    "replacement": {
      "memory_id": "c6540e9b-eb5d-4164-82fb-21716bd3f1ad",
      "status": "confirmed",
      "revision": 1
    }
  }
}
```

AI 제안 응답 `201`:

```json
{
  "request_id": "08779fee-d939-4cb0-b6c3-777ab93c74d8",
  "data": {
    "existing": {
      "memory_id": "6e5239f4-e4e6-4c58-8d7e-ebc3adebcba4",
      "status": "confirmed",
      "revision": 2
    },
    "replacement": {
      "memory_id": "8b5a72ef-b043-485f-a9d8-7f5c2f6cb9a2",
      "status": "proposed",
      "revision": 1
    },
    "transition": "proposal_created"
  }
}
```

### `POST /v1/memories/{memory_id}/forget-preview`

삭제 전에 실제 영향 범위를 계산하고 짧은 수명의 실행 token을 발급합니다. preview는 데이터를 변경하지 않습니다.

요청:

```json
{
  "expected_revision": 2,
  "reason_code": "user_requested",
  "delete_linked_source": false
}
```

응답 `200`:

```json
{
  "request_id": "36e94b42-acde-49f8-9a63-50be6e0bba3d",
  "data": {
    "memory_id": "6e5239f4-e4e6-4c58-8d7e-ebc3adebcba4",
    "impact": {
      "memories": 1,
      "linked_sources": 0,
      "snapshots": 0,
      "audit_payloads_to_redact": 2,
      "other_active_memories_using_source": 0
    },
    "preview_token": "signed-opaque-token",
    "expires_at": "2026-07-31T13:15:00Z"
  }
}
```

`preview_token`은 owner, memory ID, expected revision, reason, 삭제 option과 impact hash를 서명한 opaque token입니다. 기본 유효기간은 5분이며 DB에 별도 report row를 만들 필요는 없습니다. 대상 revision이나 영향 범위가 바뀌면 execute를 거부하고 새 preview를 요구합니다.

### `POST /v1/memories/{memory_id}/forget`

요청:

```json
{
  "expected_revision": 2,
  "reason_code": "user_requested",
  "delete_linked_source": false,
  "preview_token": "signed-opaque-token",
  "confirmation": {
    "origin": "explicit_user",
    "source": {
      "type": "user_message",
      "id": "codex-session-123:message-70"
    },
    "confirmed_at": "2026-07-31T13:10:00Z"
  }
}
```

`reason_code`는 `user_requested`, `sensitive_data`, `retention_expired`, `unauthorized_source` 중 하나입니다.

규칙:

- 모든 실행 요청은 아직 유효하고 현재 영향 범위와 일치하는 `preview_token`이 필요합니다.
- `user_requested`에는 `memory:forget`과 `confirmation.origin: "explicit_user"`가 필요합니다.
- `sensitive_data`에는 `memory:forget_sensitive`와 `confirmation.origin: "policy_enforcement"`가 필요하며 사용자 메시지 확정 없이 실행할 수 있습니다.
- `delete_linked_source: true`는 그 source가 같은 사용자 소유이고 다른 활성 기억의 근거가 아니거나, 함께 삭제할 범위가 명시됐을 때만 허용합니다.
- 일반 결정 변경에는 이 endpoint 대신 supersede를 사용합니다.
- 감사 event의 입력 원문은 지우되 요청 ID, 실행 주체, reason, 삭제된 내부 ID와 시각 같은 비민감 metadata는 보존합니다.
- DB 밖 backup이 존재하면 API가 제거 여부를 거짓으로 보고하지 않습니다.

응답 `200`:

```json
{
  "request_id": "bb2b357a-979a-494b-8ad1-761b25e5de9e",
  "data": {
    "memory_id": "6e5239f4-e4e6-4c58-8d7e-ebc3adebcba4",
    "database": {
      "memory_deleted": true,
      "linked_sources_deleted": 0,
      "snapshots_deleted": 0,
      "audit_payloads_redacted": 2
    },
    "backups": {
      "status": "not_configured"
    },
    "completed_at": "2026-07-31T13:10:01Z"
  }
}
```

backup이 구성됐지만 API transaction 안에서 purge할 수 없다면 `backups.status`는 `purge_required`이고 operator가 추적할 운영 작업 ID를 함께 반환합니다.

MVP의 삭제 결과는 이 응답과 `audit_events`의 비민감 metadata로 추적합니다. 별도 deletion report 테이블은 장기 비동기 purge나 여러 backup target을 운영하게 될 때 후속 migration으로 추가합니다.

## 멱등성 계약

### key 범위

상태 변경 요청의 멱등성 scope는 다음 tuple입니다.

```text
(principal_id, HTTP method, route template, X-Idempotency-Key)
```

route template을 사용하므로 `/v1/memories/{memory_id}/confirm`의 실제 `memory_id`는 canonical request hash에 포함되지만 key scope route는 template으로 정규화합니다.

초기 DB의 `idempotency_records(owner_id, actor_type, actor_id, operation, idempotency_key)`에는 이 논리 scope를 인증된 owner와 actor context로 매핑합니다. 별도 principal 테이블은 필요하지 않습니다.

권장 key:

```text
github-sync:<repository-node-id>:<run-id>:<logical-operation>
mcp:<session-id>:<tool-call-id>
```

key는 16~200자의 출력 가능한 ASCII 문자열이어야 하며 credential이나 개인정보를 포함하면 안 됩니다.

### 서버 동작

1. 인증, authorization, 기본 JSON parse와 크기 검사를 먼저 수행합니다.
2. 민감정보 검사를 통과한 canonical request의 SHA-256 hash를 `sha256:<lowercase-hex-64>` 형식으로 계산합니다.
3. idempotency row를 예약합니다.
4. 동일 scope와 key의 완료 row가 있으면 저장된 status와 body를 반환하고 `Idempotency-Replayed: true` header를 추가합니다.
5. 동일 key에 다른 request hash가 오면 `409 IDEMPOTENCY_CONFLICT`입니다.
6. 같은 key가 처리 중이면 짧게 결과를 기다린 뒤, 끝나지 않으면 `409 IDEMPOTENCY_IN_PROGRESS`와 `Retry-After`를 반환합니다.
7. 업무 transaction이 commit될 때 idempotency 결과와 감사 성공 event도 함께 확정합니다.
8. transaction 전의 일시적 `5xx`는 완료 결과로 고정하지 않아 같은 key로 재시도할 수 있습니다.

인증 실패와 JSON schema 오류는 idempotency row를 만들지 않습니다. 인증 이후 발생한 결정적 업무 거부(`SENSITIVE_DATA_DETECTED`, 상태 전이 오류 등)는 같은 key 재시도에 같은 응답을 주도록 완료 결과로 기록할 수 있지만, 요청 원문은 저장하지 않습니다.

GitHub source batch는 예외적으로 envelope와 item 두 단계의 멱등성을 사용합니다.

- envelope header key는 한 HTTP 전달 시도와 전체 응답을 식별합니다.
- 각 item key는 `(owner_id, github_source_item, item.idempotency_key)`로 예약하고 item transaction과 함께 완료합니다.
- process가 일부 item commit 뒤 중단돼 envelope가 완료되지 않아도, 새 envelope key와 기존 item key로 재시도하면 완료 item은 `duplicate`가 됩니다.
- 실패 item만 재전송할 때는 새 envelope key를 쓰고 item key는 그대로 유지합니다.

### 이중 중복 방지

멱등성 key 외에도 도메인 고유 제약을 둡니다.

- repository: GitHub node ID unique
- Issue: `(repository_id, issue_number)` unique
- GitHub source: `(repository_id, source_type, github_id)` unique
- snapshot: `(source_object_id, hash_version, content_hash)` unique
- supersede relation: 한 기억은 최대 하나의 직접 replacement를 가짐

idempotency row 보존 기간이 지나도 이 제약이 영구 중복을 막습니다.

## 오류 계약

모든 오류는 같은 envelope를 사용합니다.

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "요청 형식이 올바르지 않습니다.",
    "request_id": "d93f9535-a9e4-420c-96c5-ab0b83859b4b",
    "retryable": false,
    "details": [
      {
        "path": "/items/0/issue/title",
        "reason": "required"
      }
    ]
  }
}
```

- `message`는 사용자에게 보여줄 수 있는 비민감 설명입니다.
- `details.path`는 JSON Pointer입니다.
- 입력값 원문, token, SQL, stack trace는 `details`에 넣지 않습니다.
- 알 수 없는 `code`도 클라이언트가 HTTP status와 `retryable`로 처리할 수 있어야 합니다.

| HTTP | 대표 code | 재시도 |
|---|---|---|
| `400` | `INVALID_JSON`, `INVALID_ARGUMENT` | 수정 전 불가 |
| `401` | `UNAUTHENTICATED` | credential 갱신 후 |
| `403` | `FORBIDDEN` | 권한 변경 전 불가 |
| `404` | `NOT_FOUND` | 일반적으로 불가 |
| `409` | `IDEMPOTENCY_CONFLICT`, `CONFLICT`, `INVALID_STATE_TRANSITION` | 최신 상태 조회 후 가능 |
| `413` | `PAYLOAD_TOO_LARGE` | 요청을 나눈 뒤 |
| `422` | `SENSITIVE_DATA_DETECTED` | 입력 정리 후 |
| `429` | `RATE_LIMITED` | `Retry-After` 후 |
| `500` | `INTERNAL` | 같은 멱등성 key로 가능 |
| `503` | `DEPENDENCY_UNAVAILABLE` | 같은 멱등성 key로 가능 |

인증은 됐지만 scope 밖 resource를 ID로 조회한 경우 `NOT_FOUND`를 사용합니다. endpoint 자체 사용 권한이 없을 때만 `FORBIDDEN`을 사용합니다.

클라이언트는 `retryable: true`인 요청에만 지수 backoff와 jitter를 적용합니다. `POST` 재시도는 반드시 같은 멱등성 key와 byte-equivalent 의미의 body를 사용합니다.

## 민감정보 검사

### 검사 시점

민감정보 검사는 다음보다 먼저 실행합니다.

- 원본·snapshot·기억·실행 기록 저장
- idempotency request body 또는 response body 저장
- 감사 로그의 redacted input 저장
- 검색용 text column과 로그 출력

서버 access log도 Authorization header와 request body를 기록하지 않도록 별도로 설정합니다.

### 검사 대상

- 모든 자유 텍스트 필드
- GitHub Issue·댓글 title과 body
- 기억 statement, rationale, source excerpt, failure detail
- agent run goal, action summary, verification summary와 path
- JSON 내부에 포함된 중첩 문자열

최소 탐지 범주:

```text
private_key
api_key
access_token
refresh_token
session_cookie
jwt
password_or_connection_string
env_file_content
personal_identity
```

일반적인 vendor token prefix, PEM private key block, password가 포함된 DB URL, cookie header, `.env` 형태의 다중 key-value, 이메일·전화번호 등 개인 식별 패턴을 검사합니다. 알려진 placeholder와 test fixture는 실제 secret과 구분하되, 검사 우회를 위한 임의 caller flag는 두지 않습니다.

### 처리 원칙

- credential과 인증정보의 high-confidence match는 해당 논리 항목을 거부합니다. 단일-resource endpoint에서는 요청 전체가 실패하고, GitHub batch에서는 해당 item만 `quarantined_permanent`가 되며 다른 item은 계속 처리합니다.
- 개인정보도 MVP 기본값은 거부입니다. 자동 마스킹으로 원본의 의미를 조용히 바꾸지 않습니다.
- caller는 source에서 값을 제거하거나 명시적으로 `[REDACTED]`로 바꾼 뒤 같은 논리 작업을 새 멱등성 key로 재시도합니다.
- raw GitHub source에 secret이 있으면 DB에 복제하지 않고 sync run과 quarantine metadata에 차단 사실만 기록합니다. 원문은 GitHub에 남으므로 별도 보안 대응이 필요합니다.
- 탐지 결과에는 category, JSON Pointer, rule ID만 남기고 matched value나 주변 문장을 저장하지 않습니다.
- scanner version과 정책 version을 감사 metadata에 남깁니다.

응답 `422` 예시:

```json
{
  "error": {
    "code": "SENSITIVE_DATA_DETECTED",
    "message": "저장할 수 없는 민감정보 패턴이 발견되었습니다.",
    "request_id": "670d0ae2-0747-490d-a264-691fbf910ed5",
    "retryable": false,
    "details": [
      {
        "path": "/items/0/issue/body",
        "reason": "access_token",
        "rule_id": "credential.github_token.v1"
      }
    ]
  }
}
```

민감정보 검사는 완전한 보안 경계가 아닙니다. caller 지침, 최소 권한, server log 제한, 사용자 검토와 삭제 절차를 함께 적용합니다.

## 트랜잭션 경계

### 공통

인증, JSON parsing, 크기 제한, 민감정보 검사는 DB transaction 전에 수행할 수 있습니다. 다음 항목은 업무 데이터와 같은 transaction에서 commit되어야 합니다.

- 상태 변경 업무 row
- 연관 관계와 tag
- 성공 감사 event
- idempotency 완료 결과

업무 write가 rollback되면 성공 감사 event와 idempotency 성공 결과도 rollback되어야 합니다. 실패 감사 event는 요청 원문 없이 별도 안전한 transaction으로 남길 수 있습니다.

### endpoint별 경계

| Endpoint | 하나의 transaction에 포함할 항목 |
|---|---|
| sync run 시작 | repository upsert, sync run 생성, 감사, idempotency |
| sync heartbeat | sync run progress와 updated 시각, 감사, idempotency |
| source batch 수집 | item 하나의 source object, snapshot, label relation 또는 tombstone, item idempotency, sync count와 감사. item마다 독립 transaction |
| quarantine retry | 수정된 item 수집, quarantine audit metadata 해소, 감사, idempotency |
| sync 완료 | sync run row lock, summary 검증, checkpoint version 검증·전진 또는 실패 종료, 감사, idempotency |
| decision/failure 생성 | scope·source 소유권 검증, memory, subtype detail, source relation, tag, 감사, idempotency |
| agent run finish | run, changed file/action/verification, memory usage rating relation, 감사, idempotency |
| confirm | memory row lock, revision·상태 검증, confirmed 전이와 근거, 감사, idempotency |
| supersede | confirmed 모드는 기존 memory row lock, 신규 memory와 관계 생성, 기존 status 전이, 감사, idempotency. proposed 모드는 기존 상태를 유지하고 successor만 생성 |
| forget preview | read-only 영향 범위 계산과 signed preview token 발급 |
| forget | preview 재검증, 삭제 범위 잠금, DB 삭제/감사 payload redaction, 응답용 결과 집계, 감사 metadata, idempotency |

GitHub source batch는 부분 성공을 반환하며 각 item의 transaction 결과를 독립적으로 제공합니다. 무료 DB 환경에서 transaction과 응답이 길어지지 않도록 batch 상한을 적용합니다.

검색과 상세 조회는 일관된 하나의 statement 또는 read-only transaction으로 실행합니다. Context Pack은 서로 다른 시점의 상태가 섞이지 않도록 하나의 read-only transaction snapshot에서 구성합니다.

외부 backup purge, credential 회수, GitHub 원본 수정은 DB transaction에 포함할 수 없습니다. 이런 작업은 결과를 `completed`로 가장하지 않고 별도 상태와 추적 ID를 반환합니다.

## 감사 로그

모든 인증된 요청은 최소 다음 metadata를 남깁니다.

```json
{
  "request_id": "9a94573b-acde-4df1-8f46-c142f5bbd974",
  "idempotency_key_digest": "sha256:...",
  "endpoint": "POST /v1/memories/decisions",
  "principal_id": "2a7e0df1-f5eb-4c94-bb44-84b7f918ac3a",
  "credential_id": "a450cc7a-094f-4ad1-b880-ef85371ebd17",
  "user_id": "8b79ee3a-62c1-4f97-93ee-02f3781d2af4",
  "agent_session_id": "codex-session-123",
  "repository_id": "42ea9de7-e910-4056-ae92-3fdde4d02230",
  "input_summary": {
    "kind": "decision",
    "status": "confirmed",
    "sensitive_fields_removed": true
  },
  "affected_resource_ids": [
    "6e5239f4-e4e6-4c58-8d7e-ebc3adebcba4"
  ],
  "outcome": "succeeded",
  "error_code": null,
  "created_at": "2026-07-31T12:30:01Z"
}
```

`Authorization`, credential 원문, 전체 request body, 전체 GitHub body와 사용자 메시지 전문은 감사 로그에 넣지 않습니다. 삭제 요청 후에도 책임 추적에 필요한 비민감 metadata는 남기되, 삭제된 내용을 복원할 수 있는 excerpt나 hash는 제거합니다.

## A 트랙 DB와 합류할 데이터 요구사항

아래는 테이블 이름을 강제하지 않지만 API 계약을 구현하기 위해 DB가 제공해야 하는 논리 데이터입니다.

### 인증과 범위

- `auth.users.id`를 tenant 식별자인 `owner_id`로 사용하는 사용자 소유권
- 모든 사용자 업무 row에서 직접 또는 composite foreign key로 추적 가능한 `owner_id`
- `owner_id = auth.uid()`를 기준으로 하는 RLS와 `anon` 거부
- principal type, permission, repository 허용 범위는 초기 DB 테이블이 아니라 검증된 auth token claim과 제한된 API endpoint에서 강제
- 장기 opaque credential의 자체 발급·회수·사용 추적이 실제로 필요해질 때만 credential 관련 테이블을 후속 migration으로 추가

### GitHub 원본과 동기화

- 안정적 GitHub node ID와 database ID를 가진 repository
- repository별 sync checkpoint와 compare-and-set 가능한 논리 revision
- mode, client run ID, 시작·종료·실패 상태와 실제 처리 count를 가진 sync run
- Issue·댓글을 공통 식별할 source object
- source object별 immutable snapshot, hash version과 server-calculated content hash
- label metadata와 Issue-label relation
- 명시적 tombstone 또는 deleted state
- source가 처음·마지막으로 관찰된 시각

필수 unique:

```text
repository(github_node_id)
source_object(owner_id, repository_id, source_type, external_id)
issue(repository_id, issue_number)
source_snapshot(source_object_id, hash_version, content_hash)
sync_run(owner_id, idempotency_key)
```

### 기억과 근거

- memory 공통 필드: kind, statement, rationale, scope, status, confidence, 유효 기간, revision, 확정 시각
- decision과 failure subtype detail 또는 같은 정보를 손실 없이 담는 구조
- memory와 source의 다대다 관계
- memory tag
- `supersedes_id`와 역방향 `superseded_by` 조회
- 한 기억이 둘 이상의 직접 replacement를 갖지 못하게 하는 제약
- 활성 기억이 source를 하나 이상 갖도록 보장하는 write procedure
- failure resolution status와 memory status의 분리
- optimistic concurrency를 위한 revision

상태 enum은 기존 문서와 정확히 일치해야 합니다.

```text
memory kind:
learning, decision, preference, failure, procedure, constraint

memory status:
proposed, confirmed, verified, superseded, deprecated, deleted

failure resolution status:
observed, investigating, hypothesis, resolved, verified, recurring

scope type:
global, organization, repository, project, path, task
```

### 실행 기록과 평가

- 멱등성 key로 논리 완료 작업을 구분하고 `session_id` 검색이 가능한 agent run
- changed file, action summary, verification 결과
- 사용·생성 memory와 failure relation
- `helpful`, `irrelevant`, `outdated`, `incorrect`, `conflicting` 평가
- 기억별 마지막 사용 시각과 평가 집계에 필요한 index

### 멱등성, 감사와 삭제

- idempotency scope tuple unique row
- canonical request hash, 처리 상태, 시작·갱신 시각, 완료 HTTP status와 안전한 response
- request ID로 상호 연관 가능한 감사 event
- endpoint, actor type·ID, session, owner, repository, 결과와 scanner version
- 감사 입력은 JSON 원문이 아니라 민감정보 제거 summary
- 영구 수집 실패와 재처리 결과를 request ID와 target ID로 연결할 수 있는 감사 metadata
- 삭제 transaction의 영향 수를 안전한 응답과 감사 metadata로 기록
- 민감정보 삭제 시 감사 payload를 복원 불가능하게 redaction할 수 있는 구조
- 비동기 backup purge를 실제 운영하게 되기 전에는 별도 deletion report 테이블을 요구하지 않음

필수 unique:

```text
idempotency_request(owner_id, actor_type, actor_id, operation, idempotency_key)
```

`actor_type`과 `actor_id`는 검증된 principal context에서 결정하고, `operation`은 HTTP method와 route template을 구분할 수 있게 API가 정규화합니다. credential 원문이나 민감정보는 actor ID, `operation`과 key에 포함하지 않습니다.

### 권한과 index

- 모든 사용자 데이터 row는 직접 또는 repository/scope 관계를 통해 `owner_id` 소유권을 판정할 수 있어야 합니다.
- RLS는 `auth.uid()`의 `owner_id`를, API 또는 allowlisted procedure는 token claim의 principal repository 범위를 추가로 검사할 수 있어야 합니다.
- 일반 검색에서 `superseded`, `deprecated`, `deleted`, `proposed`를 효율적으로 제외할 partial index가 필요합니다.
- repository, scope type·ID, kind, status, tag, 최신 확인 시각으로 기억을 필터링할 수 있어야 합니다.
- source에서 memory로, memory에서 source와 supersede 관계로 양방향 조회할 수 있어야 합니다.
- sync checkpoint update와 memory 상태 전이는 row lock 또는 revision 조건부 update를 지원해야 합니다.

## TypeScript 채택 시 표현 기준

구현 언어는 미확정이지만 TypeScript를 채택하면 다음 기준을 사용합니다.

- request body는 endpoint별 명시적 interface로 정의하고 `any`를 사용하지 않습니다.
- `kind`, `status`, `scope.type`, `principal_type`, `result`는 string union입니다.
- decision과 failure 입력은 `kind`를 discriminator로 하는 union입니다.
- 외부 JSON은 runtime schema 검증 후에만 domain type으로 변환합니다.
- GitHub ID type은 `string` alias로 유지하고 `number`로 변환하지 않습니다.
- timestamp type은 wire에서는 `string`, 검증 후 domain에서는 별도 branded type 또는 date value로 다룹니다.
- 오류 `code`는 알려진 union을 제공하되 미래 code에 대한 fallback 처리를 유지합니다.
- OpenAPI 3.1 또는 JSON Schema를 이 문서의 wire 계약에서 생성하고 MCP JSON Schema와 같은 source definition을 공유할 수 있습니다.

개념 예시:

```ts
type MemoryKind =
  | "learning"
  | "decision"
  | "preference"
  | "failure"
  | "procedure"
  | "constraint";

type MemoryStatus =
  | "proposed"
  | "confirmed"
  | "verified"
  | "superseded"
  | "deprecated"
  | "deleted";

type Scope =
  | { type: "global"; id: string }
  | { type: "organization"; id: string }
  | { type: "repository"; id: string }
  | { type: "project"; id: string }
  | { type: "path"; id: string }
  | { type: "task"; id: string };

type ApiResult<T> =
  | { request_id: string; data: T }
  | {
      error: {
        code: string;
        message: string;
        request_id: string;
        retryable: boolean;
        details?: Array<Record<string, unknown>>;
      };
    };
```

## 구현 완료 조건

- 같은 상태 변경 요청을 같은 key로 반복해도 업무 row가 중복 생성되지 않습니다.
- 같은 key와 다른 body는 `409`로 거부됩니다.
- 수정되지 않은 GitHub Issue와 댓글은 새 snapshot을 만들지 않습니다.
- 실패한 sync는 checkpoint를 전진시키지 않습니다.
- GitHub sync credential로 기억을 읽거나 쓸 수 없습니다.
- MCP credential로 허용 범위 밖 repository와 기억에 접근할 수 없습니다.
- `confirmed` 생성, confirm, supersede에는 명시적 사용자 근거와 해당 permission이 모두 필요합니다.
- 민감정보가 원본, 기억, idempotency payload, 감사 payload와 server log에 저장되지 않습니다.
- supersede의 양쪽 상태와 관계는 원자적으로 변경됩니다.
- Context Pack은 하나의 일관된 read snapshot에서 생성됩니다.
- API 응답과 로그에 SQL, stack trace, credential 원문이 노출되지 않습니다.
- 기억에서 원본 source로, source에서 파생 기억으로 추적할 수 있습니다.
