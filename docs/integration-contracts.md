# GitHub 동기화 및 로컬 MCP 통합 계약

## 목적과 범위

이 문서는 GitHub Issues를 원본 저장소로 동기화하는 작업과 로컬 MCP 서버가 제공하는 9개 도구의 구현 계약을 정의합니다.

MVP의 경계는 다음과 같습니다.

- GitHub Actions는 GitHub 원본을 읽고 수집 API를 호출합니다.
- 로컬 MCP 서버는 에이전트의 요청을 검증하고 같은 수집 API를 호출합니다.
- 두 클라이언트는 Supabase 관리자 키나 내부 테이블에 직접 접근하지 않습니다.
- GitHub는 Issue와 댓글의 Source of Truth이며 DB의 원본 복제본은 직접 수정하지 않습니다.
- 별도 LLM을 이용한 자동 요약, 실시간 webhook, PR 동기화는 MVP 범위가 아닙니다.

이 문서에서 `MUST`, `MUST NOT`, `SHOULD`는 구현 간 호환성을 위한 요구사항입니다.

## 공통 표현

- 계약 버전은 `v1`입니다.
- 시간은 UTC RFC 3339 형식으로 주고받습니다. 예: `2026-07-31T03:15:22Z`
- 외부 ID는 숫자로 변환하지 않고 문자열로 전달합니다. GitHub의 큰 정수 ID가 JavaScript 정밀도 범위를 넘을 수 있기 때문입니다.
- 해시는 `sha256:<lowercase-hex>` 형식입니다.
- 입력 객체는 별도 표기가 없으면 알 수 없는 필드를 거부합니다.
- 빈 문자열은 값이 없는 것으로 취급하지 않습니다. 선택 필드는 필요하지 않으면 생략합니다.
- API와 MCP 로그는 비밀번호, 토큰, 세션 쿠키, `.env` 내용과 개인정보를 저장하지 않습니다.

---

# 1. GitHub Issues 증분 동기화 계약

## 1.1 동기화 대상과 식별자

동기화 대상은 Issue와 Issue comment입니다. GitHub REST 응답에 `pull_request` 필드가 있는 항목은 제외합니다.

| 엔티티 | 논리 식별자 | 보조 식별자 |
|---|---|---|
| repository | `repository_id` | `owner/name`, URL |
| issue | `repository_id + issue_number` | `issue_id`, `node_id` |
| comment | `repository_id + comment_id` | `issue_number`, `node_id` |

아키텍처의 기본 식별자는 `repository_id + issue_number`이지만, 동기화기는 이동·복원·중복 진단을 위해 GitHub의 `issue_id`와 `node_id`도 보존해야 합니다. 저장소 이름 변경은 새 repository를 만들지 않습니다.

## 1.2 실행 종류

| 모드 | 주기 | 목적 |
|---|---|---|
| `incremental` | 6시간마다 | 마지막 완료 지점 이후 변경분 수집 |
| `reconcile` | 주 1회 | 전체 Issue·댓글 목록과 DB 복제본의 정합성 확인 |
| `manual` | 필요 시 | 운영자가 선택한 repository 또는 Issue를 재수집 |

동일 repository에 대한 실행은 한 번에 하나만 활성화합니다. 이미 실행 중이면 새 실행은 `skipped_concurrent`로 종료하거나 기존 실행이 끝난 뒤 시작해야 하며, 동시에 서로 다른 커서를 전진시키면 안 됩니다.

## 1.3 영속 커서와 overlap window

repository별 커서는 다음 논리 구조를 가집니다.

```json
{
  "repository_id": "987654321",
  "successful_through": "2026-07-31T00:00:00Z",
  "last_run_id": "ghsync_01K...",
  "last_mode": "incremental",
  "contract_version": "v1"
}
```

증분 실행은 다음 순서를 MUST 따릅니다.

1. 실행 시작 전에 `run_started_at`을 고정합니다.
2. `query_since = successful_through - overlap_window`를 계산합니다.
3. Issue 변경 목록과 comment 변경 목록을 각각 `query_since`부터 조회합니다.
4. 모든 페이지를 읽고 각 항목이 수집 API에서 종결 상태가 될 때까지 처리합니다.
5. 실행이 커서 전진 가능 조건을 만족하면 `successful_through = run_started_at`으로 한 번만 갱신합니다.

기본 `overlap_window`는 15분이며 설정 가능 범위는 5분 이상 6시간 이하입니다. GitHub API의 초 단위 경계, 페이지 이동 중 변경, 지연된 가시성을 흡수하기 위한 값입니다.

`updated_at > run_started_at`인 항목을 실행 중 우연히 받았으면 저장해도 되지만, 커서는 여전히 `run_started_at`까지만 전진합니다. 따라서 다음 실행에서 해당 항목을 다시 조회하게 됩니다.

커서가 없는 최초 실행은 임의의 최근 구간만 증분 조회하지 않고 `reconcile`로 전체 기준선을 만든 뒤 커서를 생성합니다. 커서 형식이 손상됐거나 지원하지 않는 계약 버전이면 커서를 추측해 전진시키지 않고 전체 reconcile을 요구합니다.

커서는 다음 조건을 모두 만족할 때만 전진합니다.

- GitHub의 모든 예정된 페이지 조회가 성공했습니다.
- 각 수집 항목이 `accepted`, `duplicate` 또는 `quarantined_permanent` 중 하나로 종결됐습니다.
- 재시도 가능한 항목이 남아 있지 않습니다.
- repository 접근 권한과 식별자가 실행 도중 유효했습니다.

네트워크 오류, GitHub rate limit, 수집 API `5xx`, 처리되지 않은 부분 배치가 있으면 커서를 갱신하지 않습니다.

`quarantined_permanent`는 원본 응답의 비밀값을 제거한 진단 정보와 payload hash를 보존하고 운영자가 재처리할 수 있어야 합니다. 영구 오류 한 건 때문에 정상 변경 전체가 영원히 막히지 않게 하기 위한 예외이며, 실행 결과는 `completed_with_errors`가 됩니다.

## 1.4 조회 스트림

Issue와 comment는 독립된 변경 스트림으로 조회합니다.

### Issue 스트림

- `state=all`로 open과 closed를 모두 조회합니다.
- `since=query_since`를 사용합니다.
- 모든 페이지를 순회합니다.
- PR 항목을 제외합니다.
- 학습 대상 label 필터는 GitHub 변경 목록 조회에 적용하지 않고 응답을 받은 뒤 적용합니다. 원격 조회 자체를 label로 제한하면 label이 제거된 기존 대상을 놓칠 수 있습니다.
- 처리 순서는 가능하면 `(updated_at, issue_id)` 오름차순으로 정규화합니다.

### Comment 스트림

- repository comment 목록에서 `since=query_since` 이후 생성·수정된 댓글을 조회합니다.
- 댓글을 저장하기 전에 부모 Issue가 존재하도록 Issue 최소 레코드를 먼저 upsert할 수 있습니다.
- 변경된 Issue를 처리할 때 해당 Issue의 전체 댓글 목록도 조회하여 댓글 삭제를 조기에 발견할 수 있습니다.
- 주간 `reconcile`은 동기화 대상 Issue의 전체 댓글 목록을 기준으로 누락된 댓글을 검사합니다.

Issue의 `updated_at` 변경만으로 댓글 변경을 추론하면 안 됩니다. comment 스트림의 커버리지가 반드시 별도로 있어야 합니다.

## 1.5 정규화와 content hash

원본 응답은 민감정보 검사 후 원본 이벤트로 보존할 수 있지만, 버전 생성 여부는 정규화된 payload의 content hash로 판단합니다.

정규화 규칙은 다음과 같습니다.

1. JSON 객체 키를 사전식으로 정렬합니다.
2. 배열 중 순서가 의미 없는 labels, assignees는 안정적인 GitHub ID 순으로 정렬합니다.
3. 본문의 CRLF는 LF로 정규화하되 그 밖의 공백은 보존합니다.
4. 누락 필드와 `null`은 서로 다르게 취급합니다.
5. `updated_at`, API URL, pagination 정보처럼 내용 의미가 없는 전달 메타데이터는 hash에서 제외합니다.
6. 정규화된 JSON을 UTF-8로 직렬화한 뒤 SHA-256을 계산합니다.

snapshot에는 `hash_version=v1`을 함께 저장합니다. 정규화 규칙이 바뀌면 기존 hash 의미를 바꾸지 않고 새 hash version을 도입해야 합니다.

Issue hash에는 최소한 다음 값이 포함됩니다.

```json
{
  "issue_id": "123",
  "node_id": "I_kw...",
  "number": 42,
  "title": "제목",
  "body": "본문",
  "state": "open",
  "state_reason": null,
  "locked": false,
  "author_id": "456",
  "assignee_ids": [],
  "labels": [
    {
      "id": "789",
      "name": "learning",
      "color": "0e8a16",
      "description": null
    }
  ],
  "milestone_id": null,
  "created_at": "2026-07-01T00:00:00Z"
}
```

Comment hash에는 최소한 다음 값이 포함됩니다.

```json
{
  "comment_id": "991",
  "node_id": "IC_kw...",
  "issue_number": 42,
  "author_id": "456",
  "body": "댓글 본문",
  "created_at": "2026-07-02T00:00:00Z"
}
```

현재 hash가 마지막 저장 hash와 같으면 새 스냅샷을 만들지 않고 `last_seen_at`만 갱신합니다. hash가 다르면 새 immutable snapshot을 만들고 현재 버전 포인터를 갱신합니다.

제목·본문이 같더라도 labels, open/closed 상태, `state_reason`, assignee, milestone이 바뀌면 새 Issue snapshot을 생성해야 합니다.

## 1.6 상태, label, 댓글 처리

### Issue 상태

- `open`과 `closed`는 삭제 상태가 아닙니다.
- 재개된 Issue는 새 snapshot을 만들고 현재 상태를 `open`으로 갱신합니다.
- `state_reason`은 `completed`, `not_planned`, `reopened` 등 GitHub가 반환한 값을 보존합니다.
- 상태 변경은 원본 복제본을 갱신하지만 기존 기억을 자동으로 `confirmed` 또는 `deleted`로 바꾸지 않습니다.

### Labels

- labels는 부분 patch가 아니라 매 실행에서 받은 전체 집합으로 교체합니다.
- label 이름뿐 아니라 안정적인 label ID를 보존합니다.
- label 추가·제거는 새 Issue snapshot의 원인이 됩니다.
- 학습 대상 여부를 label로 판단하는 경우, 대상 label이 제거되면 파생 기억을 즉시 삭제하지 않고 동기화 검토 작업을 `source_review_required`로 생성해야 합니다. 이 값은 기억 상태 enum이 아닙니다.
- label이 다시 추가되면 같은 Issue를 재수집하되 동일 hash snapshot은 중복 생성하지 않습니다.

### Comments

- 댓글은 Issue 본문에 합쳐 저장하지 않고 독립 원본과 독립 버전을 가집니다.
- 새 댓글과 수정 댓글은 comment hash로 구분합니다.
- 댓글 작성자, 생성 시각, 수정 시각, 원본 URL과 부모 Issue 식별자를 보존합니다.
- 댓글 수정은 기존 버전을 덮어쓰지 않습니다.
- 댓글 삭제는 부모 Issue 삭제로 전파하지 않습니다.
- 삭제되거나 수정된 댓글을 근거로 한 기억은 자동 확정하지 않고 근거 재검토 대상으로 표시합니다.

## 1.7 삭제와 접근 불가 구분

단일 `404` 또는 목록 누락 한 번만으로 삭제를 확정하면 안 됩니다.

삭제 판정은 다음 상태를 사용합니다.

```text
active
missing_candidate
deleted
```

`reconcile` 실행에서 기존 active 엔티티가 전체 목록에 없으면 `missing_candidate`로 표시합니다. repository 접근 검사가 성공한 상태에서 두 번의 연속된 전체 reconcile에 같은 엔티티가 없을 때 `deleted` tombstone을 생성합니다. 두 reconcile은 서로 다른 실행이어야 합니다.

다음 경우에는 누락 후보를 만들거나 삭제를 전파하지 않습니다.

- repository 자체가 `401`, `403`, `404`로 접근되지 않음
- pagination이 중간에 실패함
- GitHub rate limit으로 전체 목록을 읽지 못함
- 수집 대상 label 필터가 실행 사이에 잘못 변경됨

삭제 tombstone은 마지막 원본 snapshot을 덮어쓰지 않습니다. tombstone은 최소한 대상 ID, 마지막 hash, 최초 누락 시각, 삭제 확정 시각, 확정한 reconcile run ID를 가집니다.

GitHub 원본 삭제가 확인되어도 외부 GitHub 데이터를 DB에서 복구했다고 표현해서는 안 됩니다. DB에는 검색 복제본과 이력만 남습니다.

## 1.8 수집 요청과 멱등성

각 엔티티 버전은 다음 형식의 결정적 멱등성 키를 사용합니다.

```text
gh:{repository_id}:issue:{issue_id}:{content_hash}
gh:{repository_id}:comment:{comment_id}:{content_hash}
gh:{repository_id}:issue:{issue_id}:tombstone:{last_known_hash}
gh:{repository_id}:comment:{comment_id}:tombstone:{last_known_hash}
```

수집 배치의 각 항목은 독립된 `idempotency_key`를 가져야 합니다. 배치 전체가 재시도돼도 이미 성공한 항목은 `duplicate`로 응답하고 새 snapshot을 만들지 않습니다.

같은 멱등성 키와 같은 정규 payload는 최초 응답을 재사용합니다. 같은 키에 다른 payload hash가 오면 `IDEMPOTENCY_CONFLICT`로 거부합니다.

동기화 전달 보장은 exactly-once가 아니라 at-least-once입니다. exactly-once 효과는 수집 API와 DB의 고유 제약으로 만듭니다.

## 1.9 retry 규칙

| 오류 | 처리 |
|---|---|
| 네트워크 timeout, 연결 끊김 | 지수 backoff 후 재시도 |
| GitHub `429`, rate-limit `403` | `Retry-After` 또는 reset 시각 존중 |
| GitHub `5xx` | 지수 backoff 후 재시도 |
| 수집 API `429`, `5xx` | 동일 멱등성 키로 재시도 |
| 수집 API 항목별 retryable 오류 | 실패 항목만 재전송 |
| GitHub 인증 `401`, 권한 `403` | 실행 실패, 커서 유지, tombstone 금지 |
| 입력 스키마 위반, 차단된 민감정보 | quarantine 후 `completed_with_errors` 가능 |

backoff에는 jitter를 적용하고 한 실행의 총 재시도 시간에는 상한을 둡니다. 상한을 넘기면 실행을 실패시키고 다음 예약 실행에서 같은 overlap 구간을 다시 처리합니다.

로그에는 토큰, Authorization header, 원본 비밀값을 남기지 않습니다. `run_id`, repository ID, page 또는 item ID, 시도 횟수, HTTP 상태, 오류 코드, 다음 재시도 시각만 남깁니다.

## 1.10 reconciliation 알고리즘

주간 `reconcile`은 다음을 검사합니다.

1. repository 접근 가능 여부를 먼저 확인합니다.
2. open/closed 전체 Issue를 pagination 끝까지 읽습니다.
3. 각 대상 Issue의 댓글 전체 목록을 읽습니다.
4. 원격 현재 hash와 로컬 current hash를 비교합니다.
5. 원격에 있고 로컬에 없으면 새 엔티티로 수집합니다.
6. 양쪽에 있지만 hash가 다르면 새 snapshot을 수집합니다.
7. 원격에 없고 로컬에 있으면 첫 누락은 `missing_candidate`, 연속 두 번째 누락은 tombstone으로 처리합니다.
8. 원격에 다시 나타난 `missing_candidate`는 `active`로 복구합니다.
9. 처리되지 않은 retryable 오류가 하나라도 있으면 reconcile을 불완전으로 표시하고 누락 횟수를 증가시키지 않습니다.

reconcile은 마지막 증분 커서를 뒤로 이동시키지 않습니다. 성공한 reconcile 종료 시각이 기존 `successful_through`보다 최신이면 그 시각까지 전진시킬 수 있지만, 실행 전체가 완전했을 때만 허용합니다.

## 1.11 동기화 fixture 계약

구현 테스트 fixture는 다음 공통 구조를 사용해야 합니다.

```json
{
  "name": "fixture-name",
  "initial_cursor": {
    "successful_through": "2026-07-31T00:00:00Z"
  },
  "run": {
    "mode": "incremental",
    "run_started_at": "2026-07-31T06:00:00Z",
    "overlap_seconds": 900
  },
  "github_pages": [],
  "ingest_responses": [],
  "expected": {
    "snapshots_created": [],
    "duplicates": [],
    "quarantined": [],
    "entity_states": {},
    "cursor": {},
    "run_status": "completed"
  }
}
```

최소 fixture 세트는 다음 시나리오를 포함해야 합니다.

| ID | 시나리오 | 기대 결과 |
|---|---|---|
| `GH-01` | 최초 Issue와 댓글 수집 | Issue·comment current 및 snapshot 생성 |
| `GH-02` | overlap 구간의 같은 payload 재수집 | snapshot 0개, `duplicate`, 커서 전진 |
| `GH-03` | Issue 본문 수정 | Issue snapshot만 1개 추가 |
| `GH-04` | 본문 동일, label 제거와 closed 전환 | 새 Issue snapshot, 파생 기억 검토 표시 |
| `GH-05` | 댓글 추가와 기존 댓글 수정 | 각 comment에 독립 snapshot 생성 |
| `GH-06` | 배치 중 수집 API `503` 후 재시도 | 같은 키 재사용, 중복 snapshot 없음 |
| `GH-07` | repository 인증 `403` | 커서 유지, 누락 후보와 tombstone 0개 |
| `GH-08` | 첫 전체 reconcile에서 댓글 누락 | `missing_candidate`, tombstone 없음 |
| `GH-09` | 다음 전체 reconcile에서도 같은 댓글 누락 | comment tombstone 1개 |
| `GH-10` | 누락 후보 댓글이 다시 나타남 | `active` 복구, tombstone 없음 |
| `GH-11` | pagination 중간 실패 | 커서 유지, 누락 횟수 증가 금지 |
| `GH-12` | 실행 시작 후 수정된 항목을 먼저 관찰 | 저장은 허용, 다음 실행에서 재조회 |

### retry fixture 예시

```json
{
  "name": "GH-06-partial-batch-retry",
  "initial_cursor": {
    "successful_through": "2026-07-31T00:00:00Z"
  },
  "run": {
    "mode": "incremental",
    "run_started_at": "2026-07-31T06:00:00Z",
    "overlap_seconds": 900
  },
  "github_pages": [
    {
      "stream": "issues",
      "page": 1,
      "items": [
        {"issue_id": "101", "content_hash": "sha256:aaa"},
        {"issue_id": "102", "content_hash": "sha256:bbb"}
      ]
    }
  ],
  "ingest_responses": [
    {
      "attempt": 1,
      "items": [
        {"issue_id": "101", "status": "accepted"},
        {"issue_id": "102", "status": "retryable_error", "code": "DEPENDENCY_UNAVAILABLE"}
      ]
    },
    {
      "attempt": 2,
      "items": [
        {"issue_id": "102", "status": "accepted"}
      ]
    }
  ],
  "expected": {
    "snapshots_created": ["issue:101:sha256:aaa", "issue:102:sha256:bbb"],
    "duplicates": [],
    "cursor": {
      "successful_through": "2026-07-31T06:00:00Z"
    },
    "run_status": "completed"
  }
}
```

첫 시도 응답이 유실되어 `101`도 재전송되는 변형 fixture에서는 `101`이 `duplicate`로 끝나고 snapshot 수가 그대로여야 합니다.

### 삭제 reconciliation fixture 예시

```json
{
  "name": "GH-08-09-two-pass-comment-deletion",
  "local_before": {
    "comment_id": "991",
    "state": "active",
    "last_known_hash": "sha256:ccc",
    "consecutive_complete_misses": 0
  },
  "runs": [
    {
      "run_id": "reconcile-1",
      "repository_access": "ok",
      "all_pages_complete": true,
      "remote_comment_ids": [],
      "expected_state": "missing_candidate",
      "expected_misses": 1
    },
    {
      "run_id": "reconcile-2",
      "repository_access": "ok",
      "all_pages_complete": true,
      "remote_comment_ids": [],
      "expected_state": "deleted",
      "expected_misses": 2,
      "expected_idempotency_key": "gh:987654321:comment:991:tombstone:sha256:ccc"
    }
  ]
}
```

---

# 2. 로컬 MCP 공통 계약

## 2.1 도구 목록

읽기 도구는 다음 3개입니다.

- `brain_get_context`
- `brain_search`
- `brain_get_detail`

쓰기 도구는 다음 6개입니다.

- `brain_save_decision`
- `brain_save_failure`
- `brain_finish_run`
- `brain_confirm_memory`
- `brain_supersede_memory`
- `brain_forget`

## 2.2 공통 성공·오류 envelope

모든 도구의 성공 결과는 다음 구조를 사용합니다.

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "contract_version": "v1",
    "request_id": "req_01K...",
    "generated_at": "2026-07-31T06:00:00Z"
  }
}
```

오류는 MCP tool result를 실패로 표시하고 본문에 다음 구조를 반환합니다.

```json
{
  "ok": false,
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "사용자가 조치할 수 있는 안전한 설명",
    "retryable": false,
    "details": {
      "field": "scope.scope_id"
    }
  },
  "meta": {
    "contract_version": "v1",
    "request_id": "req_01K...",
    "generated_at": "2026-07-31T06:00:00Z"
  }
}
```

공통 오류 코드는 다음과 같습니다.

| 코드 | retryable | 의미 |
|---|---:|---|
| `INVALID_ARGUMENT` | false | 스키마, 길이, enum 또는 필드 조합 오류 |
| `UNAUTHENTICATED` | false | 로컬 클라이언트 또는 수집 API 인증 실패 |
| `FORBIDDEN` | false | 주체가 해당 scope 또는 쓰기 작업 권한 없음 |
| `NOT_FOUND` | false | repository, memory, run 또는 source 없음 |
| `CONFLICT` | false | 현재 revision이나 상태가 요청 전제와 다름 |
| `IDEMPOTENCY_CONFLICT` | false | 같은 키에 다른 payload 사용 |
| `CONFIRMATION_REQUIRED` | false | 사용자 확정 근거가 필요한 작업 |
| `INVALID_STATE_TRANSITION` | false | 허용되지 않는 기억·실패 상태 전이 |
| `SENSITIVE_DATA_DETECTED` | false | 저장 금지 정보가 입력에서 탐지됨 |
| `RATE_LIMITED` | true | 제한 해제 후 재시도 가능 |
| `DEPENDENCY_UNAVAILABLE` | true | 수집 API, DB 또는 GitHub 일시 장애 |
| `INTERNAL` | 상황별 | 분류하지 못한 서버 오류 |

내부 SQL, 테이블 이름, stack trace, credential 존재 여부는 오류 응답에 포함하지 않습니다.

## 2.3 공통 참조 객체

### RepositoryRef

```json
{
  "id": "987654321",
  "name": "owner/repository",
  "local_path": "C:\\work\\repository"
}
```

`id`는 안정적인 GitHub repository ID이며 MUST입니다. `name`과 `local_path`는 식별 보조값입니다.

### ScopeRef

```json
{
  "type": "repository",
  "id": "987654321",
  "path": null
}
```

`type`은 `global`, `organization`, `repository`, `project`, `path`, `task` 중 하나입니다. `path` scope는 repository ID와 저장소 상대 경로가 모두 필요하며 절대 로컬 경로를 scope ID로 사용하면 안 됩니다.

### SourceRef

```json
{
  "type": "user_message",
  "id": "message_01K...",
  "uri": null,
  "excerpt": "이 프로젝트에서는 pnpm을 사용해."
}
```

`type`은 `github_issue`, `github_comment`, `user_message`, `agent_run`, `document`, `test_result`, `policy_event` 중 하나입니다. `excerpt`는 필요한 최소 범위만 저장하며 민감정보 검사를 통과해야 합니다.

### ConfirmationRef

```json
{
  "origin": "explicit_user",
  "source": {
    "type": "user_message",
    "id": "message_01K..."
  }
}
```

`origin`은 다음 중 하나입니다.

- `explicit_user`: 사용자가 현재 대화에서 명시적으로 확정
- `agent_inference`: 에이전트가 대화나 작업에서 추론
- `verified_execution`: 테스트·재현 가능한 실행 결과가 근거
- `policy_enforcement`: 민감정보 삭제 정책 집행 근거. `brain_forget`에서만 허용

`explicit_user`는 반드시 추적 가능한 사용자 메시지 참조가 있어야 합니다. 에이전트가 작성한 요약문만으로 사용자 확정 근거를 만들 수 없습니다.

## 2.4 confirmed, proposed, verified 강제 규칙

클라이언트가 보낸 상태를 그대로 신뢰하지 않고 서버가 `ConfirmationRef`, 출처와 검증 증거를 검사해 최종 상태를 계산합니다.

| 근거 | 허용되는 최종 기억 상태 |
|---|---|
| `agent_inference` | `proposed`만 |
| `explicit_user` + 유효한 사용자 메시지 참조 | `confirmed` |
| `verified_execution` + 성공한 검증 결과와 run/source 참조 | `verified` |

추가 규칙은 다음과 같습니다.

- `proposed`는 기본 Context Pack과 일반 검색에서 제외합니다.
- `brain_confirm_memory`만 사용자의 명시적 확인으로 proposed를 confirmed로 전환합니다.
- AI가 “사용자가 그럴 것 같다”고 추론한 내용은 confirmed가 될 수 없습니다.
- 검증되지 않은 failure의 원인·해결책은 confirmed나 verified 해결법으로 저장할 수 없습니다.
- 기존 confirmed 기억을 proposed 대안으로 즉시 supersede하면 안 됩니다.
- 쓰기 결과에는 서버가 실제 적용한 `status`와 그 이유를 반환합니다.

## 2.5 쓰기 멱등성

모든 쓰기 도구는 `idempotency_key`를 필수로 받습니다.

- 형식: 클라이언트가 생성한 8~200자의 불투명 문자열
- 같은 인증 주체, 도구 이름, 키, 정규 payload 조합은 최초 결과를 재사용합니다.
- 같은 키에 다른 정규 payload를 보내면 `IDEMPOTENCY_CONFLICT`입니다.
- timeout 후 결과를 알 수 없으면 새 키를 만들지 않고 같은 키로 재시도합니다.
- 성공 응답의 `data.replayed`로 최초 처리인지 재생인지 알 수 있어야 합니다.

읽기 도구는 별도 멱등성 키가 없습니다. 반복 호출은 안전하지만 `last_used_at`, 감사 로그, 최신 데이터와 검색 순위 때문에 바이트 단위로 같은 결과를 보장하지 않습니다. 결과의 `snapshot_at` 또는 `generated_at`을 함께 사용합니다.

---

# 3. MCP 읽기 도구 계약

## 3.1 `brain_get_context`

현재 작업 시작에 필요한 3,000토큰 이하의 Context Pack을 반환합니다.

### 입력

```json
{
  "repository": {
    "id": "987654321",
    "name": "owner/repository",
    "local_path": "C:\\work\\repository"
  },
  "task": "인증 미들웨어의 refresh token 오류 수정",
  "paths": ["src/auth", "tests/auth"],
  "tags": ["auth", "refresh-token"],
  "token_budget": 3000,
  "per_kind_limit": 5,
  "total_limit": 20
}
```

- `repository.id`, `task`는 필수입니다.
- `paths`는 저장소 상대 경로이며 최대 20개입니다.
- `tags`는 최대 20개입니다.
- `token_budget` 기본값과 최댓값은 3,000입니다.
- `per_kind_limit` 기본값은 5, `total_limit` 기본값과 최댓값은 20입니다.

### 출력

```json
{
  "ok": true,
  "data": {
    "repository": {
      "id": "987654321",
      "name": "owner/repository"
    },
    "task": "인증 미들웨어의 refresh token 오류 수정",
    "constraints": [],
    "decisions": [],
    "preferences": [],
    "related_learning": [],
    "past_failures": [],
    "procedures": [],
    "conflicts": [],
    "sources": [],
    "truncated": false,
    "additional_search_suggested": false,
    "snapshot_at": "2026-07-31T06:00:00Z"
  },
  "meta": {
    "contract_version": "v1",
    "request_id": "req_01K...",
    "generated_at": "2026-07-31T06:00:00Z"
  }
}
```

각 기억 항목은 `id`, `kind`, 짧은 `statement`, `status`, `scope`, `confidence`, `source_ids`, `updated_at`을 포함합니다. 원본 전문은 포함하지 않습니다.

충돌은 상충하는 memory ID와 각각의 근거, `requires_user_confirmation`을 포함하며 서버가 임의로 승자를 고르지 않습니다.

### 오류·멱등성·상태 규칙

- 주요 오류: `INVALID_ARGUMENT`, `NOT_FOUND`, `FORBIDDEN`, `DEPENDENCY_UNAVAILABLE`
- 반복 호출은 안전하지만 최신 기억과 사용 시각에 따라 순위가 달라질 수 있습니다.
- `confirmed`, `verified` 활성 기억만 기본 결과에 포함합니다.
- `proposed`, `superseded`, `deprecated`, `deleted`는 포함하지 않습니다.
- MCP가 실패하면 클라이언트는 빈 Context Pack을 성공 결과처럼 만들거나 기억을 읽었다고 말하면 안 됩니다.

## 3.2 `brain_search`

기억 종류, 상태와 scope를 지정해 구조화 문자열 검색을 수행합니다.

### 입력

```json
{
  "query": "refresh token 재사용 오류",
  "kinds": ["failure", "decision"],
  "scopes": [
    {"type": "repository", "id": "987654321"}
  ],
  "mode": "active",
  "statuses": ["confirmed", "verified"],
  "tags": ["auth"],
  "limit": 20,
  "cursor": null
}
```

- `query`는 1~500자입니다.
- `kinds`는 `learning`, `decision`, `preference`, `failure`, `procedure`, `constraint`의 부분집합입니다.
- `mode`는 `active` 또는 `inbox`입니다.
- `active` 모드의 기본 상태는 `confirmed`, `verified`입니다.
- `inbox` 모드는 `proposed`만 조회하며 Memory Inbox 용도입니다.
- `limit` 기본값은 20, 최댓값은 50입니다.
- `cursor`는 서버가 발급한 불투명 문자열입니다.

### 출력

```json
{
  "ok": true,
  "data": {
    "items": [
      {
        "id": "mem_01K...",
        "kind": "failure",
        "statement": "만료된 refresh token 재사용은 세션 회전을 중단시킨다.",
        "status": "verified",
        "scope": {"type": "repository", "id": "987654321"},
        "source_ids": ["run_01K..."],
        "score_reasons": ["same_repository", "exact_tag", "verified"]
      }
    ],
    "next_cursor": null,
    "snapshot_at": "2026-07-31T06:00:00Z"
  },
  "meta": {
    "contract_version": "v1",
    "request_id": "req_01K...",
    "generated_at": "2026-07-31T06:00:00Z"
  }
}
```

### 오류·멱등성·상태 규칙

- 주요 오류: `INVALID_ARGUMENT`, `FORBIDDEN`, `DEPENDENCY_UNAVAILABLE`
- 같은 cursor를 반복 사용해도 데이터 변경으로 결과가 달라질 수 있으므로 cursor에는 만료 시각 또는 snapshot 기준이 있어야 합니다.
- `mode=active`에서 `proposed`를 요청하거나 `mode=inbox`에서 활성 상태를 요청하면 `INVALID_ARGUMENT`입니다.
- 일반 검색에서 `superseded`, `deprecated`, `deleted`를 반환하지 않습니다.
- 검색은 상태를 변경하지 않지만 감사 로그와 `last_used_at`을 갱신할 수 있습니다.

## 3.3 `brain_get_detail`

선택한 기억의 상세 내용, 근거, 대체 관계와 사용·검증 이력을 반환합니다.

### 입력

```json
{
  "memory_id": "mem_01K...",
  "include_source_excerpt": true,
  "include_history": true
}
```

`memory_id`는 필수입니다. 원본 전문을 반환하는 옵션은 제공하지 않습니다.

### 출력

```json
{
  "ok": true,
  "data": {
    "memory": {
      "id": "mem_01K...",
      "kind": "decision",
      "statement": "이 저장소의 패키지 관리자는 pnpm이다.",
      "rationale": "workspace와 lockfile을 단일 도구로 관리한다.",
      "status": "confirmed",
      "confidence": 1,
      "scope": {"type": "repository", "id": "987654321"},
      "tags": ["package-manager"],
      "valid_from": "2026-07-01T00:00:00Z",
      "valid_until": null,
      "sources": [],
      "supersedes_id": null,
      "superseded_by_id": null,
      "created_at": "2026-07-01T00:00:00Z",
      "updated_at": "2026-07-01T00:00:00Z",
      "revision": 1
    },
    "usage_history": [],
    "verification_history": []
  },
  "meta": {
    "contract_version": "v1",
    "request_id": "req_01K...",
    "generated_at": "2026-07-31T06:00:00Z"
  }
}
```

### 오류·멱등성·상태 규칙

- 주요 오류: `INVALID_ARGUMENT`, `NOT_FOUND`, `FORBIDDEN`, `DEPENDENCY_UNAVAILABLE`
- 반복 호출은 안전합니다.
- ID를 명시한 상세 조회는 권한이 있으면 `proposed`, `superseded`, `deprecated`도 반환할 수 있으며 상태를 숨기면 안 됩니다.
- `deleted` 기억은 본문과 원본 excerpt를 반환하지 않고 삭제 상태, 최소 감사 메타데이터와 삭제 시각만 반환합니다.

---

# 4. MCP 쓰기 도구 계약

## 4.1 `brain_save_decision`

사용자의 확정된 결정 또는 AI가 제안한 결정을 저장합니다.

### 입력

```json
{
  "idempotency_key": "session-42-decision-1",
  "statement": "이 저장소에서는 pnpm을 사용한다.",
  "rationale": "기존 pnpm lockfile과 workspace 구성을 유지한다.",
  "alternatives_not_chosen": ["npm", "yarn"],
  "scope": {"type": "repository", "id": "987654321"},
  "tags": ["package-manager"],
  "valid_from": "2026-07-31T06:00:00Z",
  "valid_until": null,
  "status_intent": "confirmed",
  "confirmation": {
    "origin": "explicit_user",
    "source": {"type": "user_message", "id": "message_01K..."}
  }
}
```

- `statement`, `scope`, `status_intent`, `confirmation`, `idempotency_key`는 필수입니다.
- `status_intent`는 `proposed` 또는 `confirmed`만 허용합니다.
- 전역 scope는 사용자가 전역 적용을 명시한 경우에만 허용합니다.

### 출력

```json
{
  "ok": true,
  "data": {
    "memory_id": "mem_01K...",
    "status": "confirmed",
    "status_reason": "explicit_user_confirmation",
    "created": true,
    "replayed": false,
    "revision": 1
  },
  "meta": {
    "contract_version": "v1",
    "request_id": "req_01K...",
    "generated_at": "2026-07-31T06:00:00Z"
  }
}
```

### 오류·멱등성·상태 규칙

- 주요 오류: `INVALID_ARGUMENT`, `CONFIRMATION_REQUIRED`, `SENSITIVE_DATA_DETECTED`, `IDEMPOTENCY_CONFLICT`, `FORBIDDEN`
- 같은 키와 payload는 같은 memory ID를 반환합니다.
- `agent_inference`는 `status_intent=proposed`만 허용합니다.
- `status_intent=confirmed`인데 유효한 사용자 메시지 참조가 없으면 `CONFIRMATION_REQUIRED`입니다.
- 기존 결정과 충돌해도 자동 supersede하지 않고 새 기억을 저장한 뒤 충돌을 반환하거나 `brain_supersede_memory` 사용을 안내합니다.

## 4.2 `brain_save_failure`

증상, 시도, 원인 또는 가설, 해결 방법과 검증 결과를 저장합니다.

### 입력

```json
{
  "idempotency_key": "session-42-failure-1",
  "title": "refresh token 회전 후 세션 종료",
  "symptom": "두 번째 갱신 요청이 401을 반환한다.",
  "environment": "Node.js API, repository 987654321",
  "attempts": [
    {
      "description": "쿠키 만료 시간을 연장했다.",
      "outcome": "증상 지속"
    }
  ],
  "cause": {
    "statement": "이전 token 재사용 감지가 새 세션도 폐기한다.",
    "certainty": "hypothesis"
  },
  "resolution": "세션 계보 단위로 재사용 감지를 격리한다.",
  "verification": {
    "status": "not_run",
    "summary": null,
    "source": null
  },
  "failure_status": "hypothesis",
  "memory_status_intent": "proposed",
  "scope": {"type": "repository", "id": "987654321"},
  "tags": ["auth", "refresh-token"],
  "confirmation": {
    "origin": "agent_inference",
    "source": {"type": "agent_run", "id": "run_01K..."}
  }
}
```

`failure_status`는 `observed`, `investigating`, `hypothesis`, `resolved`, `verified`, `recurring` 중 하나입니다.

`memory_status_intent`는 `proposed`, `confirmed`, `verified` 중 하나입니다. `confirmed`는 원인과 해결 상태까지 사용자가 명시적으로 확인한 경우에만 허용하고, `verified`는 아래 검증 증거를 요구합니다.

검증 완료 예시는 다음 필드를 사용합니다.

```json
{
  "status": "passed",
  "summary": "회전·재사용·만료 테스트 12개 통과",
  "source": {"type": "test_result", "id": "test_01K..."}
}
```

### 출력

```json
{
  "ok": true,
  "data": {
    "memory_id": "mem_01K...",
    "failure_id": "failure_01K...",
    "memory_status": "proposed",
    "failure_status": "hypothesis",
    "created": true,
    "replayed": false,
    "revision": 1
  },
  "meta": {
    "contract_version": "v1",
    "request_id": "req_01K...",
    "generated_at": "2026-07-31T06:00:00Z"
  }
}
```

### 오류·멱등성·상태 규칙

- 주요 오류: `INVALID_ARGUMENT`, `INVALID_STATE_TRANSITION`, `CONFIRMATION_REQUIRED`, `SENSITIVE_DATA_DETECTED`, `IDEMPOTENCY_CONFLICT`
- 같은 키와 payload는 같은 failure와 memory ID를 반환합니다.
- 원인 certainty가 `hypothesis`이면 기억은 `proposed`만 가능합니다.
- `failure_status=verified`와 memory `verified`는 `verification.status=passed`와 test 또는 agent run source가 모두 있어야 합니다.
- 해결됐지만 검증하지 않은 경우 `failure_status=resolved`까지 허용하며 verified로 승격하지 않습니다.
- 사용자가 실패 사실을 확인했어도 검증되지 않은 해결책은 confirmed 해결법으로 표현하지 않습니다.

## 4.3 `brain_finish_run`

에이전트 작업 한 번의 목표, 결과, 변경, 검증과 기억 사용 피드백을 기록합니다.

### 입력

```json
{
  "idempotency_key": "session-42-finish",
  "session_id": "session-42",
  "agent": "codex",
  "repository": {"id": "987654321", "name": "owner/repository"},
  "goal": "refresh token 오류 수정",
  "started_at": "2026-07-31T05:30:00Z",
  "finished_at": "2026-07-31T06:00:00Z",
  "result": "success",
  "summary": "세션 계보 단위로 재사용 감지를 격리했다.",
  "changed_files": ["src/auth/refresh.ts", "tests/auth/refresh.test.ts"],
  "actions": [
    {"kind": "test", "summary": "인증 테스트 실행"}
  ],
  "verification": [
    {
      "kind": "test",
      "status": "passed",
      "summary": "12 tests passed",
      "source_id": "test_01K..."
    }
  ],
  "used_memories": [
    {"memory_id": "mem_01K...", "feedback": "helpful"}
  ],
  "created_memory_ids": ["mem_01J..."],
  "failure_ids": []
}
```

- `result`는 `success`, `partial`, `failed`, `aborted` 중 하나입니다.
- memory feedback은 `helpful`, `irrelevant`, `outdated`, `incorrect`, `conflicting` 중 하나입니다.
- `changed_files`는 repository 상대 경로만 허용합니다.
- 명령의 전체 stdout, 환경 변수와 credential은 저장하지 않습니다.

### 출력

```json
{
  "ok": true,
  "data": {
    "run_id": "run_01K...",
    "result": "success",
    "recorded_feedback_count": 1,
    "created": true,
    "replayed": false
  },
  "meta": {
    "contract_version": "v1",
    "request_id": "req_01K...",
    "generated_at": "2026-07-31T06:00:00Z"
  }
}
```

### 오류·멱등성·상태 규칙

- 주요 오류: `INVALID_ARGUMENT`, `NOT_FOUND`, `SENSITIVE_DATA_DETECTED`, `IDEMPOTENCY_CONFLICT`, `CONFLICT`
- 같은 session의 완료 기록은 같은 키와 payload로만 재생할 수 있습니다.
- `created_memory_ids`는 이미 생성된 기억 참조이며 이 도구가 상태를 confirmed로 올리지 않습니다.
- 사용 피드백은 기억을 자동 삭제·supersede하지 않습니다.
- `incorrect`, `outdated`, `conflicting` 피드백은 검토 신호만 만들고 활성 상태를 즉시 바꾸지 않습니다.
- 실행 기록 저장 실패를 작업 자체의 성공 기록으로 보고하면 안 됩니다. 클라이언트는 작업 결과와 기록 실패를 구분해 알려야 합니다.

## 4.4 `brain_confirm_memory`

Memory Inbox의 proposed 기억을 사용자의 명시적 확인으로 confirmed로 전환합니다.

### 입력

```json
{
  "idempotency_key": "session-42-confirm-1",
  "memory_id": "mem_01K...",
  "expected_revision": 1,
  "confirmation": {
    "origin": "explicit_user",
    "source": {"type": "user_message", "id": "message_01K..."}
  }
}
```

### 출력

```json
{
  "ok": true,
  "data": {
    "memory_id": "mem_01K...",
    "previous_status": "proposed",
    "status": "confirmed",
    "revision": 2,
    "superseded_memory_id": null,
    "replayed": false
  },
  "meta": {
    "contract_version": "v1",
    "request_id": "req_01K...",
    "generated_at": "2026-07-31T06:00:00Z"
  }
}
```

### 오류·멱등성·상태 규칙

- 주요 오류: `NOT_FOUND`, `CONFIRMATION_REQUIRED`, `CONFLICT`, `INVALID_STATE_TRANSITION`, `IDEMPOTENCY_CONFLICT`
- 같은 키와 payload는 동일 전이 결과를 반환합니다.
- 현재 상태가 proposed이고 revision이 일치할 때만 전환합니다.
- statement나 scope를 함께 수정하지 않습니다. 내용이 달라지면 새 제안 또는 supersede 흐름을 사용합니다.
- 기억에 `pending_supersedes_id`가 있으면 확인과 동시에 기존 기억을 superseded로 바꾸는 작업을 한 transaction에서 수행합니다.
- AI 자체 확인이나 `agent_inference`는 허용하지 않습니다.

## 4.5 `brain_supersede_memory`

기존 기억을 대체할 새 기억을 만들고 관계를 원자적으로 연결합니다.

### 입력

```json
{
  "idempotency_key": "session-42-supersede-1",
  "existing_memory_id": "mem_old",
  "expected_existing_revision": 3,
  "replacement": {
    "kind": "decision",
    "statement": "이 저장소에서는 pnpm 10을 사용한다.",
    "rationale": "workspace catalog 기능을 사용한다.",
    "scope": {"type": "repository", "id": "987654321"},
    "tags": ["package-manager"],
    "valid_from": "2026-07-31T06:00:00Z"
  },
  "status_intent": "confirmed",
  "confirmation": {
    "origin": "explicit_user",
    "source": {"type": "user_message", "id": "message_01K..."}
  }
}
```

replacement의 `kind`와 `scope`는 기존 기억과 동일해야 합니다. scope 동일성은 `type`, `id`, `path`가 모두 같은 경우를 뜻합니다. kind 또는 scope를 바꾸려면 supersede가 아니라 별도의 새 기억으로 저장합니다.

### 출력

확정된 교체:

```json
{
  "ok": true,
  "data": {
    "existing_memory_id": "mem_old",
    "existing_status": "superseded",
    "replacement_memory_id": "mem_new",
    "replacement_status": "confirmed",
    "transition": "superseded",
    "replayed": false
  },
  "meta": {
    "contract_version": "v1",
    "request_id": "req_01K...",
    "generated_at": "2026-07-31T06:00:00Z"
  }
}
```

AI 제안 교체:

```json
{
  "ok": true,
  "data": {
    "existing_memory_id": "mem_old",
    "existing_status": "confirmed",
    "replacement_memory_id": "mem_candidate",
    "replacement_status": "proposed",
    "transition": "proposal_created",
    "replayed": false
  },
  "meta": {
    "contract_version": "v1",
    "request_id": "req_01K...",
    "generated_at": "2026-07-31T06:00:00Z"
  }
}
```

### 오류·멱등성·상태 규칙

- 주요 오류: `NOT_FOUND`, `CONFLICT`, `CONFIRMATION_REQUIRED`, `INVALID_STATE_TRANSITION`, `IDEMPOTENCY_CONFLICT`, `SENSITIVE_DATA_DETECTED`
- confirmed 또는 verified 기억의 교체는 expected revision이 일치해야 합니다.
- `explicit_user` 확정은 기존 상태 변경과 replacement 생성을 한 transaction에서 수행합니다.
- `agent_inference`는 replacement를 proposed로만 만들고 기존 기억은 활성 상태로 유지합니다.
- proposed replacement가 `brain_confirm_memory`로 확인될 때만 기존 기억을 superseded로 바꿉니다.
- 이미 superseded 또는 deleted인 기억을 다시 대체하려 하면 `INVALID_STATE_TRANSITION`입니다.

## 4.6 `brain_forget`

The implemented v1 wire contract uses the API-aligned field names below. `preview` is read-only
and does not need an idempotency key; `execute` needs the preview's matching token and an
idempotency key.

```json
{
  "mode": "preview",
  "memory_id": "42",
  "expected_revision": 3,
  "reason_code": "user_requested",
  "delete_linked_source": false
}
```

`reason_code` is one of `user_requested`, `sensitive_data`, `retention_expired`, or
`unauthorized_source`. `user_requested` execution requires an `explicit_user` confirmation;
the other reasons require a `policy_enforcement` confirmation sourced from `policy_event`.

사용자의 삭제 요청 또는 민감정보 발견에 따라 영향 범위를 미리 보거나 실제 삭제·비식별화합니다.

### 입력

미리 보기:

```json
{
  "idempotency_key": "session-42-forget-preview-1",
  "mode": "preview",
  "memory_id": "mem_01K...",
  "reason": "user_request",
  "confirmation": {
    "origin": "explicit_user",
    "source": {"type": "user_message", "id": "message_01K..."}
  }
}
```

실행:

```json
{
  "idempotency_key": "session-42-forget-execute-1",
  "mode": "execute",
  "memory_id": "mem_01K...",
  "reason": "sensitive_data",
  "preview_token": "forget_preview_01K...",
  "confirmation": {
    "origin": "explicit_user",
    "source": {"type": "user_message", "id": "message_01K..."}
  }
}
```

`reason`은 `user_request`, `sensitive_data`, `retention_policy` 중 하나입니다. `execute`는 같은 대상에 대해 최근 발급된 `preview_token`을 요구합니다. 자동 민감정보 정책 주체가 실행하는 경우에는 `origin=policy_enforcement`와 `type=policy_event`인 정책 감사 참조가 필요하며, 일반 에이전트가 이를 가장하면 안 됩니다.

### 출력

```json
{
  "ok": true,
  "data": {
    "mode": "execute",
    "memory_id": "mem_01K...",
    "status": "deleted",
    "affected": {
      "memories": 1,
      "source_excerpts_redacted": 2,
      "snapshots_redacted": 0,
      "run_references_detached": 1
    },
    "external_sources_deleted": false,
    "audit_record_id": "audit_01K...",
    "replayed": false
  },
  "meta": {
    "contract_version": "v1",
    "request_id": "req_01K...",
    "generated_at": "2026-07-31T06:00:00Z"
  }
}
```

### 오류·멱등성·상태 규칙

- 주요 오류: `NOT_FOUND`, `CONFIRMATION_REQUIRED`, `FORBIDDEN`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `DEPENDENCY_UNAVAILABLE`
- preview와 execute는 서로 다른 멱등성 키를 사용합니다. 각 단계의 재시도에는 원래 키를 재사용합니다.
- 삭제는 새 proposed 또는 confirmed 기억을 만들지 않습니다.
- execute 후 기억 본문과 source excerpt는 일반 조회에서 반환할 수 없습니다.
- 감사 로그에는 대상 ID, 실행 주체, 이유, 시각과 삭제 범위만 남기고 삭제된 원문은 남기지 않습니다.
- GitHub Issue나 댓글 원본을 외부 GitHub에서 삭제하지 않습니다. 응답의 `external_sources_deleted`는 항상 false입니다.
- 부분 삭제가 발생하면 성공으로 응답하지 않고 retryable 오류와 완료·미완료 범위를 반환해야 합니다.

---

# 5. A/B 트랙 합류 요구사항

## 5.1 A 트랙 DB 스키마에 필요한 보장

A 트랙은 실제 테이블 이름과 무관하게 다음 의미를 저장하고 원자적으로 처리할 수 있어야 합니다.

1. repository별 동기화 커서, 마지막 완료 run, 실행 모드와 실행 상태
2. GitHub Issue의 `repository_id + issue_number` 고유 제약과 `issue_id`, `node_id` 보조 식별자
3. GitHub comment의 `repository_id + comment_id` 고유 제약과 부모 Issue FK
4. 엔티티별 current record와 immutable snapshot, `content_hash` 고유성
5. `active`, `missing_candidate`, `deleted`, 연속 누락 횟수와 tombstone 메타데이터
6. label 전체 집합과 Issue snapshot 사이의 재현 가능한 관계
7. 동기화 run, 페이지 또는 batch 처리 결과, quarantine과 retry 상태
8. 인증 주체 + 도구 이름 + 멱등성 키의 고유 제약, request hash와 최초 응답 보존
9. memory revision을 이용한 optimistic concurrency
10. proposed replacement를 보존하는 `pending_supersedes` 관계
11. confirmed supersede 시 기존·신규 기억을 한 transaction에서 전이하는 제약
12. failure 상태와 memory 상태를 별도 필드로 보존하는 구조
13. agent run, 사용 기억 feedback, 검증 출처와 감사 로그
14. forget 실행 시 본문·excerpt 비식별화와 최소 감사 메타데이터 보존을 구분하는 구조

DB 제약은 최소한 다음 불변식을 강제해야 합니다.

- 같은 엔티티와 content hash의 snapshot은 하나뿐입니다.
- 같은 멱등성 키에 서로 다른 request hash를 연결할 수 없습니다.
- 활성 기억이 superseded가 되면 replacement 관계가 존재합니다.
- proposed replacement만으로 기존 confirmed 기억을 비활성화할 수 없습니다.
- deleted 기억의 민감 본문과 excerpt는 일반 조회 경로에서 노출되지 않습니다.

## 5.2 B 트랙 수집 API에 필요한 보장

B 트랙은 다음 endpoint 또는 동등한 기능을 제공해야 합니다.

1. GitHub Issue·comment·tombstone의 항목별 멱등 수집과 부분 배치 결과
2. repository 동기화 run 시작, heartbeat 또는 상태 기록, 성공 시 cursor compare-and-set 완료
3. quarantine 기록과 수동 재처리
4. Context Pack 조회, 기억 검색, 상세 조회
5. 6개 MCP 쓰기 작업의 입력 검증과 공통 오류 envelope
6. 사용자 확정 출처와 verified execution 증거 검증
7. optimistic revision 검사와 supersede transaction
8. forget preview token 발급과 원자적 execute
9. 모든 쓰기 및 민감 읽기의 감사 기록

API는 batch 전체 성공만 반환하면 안 됩니다. GitHub 동기화기가 실패 항목만 같은 멱등성 키로 재전송할 수 있도록 항목별로 다음 상태를 반환해야 합니다.

```text
accepted
duplicate
retryable_error
quarantined_permanent
```

API 오류 코드는 이 문서의 MCP 공통 오류 코드와 가능한 한 동일하게 유지하고, HTTP 상태와 도메인 오류 코드를 분리해야 합니다.

## 5.3 공유 contract test

A/B/C 트랙 합류 후 다음 테스트를 같은 fixture로 실행해야 합니다.

- `GH-01`부터 `GH-12`까지의 동기화 fixture
- 모든 쓰기 도구의 같은-key/same-payload 재생
- 모든 쓰기 도구의 same-key/different-payload 충돌
- AI inference를 confirmed로 저장하려는 요청 거부
- 검증 증거 없는 verified failure 거부
- proposed supersede가 기존 confirmed 기억을 유지하는지 확인
- proposed replacement 확인 시 두 기억의 원자적 상태 전이
- stale revision에서 confirm/supersede 충돌
- forget preview 없이 execute 거부
- MCP dependency 장애를 빈 성공 결과로 변환하지 않는지 확인

이 테스트가 통과해야 GitHub Actions와 로컬 MCP stub을 실제 수집 API에 연결할 수 있습니다.
