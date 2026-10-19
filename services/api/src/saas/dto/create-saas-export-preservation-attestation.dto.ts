import { IsEnum, IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';

export enum SaasExportPreservationVerificationMethod {
  READ_BACK_HASH = 'READ_BACK_HASH',
  SIGNATURE_VALIDATION = 'SIGNATURE_VALIDATION',
  DUAL_CONTROL_REVIEW = 'DUAL_CONTROL_REVIEW',
}

export class CreateSaasExportPreservationAttestationDto {
  @IsInt()
  @Min(2)
  @Max(Number.MAX_SAFE_INTEGER)
  expected_version!: number;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/i)
  bundle_digest!: string;

  @IsEnum(SaasExportPreservationVerificationMethod)
  verification_method!: SaasExportPreservationVerificationMethod;

  /** Opaque ticket/object-audit identifier; raw URLs and credentials are not accepted. */
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/)
  verification_reference!: string;

  @IsString()
  @Length(3, 1000)
  reason!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
