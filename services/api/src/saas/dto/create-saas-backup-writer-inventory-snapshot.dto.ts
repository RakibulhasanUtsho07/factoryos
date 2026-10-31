import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsString, Length, Matches, ValidateNested,
} from 'class-validator';
import { SaasTransferDatasetCategory } from './create-saas-schema-compatibility-rule.dto';

export const SAAS_BACKUP_WRITER_ACCESS_PATHS = [
  'APP_WORKER',
  'SCHEDULED_JOB',
  'RESTORE_DR',
  'REPLICATION',
  'ACCESS_POINT',
  'MULTIPART_COMPLETION',
  'LEGACY_WRITER',
  'VENDOR',
  'OTHER',
] as const;

export class SaasBackupWriterInventoryEntryDto {
  @IsString()
  @Length(1, 100)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/)
  producer_id!: string;

  @IsString()
  @Length(1, 200)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/)
  provider_principal_reference!: string;

  @IsIn(SAAS_BACKUP_WRITER_ACCESS_PATHS)
  access_path_code!: typeof SAAS_BACKUP_WRITER_ACCESS_PATHS[number];

  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  permission_scope_digest!: string;
}

export class CreateSaasBackupWriterInventorySnapshotDto {
  @IsIn(Object.values(SaasTransferDatasetCategory))
  category_code!: SaasTransferDatasetCategory;

  @IsString()
  @Length(1, 200)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/)
  inventory_reference!: string;

  @IsString()
  @Length(1, 100)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/)
  idempotency_key!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => SaasBackupWriterInventoryEntryDto)
  entries!: SaasBackupWriterInventoryEntryDto[];
}
