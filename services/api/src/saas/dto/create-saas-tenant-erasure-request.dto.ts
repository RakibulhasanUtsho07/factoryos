import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsEnum, IsInt, IsString, Length, Matches, Min } from 'class-validator';
import { SaasTransferDatasetCategory } from './create-saas-schema-compatibility-rule.dto';

export class CreateSaasTenantErasureRequestDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsEnum(SaasTransferDatasetCategory, { each: true })
  categories!: SaasTransferDatasetCategory[];

  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  export_transfer_id!: string;

  @IsInt()
  @Min(1)
  export_transfer_version!: number;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  export_bundle_digest!: string;

  @IsString()
  @Length(3, 1000)
  reason!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
