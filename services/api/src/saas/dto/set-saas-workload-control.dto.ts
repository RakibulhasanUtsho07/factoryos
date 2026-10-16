import { IsEnum, IsString, MaxLength, Matches } from 'class-validator';
export enum SaasNonCriticalWorkloadClass {
 EVALUATION='EVALUATION',
 RED_TEAM='RED_TEAM',
 SHADOW_MODE='SHADOW_MODE',
 DEVELOPMENT='DEVELOPMENT',
}
export enum SaasWorkloadControlState { PAUSED='PAUSED', RESUMED='RESUMED' }
export enum SaasWorkloadScopeLevel { TENANT='TENANT', FACTORY='FACTORY' }
export class SetSaasWorkloadControlDto {
 @IsEnum(SaasNonCriticalWorkloadClass)
 workload_class!: SaasNonCriticalWorkloadClass;
 @IsEnum(SaasWorkloadControlState)
 control_state!: SaasWorkloadControlState;
 @IsEnum(SaasWorkloadScopeLevel)
 scope_level!: SaasWorkloadScopeLevel;
 @IsString() @MaxLength(1000)
 reason!: string;
 @IsString() @MaxLength(128) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
 idempotency_key!: string;
}
