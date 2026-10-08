import {
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateAiAgentStudioDraftDto {
  @IsString()
  @MaxLength(4000)
  prompt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string | null;
}

export class ReviewAiAgentStudioDraftDto {
  @IsString()
  @MaxLength(20)
  decision!: 'APPROVE' | 'REJECT';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}
