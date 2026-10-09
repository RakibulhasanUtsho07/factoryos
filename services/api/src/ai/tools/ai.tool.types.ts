/**
 * FactoryOS AI - Tool Contract Types
 *
 * WP06 Tool / Agent Execution
 *
 * Design source:
 * - FactoryOS AI v2.1 HLD/LLD
 * - FactoryOS AI v2.1 Engineering Implementation Blueprint
 *
 * Non-negotiable contracts:
 * - Tool identifiers are stable.
 * - Tool versions are immutable/versioned.
 * - Input/output schemas are strict JSON Schema objects.
 * - Risk class is explicitly bounded from L0 through L4.
 * - Required IAM scopes are explicit.
 * - Write-capable tools require idempotency.
 * - Write-capable tools must define a rollback strategy.
 * - Tool execution must remain bounded and auditable.
 * - Registry definitions are read-only runtime contracts.
 */

/* ============================================================
 * JSON SCHEMA
 * ============================================================ */

export type AiJsonSchemaType =
  | 'null'
  | 'boolean'
  | 'object'
  | 'array'
  | 'number'
  | 'integer'
  | 'string';

export interface AiJsonSchema {
  $schema?: string;

  $id?: string;

  title?: string;

  description?: string;

  type?:
    | AiJsonSchemaType
    | AiJsonSchemaType[];

  properties?: Record<
    string,
    AiJsonSchema
  >;

  required?: string[];

  additionalProperties?:
    | boolean
    | AiJsonSchema;

  items?:
    | AiJsonSchema
    | AiJsonSchema[];

  prefixItems?:
    AiJsonSchema[];

  minItems?: number;

  maxItems?: number;

  uniqueItems?: boolean;

  minProperties?: number;

  maxProperties?: number;

  minLength?: number;

  maxLength?: number;

  pattern?: string;

  format?: string;

  minimum?: number;

  maximum?: number;

  exclusiveMinimum?:
    | number
    | boolean;

  exclusiveMaximum?:
    | number
    | boolean;

  multipleOf?: number;

  enum?: unknown[];

  const?: unknown;

  anyOf?: AiJsonSchema[];

  allOf?: AiJsonSchema[];

  oneOf?: AiJsonSchema[];

  not?: AiJsonSchema;

  nullable?: boolean;

  default?: unknown;

  examples?: unknown[];

  patternProperties?: Record<
    string,
    AiJsonSchema
  >;

  dependentRequired?: Record<
    string,
    string[]
  >;

  dependentSchemas?: Record<
    string,
    AiJsonSchema
  >;

  if?: AiJsonSchema;

  then?: AiJsonSchema;

  else?: AiJsonSchema;

  [key: string]:
    | unknown
    | undefined;
}

/**
 * Explicit tool-specific JSON Schema alias.
 *
 * IMPORTANT:
 * Keep this named export.
 *
 * AiToolRegistryService imports AiToolJsonSchema
 * directly from this module.
 */
export type AiToolJsonSchema =
  AiJsonSchema;

/* ============================================================
 * RISK CLASS
 * ============================================================ */

export type AiToolRiskClass =
  | 'L0'
  | 'L1'
  | 'L2'
  | 'L3'
  | 'L4';

/* ============================================================
 * APPROVAL MODE
 * ============================================================ */

/**
 * Canonical persisted/runtime approval modes.
 */
export type AiToolApprovalMode =
  | 'NONE'
  | 'USER'
  | 'ROLE'
  | 'DUAL'
  | 'POLICY';

/**
 * Source-architecture compatibility values.
 *
 * The blueprint sometimes expresses these values in lower case.
 * Keep both forms type-safe at the boundary.
 */
export type AiToolApprovalModeValue =
  | AiToolApprovalMode
  | 'none'
  | 'user'
  | 'role'
  | 'dual'
  | 'policy';

/* ============================================================
 * REGISTRY STATUS
 * ============================================================ */

export type AiToolRegistryStatus =
  | 'ACTIVE'
  | 'INACTIVE'
  | 'DISABLED'
  | 'REVOKED'
  | 'DRAFT';

/* ============================================================
 * AUDIT MODE
 * ============================================================ */

export type AiToolAuditMode =
  | 'REDACTED';

/* ============================================================
 * ROLLBACK
 * ============================================================ */

export type AiToolRollbackType =
  | 'NONE'
  | 'REVERSIBLE'
  | 'COMPENSATION';

export interface AiToolRollbackDefinition {
  /**
   * NONE:
   * No rollback operation is defined.
   *
   * REVERSIBLE:
   * The original command can be safely reversed.
   *
   * COMPENSATION:
   * A dedicated compensating operation is required.
   */
  type:
    AiToolRollbackType;

  /**
   * Optional human-readable explanation.
   */
  description?:
    | string
    | null;

  /**
   * Optional compensation tool identifier.
   */
  toolId?:
    | string
    | null;

  /**
   * Optional compensation tool version.
   */
  toolVersion?:
    | string
    | null;

  /**
   * Optional compensation action name.
   */
  actionType?:
    | string
    | null;

  /**
   * Optional metadata used by the executor.
   */
  metadata?:
    Record<string, unknown>;
}

/* ============================================================
 * TOOL DEFINITION
 * ============================================================ */

export interface AiToolDefinition {
  /**
   * Registry row UUID.
   */
  id: string;

  /**
   * Null means globally registered tool.
   */
  tenantId:
    | string
    | null;

  /**
   * Null means tenant-level or globally scoped tool.
   */
  factoryId:
    | string
    | null;

  /**
   * Stable tool identifier.
   */
  toolId: string;

  /**
   * Immutable tool version / SemVer-compatible version.
   */
  version: string;

  /**
   * Strict input JSON Schema.
   */
  inputSchema:
    AiToolJsonSchema;

  /**
   * Strict output JSON Schema.
   */
  outputSchema:
    AiToolJsonSchema;

  /**
   * Explicit FactoryOS risk class.
   */
  riskClass:
    AiToolRiskClass;

  /**
   * Required IAM permissions/scopes.
   */
  requiredScopes:
    string[];

  /**
   * Human/policy approval mode.
   *
   * Canonical values:
   * NONE / USER / ROLE / DUAL / POLICY
   *
   * Lower-case values remain type-compatible for
   * source-architecture terminology.
   */
  approvalMode:
    AiToolApprovalModeValue;

  /**
   * Whether this tool can mutate business/domain state.
   */
  writeCapable:
    boolean;

  /**
   * Required for write-capable tools.
   */
  idempotencyRequired:
    boolean;

  /**
   * Hard execution timeout in milliseconds.
   */
  timeoutMs:
    number;

  /**
   * Audit payload handling mode.
   */
  auditMode:
    AiToolAuditMode;

  /**
   * Rollback/compensation definition.
   */
  rollback:
    AiToolRollbackDefinition;

  /**
   * Current registry lifecycle state.
   */
  status:
    AiToolRegistryStatus;

  /**
   * Additional non-sensitive registry metadata.
   */
  metadata:
    Record<string, unknown>;

  /**
   * Creator may be null for system-managed definitions.
   */
  createdBy:
    | string
    | null;

  /**
   * Registry creation timestamp.
   */
  createdAt:
    string;

  /**
   * Last registry update timestamp.
   */
  updatedAt:
    string;
}

/* ============================================================
 * TOOL EXECUTION CONTRACTS
 * ============================================================ */

export interface AiToolExecutionAction {
  /**
   * AI action intent identifier.
   */
  actionIntentId:
    string;

  /**
   * Tenant scope.
   */
  tenantId:
    string;

  /**
   * Factory scope.
   */
  factoryId:
    string;

  /**
   * Decision envelope identifier.
   */
  decisionId:
    string;

  /**
   * Registered tool identifier.
   */
  toolId:
    string;

  /**
   * Tool version selected for execution.
   */
  toolVersion:
    string;

  /**
   * Canonical action type.
   */
  actionType:
    string;

  /**
   * Resource target.
   */
  target:
    Record<string, unknown>;

  /**
   * Resource type.
   */
  resourceType:
    | string
    | null;

  /**
   * Resource identifier.
   */
  resourceId:
    | string
    | null;

  /**
   * Validated action payload.
   */
  payload:
    Record<string, unknown>;

  /**
   * SHA-256 payload hash.
   */
  payloadHash:
    string;

  /**
   * Risk class bound at authorization time.
   */
  riskClass:
    AiToolRiskClass;

  /**
   * Authorization state.
   */
  authorizationStatus:
    | 'DENIED'
    | 'APPROVAL_REQUIRED'
    | 'AUTHORIZED';

  /**
   * Approval reference, when applicable.
   */
  approvalId:
    | string
    | null;

  /**
   * Hash of the short-lived action token.
   *
   * Raw action tokens must never be persisted.
   */
  actionTokenHash:
    | string
    | null;

  /**
   * Token expiry.
   */
  tokenExpiresAt:
    | string
    | null;

  /**
   * Idempotency key.
   */
  idempotencyKey:
    | string
    | null;
}

/**
 * Runtime context supplied to Tool Gateway.
 *
 * This extends the persisted/action-intent contract with the
 * runtime-only values that must never be persisted in raw form.
 */
export interface AiToolActionContext
  extends AiToolExecutionAction {
  /**
   * Verified actor performing the action.
   */
  actorUserId:
    string;

  /**
   * Executor classification.
   *
   * Examples:
   * - AI_TOOL_GATEWAY
   * - AGENT
   * - WORKFLOW
   * - SYSTEM
   */
  executorType:
    string;

  /**
   * Raw short-lived action token.
   *
   * IMPORTANT:
   * This value is runtime-only and must never be stored
   * in the database or audit logs.
   */
  actionToken:
    string;
}

/* ============================================================
 * TOOL EXECUTION RESULT
 * ============================================================ */

export interface AiToolExecutionResult {
  /**
   * Whether an existing execution record was replayed.
   */
  idempotent:
    boolean;

  /**
   * Execution record identifier.
   */
  executionId:
    string;

  /**
   * Action intent identifier.
   */
  actionIntentId:
    string;

  /**
   * Selected tool identifier.
   */
  toolId:
    string;

  /**
   * Selected tool version.
   */
  toolVersion:
    string;

  /**
   * Execution status.
   */
  status:
    | 'SUCCEEDED'
    | 'FAILED';

  /**
   * Typed/validated tool result.
   */
  result:
    | Record<string, unknown>
    | null;

  /**
   * Structured executor error.
   */
  error:
    | Record<string, unknown>
    | null;
}

/**
 * Tool Gateway execution outcome.
 *
 * This is deliberately separate from the persisted execution
 * record contract because the Gateway returns a richer runtime
 * envelope containing the resolved tool definition and
 * execution metadata.
 */
export interface AiToolExecutionOutcome {
  /**
   * Execution status.
   */
  status:
    | 'SUCCEEDED'
    | 'FAILED';

  /**
   * Tool result.
   */
  result:
    Record<string, unknown>;

  /**
   * Structured execution error.
   */
  error:
    Record<string, unknown>;

  /**
   * Resolved immutable tool definition.
   */
  tool:
    AiToolDefinition;

  /**
   * Executor classification.
   */
  executorType:
    string;

  /**
   * Resolved tool version.
   */
  toolVersion:
    string;

  /**
   * SHA-256 hash of execution inputs.
   */
  inputsHash:
    string;
}

/* ============================================================
 * TOOL VALIDATION RESULT
 * ============================================================ */

export interface AiToolValidationResult {
  valid:
    boolean;

  errors:
    string[];
}

/* ============================================================
 * AGENT STATE
 * ============================================================ */

export type AiAgentState =
  | 'CREATED'
  | 'CONTEXT_READY'
  | 'PLAN_READY'
  | 'AWAITING_AUTH'
  | 'AWAITING_APPROVAL'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'BLOCKED'
  | 'FAILED'
  | 'CANCELLED';

/* ============================================================
 * AGENT HANDOFF
 * ============================================================ */

export interface AiAgentHandoff {
  /**
   * Scoped handoff identifier.
   */
  id:
    string;

  /**
   * Tenant scope.
   */
  tenantId:
    string;

  /**
   * Factory scope.
   */
  factoryId:
    string;

  /**
   * Purpose of the receiving-agent task.
   */
  purpose:
    string;

  /**
   * Data classifications explicitly allowed.
   */
  allowedDataClasses:
    string[];

  /**
   * Tools explicitly permitted for the receiving agent.
   */
  permittedTools:
    string[];

  /**
   * Handoff expiry.
   */
  expiresAt:
    string;

  /**
   * Parent execution/decision trace.
   */
  parentTraceId:
    string;

  /**
   * Expected artifact from the receiving agent.
   */
  expectedArtifact:
    | Record<string, unknown>
    | null;
}