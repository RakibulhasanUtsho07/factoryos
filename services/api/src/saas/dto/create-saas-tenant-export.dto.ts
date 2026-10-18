import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { SaasTransferDatasetCategory } from './create-saas-schema-compatibility-rule.dto';

export class CreateSaasTenantExportDto {
  @IsString()
  @MaxLength(32)
  @Matches(/^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}$/)
  source_schema_version!: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(9)
  @IsEnum(SaasTransferDatasetCategory, { each: true })
  dataset_categories?: SaasTransferDatasetCategory[];

  @IsString()
  @MaxLength(1000)
  reason!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
