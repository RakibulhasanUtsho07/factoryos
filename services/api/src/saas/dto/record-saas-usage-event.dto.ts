import { IsDateString, IsEnum, IsNumber, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { SaasMeterMetric } from './create-saas-meter-rate.dto';

export enum SaasWorkloadClass {
  PRODUCTION='PRODUCTION',
  EVALUATION='EVALUATION',
  RED_TEAM='RED_TEAM',
  SHADOW_MODE='SHADOW_MODE',
  DEVELOPMENT='DEVELOPMENT',
  NON_AI='NON_AI',
}
export enum SaasUsageSourceSystem {
  API='API',
  AI_GATEWAY='AI_GATEWAY',
  TOOL_GATEWAY='TOOL_GATEWAY',
  TELEMETRY='TELEMETRY',
  CONNECTOR='CONNECTOR',
  EDGE_GATEWAY='EDGE_GATEWAY',
  MANUAL='MANUAL',
}
export class RecordSaasUsageEventDto {
  @IsEnum(SaasMeterMetric)
  metric_code!: SaasMeterMetric;

  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z][a-z0-9._:-]{0,99}$/)
  capability_code!: string;

  @IsEnum(SaasWorkloadClass)
  workload_class!: SaasWorkloadClass;

  @IsNumber({allowNaN:false,allowInfinity:false})
  @Min(0.000001)
  @Max(1000000000000)
  quantity!: number;

  @IsDateString()
  occurred_at!: string;

  @IsEnum(SaasUsageSourceSystem)
  source_system!: SaasUsageSourceSystem;

  @IsString()
  @MaxLength(255)
  source_event_ref!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
