# 무료 MVP 로드맵

## MVP 목표

첫 번째 버전의 성공 기준은 다음 문장으로 정의합니다.

> GitHub 학습 Issue를 무료로 동기화하고, Codex와 Claude Code가 로컬 MCP를 통해 관련 기억을 읽으며, 사용자가 확정한 결정과 검증된 실패 경험을 다시 저장할 수 있다.

완전한 대화 저장이나 자율 작업은 MVP 목표가 아닙니다.

## 비용 원칙

- 유료 서버를 사용하지 않음
- Supabase Free 범위를 사용
- GitHub Actions 기본 제공량 안에서 실행
- 별도 AI API로 백그라운드 요약하지 않음
- 임베딩 API를 사용하지 않음
- MCP 서버는 로컬에서 필요한 동안만 실행
- 변경된 데이터만 처리

## 구현 현황 (2026-07-31)

- 데이터베이스 migration, RLS 경계와 Node.js·TypeScript API는 구현되었습니다.
- Context 조회·기억 검색, decision/failure 생성, agent run 완료, confirm·supersede 및 forget preview/execute API가 구현되었습니다.
- 표준 입출력 기반 로컬 MCP 서버와 9개 도구가 구현되었습니다.
- GitHub Actions 증분 동기화 workflow(6시간 증분·주간 reconcile·수동 실행)가 구현되었습니다.
- 실제 Supabase 프로젝트 연결, custom JWT claim 발급과 GitHub-hosted runner가 접근할 HTTPS 배포 구성이 남아 있습니다.

구현 완료는 운영 환경이 이미 준비되었다는 뜻이 아닙니다. 필요한 환경 변수와 host 설정은 [운영 환경 설정](operations.md)을 따릅니다.

## 0단계: 설계 기준 확정

완료되었습니다.

- 전체 아키텍처
- 기억 종류, 상태와 범위
- Context Pack과 MCP 계약
- 기억 저장 및 삭제 정책
- MVP 범위와 제외 항목

완료 조건은 문서 사이에 서로 충돌하는 규칙이 없고, 구현 시 필요한 경계가 설명되어 있는 것입니다.

## 1단계: 데이터 기반

### 구현 범위

- Supabase Free 프로젝트
- 데이터베이스 마이그레이션
- 원본, 스냅샷, 기억, 실행 기록과 감사 로그
- 기본 RLS와 최소 권한 인증
- 수집 API
- 민감정보 기본 검사
- 멱등성 처리

### 완료 조건

- 같은 요청을 반복해도 데이터가 중복되지 않음
- 기억에서 원본 출처를 찾을 수 있음
- 범위와 상태를 저장하고 변경할 수 있음
- 비인가 요청이 데이터를 읽거나 쓰지 못함

구현은 완료되었고, 실제 Supabase 환경에서 migration 적용 및 JWT 발급 정책을 확정하는 운영 검증이 남아 있습니다.

## 2단계: GitHub Issue 동기화

### 구현 범위

- GitHub Actions workflow
- 변경된 Issue와 댓글 증분 조회
- 6시간 주기 실행
- 수동 실행
- 주 1회 정합성 확인
- 내용 해시 기반 버전 생성
- 동기화 실행 결과와 오류 기록

### 완료 조건

- 새 Issue가 DB에 저장됨
- 수정한 Issue만 새 스냅샷이 생김
- workflow를 재실행해도 중복되지 않음
- 삭제, 상태 변경과 라벨 변경을 반영함
- 실패 후 다음 실행에서 복구 가능

workflow와 증분 수집 어댑터는 구현되었습니다. reconcile은 완전한 원격 목록 수집 후 서버가 `last_seen_sync_run_id`로 누락 후보와 두 번째 누락 tombstone을 반영합니다. 실제 실행에는 `SECOND_BRAIN_API_URL`, Supabase 로그인 설정, `github_sync` 기술 계정, HTTPS API 배포가 필요합니다.

## 3단계: 로컬 MCP

### 구현 범위

- `brain_get_context`
- `brain_search`
- `brain_get_detail`
- `brain_save_decision`
- `brain_save_failure`
- `brain_finish_run`
- `brain_confirm_memory`
- `brain_supersede_memory`
- `brain_forget`

Codex와 Claude Code가 같은 서버를 사용하도록 설정합니다.

### 완료 조건

- 작업 시작 시 관련 프로젝트 기억을 조회할 수 있음
- 사용자의 확정된 결정이 `confirmed`로 저장됨
- AI 추론은 `proposed`로만 저장됨
- 실패의 가설과 검증된 해결을 구분함
- 작업 결과와 사용한 기억을 기록함
- MCP 장애를 AI가 명확히 알 수 있음

9개 도구와 API forwarding은 구현되었습니다. 각 MCP 클라이언트의 사용자 전용 secret 설정과 실제 API 연결은 운영 환경에서 확인해야 합니다.

## 4단계: 기억 품질과 복구

### 구현 범위

- Memory Inbox 조회와 확인
- 충돌 탐지
- 사용한 기억의 유용성 평가
- JSONL 및 Markdown 내보내기
- 로컬 백업 절차
- 잘못된 기억 수정 및 완전 삭제 절차

### 완료 조건

- 충돌한 기억을 AI가 임의로 선택하지 않음
- 오래된 기억을 신규 결정으로 교체할 수 있음
- 전체 기억을 외부 형식으로 내보낼 수 있음
- 민감정보 삭제 범위를 확인할 수 있음

## MVP 제외 항목

- 벡터 및 임베딩 검색
- 실시간 GitHub webhook
- 별도 웹 관리 화면
- 전체 대화 자동 수집과 요약
- 별도 LLM을 이용한 기억 추출
- 여러 AI의 동시 쓰기 조정
- 자동 PR 생성과 병합
- 배포 및 DB 변경 자동 승인
- 24시간 실행되는 자율 에이전트

## 운영 예산 보호

### GitHub Actions

- Linux 기본 러너 사용
- 6시간 주기
- 짧은 timeout 설정
- workflow artifact를 생성하지 않음
- 동시 실행을 제한
- 변경분만 조회

### Supabase

- 원본이 실제 변경된 경우에만 스냅샷 추가
- 큰 로그와 첨부파일 저장 제한
- DB 사용량 확인
- 무료 한도에 가까워지면 보존 정책부터 조정

### AI

- 현재 Codex 또는 Claude가 MCP 입력을 구조화
- 별도 요약 API 호출 금지
- Context Pack 크기 제한
- 원문은 필요할 때만 조회

## 구현 전에 남은 선택

다음 선택은 설계가 아니라 실제 구현을 시작할 때 확정합니다.

1. Supabase custom JWT claim의 발급·회수 방식과 실제 토큰 범위
2. GitHub App 또는 GitHub Actions 기본 토큰 사용 범위
3. MCP가 원격 API에 연결할 경우 HTTPS·네트워크 경로
4. 한국어 검색을 위한 `pg_trgm` 적용 방식
5. 로컬 백업 위치와 암호화 여부

## 다음 구현 순서

```text
실제 Supabase/JWT 및 GitHub Actions·MCP host 연결 검증
→ GitHub reconcile tombstone 대조와 Memory Inbox 충돌 처리
→ 내보내기와 운영 점검
```
