import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';

import {
  createHash,
} from 'node:crypto';

import {
  IamService,
} from '../../iam/iam.service';

import {
  AiToolRegistryService,
  aiToolRequiresApproval,
} from './ai.tool.registry.service';

import type {
  AiJsonSchema,
  AiToolActionContext,
  AiToolDefinition,
  AiToolExecutionOutcome,
} from './ai.tool.types';

@Injectable()
export class AiToolGatewayService {
  constructor(
    private readonly registry:
      AiToolRegistryService,

    private readonly iamService:
      IamService,
  ) {}

  /* ==========================================================
   * PUBLIC: EXECUTE REGISTERED TOOL
   * ========================================================== */

  async execute(
    action:
      AiToolActionContext,
  ): Promise<AiToolExecutionOutcome> {
    const tool =
      await this.registry.getTool(
        action.tenantId,
        action.factoryId,
        action.toolId,
        action.toolVersion,
      );

    this.validateActionAgainstTool(
      action,
      tool,
    );

    for (
      const permission of
        tool.requiredScopes
    ) {
      await this.iamService.authorize(
        action.actorUserId,
        action.tenantId,
        permission,
        action.factoryId,
      );
    }

    /*
     * IMPORTANT:
     *
     * The action payload hash was already established by the
     * upstream AI Runtime authorization boundary.
     *
     * The gateway treats that hash as the execution input
     * binding and does not silently recalculate it from a
     * different representation.
     */
    const inputsHash =
      action.payloadHash;

    const result =
      await this.executeRegisteredTool(
        action,
        tool,
      );

    if (
      result.status ===
      'SUCCEEDED'
    ) {
      this.assertJsonSchema(
        result.result,
        tool.outputSchema,
        '$.result',
      );
    }

    return {
      ...result,
      tool,
      executorType:
        action.executorType,
      toolVersion:
        tool.version,
      inputsHash,
    };
  }

  /* ==========================================================
   * PRIVATE: ACTION / TOOL BINDING
   * ========================================================== */

  private validateActionAgainstTool(
    action:
      AiToolActionContext,
    tool:
      AiToolDefinition,
  ): void {
    if (
      action.toolId !==
      tool.toolId
    ) {
      throw new ConflictException(
        'AI action tool id does not match the registered tool',
      );
    }

    if (
      action.actionType !==
      tool.toolId
    ) {
      throw new ConflictException(
        'AI action type does not match the registered tool',
      );
    }

    if (
      action.toolVersion !==
      tool.version
    ) {
      throw new ConflictException(
        'AI action tool version does not match the registered tool',
      );
    }

    if (
      action.authorizationStatus !==
      'AUTHORIZED'
    ) {
      throw new ConflictException(
        'AI action is not authorized for Tool Gateway execution',
      );
    }

    if (
      !action.tokenExpiresAt
    ) {
      throw new ConflictException(
        'AI action token expiry is missing',
      );
    }

    const tokenExpiry =
      new Date(
        action.tokenExpiresAt,
      ).getTime();

    if (
      !Number.isFinite(
        tokenExpiry,
      )
    ) {
      throw new ConflictException(
        'AI action token expiry is invalid',
      );
    }

    if (
      tokenExpiry <=
      Date.now()
    ) {
      throw new ConflictException(
        'AI action token has expired',
      );
    }

    /*
     * IMPORTANT:
     *
     * AiRuntimeService hashes an action token as:
     *
     *   SHA256(
     *     JSON.stringify(token)
     *   )
     *
     * Gateway MUST use exactly the same representation.
     *
     * Hashing raw UTF-8 token bytes would create a different
     * digest and incorrectly reject a valid Runtime-issued token.
     */
    const computedTokenHash =
      this.computeHash(
        action.actionToken,
      );

    if (
      !action.actionTokenHash ||
      computedTokenHash !==
        action.actionTokenHash
    ) {
      throw new ConflictException(
        'AI action token binding is invalid',
      );
    }

    if (
      action.riskClass ===
        null ||
      action.riskClass ===
        undefined ||
      action.riskClass !==
        tool.riskClass
    ) {
      throw new ConflictException(
        'AI action risk class does not match the registered tool risk class',
      );
    }

    if (
      aiToolRequiresApproval(
        tool.approvalMode,
      ) &&
      !action.approvalId
    ) {
      throw new ConflictException(
        'Registered AI tool requires an approval binding',
      );
    }

    if (
      tool.idempotencyRequired &&
      !action.idempotencyKey
    ) {
      throw new ConflictException(
        'Registered AI tool requires an idempotency key',
      );
    }

    /*
     * Every registered tool input must satisfy the immutable
     * JSON Schema contract before execution.
     */
    this.assertJsonSchema(
      action.payload,
      tool.inputSchema,
      '$.payload',
    );
  }

  /* ==========================================================
   * PRIVATE: REGISTERED EXECUTION
   * ========================================================== */

  private async executeRegisteredTool(
    action:
      AiToolActionContext,
    tool:
      AiToolDefinition,
  ): Promise<{
    status:
      | 'SUCCEEDED'
      | 'FAILED';

    result:
      Record<string, unknown>;

    error:
      Record<string, unknown>;
  }> {
    const execution =
      this.executeBuiltin(
        action,
        tool,
      );

    return this.withTimeout(
      execution,
      tool.timeoutMs,
    );
  }

  /* ==========================================================
   * PRIVATE: BUILTIN CONTRACT EXECUTORS
   * ========================================================== */

  private executeBuiltin(
    action:
      AiToolActionContext,
    tool:
      AiToolDefinition,
  ): Promise<{
    status:
      | 'SUCCEEDED'
      | 'FAILED';

    result:
      Record<string, unknown>;

    error:
      Record<string, unknown>;
  }> {
    if (
      tool.toolId ===
      'AI.RUNTIME.NOOP'
    ) {
      return Promise.resolve({
        status:
          'SUCCEEDED',

        result: {
          execution:
            'NO_SIDE_EFFECT',

          executorType:
            action.executorType,

          actionType:
            action.actionType,

          committed:
            false,
        },

        error: {},
      });
    }

    if (
      tool.toolId ===
      'AUDIT_ONLY'
    ) {
      return Promise.resolve({
        status:
          'SUCCEEDED',

        result: {
          execution:
            'NO_SIDE_EFFECT',

          executorType:
            action.executorType,

          actionType:
            action.actionType,

          committed:
            false,
        },

        error: {},
      });
    }

    /*
     * Fail closed for action types that do not yet have a
     * domain executor.
     *
     * Do not pretend a business mutation happened.
     */
    return Promise.resolve({
      status:
        'FAILED',

      result: {},

      error: {
        code:
          'EXECUTOR_NOT_CONFIGURED',

        message:
          'No Tool Gateway/domain executor is registered for this AI action type',

        actionType:
          action.actionType,

        executorType:
          action.executorType,

        toolId:
          tool.toolId,

        toolVersion:
          tool.version,
      },
    });
  }

  /* ==========================================================
   * PRIVATE: BOUNDED TIMEOUT
   * ========================================================== */

  private async withTimeout(
    promise: Promise<{
      status:
        | 'SUCCEEDED'
        | 'FAILED';

      result:
        Record<string, unknown>;

      error:
        Record<string, unknown>;
    }>,
    timeoutMs:
      number,
  ): Promise<{
    status:
      | 'SUCCEEDED'
      | 'FAILED';

    result:
      Record<string, unknown>;

    error:
      Record<string, unknown>;
  }> {
    let timeoutHandle:
      | ReturnType<
          typeof setTimeout
        >
      | null =
        null;

    const timeout =
      new Promise<never>(
        (
          _,
          reject,
        ) => {
          timeoutHandle =
            setTimeout(
              () => {
                reject(
                  new ConflictException(
                    `AI tool execution exceeded timeout of ${timeoutMs}ms`,
                  ),
                );
              },
              timeoutMs,
            );
        },
      );

    try {
      return await Promise.race([
        promise,
        timeout,
      ]);
    } finally {
      if (
        timeoutHandle
      ) {
        clearTimeout(
          timeoutHandle,
        );
      }
    }
  }

  /* ==========================================================
   * PRIVATE: JSON SCHEMA VALIDATION
   * ========================================================== */

  private assertJsonSchema(
    value:
      unknown,
    schema:
      AiJsonSchema,
    path:
      string,
  ): void {
    if (
      schema.const !==
      undefined
    ) {
      if (
        !this.deepEqual(
          value,
          schema.const,
        )
      ) {
        throw new BadRequestException(
          `${path} must equal the schema const value`,
        );
      }
    }

    if (
      schema.enum
    ) {
      const matched =
        schema.enum.some(
          (
            candidate,
          ) =>
            this.deepEqual(
              candidate,
              value,
            ),
        );

      if (!matched) {
        throw new BadRequestException(
          `${path} must match one of the schema enum values`,
        );
      }
    }

    if (
      schema.allOf &&
      schema.allOf.length > 0
    ) {
      for (
        const childSchema of
          schema.allOf
      ) {
        this.assertJsonSchema(
          value,
          childSchema,
          path,
        );
      }
    }

    if (
      schema.anyOf &&
      schema.anyOf.length > 0
    ) {
      const matched =
        schema.anyOf.some(
          (
            candidateSchema,
          ) => {
            try {
              this.assertJsonSchema(
                value,
                candidateSchema,
                path,
              );

              return true;
            } catch {
              return false;
            }
          },
        );

      if (!matched) {
        throw new BadRequestException(
          `${path} must match at least one schema in anyOf`,
        );
      }
    }

    if (
      schema.oneOf &&
      schema.oneOf.length > 0
    ) {
      let matches =
        0;

      for (
        const candidateSchema of
          schema.oneOf
      ) {
        try {
          this.assertJsonSchema(
            value,
            candidateSchema,
            path,
          );

          matches +=
            1;
        } catch {
          // Candidate did not match.
        }
      }

      if (
        matches !==
        1
      ) {
        throw new BadRequestException(
          `${path} must match exactly one schema in oneOf`,
        );
      }
    }

    if (
      schema.not
    ) {
      if (
        this.matchesSchema(
          value,
          schema.not,
          path,
        )
      ) {
        throw new BadRequestException(
          `${path} must not match the registered tool schema`,
        );
      }
    }

    if (
      schema.type
    ) {
      this.assertType(
        value,
        schema.type,
        path,
      );
    }

    switch (
      this.primarySchemaType(
        schema.type,
      )
    ) {
      case 'object':
        this.assertObjectSchema(
          value,
          schema,
          path,
        );
        break;

      case 'array':
        this.assertArraySchema(
          value,
          schema,
          path,
        );
        break;

      case 'string':
        this.assertStringSchema(
          value,
          schema,
          path,
        );
        break;

      case 'number':
      case 'integer':
        this.assertNumberSchema(
          value,
          schema,
          path,
        );
        break;

      default:
        break;
    }
  }

  /* ==========================================================
   * PRIVATE: OBJECT SCHEMA
   * ========================================================== */

  private assertObjectSchema(
    value:
      unknown,
    schema:
      AiJsonSchema,
    path:
      string,
  ): void {
    if (
      !this.isObject(
        value,
      )
    ) {
      return;
    }

    const required =
      schema.required ??
      [];

    for (
      const property of
        required
    ) {
      if (
        !Object.prototype.hasOwnProperty.call(
          value,
          property,
        )
      ) {
        throw new BadRequestException(
          `${path}.${property} is required by the registered tool schema`,
        );
      }
    }

    const properties =
      schema.properties ??
      {};

    if (
      schema.additionalProperties ===
      false
    ) {
      for (
        const key of
          Object.keys(
            value,
          )
      ) {
        if (
          !Object.prototype.hasOwnProperty.call(
            properties,
            key,
          )
        ) {
          throw new BadRequestException(
            `${path}.${key} is not allowed by the registered tool schema`,
          );
        }
      }
    }

    if (
      schema.minProperties !==
        undefined &&
      Object.keys(
        value,
      ).length <
        schema.minProperties
    ) {
      throw new BadRequestException(
        `${path} must contain at least ${schema.minProperties} propert${schema.minProperties === 1 ? 'y' : 'ies'}`,
      );
    }

    if (
      schema.maxProperties !==
        undefined &&
      Object.keys(
        value,
      ).length >
        schema.maxProperties
    ) {
      throw new BadRequestException(
        `${path} must contain no more than ${schema.maxProperties} properties`,
      );
    }

    for (
      const [
        key,
        childSchema,
      ] of Object.entries(
        properties,
      )
    ) {
      if (
        Object.prototype.hasOwnProperty.call(
          value,
          key,
        )
      ) {
        this.assertJsonSchema(
          value[key],
          childSchema,
          `${path}.${key}`,
        );
      }
    }

    if (
      schema.patternProperties
    ) {
      for (
        const [
          pattern,
          childSchema,
        ] of Object.entries(
          schema.patternProperties,
        )
      ) {
        const regex =
          new RegExp(
            pattern,
          );

        for (
          const key of
            Object.keys(
              value,
            )
        ) {
          if (
            regex.test(
              key,
            )
          ) {
            this.assertJsonSchema(
              value[key],
              childSchema,
              `${path}.${key}`,
            );
          }
        }
      }
    }

    if (
      schema.dependentRequired
    ) {
      for (
        const [
          key,
          dependentKeys,
        ] of Object.entries(
          schema.dependentRequired,
        )
      ) {
        if (
          Object.prototype.hasOwnProperty.call(
            value,
            key,
          )
        ) {
          for (
            const dependentKey of
              dependentKeys
          ) {
            if (
              !Object.prototype.hasOwnProperty.call(
                value,
                dependentKey,
              )
            ) {
              throw new BadRequestException(
                `${path}.${dependentKey} is required when ${path}.${key} is present`,
              );
            }
          }
        }
      }
    }

    if (
      schema.dependentSchemas
    ) {
      for (
        const [
          key,
          dependentSchema,
        ] of Object.entries(
          schema.dependentSchemas,
        )
      ) {
        if (
          Object.prototype.hasOwnProperty.call(
            value,
            key,
          )
        ) {
          this.assertJsonSchema(
            value,
            dependentSchema,
            path,
          );
        }
      }
    }
  }

  /* ==========================================================
   * PRIVATE: ARRAY SCHEMA
   * ========================================================== */

  private assertArraySchema(
    value:
      unknown,
    schema:
      AiJsonSchema,
    path:
      string,
  ): void {
    if (
      !Array.isArray(
        value,
      )
    ) {
      return;
    }

    if (
      schema.minItems !==
        undefined &&
      value.length <
        schema.minItems
    ) {
      throw new BadRequestException(
        `${path} must contain at least ${schema.minItems} item(s)`,
      );
    }

    if (
      schema.maxItems !==
        undefined &&
      value.length >
        schema.maxItems
    ) {
      throw new BadRequestException(
        `${path} must contain no more than ${schema.maxItems} item(s)`,
      );
    }

    if (
      schema.uniqueItems
    ) {
      for (
        let index = 0;
        index <
        value.length;
        index += 1
      ) {
        for (
          let compareIndex =
            index + 1;
          compareIndex <
          value.length;
          compareIndex += 1
        ) {
          if (
            this.deepEqual(
              value[index],
              value[compareIndex],
            )
          ) {
            throw new BadRequestException(
              `${path} must contain unique items`,
            );
          }
        }
      }
    }

    if (
      schema.prefixItems
    ) {
      for (
        let index = 0;
        index <
        schema.prefixItems.length;
        index += 1
      ) {
        if (
          index >=
          value.length
        ) {
          break;
        }

        this.assertJsonSchema(
          value[index],
          schema.prefixItems[index],
          `${path}[${index}]`,
        );
      }
    }

    if (
      schema.items
    ) {
      if (
        Array.isArray(
          schema.items,
        )
      ) {
        for (
          let index = 0;
          index <
          schema.items.length;
          index += 1
        ) {
          if (
            index >=
            value.length
          ) {
            break;
          }

          this.assertJsonSchema(
            value[index],
            schema.items[index],
            `${path}[${index}]`,
          );
        }
      } else {
        for (
          let index = 0;
          index <
          value.length;
          index += 1
        ) {
          this.assertJsonSchema(
            value[index],
            schema.items,
            `${path}[${index}]`,
          );
        }
      }
    }
  }

  /* ==========================================================
   * PRIVATE: STRING SCHEMA
   * ========================================================== */

  private assertStringSchema(
    value:
      unknown,
    schema:
      AiJsonSchema,
    path:
      string,
  ): void {
    if (
      typeof value !==
      'string'
    ) {
      return;
    }

    if (
      schema.minLength !==
        undefined &&
      value.length <
        schema.minLength
    ) {
      throw new BadRequestException(
        `${path} must contain at least ${schema.minLength} character(s)`,
      );
    }

    if (
      schema.maxLength !==
        undefined &&
      value.length >
        schema.maxLength
    ) {
      throw new BadRequestException(
        `${path} must contain no more than ${schema.maxLength} character(s)`,
      );
    }

    if (
      schema.pattern
    ) {
      const pattern =
        new RegExp(
          schema.pattern,
        );

      if (
        !pattern.test(
          value,
        )
      ) {
        throw new BadRequestException(
          `${path} does not match the registered tool pattern`,
        );
      }
    }

    if (
      schema.format
    ) {
      this.assertStringFormat(
        value,
        schema.format,
        path,
      );
    }
  }

  /* ==========================================================
   * PRIVATE: NUMBER SCHEMA
   * ========================================================== */

  private assertNumberSchema(
    value:
      unknown,
    schema:
      AiJsonSchema,
    path:
      string,
  ): void {
    if (
      typeof value !==
        'number' ||
      !Number.isFinite(
        value,
      )
    ) {
      return;
    }

    if (
      schema.minimum !==
        undefined &&
      value <
        schema.minimum
    ) {
      throw new BadRequestException(
        `${path} must be greater than or equal to ${schema.minimum}`,
      );
    }

    if (
      schema.maximum !==
        undefined &&
      value >
        schema.maximum
    ) {
      throw new BadRequestException(
        `${path} must be less than or equal to ${schema.maximum}`,
      );
    }

    if (
      schema.exclusiveMinimum !==
        undefined
    ) {
      const exclusiveMinimum =
        schema.exclusiveMinimum;

      if (
        typeof exclusiveMinimum ===
        'number'
      ) {
        if (
          value <=
          exclusiveMinimum
        ) {
          throw new BadRequestException(
            `${path} must be greater than ${exclusiveMinimum}`,
          );
        }
      }
    }

    if (
      schema.exclusiveMaximum !==
        undefined
    ) {
      const exclusiveMaximum =
        schema.exclusiveMaximum;

      if (
        typeof exclusiveMaximum ===
        'number'
      ) {
        if (
          value >=
          exclusiveMaximum
        ) {
          throw new BadRequestException(
            `${path} must be less than ${exclusiveMaximum}`,
          );
        }
      }
    }

    if (
      schema.multipleOf !==
        undefined
    ) {
      if (
        schema.multipleOf <=
        0
      ) {
        throw new BadRequestException(
          `${path} schema multipleOf must be greater than zero`,
        );
      }

      const multiple =
        value /
        schema.multipleOf;

      const tolerance =
        1e-10;

      if (
        Math.abs(
          multiple -
            Math.round(
              multiple,
            ),
        ) >
        tolerance
      ) {
        throw new BadRequestException(
          `${path} must be a multiple of ${schema.multipleOf}`,
        );
      }
    }
  }

  /* ==========================================================
   * PRIVATE: JSON TYPE
   * ========================================================== */

  private assertType(
    value:
      unknown,
    type:
      | string
      | string[],
    path:
      string,
  ): void {
    const types =
      Array.isArray(
        type,
      )
        ? type
        : [type];

    const valid =
      types.some(
        (
          candidateType,
        ) =>
          this.matchesJsonType(
            value,
            candidateType,
          ),
      );

    if (
      !valid
    ) {
      throw new BadRequestException(
        `${path} must be of JSON Schema type ${types.join(' or ')}`,
      );
    }
  }

  private matchesJsonType(
    value:
      unknown,
    type:
      string,
  ): boolean {
    switch (
      type
    ) {
      case 'object':
        return this.isObject(
          value,
        );

      case 'array':
        return Array.isArray(
          value,
        );

      case 'string':
        return (
          typeof value ===
          'string'
        );

      case 'number':
        return (
          typeof value ===
            'number' &&
          Number.isFinite(
            value,
          )
        );

      case 'integer':
        return (
          typeof value ===
            'number' &&
          Number.isInteger(
            value,
          )
        );

      case 'boolean':
        return (
          typeof value ===
          'boolean'
        );

      case 'null':
        return (
          value ===
          null
        );

      default:
        throw new BadRequestException(
          `Unsupported JSON Schema type: ${type}`,
        );
    }
  }

  private primarySchemaType(
    type:
      | string
      | string[]
      | undefined,
  ):
    | string
    | undefined {
    if (
      Array.isArray(
        type,
      )
    ) {
      return type[0];
    }

    return type;
  }

  /* ==========================================================
   * PRIVATE: STRING FORMAT
   * ========================================================== */

  private assertStringFormat(
    value:
      string,
    format:
      string,
    path:
      string,
  ): void {
    switch (
      format
    ) {
      case 'uuid': {
        const uuidPattern =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

        if (
          !uuidPattern.test(
            value,
          )
        ) {
          throw new BadRequestException(
            `${path} must be a valid UUID`,
          );
        }

        break;
      }

      case 'email': {
        const emailPattern =
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (
          !emailPattern.test(
            value,
          )
        ) {
          throw new BadRequestException(
            `${path} must be a valid email address`,
          );
        }

        break;
      }

      case 'date-time': {
        const timestamp =
          Date.parse(
            value,
          );

        if (
          Number.isNaN(
            timestamp,
          )
        ) {
          throw new BadRequestException(
            `${path} must be a valid date-time`,
          );
        }

        break;
      }

      default:
        /*
         * Unknown formats remain permissive.
         *
         * JSON Schema format semantics are annotation-oriented
         * unless a format-specific validator is explicitly
         * configured.
         */
        break;
    }
  }

  /* ==========================================================
   * PRIVATE: SCHEMA MATCH HELPERS
   * ========================================================== */

  private matchesSchema(
    value:
      unknown,
    schema:
      AiJsonSchema,
    path:
      string,
  ): boolean {
    try {
      this.assertJsonSchema(
        value,
        schema,
        path,
      );

      return true;
    } catch {
      return false;
    }
  }

  /* ==========================================================
   * PRIVATE: CANONICAL HASH
   * ========================================================== */

  private computeHash(
    value:
      unknown,
  ): string {
    /*
     * Must stay aligned with AiRuntimeService.computeHash().
     *
     * Runtime:
     *
     *   JSON.stringify(
     *     canonicalize(value),
     *   )
     *
     * For actionToken (string), canonicalize returns the
     * string itself, so the final hash input is:
     *
     *   JSON.stringify(value)
     */
    return createHash(
      'sha256',
    )
      .update(
        JSON.stringify(
          value,
        ),
        'utf8',
      )
      .digest(
        'hex',
      );
  }

  /* ==========================================================
   * PRIVATE: DEEP EQUALITY
   * ========================================================== */

  private deepEqual(
    left:
      unknown,
    right:
      unknown,
  ): boolean {
    return (
      JSON.stringify(
        left,
      ) ===
      JSON.stringify(
        right,
      )
    );
  }

  /* ==========================================================
   * PRIVATE: OBJECT CHECK
   * ========================================================== */

  private isObject(
    value:
      unknown,
  ): value is Record<
    string,
    unknown
  > {
    return (
      typeof value ===
        'object' &&
      value !== null &&
      !Array.isArray(
        value,
      )
    );
  }
}