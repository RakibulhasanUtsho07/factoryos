import { IsDateString, Matches } from 'class-validator';

export class CreateMrpLiteRunDto {
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  horizon_start!: string;

  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  horizon_end!: string;
}
