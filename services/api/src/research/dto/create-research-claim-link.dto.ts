import { IsIn, IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateResearchClaimLinkDto {
  @IsUUID()
  related_claim_id!: string;

  @IsIn(['SUPPORTS', 'CONTRADICTS', 'RELATED_TO'])
  relation_type!: 'SUPPORTS' | 'CONTRADICTS' | 'RELATED_TO';

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  context!: string;
}
