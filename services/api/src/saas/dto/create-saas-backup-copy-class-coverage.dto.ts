import { IsDateString, IsIn, IsString, Length, Matches } from 'class-validator';
import { REQUIRED_BACKUP_COPY_CLASSES } from '../backup-copy-class-coverage.constants';
import { SaasTransferDatasetCategory } from './create-saas-schema-compatibility-rule.dto';
const CATEGORIES = Object.values(SaasTransferDatasetCategory);
export class CreateSaasBackupCopyClassCoverageDto {
  @IsIn(CATEGORIES) category_code!: SaasTransferDatasetCategory;
  @IsIn(REQUIRED_BACKUP_COPY_CLASSES) copy_class_code!: (typeof REQUIRED_BACKUP_COPY_CLASSES)[number];
  @IsIn(['SUPPORTED','NOT_APPLICABLE','UNRESOLVED']) disposition!: 'SUPPORTED'|'NOT_APPLICABLE'|'UNRESOLVED';
  @IsString() @Length(1,200) @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/) evidence_reference!: string;
  @IsString() @Matches(/^[a-f0-9]{64}$/) evidence_sha256!: string;
  @IsDateString() evidence_at!: string;
  @IsString() @Length(1,100) @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/) attestation_key_id!: string;
  @IsString() @Length(1,200) @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/) attestation_owner_reference!: string;
  @IsString() @Matches(/^[A-Za-z0-9_-]{86}$/) attestation_signature!: string;
  @IsString() @Length(1,200) @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/) data_owner_reference!: string;
  @IsString() @Length(1,200) @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/) infrastructure_owner_reference!: string;
  @IsString() @Length(1,200) @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/) policy_reference!: string;
  @IsString() @Length(3,1000) reason!: string;
  @IsString() @Length(1,100) @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/) idempotency_key!: string;
}
