import { IsArray, IsIn, IsInt, IsNotEmpty, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class CreateResearchReleaseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  release_key!: string;

  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title!: string;

  @IsArray()
  @IsUUID(undefined, { each: true })
  claim_ids!: string[];

  @IsIn(['A', 'B', 'C', 'D', 'MIXED'])
  evidence_grade!: 'A' | 'B' | 'C' | 'D' | 'MIXED';
}
