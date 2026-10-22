import { IsString, IsUUID, Matches, Length } from 'class-validator';

export class CreateProductChangeOrderDto {
  @IsUUID()
  proposed_version_id!: string;

  @IsString()
  @Length(3, 160)
  title!: string;

  @IsString()
  @Length(10, 4000)
  rationale!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  effective_date!: string;
}
