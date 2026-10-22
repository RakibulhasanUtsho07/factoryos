import { IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class ProductChangeOrderActionDto {
  @IsInt()
  @Min(1)
  expected_version!: number;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  comment?: string;
}
