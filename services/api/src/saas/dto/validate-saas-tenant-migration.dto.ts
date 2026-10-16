import { IsString, Matches, MaxLength } from 'class-validator';

export class ValidateSaasTenantMigrationDto {
  @IsString()
  @Matches(/^[0-9a-f-]{36}$/i)
  source_transfer_id!: string;

  @IsString()
  @MaxLength(32)
  @Matches(/^[0-9]{1,8}\.[0-9]{1,8}\.[0-9]{1,8}$/)
  target_schema_version!: string;

  @IsString()
  @MaxLength(1000)
  reason!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
