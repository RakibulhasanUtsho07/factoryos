import { IsDateString, IsEnum, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { SaasMeterMetric } from './create-saas-meter-rate.dto';
import { SaasWorkloadClass } from './record-saas-usage-event.dto';

const PROVIDER_METRICS = {
 AI_INPUT_TOKEN: 'AI_INPUT_TOKEN',
 AI_OUTPUT_TOKEN: 'AI_OUTPUT_TOKEN',
 AI_TOOL_CALL: 'AI_TOOL_CALL',
 PREMIUM_WORKLOAD: 'PREMIUM_WORKLOAD',
 EDGE_INFERENCE: 'EDGE_INFERENCE',
 INTEGRATION_CALL: 'INTEGRATION_CALL',
};

export enum SaasProviderCostSource {
 PROVIDER_EXPORT='PROVIDER_EXPORT',
 PROVIDER_API='PROVIDER_API',
 MANUAL='MANUAL',
}

export class RecordSaasProviderCostEventDto {
 @IsString() @MaxLength(60) @Matches(/^[a-z][a-z0-9._:-]{0,59}$/) provider_code!: string;
 @IsOptional() @IsString() @MaxLength(100) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/) model_code?: string;
 @IsEnum(PROVIDER_METRICS) metric_code!: SaasMeterMetric;
 @IsEnum(SaasWorkloadClass) workload_class!: SaasWorkloadClass;
 @IsNumber({allowNaN:false,allowInfinity:false}) @Min(0.000001) @Max(1000000000000) quantity!: number;
 @IsString() @Matches(/^[A-Z]{3}$/) currency!: string;
 @IsNumber({allowNaN:false,allowInfinity:false}) @Min(0) @Max(9000000000000000) provider_cost_minor!: number;
 @IsDateString() occurred_at!: string;
 @IsOptional() @IsString() @MaxLength(180) provider_invoice_reference?: string;
 @IsEnum(SaasProviderCostSource) source_system!: SaasProviderCostSource;
 @IsString() @MaxLength(255) source_event_ref!: string;
 @IsString() @MaxLength(128) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/) idempotency_key!: string;
}
