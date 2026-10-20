import { IsEnum, IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';
import { SaasTransferDatasetCategory } from './create-saas-schema-compatibility-rule.dto';

export enum SaasRetentionDisposition {
  DELETE = 'DELETE',
  ANONYMIZE = 'ANONYMIZE',
  REVIEW = 'REVIEW',
}

export class CreateSaasRetentionPolicyDto {
  @IsEnum(SaasTransferDatasetCategory)
  category_code!: SaasTransferDatasetCategory;

  @IsInt()
  @Min(1)
  @Max(36500)
  retention_days!: number;

  @IsEnum(SaasRetentionDisposition)
  disposition!: SaasRetentionDisposition;

  @IsString()
  @Length(3, 200)
  legal_basis!: string;

  @IsString()
  @Length(3, 1000)
  reason!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
