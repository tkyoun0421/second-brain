import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const migrationPath = path.join(
  repositoryRoot,
  "supabase",
  "migrations",
  "20260731000100_initial_schema.sql",
);
const designPath = path.join(repositoryRoot, "docs", "db-schema.md");

const migration = fs.readFileSync(migrationPath, "utf8");
const design = fs.readFileSync(designPath, "utf8");
const failures = [];

function assert(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validateLexicalBalance(sql) {
  let parenthesisDepth = 0;
  let state = "normal";
  let dollarTag = "";

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (state === "line-comment") {
      if (character === "\n") {
        state = "normal";
      }
      continue;
    }

    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "normal";
        index += 1;
      }
      continue;
    }

    if (state === "single-quote") {
      if (character === "'" && next === "'") {
        index += 1;
      } else if (character === "'") {
        state = "normal";
      }
      continue;
    }

    if (state === "dollar-quote") {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        state = "normal";
      }
      continue;
    }

    if (character === "-" && next === "-") {
      state = "line-comment";
      index += 1;
    } else if (character === "/" && next === "*") {
      state = "block-comment";
      index += 1;
    } else if (character === "'") {
      state = "single-quote";
    } else if (character === "$") {
      const match = sql.slice(index).match(/^\$[a-zA-Z_][a-zA-Z0-9_]*\$|^\$\$/);
      if (match) {
        dollarTag = match[0];
        state = "dollar-quote";
        index += dollarTag.length - 1;
      }
    } else if (character === "(") {
      parenthesisDepth += 1;
    } else if (character === ")") {
      parenthesisDepth -= 1;
      assert(parenthesisDepth >= 0, `unexpected closing parenthesis at ${index}`);
    }
  }

  assert(state === "normal", `unterminated SQL lexical state: ${state}`);
  assert(parenthesisDepth === 0, `unbalanced parentheses: ${parenthesisDepth}`);
}

validateLexicalBalance(migration);

const expectedTables = [
  "github_accounts",
  "repositories",
  "repository_locations",
  "projects",
  "memory_scopes",
  "sync_runs",
  "sync_checkpoints",
  "source_records",
  "source_snapshots",
  "sync_run_items",
  "agent_runs",
  "memories",
  "memory_failure_details",
  "memory_evidence",
  "agent_run_memories",
  "idempotency_records",
  "audit_events",
];

for (const table of expectedTables) {
  const escapedTable = escapeRegExp(table);

  assert(
    new RegExp(`create table public\\.${escapedTable}\\s*\\(`, "i").test(
      migration,
    ),
    `missing table: ${table}`,
  );
  assert(
    new RegExp(
      `alter table public\\.${escapedTable} enable row level security;`,
      "i",
    ).test(migration),
    `RLS is not enabled: ${table}`,
  );
  assert(
    new RegExp(
      `alter table public\\.${escapedTable} force row level security;`,
      "i",
    ).test(migration),
    `RLS is not forced: ${table}`,
  );
  assert(
    new RegExp(
      `create policy ${escapedTable}_owner_policy\\s+on public\\.${escapedTable}`,
      "i",
    ).test(migration),
    `owner policy is missing: ${table}`,
  );
  assert(design.includes(`\`${table}\``), `design omits table: ${table}`);
}

const identityTables = [
  "github_accounts",
  "repositories",
  "repository_locations",
  "projects",
  "memory_scopes",
  "sync_runs",
  "sync_checkpoints",
  "source_records",
  "source_snapshots",
  "sync_run_items",
  "agent_runs",
  "memories",
  "memory_evidence",
  "idempotency_records",
  "audit_events",
];

for (const table of identityTables) {
  assert(
    migration.includes(`public.${table}_id_seq`),
    `authenticated sequence grant is missing: ${table}_id_seq`,
  );
}

const requiredFunctions = [
  "set_updated_at",
  "validate_memory_scope_target",
  "validate_source_parent",
  "bump_memory_revision",
  "bump_sync_checkpoint_revision",
  "validate_memory_supersession",
  "validate_supersession_consistency",
  "validate_failure_memory_detail",
  "protect_memory_evidence_identity",
  "validate_memory_has_evidence",
];

for (const functionName of requiredFunctions) {
  const functionStart = migration.indexOf(
    `create or replace function public.${functionName}()`,
  );
  assert(functionStart >= 0, `missing function: ${functionName}`);

  if (functionStart >= 0) {
    const functionEnd = migration.indexOf("$$;", functionStart);
    const body = migration.slice(functionStart, functionEnd + 3);
    assert(
      body.includes("set search_path = ''"),
      `function search_path is not pinned: ${functionName}`,
    );
  }
}

assert(
  !/\bserial\b/i.test(migration),
  "serial is forbidden; use generated identity",
);
assert(
  !/\bvarchar\s*\(/i.test(migration),
  "varchar(n) is forbidden without a documented need",
);
assert(
  !/\btimestamp(?!tz)\b/i.test(migration),
  "timestamp without time zone is forbidden",
);
assert(
  !/gen_random_uuid\(\)\s+primary key/i.test(migration),
  "random UUID primary keys are forbidden",
);
assert(
  migration.includes("extensions.gin_trgm_ops"),
  "pg_trgm search index is missing",
);
assert(
  migration.includes(
    "unique (source_id, hash_version, content_hash)",
  ),
  "source snapshot dedupe constraint is missing",
);
assert(
  migration.includes("where status = 'running'"),
  "single active sync-run index is missing",
);
assert(
  migration.trimStart().startsWith("begin;") &&
    migration.trimEnd().endsWith("commit;"),
  "initial migration must be one transaction",
);

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`FAIL: ${failure}`);
  }
  process.exit(1);
}

console.log(
  `DB schema validation passed: ${expectedTables.length} tables, ${requiredFunctions.length} functions`,
);
