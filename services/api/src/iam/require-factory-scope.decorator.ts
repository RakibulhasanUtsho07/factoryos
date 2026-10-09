import { SetMetadata } from '@nestjs/common';

export const REQUIRED_FACTORY_SCOPE_KEY = 'required_factory_scope';

export const RequireFactoryScope = () =>
  SetMetadata(REQUIRED_FACTORY_SCOPE_KEY, true);