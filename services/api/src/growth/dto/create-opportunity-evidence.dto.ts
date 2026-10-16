import {
  IsIn, IsNumber, IsObject, IsOptional, IsString, IsUrl, IsUUID,
  Max, MaxLength, Min,
} from 'class-validator';

export class CreateOpportunityEvidenceDto {
  @IsIn(['RESEARCH_CLAIM', 'CBB_ENTITY', 'OPERATIONAL_METRIC', 'MARKET_SIGNAL', 'CLIENT_DOCUMENT'])
  evidence_type!: 'RESEARCH_CLAIM' | 'CBB_ENTITY' | 'OPERATIONAL_METRIC' | 'MARKET_SIGNAL' | 'CLIENT_DOCUMENT';

  @IsString()
  @MaxLength(4000)
  description!: string;

  @IsOptional()
  @IsUUID()
  research_claim_id?: string;

  @IsOptional()
  @IsUUID()
  business_entity_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reference_ref?: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(4000)
  citation_url?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;

  @IsOptional()
  @IsObject()
  evidence_snapshot?: Record<string, unknown>;
}
