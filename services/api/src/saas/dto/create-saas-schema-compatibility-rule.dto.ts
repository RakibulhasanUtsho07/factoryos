import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export enum SaasTransferDatasetCategory {
  BUSINESS_DATA = 'BUSINESS_DATA',
  AUDIT_LOG = 'AUDIT_LOG',
  EVIDENCE = 'EVIDENCE',
  APPROVALS = 'APPROVALS',
  EFFECTIVE_DATED_MASTER_DATA = 'EFFECTIVE_DATED_MASTER_DATA',
  AI_CONTEXT = 'AI_CONTEXT',
  LEARNING_EVALUATION = 'LEARNING_EVALUATION',
  INTEGRATION_METADATA = 'INTEGRATION_METADATA',
  FILE_REFERENCES = 'FILE_REFERENCES',
}

export const REQUIRED_TRANSFER_CATEGORIES = [
  SaasTransferDatasetCategory.BUSINESS_DATA,
  SaasTransferDatasetCategory.AUDIT_LOG,
  SaasTransferDatasetCategory.EVIDENCE,
  SaasTransferDatasetCategory.APPROVALS,
  SaasTransferDatasetCategory.EFFECTIVE_DATED_MASTER_DATA,
] as const;

export enum SaasSchemaCompatibilityDecision {
  COMPATIBLE = 'COMPATIBLE',
  TRANSFORM_REQUIRED = 'TRANSFORM_REQUIRED',
  INCOMPATIBLE = 'INCOMPATIBLE',
}

export class CreateSaasSchemaCompatibilityRuleDto {
  @IsString()
  @MaxLength(32)
  @Matches(/^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}$/)
  source_schema_version!: string;

  @IsString()
  @MaxLength(32)
  @Matches(/^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}$/)
  target_schema_version!: string;

  @IsEnum(SaasSchemaCompatibilityDecision)
  decision!: SaasSchemaCompatibilityDecision;

  @IsArray()
  @ArrayUnique()
  @ArrayMinSize(5)
  @ArrayMaxSize(9)
  @IsEnum(SaasTransferDatasetCategory, { each: true })
  required_categories!: SaasTransferDatasetCategory[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
  mapping_reference?: string;

  @IsString()
  @MaxLength(1000)
  reason!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
