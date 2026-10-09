import {
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateAiAgentHandoffDto {
  @IsString()
  @MaxLength(200)
  target_agent_id!: string;

  @IsString()
  @MaxLength(1000)
  purpose!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  allowed_data_classes!: string[];

  @IsArray()
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  permitted_tools!: string[];

  @IsOptional()
  @IsISO8601()
  expires_at?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  parent_trace_id?: string | null;

  @IsOptional()
  @IsObject()
  expected_artifact?: Record<string, unknown> | null;
}
