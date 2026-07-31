# 기억 모델

## 원본, 기억, 실행 기록

데이터를 세 영역으로 구분합니다.

| 영역 | 설명 | 예시 |
|---|---|---|
| 원본 | 외부 시스템에서 받은 변경하지 않은 기록 | Issue 본문, 댓글, 사용자 메시지 참조 |
| 기억 | 다음 작업에 재사용하도록 정리한 내용 | 결정, 선호, 실패 해결법 |
| 실행 기록 | AI가 수행한 작업과 결과 | 목표, 변경 파일, 테스트 결과 |

원본은 근거이고 기억은 해석입니다. 실행 기록은 새로운 기억을 검증하는 증거가 될 수 있습니다.

## 기억 종류

### `learning`

GitHub Issue 등에서 가져온 학습 내용입니다.

```text
제목
핵심 내용
태그
원본 Issue
관련 기술 및 프로젝트
```

### `decision`

사용자가 명시적으로 확정한 기술적 또는 운영상의 선택입니다.

```text
결정
결정 이유
적용 범위
고려했지만 선택하지 않은 대안
결정한 시점
```

### `preference`

여러 작업에 반복 적용할 수 있는 사용자의 선호입니다.

```text
선호 내용
전역 또는 프로젝트 범위
사용자가 직접 말했는지 여부
마지막 확인 시점
```

### `failure`

실패한 작업과 해결 경험입니다.

```text
증상
상황과 환경
시도한 접근
실제 원인 또는 현재 가설
해결 방법
검증 방법
해결 상태
```

### `procedure`

반복 실행할 수 있는 작업 절차입니다.

```text
목표
사전 조건
순서
검증 방법
중단 조건
승인이 필요한 단계
```

### `constraint`

AI가 작업할 때 반드시 고려해야 할 프로젝트 제약입니다.

```text
금지된 작업
필수 테스트
변경 가능한 경로
승인 조건
```

## 공통 필드

구현 시 기억 엔티티는 최소한 다음 정보를 가져야 합니다.

```text
id
kind
statement
rationale
scope_type
scope_id
status
confidence
source_type
source_id
source_uri
source_excerpt
valid_from
valid_until
supersedes_id
created_at
updated_at
confirmed_at
last_used_at
tags
```

`statement`는 AI가 Context Pack에 넣을 수 있는 짧고 독립적인 문장이어야 합니다. 상세한 설명은 `rationale`과 원본 참조에 둡니다.

## 적용 범위

```text
global
organization
repository
project
path
task
```

구체적인 범위가 일반적인 범위보다 우선합니다.

```text
사용자의 현재 지시
> task
> path
> project
> repository
> organization
> global
```

현재 지시는 기억보다 항상 우선합니다.

## 기억 상태

| 상태 | 의미 |
|---|---|
| `proposed` | AI가 추출했지만 사용자가 확정하지 않음 |
| `confirmed` | 사용자가 명시적으로 확정 |
| `verified` | 실제 작업과 검증을 통해 유효성이 확인됨 |
| `superseded` | 새로운 기억으로 대체됨 |
| `deprecated` | 현재는 권장하지 않지만 이력 보존 |
| `deleted` | 개인정보 또는 보존할 이유가 없어 제거 |

`proposed` 기억은 Memory Inbox에서만 관리하며 기본 Context Pack에는 포함하지 않습니다.

## 기억 생성 규칙

### 바로 `confirmed`로 저장

- 사용자가 “기억해줘”라고 요청한 내용
- 사용자가 선택지 중 하나를 명확하게 확정한 내용
- 사용자가 적용 범위와 함께 선언한 정책
- 사용자가 기존 기억을 직접 수정한 내용

### `proposed`로 저장

- AI가 반복 대화에서 추론한 사용자 성향
- 원인이 확인되지 않은 에러 가설
- 아직 검증되지 않은 해결책
- 사용자가 확정하지 않은 아키텍처 제안

### 저장하지 않음

- 단순 브레인스토밍
- 임시 질문과 후보
- AI가 근거 없이 추측한 사실
- 비밀번호, API 키, 토큰과 개인정보
- 다음 작업에 재사용할 가치가 없는 잡담

## 결정의 변경

기존 기억을 덮어쓰지 않습니다.

```text
기존 기억
status = superseded
superseded_by = 신규 기억 ID

신규 기억
supersedes_id = 기존 기억 ID
status = confirmed
```

이 구조를 통해 어떤 결정이 언제 왜 바뀌었는지 확인할 수 있습니다.

## 충돌

같은 범위에 서로 다른 활성 기억이 있으면 충돌입니다.

예시:

```text
repository 범위: ORM으로 Prisma 사용
repository 범위: ORM을 사용하지 않음
```

Context Builder는 둘 중 하나를 고르지 않고 다음을 반환합니다.

```text
conflict
- 기억 A와 근거
- 기억 B와 근거
- 사용자 확인 필요 여부
```

범위가 다른 경우에는 더 구체적인 범위를 적용하되, 전역 기억과 다른 프로젝트 결정을 함께 보여줄 필요가 있으면 참고 정보로 남깁니다.

## 실패 사례 상태

실패 사례의 해결 상태는 기억 상태와 별도로 관리합니다.

```text
observed       증상만 관찰
investigating  원인 조사 중
hypothesis     원인 또는 해결법이 가설
resolved       해결됐지만 재검증 전
verified       재현 또는 테스트로 해결 확인
recurring      해결 후 다시 발생
```

검증되지 않은 가설을 확정된 해결법처럼 제공하지 않습니다.

## 실행 기록

AI 작업 한 번을 `agent_run`으로 기록합니다.

```text
session_id
agent
repository_id
goal
started_at
finished_at
result
changed_files
commands_or_actions
verification
used_memory_ids
created_memory_ids
failure_ids
```

사용한 기억이 도움이 되었는지도 기록합니다.

```text
helpful
irrelevant
outdated
incorrect
conflicting
```

이 피드백은 별도 AI 학습 없이 다음 검색 순위 계산에 사용합니다.
