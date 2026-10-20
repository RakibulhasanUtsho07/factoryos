import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsEnum, IsString, Length, Matches } from 'class-validator';
import { SaasTransferDatasetCategory } from './create-saas-schema-compatibility-rule.dto';

export class CreateSaasDataLegalHoldDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsEnum(SaasTransferDatasetCategory, { each: true })
  categories!: SaasTransferDatasetCategory[];

  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
  case_reference!: string;

  @IsString()
  @Length(3, 1000)
  reason!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
