import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';

import {
  isUUID,
} from 'class-validator';

import { DatabaseService } from '../database/database.service';

export interface AuditEventInput {
  tenantId: string;

  factoryId?: string | null;

  actorUserId?: string | null;

  eventType: string;

  action: string;

  resourceType?: string | null;

  resourceId?: string | null;

  correlationId?: string | null;

  requestId?: string | null;

  dataClass?: string;

  payload?: Record<
    string,
    unknown
  >;
}

@Injectable()
export class AuditService {
  constructor(
    private readonly database: DatabaseService,
  ) {}

  async record(
    input: AuditEventInput,
  ): Promise<string> {
    this.validateUuid(
      input.tenantId,
      'tenantId',
    );

    this.validateOptionalUuid(
      input.factoryId,
      'factoryId',
    );

    this.validateOptionalUuid(
      input.actorUserId,
      'actorUserId',
    );

    this.validateOptionalUuid(
      input.correlationId,
      'correlationId',
    );

    this.validateOptionalUuid(
      input.requestId,
      'requestId',
    );

    if (
      !input.eventType.trim()
    ) {
      throw new BadRequestException(
        'eventType is required',
      );
    }

    if (
      !input.action.trim()
    ) {
      throw new BadRequestException(
        'action is required',
      );
    }

    const result =
      await this.database.query<{
        id: string;
      }>(
        `
        INSERT INTO audit_events (
          tenant_id,
          factory_id,
          actor_user_id,
          event_type,
          action,
          resource_type,
          resource_id,
          correlation_id,
          request_id,
          data_class,
          payload
        )

        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11::jsonb
        )

        RETURNING
          id
        `,
        [
          input.tenantId,
          input.factoryId ??
            null,
          input.actorUserId ??
            null,
          input.eventType,
          input.action,
          input.resourceType ??
            null,
          input.resourceId ??
            null,
          input.correlationId ??
            null,
          input.requestId ??
            null,
          input.dataClass ??
            'INTERNAL',
          JSON.stringify(
            input.payload ??
              {},
          ),
        ],
        {
          tenantId:
            input.tenantId,

          userId:
            input.actorUserId,
        },
      );

    const row =
      result.rows[0];

    if (!row) {
      throw new Error(
        'AUDIT_EVENT_INSERT_FAILED',
      );
    }

    return row.id;
  }

  private validateUuid(
    value: string,
    field: string,
  ): void {
    if (
      !isUUID(value)
    ) {
      throw new BadRequestException(
        `${field} must be a valid UUID`,
      );
    }
  }

  private validateOptionalUuid(
    value:
      | string
      | null
      | undefined,
    field: string,
  ): void {
    if (
      value !== null &&
      value !== undefined &&
      !isUUID(value)
    ) {
      throw new BadRequestException(
        `${field} must be a valid UUID`,
      );
    }
  }
}