import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class RegisterIntegrationConnectorDto {
  @IsString()
  @Length(2, 160)
  display_name!: string;

  @IsString()
  @Matches(/^[A-Z0-9][A-Z0-9._-]{1,119}$/)
  source_system!: string;

  @IsString()
  @Matches(/^env:\/\/WEBHOOK_SECRET_[A-Z][A-Z0-9_]{0,79}$/)
  secret_reference!: string;

  @IsInt()
  @Min(1)
  @Max(10000)
  schema_version!: number;

  @IsObject()
  payload_schema!: Record<string, unknown>;
}

export class IntegrationConnectorDecisionDto {
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class RotateIntegrationSecretDto {
  @IsString()
  @Matches(/^env:\/\/WEBHOOK_SECRET_[A-Z][A-Z0-9_]{0,79}$/)
  secret_reference!: string;

  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class ListIntegrationConnectorsDto {
  @IsOptional()
  @IsIn(['PENDING_REVIEW', 'ACTIVE', 'PAUSED', 'REJECTED'])
  status?: string;
}
