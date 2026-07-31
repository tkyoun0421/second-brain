# Second Brain

GitHub에 기록한 학습 내용과 AI와 함께 작업하며 생긴 결정, 선호, 실패 및 해결 경험을 모아 다음 작업에 다시 사용하는 개인 지식 시스템입니다.

현재 단계의 목표는 확정된 설계를 바탕으로 MVP 데이터 기반과 인터페이스 계약을 구현하는 것입니다.

## 핵심 방향

- GitHub Issues는 학습 기록의 원본으로 유지합니다.
- PostgreSQL은 통합 검색과 AI 기억을 위한 저장소로 사용합니다.
- GitHub Actions가 Issue 변경 내용을 주기적으로 동기화합니다.
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
- [테스트 전략](docs/test-strategy.md)

## 현재 확정하지 않은 것

- 구현 언어와 프레임워크
- 실제 Supabase 프로젝트와 인증 방식
- 임베딩 모델
- 관리 화면
- 자율 실행 정책의 세부 권한

이 항목들은 MVP 구현을 시작할 때 필요한 범위만 선택합니다.
