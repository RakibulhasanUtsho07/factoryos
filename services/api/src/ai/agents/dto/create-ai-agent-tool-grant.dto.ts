import {
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateAiAgentToolGrantDto {
  @IsString()
  @MaxLength(100)
  agent_definition_id!: string;

  @IsString()
  @MaxLength(200)
  tool_id!: string;

  @IsString()
  @MaxLength(100)
  tool_version!: string;

  @IsOptional()
  @IsISO8601()
  effective_from?: string;

  @IsOptional()
  @IsISO8601()
  expires_at?: string | null;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
