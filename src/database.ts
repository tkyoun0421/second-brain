import { Pool, type PoolClient, type QueryResultRow } from "pg";

import type { Principal } from "#app/principal.js";

export interface SqlClient {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface Database {
  transaction<T>(principal: Principal, action: (client: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class PostgresDatabase implements Database {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }

  async transaction<T>(principal: Principal, action: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query("SET LOCAL ROLE app_api");
      await client.query(
        "select set_config('request.jwt.claim.sub', $1, true)",
        [principal.userId],
      );
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

export const asPoolClient = (client: SqlClient): PoolClient => client as PoolClient;
