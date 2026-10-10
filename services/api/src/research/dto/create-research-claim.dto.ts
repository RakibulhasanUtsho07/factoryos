import {
  IsEnum,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export enum ResearchClaimType {
  FACT = 'FACT',
  INFERENCE = 'INFERENCE',
  RECOMMENDATION = 'RECOMMENDATION',
  OPINION = 'OPINION',
}

export class CreateResearchClaimDto {
  @IsString()
  @MaxLength(200)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/)
  claim_key!: string;

  @IsString()
  @MaxLength(60)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,59}$/)
  claim_version!: string;

  @IsEnum(ResearchClaimType)
  claim_type!: ResearchClaimType;

  @IsString()
  @MaxLength(4000)
  statement!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
