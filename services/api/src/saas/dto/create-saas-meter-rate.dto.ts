import { IsDateString, IsEnum, IsInt, IsNumber, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export enum SaasMeterMetric {
  ACTIVE_USER='ACTIVE_USER',
  ROLE_ASSIGNMENT='ROLE_ASSIGNMENT',
  TRANSACTION='TRANSACTION',
  STORAGE_BYTE_HOUR='STORAGE_BYTE_HOUR',
  TELEMETRY_EVENT='TELEMETRY_EVENT',
  AI_INPUT_TOKEN='AI_INPUT_TOKEN',
  AI_OUTPUT_TOKEN='AI_OUTPUT_TOKEN',
  AI_TOOL_CALL='AI_TOOL_CALL',
  PREMIUM_WORKLOAD='PREMIUM_WORKLOAD',
  INTEGRATION_CALL='INTEGRATION_CALL',
  EDGE_INFERENCE='EDGE_INFERENCE',
}

export class CreateSaasMeterRateDto {
  @IsEnum(SaasMeterMetric)
  metric_code!: SaasMeterMetric;

  @IsInt()
  @Min(1)
  @Max(1000000)
  rate_version!: number;

  @IsNumber({allowNaN:false,allowInfinity:false})
  @Min(0)
  @Max(9000000000000000)
  rate_minor_per_block!: number;

  @IsNumber({allowNaN:false,allowInfinity:false})
  @Min(0.000001)
  @Max(1000000000000)
  block_quantity!: number;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;

  @IsDateString()
  effective_from!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
