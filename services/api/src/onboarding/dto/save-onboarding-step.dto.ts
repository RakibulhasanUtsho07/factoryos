import { IsObject, IsNotEmpty } from 'class-validator';

export class SaveOnboardingStepDto {
  @IsObject()
  @IsNotEmpty()
  payload!: Record<string, unknown>;
}
