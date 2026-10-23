import {
  IsEnum,
  IsISO8601,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import type { AiArtifactType } from '../ai.artifact.provenance.service';

export class CreateAiArtifactSourceDto {
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/)
  source_key!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(240)
  label!: string;

  @IsString()
  @MaxLength(2048)
  public_key_pem!: string;

  @IsISO8601({ strict: true })
  valid_until!: string;
}

export class ArtifactReasonDto {
  @IsString()
  @MinLength(8)
  @MaxLength(500)
  reason!: string;
}

export class RegisterAiArtifactDto {
  @IsEnum({
    MODEL: 'MODEL',
    TOOL: 'TOOL',
    PROMPT: 'PROMPT',
    POLICY: 'POLICY',
  })
  artifact_type!: AiArtifactType;

  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/)
  artifact_key!: string;

  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/)
  version!: string;

  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/)
  sha256!: string;

  @IsUUID()
  source_id!: string;

  @IsISO8601({ strict: true })
  expires_at!: string;

  @IsString()
  @MinLength(80)
  @MaxLength(256)
  signature_base64!: string;
}
