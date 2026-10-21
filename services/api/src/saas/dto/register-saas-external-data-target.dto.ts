import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { REQUIRED_EXTERNAL_STORE_KINDS } from '../saas-tenant-propagation.adapters';
import { SaasTransferDatasetCategory } from './create-saas-schema-compatibility-rule.dto';

export class RegisterSaasExternalDataTargetDto {
  @IsString()
  @Length(1, 100)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/)
  target_id!: string;

  @IsIn(REQUIRED_EXTERNAL_STORE_KINDS)
  store_kind!: (typeof REQUIRED_EXTERNAL_STORE_KINDS)[number];

  @IsString()
  @Length(1, 100)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/)
  adapter_key!: string;

  @IsString()
  @Length(1, 200)
  @Matches(/^(?!.*:\/\/)(?!.*(?:secret|password|credential|access[-_]?key|token))[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/i)
  config_reference!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsIn(Object.values(SaasTransferDatasetCategory), { each: true })
  categories!: SaasTransferDatasetCategory[];

  @IsOptional()
  @IsBoolean()
  required?: boolean = true;

  @IsString()
  @Length(3, 1000)
  registration_reason!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
