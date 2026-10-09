import {
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateAiAgentStudioTemplateDraftDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  customization?: string | null;
}
