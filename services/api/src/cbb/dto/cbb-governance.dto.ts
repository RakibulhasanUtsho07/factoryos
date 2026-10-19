import { Type } from 'class-transformer';
import {
  IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID,
  Max, MaxLength, Min,
} from 'class-validator';

export const CBB_ACCESS_TARGET_TYPES = [
  'BLUEPRINT', 'ENTITY', 'RELATION', 'PROCESS', 'PROCESS_STEP', 'RULE', 'TERM', 'EXCEPTION',
] as const;
export const CBB_ACCESS_LEVELS = ['READ', 'EDIT', 'OWNER'] as const;

export class GrantCbbAccessDto {
  @IsUUID() role_id!: string;
  @IsIn([...CBB_ACCESS_TARGET_TYPES]) target_type!: (typeof CBB_ACCESS_TARGET_TYPES)[number];
  @IsUUID() target_id!: string;
  @IsOptional() @IsString() @MaxLength(150) field_name?: string;
  @IsIn([...CBB_ACCESS_LEVELS]) access_level!: (typeof CBB_ACCESS_LEVELS)[number];
}

export class ScanCbbStalenessDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(3650) threshold_days!: number;
}

export class DecideCbbStalenessDto {
  @IsIn(['MARK_STALE', 'RECONFIRM', 'DISMISS']) action!: 'MARK_STALE' | 'RECONFIRM' | 'DISMISS';
  @Type(() => Number) @IsInt() @Min(1) expected_version!: number;
  @IsString() @MaxLength(2000) reason!: string;
}

export class CreateCbbTerminologyAliasDto {
  @IsString() @MaxLength(300) alias!: string;
  @IsString() @MaxLength(300) canonical_term!: string;
  @IsOptional() @IsString() @MaxLength(20) language_code?: string;
  @IsOptional() @IsString() @MaxLength(150) source_system?: string;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}

export class DecideCbbTerminologyAliasDto {
  @IsIn(['VERIFY', 'MARK_STALE']) action!: 'VERIFY' | 'MARK_STALE';
  @Type(() => Number) @IsInt() @Min(1) expected_version!: number;
  @IsString() @MaxLength(2000) reason!: string;
}

export class ResolveCbbTerminologyQueryDto {
  @IsString() @MaxLength(300) term!: string;
  @IsOptional() @IsString() @MaxLength(150) source_system?: string;
}

export class CreateCbbImpactLinkDto {
  @IsIn([...CBB_ACCESS_TARGET_TYPES].filter((value) => value !== 'BLUEPRINT')) source_type!:
    Exclude<(typeof CBB_ACCESS_TARGET_TYPES)[number], 'BLUEPRINT'>;
  @IsUUID() source_id!: string;
  @IsIn(['PROCESS','RULE','TERM','EXCEPTION','KPI','ORDER','ANALYST_WORKFLOW','SYSTEM','OTHER'])
  impacted_type!: 'PROCESS' | 'RULE' | 'TERM' | 'EXCEPTION' | 'KPI' | 'ORDER' | 'ANALYST_WORKFLOW' | 'SYSTEM' | 'OTHER';
  @IsString() @MaxLength(300) impacted_ref!: string;
  @IsOptional() @IsIn(['DEPENDS_ON','AFFECTS','OWNED_BY','MEASURES','CONSUMED_BY','BLOCKS','RELATED_TO'])
  impact_type?: 'DEPENDS_ON' | 'AFFECTS' | 'OWNED_BY' | 'MEASURES' | 'CONSUMED_BY' | 'BLOCKS' | 'RELATED_TO';
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsObject() metadata?: Record<string, unknown>;
}

export class ImpactTraceQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5) depth?: number;
}

export class RollbackCbbVersionDto {
  @IsUUID() source_version_id!: string;
  @IsUUID() expected_current_version_id!: string;
  @IsString() @MaxLength(2000) reason!: string;
  @IsOptional() @IsUUID() correlation_id?: string;
}
