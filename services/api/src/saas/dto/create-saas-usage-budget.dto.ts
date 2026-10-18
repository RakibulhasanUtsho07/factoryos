import { IsBoolean, IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { SaasMeterMetric } from './create-saas-meter-rate.dto';
import { SaasWorkloadClass } from './record-saas-usage-event.dto';

export enum SaasBudgetPeriodKind { DAILY='DAILY', MONTHLY='MONTHLY' }
export enum SaasBudgetScopeLevel { TENANT='TENANT', FACTORY='FACTORY' }

export class CreateSaasUsageBudgetDto {
 @IsString() @MaxLength(80) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/)
 budget_code!: string;
 @IsInt() @Min(1) @Max(1000000)
 policy_version!: number;
 @IsEnum(SaasBudgetPeriodKind)
 period_kind!: SaasBudgetPeriodKind;
 @IsEnum(SaasBudgetScopeLevel)
 scope_level!: SaasBudgetScopeLevel;
 @IsOptional() @IsEnum(SaasMeterMetric)
 metric_code?: SaasMeterMetric;
 @IsOptional() @IsString() @MaxLength(100) @Matches(/^[a-z][a-z0-9._:-]{0,99}$/)
 capability_code?: string;
 @IsOptional() @IsEnum(SaasWorkloadClass)
 workload_class?: SaasWorkloadClass;
 @IsString() @Matches(/^[A-Z]{3}$/)
 currency!: string;
 @IsInt() @Min(0) @Max(9000000000000000)
 soft_limit_minor!: number;
 @IsInt() @Min(0) @Max(9000000000000000)
 hard_limit_minor!: number;
 @IsOptional() @IsBoolean()
 pause_noncritical_on_hard_limit?: boolean;
 @IsOptional() @IsNumber() @Min(1.5) @Max(100)
 anomaly_multiplier?: number;
 @IsOptional() @IsInt() @Min(3) @Max(100000)
 anomaly_min_events?: number;
 @IsDateString()
 effective_from!: string;
 @IsOptional() @IsDateString()
 effective_to?: string;
 @IsString() @MaxLength(128) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
 idempotency_key!: string;
}
