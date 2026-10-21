import { IsDateString, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class CreateEngineeringChangeDto {
  @IsString() @Matches(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/)
  eco_number!: string;
  @IsString() @MaxLength(255)
  title!: string;
  @IsString() @MaxLength(4000)
  rationale!: string;
  @IsUUID()
  source_version_id!: string;
  @IsUUID()
  target_version_id!: string;
  @IsDateString({ strict: true }) @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effective_on!: string;
}
