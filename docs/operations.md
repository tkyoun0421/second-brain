# 운영 환경 설정

이 문서는 현재 구현된 API와 로컬 MCP 서버를 실제 환경에 연결하기 위해 필요한 최소 설정을 설명합니다. 여기의 설정은 배포 자동화나 credential 발급 체계를 새로 결정하지 않습니다. 아직 정해지지 않은 운영 선택은 명시적으로 보류합니다.

## 구성과 비밀 경계

```text
API 서버 전용 비밀: DATABASE_URL, MEMORY_FORGET_PREVIEW_SECRET
API 서버 설정:     SUPABASE_URL, SUPABASE_JWT_ISSUER, SUPABASE_JWT_AUDIENCE, HOST, PORT
MCP 호스트 전용:    SECOND_BRAIN_API_URL, SECOND_BRAIN_MCP_ACCESS_TOKEN
GitHub Actions 전용: SECOND_BRAIN_API_URL, SECOND_BRAIN_GITHUB_SYNC_TOKEN, github.token
```

- API 서버는 PostgreSQL에 연결하고 Supabase JWKS로 bearer JWT를 검증합니다.
- 로컬 MCP 서버는 DB에 연결하지 않고 API에 bearer token을 전달합니다.
- `DATABASE_URL`, Supabase `service_role` key, forget-preview secret은 MCP 호스트·GitHub Actions·저장소 파일에 넣지 않습니다.
- MCP access token은 프로젝트의 `.env`가 아닌 OS 보안 저장소 또는 MCP 클라이언트의 사용자 전용 secret 설정에 둡니다.

## API 서버 환경 변수

`.env.example`은 API 프로세스용 예시입니다. API를 시작하기 전에 다음 값을 배포 환경의 secret/configuration store에 설정합니다.

| 변수 | 필수 | 용도 |
| --- | --- | --- |
| `DATABASE_URL` | 예 | API 서버만 사용하는 PostgreSQL direct 또는 transaction-pooler URL |
| `SUPABASE_URL` | 예 | JWKS URL을 구성할 Supabase 프로젝트 URL |
| `SUPABASE_JWT_ISSUER` | 예 | JWT의 `iss`와 일치해야 하는 issuer |
| `SUPABASE_JWT_AUDIENCE` | 예 | JWT의 `aud`; 기본값은 `authenticated` |
| `MEMORY_FORGET_PREVIEW_SECRET` | 예 | forget preview token 서명용, 최소 32자 비밀값 |
| `HOST` | 아니오 | 기본 `127.0.0.1`; 관리형 HTTPS ingress 뒤 컨테이너에서는 `0.0.0.0` |
| `PORT` | 아니오 | API listen port, 기본값 `3000` |

`SUPABASE_URL`에서 `https://<project>.supabase.co/auth/v1/.well-known/jwks.json`을 구성해 검증 키를 읽습니다. `SUPABASE_JWT_ISSUER`와 `SUPABASE_JWT_AUDIENCE`는 발급한 JWT의 claim과 정확히 일치해야 합니다.

기본 API 진입점은 `127.0.0.1`에 바인딩됩니다. 따라서 같은 장비의 MCP는 `http://127.0.0.1:<PORT>`로 연결할 수 있습니다. 컨테이너 호스팅에서는 `HOST=0.0.0.0`을 설정하고, 플랫폼의 managed HTTPS ingress만 공개합니다. 실행 가능한 절차와 사전 조건은 [배포 가이드](deployment.md)를 따릅니다.

데이터베이스 migration은 API를 시작하기 전에 대상 Supabase/PostgreSQL에 적용해야 합니다. 이 저장소에는 migration 파일은 있지만 배포용 migration 실행 명령이나 hosted Supabase 프로젝트 설정은 포함되어 있지 않습니다.

## JWT 최소 claim

API는 Supabase JWT를 검증한 뒤 다음 custom claim으로 요청 주체를 제한합니다.

```json
{
  "sub": "<Supabase auth.users UUID>",
  "principal_type": "mcp_agent",
  "permissions": ["context:read", "memory:read", "memory:propose", "agent_run:write"],
  "repository_ids": ["<GitHub repository node ID>"],
  "aud": "authenticated"
}
```

`sub`는 tenant 사용자 ID입니다. `principal_type`은 `mcp_agent`, `github_sync`, `operator` 중 해당 실행 주체와 일치해야 합니다. 권한과 `repository_ids` 범위는 endpoint별 권한 검사와 RLS 모두에 적용됩니다.

일반 MCP session은 읽기·제안·실행 기록 권한만 가지는 것이 기본입니다. 사용자 명시 확인을 처리할 때에만 짧은 유효기간의 `memory:confirm` 또는 `memory:supersede` 권한을 추가합니다. forget은 별도의 `memory:forget` 또는 `memory:forget_sensitive` 권한과 preview/execute 확인 흐름을 요구합니다.

Supabase에서 위 custom claim을 어느 hook, server-side issuer 또는 credential broker로 발급할지는 아직 확정하지 않았습니다. 그 체계를 정하기 전에는 placeholder token이나 `service_role` key로 운영하지 않습니다.

## 최소 기동·확인 순서

1. migration을 대상 DB에 적용하고 API 서버 비밀을 설정합니다.
2. API를 `npm run start`로 시작하고 같은 장비에서 `GET /v1/health`가 `{"data":{"status":"ok"}}`를 반환하는지 확인합니다. health endpoint는 process 생존만 확인하며 DB readiness나 credential 상태는 공개하지 않습니다.
3. 위 claim과 최소 권한을 가진 MCP JWT를 사용자 전용 secret store에 저장합니다.
4. MCP 호스트에 API URL과 해당 token만 주입해 MCP 프로세스를 시작합니다.
5. 실제 tenant/repository 범위에서 context 조회와 멱등 write 재시도를 확인합니다. `TEST_DATABASE_URL`을 별도로 설정하면 통합 테스트도 실행할 수 있습니다.

## GitHub Actions 동기화

`.github/workflows/github-issue-sync.yml`은 6시간 증분 동기화, 매주 월요일 정합성 점검 및 수동 실행을 제공합니다. repository Actions secret으로 다음 두 값을 설정해야 합니다.

| Secret | 용도 |
| --- | --- |
| `SECOND_BRAIN_API_URL` | HTTPS로 공개된 API base URL (로컬 loopback URL은 GitHub-hosted runner에서 사용할 수 없음) |
| `SECOND_BRAIN_GITHUB_SYNC_TOKEN` | `principal_type: github_sync`, `github_sync:checkpoint`·`github_source:write` 권한과 해당 repository node ID 범위를 가진 최소 권한 API JWT |

workflow는 GitHub REST 호출에 Actions가 제공하는 임시 `github.token`만 쓰며, DB credential이나 Supabase service-role key를 사용하지 않습니다. `github_sync` token의 발급·회수 방식은 JWT issuer 설계와 함께 아직 확정해야 합니다.
