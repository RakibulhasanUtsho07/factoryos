import {
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class ValidateResearchCitationDto {
  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
