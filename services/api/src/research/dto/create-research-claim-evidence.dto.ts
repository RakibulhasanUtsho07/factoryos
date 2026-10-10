import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateResearchClaimEvidenceDto {
  @IsUUID()
  source_id!: string;

  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/)
  content_sha256!: string;

  @IsString()
  @MaxLength(4000)
  quote_text!: string;

  /** Zero-based Unicode code-point offset; end_offset is exclusive. */
  @IsInt()
  @Min(0)
  @Max(32767)
  start_offset!: number;

  /** Zero-based Unicode code-point offset; end_offset is exclusive. */
  @IsInt()
  @Min(1)
  @Max(32768)
  end_offset!: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  locator?: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
