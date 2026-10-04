import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';

export interface InboxExecutionResult<T> {
  duplicate: boolean;
  result: T | null;
}

interface InboxInsertRow {
  id: string;
}

@Injectable()
export class InboxService {
  constructor(
    private readonly database: DatabaseService,
  ) {}

  async executeOnce<T>(
    tenantId: string,
    consumerName: string,
    eventId: string,
    handler: (client: PoolClient) => Promise<T>,
  ): Promise<InboxExecutionResult<T>> {
    return this.database.transaction(async (client) => {
      const inserted = await client.query<InboxInsertRow>(
        `
          INSERT INTO inbox_events (
            tenant_id,
            consumer_name,
            event_id
          )
          VALUES ($1, $2, $3)
          ON CONFLICT (consumer_name, event_id)
          DO NOTHING
          RETURNING id
        `,
        [tenantId, consumerName, eventId],
      );

      if (inserted.rowCount === 0) {
        return {
          duplicate: true,
          result: null,
        };
      }

      const result = await handler(client);

      await client.query(
        `
          UPDATE inbox_events
          SET processed_at = now()
          WHERE id = $1
        `,
        [inserted.rows[0].id],
      );

      return {
        duplicate: false,
        result,
      };
    });
  }
}