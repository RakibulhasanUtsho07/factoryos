import { IsDateString, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class CreateMrpLiteRunDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  horizon_start!: string;

  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  horizon_end!: string;
}
