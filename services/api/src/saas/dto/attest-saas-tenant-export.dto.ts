import { IsInt, IsObject, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export interface SaasTransferDatasetDigest {
  record_count: number;
  sha256: string;
}

export class AttestSaasTenantExportDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER - 1)
  expected_version!: number;

  @IsString()
  @MaxLength(200)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/)
  bundle_reference!: string;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  bundle_digest!: string;

  @IsObject()
  dataset_manifest!: Record<string, SaasTransferDatasetDigest>;

  @IsString()
  @MaxLength(1000)
  reason!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
