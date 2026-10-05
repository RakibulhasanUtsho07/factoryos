export const ORDER_STATUSES = [
  'DRAFT',
  'CONFIRMED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;

export type OrderStatus =
  (typeof ORDER_STATUSES)[number];

export type KnownOrderEventType =
  | 'ORDER.CREATED'
  | 'ORDER.CONFIRMED'
  | 'ORDER.IN_PROGRESS'
  | 'ORDER.COMPLETED'
  | 'ORDER.CANCELLED';

/*
 * Event schema compatibility registry.
 *
 * Keep this registry separate from aggregate state rules.
 *
 * eventVersion describes the event schema version.
 * It does NOT describe the aggregate's lifecycle version.
 */
export const ORDER_EVENT_SCHEMA_VERSIONS: Record<
  KnownOrderEventType,
  readonly number[]
> = {
  'ORDER.CREATED': [1],
  'ORDER.CONFIRMED': [1],
  'ORDER.IN_PROGRESS': [1],
  'ORDER.COMPLETED': [1],
  'ORDER.CANCELLED': [1],
};

export interface OutboxEvent {
  id: string;
  tenantId: string;
  factoryId: string | null;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: Record<string, unknown>;
}

export interface OrderCreatedEventLine {
  id: string;
  line_number: number;
  product_code: string;
  quantity: string;
  unit: string;
}

export interface OrderCreatedEventPayload {
  order: {
    id: string;
    tenant_id: string;
    factory_id: string;
    order_number: string;
    status: OrderStatus;
  };

  lines?: OrderCreatedEventLine[];

  actor?: {
    user_id: string;
  };
}

export interface OrderLifecycleEventPayload {
  order: {
    id: string;
    tenant_id: string;
    factory_id: string;
    order_number: string;
    previous_status: OrderStatus;
    status: OrderStatus;
    version: number;
    updated_at: string;
  };

  actor?: {
    user_id: string;
  };
}

export class OutboxEventContractError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name =
      'OutboxEventContractError';
  }
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function isUuid(
  value: unknown,
): value is string {
  if (
    typeof value !== 'string'
  ) {
    return false;
  }

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isPositiveInteger(
  value: unknown,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0
  );
}

function isOrderStatus(
  value: unknown,
): value is OrderStatus {
  return (
    typeof value === 'string' &&
    (
      ORDER_STATUSES as readonly string[]
    ).includes(value)
  );
}

function isValidTimestamp(
  value: unknown,
): value is string {
  if (
    typeof value !== 'string'
  ) {
    return false;
  }

  const timestamp =
    new Date(value).getTime();

  return Number.isFinite(
    timestamp,
  );
}

function requireString(
  value: unknown,
  code: string,
  field: string,
): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0
  ) {
    throw new OutboxEventContractError(
      code,
      `${field} must be a non-empty string`,
    );
  }

  return value;
}

function requireUuid(
  value: unknown,
  code: string,
  field: string,
): string {
  if (
    !isUuid(value)
  ) {
    throw new OutboxEventContractError(
      code,
      `${field} must be a valid UUID`,
    );
  }

  return value;
}

function validateGenericEnvelope(
  event: OutboxEvent,
): void {
  requireUuid(
    event.id,
    'OUTBOX_EVENT_INVALID_ID',
    'event.id',
  );

  requireUuid(
    event.tenantId,
    'OUTBOX_EVENT_INVALID_TENANT',
    'event.tenantId',
  );

  if (
    event.factoryId !== null
  ) {
    requireUuid(
      event.factoryId,
      'OUTBOX_EVENT_INVALID_FACTORY',
      'event.factoryId',
    );
  }

  requireString(
    event.aggregateType,
    'OUTBOX_EVENT_INVALID_AGGREGATE_TYPE',
    'event.aggregateType',
  );

  requireUuid(
    event.aggregateId,
    'OUTBOX_EVENT_INVALID_AGGREGATE_ID',
    'event.aggregateId',
  );

  requireString(
    event.eventType,
    'OUTBOX_EVENT_INVALID_EVENT_TYPE',
    'event.eventType',
  );

  if (
    !Number.isInteger(
      event.eventVersion,
    ) ||
    event.eventVersion < 1
  ) {
    throw new OutboxEventContractError(
      'OUTBOX_EVENT_INVALID_VERSION',
      'event.eventVersion must be a positive integer',
    );
  }

  if (
    !isRecord(
      event.payload,
    )
  ) {
    throw new OutboxEventContractError(
      'OUTBOX_EVENT_INVALID_PAYLOAD',
      'event.payload must be an object',
    );
  }

  /*
   * ORDER events must belong to ORDER aggregate.
   */
  if (
    event.eventType.startsWith('ORDER.') &&
    event.aggregateType !== 'ORDER'
  ) {
    throw new OutboxEventContractError(
      'ORDER_EVENT_INVALID_AGGREGATE_TYPE',
      'ORDER.* events must use aggregateType ORDER',
    );
  }

  /*
   * Current Order events are factory scoped.
   *
   * We enforce this because the current OrdersService writes
   * factory_id for material order events.
   */
  if (
    event.eventType.startsWith('ORDER.') &&
    event.factoryId === null
  ) {
    throw new OutboxEventContractError(
      'ORDER_EVENT_FACTORY_REQUIRED',
      'ORDER.* events require factoryId',
    );
  }
}

function validateSupportedVersion(
  event: OutboxEvent,
): void {
  const supportedVersions =
    ORDER_EVENT_SCHEMA_VERSIONS[
      event.eventType as KnownOrderEventType
    ];

  if (
    !supportedVersions
  ) {
    /*
     * Unknown future event types are allowed through the generic
     * envelope boundary. Their dedicated payload contract can be
     * introduced when that event type is actually implemented.
     */
    return;
  }

  if (
    !supportedVersions.includes(
      event.eventVersion,
    )
  ) {
    throw new OutboxEventContractError(
      'OUTBOX_EVENT_UNSUPPORTED_VERSION',
      `${event.eventType} does not support event version ${event.eventVersion}`,
    );
  }
}

function validateOptionalActor(
  payload: Record<string, unknown>,
): void {
  const actor =
    payload.actor;

  /*
   * Actor is optional for the current persisted event contract.
   *
   * Later canonical envelope hardening can make actor mandatory
   * once OrdersService persists the canonical actor structure.
   */
  if (
    actor === undefined ||
    actor === null
  ) {
    return;
  }

  if (
    !isRecord(actor)
  ) {
    throw new OutboxEventContractError(
      'ORDER_EVENT_INVALID_ACTOR',
      'payload.actor must be an object when provided',
    );
  }

  requireUuid(
    actor.user_id,
    'ORDER_EVENT_INVALID_ACTOR_USER',
    'payload.actor.user_id',
  );
}

function validateOptionalOrderSnapshot(
  event: OutboxEvent,
): Record<string, unknown> | null {
  const payload =
    event.payload;

  const order =
    payload.order;

  /*
   * Existing dispatcher/lease/restart integration fixtures may use
   * intentionally minimal ORDER event payloads.
   *
   * The generic event envelope is authoritative until the producer
   * contract itself is upgraded to the canonical payload envelope.
   */
  if (
    order === undefined ||
    order === null
  ) {
    return null;
  }

  if (
    !isRecord(order)
  ) {
    throw new OutboxEventContractError(
      'ORDER_EVENT_INVALID_ORDER',
      'payload.order must be an object when provided',
    );
  }

  const orderId =
    requireUuid(
      order.id,
      'ORDER_EVENT_INVALID_ORDER_ID',
      'payload.order.id',
    );

  if (
    orderId !== event.aggregateId
  ) {
    throw new OutboxEventContractError(
      'ORDER_EVENT_AGGREGATE_MISMATCH',
      'payload.order.id must match aggregateId',
    );
  }

  const tenantId =
    requireUuid(
      order.tenant_id,
      'ORDER_EVENT_INVALID_ORDER_TENANT',
      'payload.order.tenant_id',
    );

  if (
    tenantId !== event.tenantId
  ) {
    throw new OutboxEventContractError(
      'ORDER_EVENT_TENANT_MISMATCH',
      'payload.order.tenant_id must match event.tenantId',
    );
  }

  const factoryId =
    requireUuid(
      order.factory_id,
      'ORDER_EVENT_INVALID_ORDER_FACTORY',
      'payload.order.factory_id',
    );

  if (
    factoryId !== event.factoryId
  ) {
    throw new OutboxEventContractError(
      'ORDER_EVENT_FACTORY_MISMATCH',
      'payload.order.factory_id must match event.factoryId',
    );
  }

  requireString(
    order.order_number,
    'ORDER_EVENT_INVALID_ORDER_NUMBER',
    'payload.order.order_number',
  );

  if (
    order.status !== undefined &&
    !isOrderStatus(
      order.status,
    )
  ) {
    throw new OutboxEventContractError(
      'ORDER_EVENT_INVALID_STATUS',
      'payload.order.status is not a supported order status',
    );
  }

  validateOptionalActor(
    payload,
  );

  return order;
}

function validateCreatedPayload(
  event: OutboxEvent,
): void {
  const order =
    validateOptionalOrderSnapshot(
      event,
    );

  /*
   * IMPORTANT:
   *
   * Do NOT force ORDER.CREATED status to DRAFT here.
   *
   * The event is a historical snapshot. Existing regression tests
   * deliberately use different aggregate states to verify that the
   * consumer uses the event snapshot rather than rereading current
   * aggregate state.
   */
  if (
    order === null
  ) {
    return;
  }

  const lines =
    event.payload.lines;

  /*
   * Lines are optional for the current compatibility boundary.
   */
  if (
    lines === undefined ||
    lines === null
  ) {
    return;
  }

  if (
    !Array.isArray(lines)
  ) {
    throw new OutboxEventContractError(
      'ORDER_CREATED_INVALID_LINES',
      'payload.lines must be an array when provided',
    );
  }

  for (
    const [
      index,
      line,
    ] of lines.entries()
  ) {
    if (
      !isRecord(line)
    ) {
      throw new OutboxEventContractError(
        'ORDER_CREATED_INVALID_LINE',
        `payload.lines[${index}] must be an object`,
      );
    }

    requireUuid(
      line.id,
      'ORDER_CREATED_INVALID_LINE_ID',
      `payload.lines[${index}].id`,
    );

    if (
      !Number.isInteger(
        line.line_number,
      ) ||
      Number(
        line.line_number,
      ) < 1
    ) {
      throw new OutboxEventContractError(
        'ORDER_CREATED_INVALID_LINE_NUMBER',
        `payload.lines[${index}].line_number must be a positive integer`,
      );
    }

    requireString(
      line.product_code,
      'ORDER_CREATED_INVALID_PRODUCT_CODE',
      `payload.lines[${index}].product_code`,
    );

    requireString(
      line.quantity,
      'ORDER_CREATED_INVALID_QUANTITY',
      `payload.lines[${index}].quantity`,
    );

    requireString(
      line.unit,
      'ORDER_CREATED_INVALID_UNIT',
      `payload.lines[${index}].unit`,
    );
  }
}

function validateLifecyclePayload(
  event: OutboxEvent,
): void {
  const order =
    validateOptionalOrderSnapshot(
      event,
    );

  if (
    order === null
  ) {
    return;
  }

  /*
   * These fields are validated only when present.
   *
   * This keeps current dispatcher fixtures compatible while still
   * validating fully shaped lifecycle snapshots.
   */
  if (
    order.previous_status !== undefined &&
    !isOrderStatus(
      order.previous_status,
    )
  ) {
    throw new OutboxEventContractError(
      'ORDER_LIFECYCLE_INVALID_PREVIOUS_STATUS',
      'payload.order.previous_status is invalid',
    );
  }

  if (
    order.version !== undefined &&
    !isPositiveInteger(
      order.version,
    )
  ) {
    throw new OutboxEventContractError(
      'ORDER_LIFECYCLE_INVALID_VERSION',
      'payload.order.version must be a positive integer',
    );
  }

  if (
    order.updated_at !== undefined &&
    !isValidTimestamp(
      order.updated_at,
    )
  ) {
    throw new OutboxEventContractError(
      'ORDER_LIFECYCLE_INVALID_UPDATED_AT',
      'payload.order.updated_at must be a valid timestamp',
    );
  }

  /*
   * Event type/status consistency is checked only when the payload
   * actually carries status.
   */
  if (
    order.status !== undefined
  ) {
    const expectedStatus =
      event.eventType.replace(
        'ORDER.',
        '',
      );

    if (
      expectedStatus !==
      order.status
    ) {
      throw new OutboxEventContractError(
        'ORDER_LIFECYCLE_EVENT_STATUS_MISMATCH',
        `${event.eventType} must contain status ${expectedStatus}`,
      );
    }
  }
}

function validateKnownOrderEvent(
  event: OutboxEvent,
): void {
  switch (
    event.eventType
  ) {
    case 'ORDER.CREATED':
      validateCreatedPayload(
        event,
      );
      return;

    case 'ORDER.CONFIRMED':
    case 'ORDER.IN_PROGRESS':
    case 'ORDER.COMPLETED':
    case 'ORDER.CANCELLED':
      validateLifecyclePayload(
        event,
      );
      return;

    default:
      return;
  }
}

function deepFreeze<T>(
  value: T,
): T {
  if (
    value === null ||
    typeof value !== 'object'
  ) {
    return value;
  }

  if (
    Object.isFrozen(value)
  ) {
    return value;
  }

  Object.freeze(
    value,
  );

  for (
    const child of Object.values(
      value as Record<
        string,
        unknown
      >,
    )
  ) {
    deepFreeze(
      child,
    );
  }

  return value;
}

export function validateOutboxEvent(
  event: OutboxEvent,
): OutboxEvent {
  if (
    !isRecord(event)
  ) {
    throw new OutboxEventContractError(
      'OUTBOX_EVENT_INVALID',
      'event must be an object',
    );
  }

  validateGenericEnvelope(
    event,
  );

  validateSupportedVersion(
    event,
  );

  validateKnownOrderEvent(
    event,
  );

  return deepFreeze(
    event,
  );
}

export function assertValidOutboxEvent(
  event: OutboxEvent,
): OutboxEvent {
  return validateOutboxEvent(
    event,
  );
}